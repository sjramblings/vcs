import * as cdk from 'aws-cdk-lib';
import {
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_s3vectors as s3vectors,
  aws_sqs as sqs,
  aws_ssm as ssm,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SSM_PATHS, VECTOR_DIMENSIONS, VECTOR_DISTANCE_METRIC, VECTOR_INDEX_NAME } from '../config';

export class DataLayer extends Construct {
  public readonly contextTable: dynamodb.Table;
  public readonly sessionsTable: dynamodb.Table;
  public readonly contentBucket: s3.Bucket;
  public readonly vectorBucketName: string;
  public readonly rollupQueue: sqs.Queue;
  public readonly rollupDlq: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ─── 1. DynamoDB Context Table ───────────────────────────────────────
    this.contextTable = new dynamodb.Table(this, 'ContextTable', {
      tableName: 'vcs-context',
      partitionKey: { name: 'uri', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'level', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI: parent-index (for ls operations)
    this.contextTable.addGlobalSecondaryIndex({
      indexName: 'parent-index',
      partitionKey: { name: 'parent_uri', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'uri', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: type-index (for scoped queries)
    this.contextTable.addGlobalSecondaryIndex({
      indexName: 'type-index',
      partitionKey: { name: 'context_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'uri', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: category-index (for memory browsing)
    this.contextTable.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updated_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── 2. DynamoDB Sessions Table ──────────────────────────────────────
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'vcs-sessions',
      partitionKey: { name: 'session_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entry_type_seq', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ─── 3a. S3 Access Logs Bucket ─────────────────────────────────────────
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `vcs-access-logs-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED, // S3 access logging does not support KMS-encrypted destination buckets
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      enforceSSL: true,
    });

    // ─── 3b. S3 Content Bucket ────────────────────────────────────────────
    this.contentBucket = new s3.Bucket(this, 'ContentBucket', {
      bucketName: `vcs-content-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'content-bucket/',
      lifecycleRules: [
        {
          id: 'expire-temp-files',
          prefix: 'temp/',
          expiration: cdk.Duration.hours(24),
        },
        {
          id: 'expire-agentcore-payloads',
          prefix: 'vcs_memory-',  // AgentCore writes to {memoryId}/{strategyId}/... not agentcore/payloads/
          expiration: cdk.Duration.days(7),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // ─── 4. S3 Vectors ──────────────────────────────────────────────────
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `vcs-vectors-${cdk.Aws.ACCOUNT_ID}`,
    });
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.vectorBucketName = vectorBucket.vectorBucketName!;

    // CRITICAL: S3 Vectors metadata schema is IMMUTABLE after creation.
    // Non-filterable: abstract, created_at
    // All other metadata keys (uri, parent_uri, context_type, level) are
    // automatically filterable when attached at vector insertion time.
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: VECTOR_INDEX_NAME,
      dimension: VECTOR_DIMENSIONS,
      distanceMetric: VECTOR_DISTANCE_METRIC,
      dataType: 'float32',
      metadataConfiguration: {
        nonFilterableMetadataKeys: ['abstract', 'created_at'],
      },
    });
    vectorIndex.addDependency(vectorBucket);

    // Audit output for schema validation
    new cdk.CfnOutput(this, 'VectorSchemaValidation', {
      value: JSON.stringify({
        indexName: VECTOR_INDEX_NAME,
        dimension: VECTOR_DIMENSIONS,
        distanceMetric: VECTOR_DISTANCE_METRIC,
        dataType: 'float32',
        nonFilterableMetadataKeys: ['abstract', 'created_at'],
        autoFilterableOnInsert: ['uri', 'parent_uri', 'context_type', 'level'],
      }),
      description: 'S3 Vectors schema - IMMUTABLE after creation. Verify before first deploy.',
    });

    // ─── 5. SQS FIFO Queue for Parent Rollup ────────────────────────────
    // All queues use SSE-SQS (free, no perf impact) + enforceSSL to ensure
    // context data is encrypted at rest and TLS-only in transit.
    this.rollupDlq = new sqs.Queue(this, 'RollupDlq', {
      queueName: 'vcs-rollup-dlq.fifo',
      fifo: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.rollupQueue = new sqs.Queue(this, 'RollupQueue', {
      queueName: 'vcs-rollup-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.rollupDlq,
        maxReceiveCount: 3,
      },
    });

    // ─── 6. SSM Parameters ──────────────────────────────────────────────
    new ssm.StringParameter(this, 'ContextTableNameParam', {
      parameterName: SSM_PATHS.CONTEXT_TABLE_NAME,
      stringValue: this.contextTable.tableName,
    });

    new ssm.StringParameter(this, 'SessionsTableNameParam', {
      parameterName: SSM_PATHS.SESSIONS_TABLE_NAME,
      stringValue: this.sessionsTable.tableName,
    });

    new ssm.StringParameter(this, 'ContentBucketNameParam', {
      parameterName: SSM_PATHS.CONTENT_BUCKET_NAME,
      stringValue: this.contentBucket.bucketName,
    });

    new ssm.StringParameter(this, 'VectorBucketNameParam', {
      parameterName: SSM_PATHS.VECTOR_BUCKET_NAME,
      stringValue: vectorBucket.vectorBucketName!,
    });

    new ssm.StringParameter(this, 'VectorIndexNameParam', {
      parameterName: SSM_PATHS.VECTOR_INDEX_NAME,
      stringValue: VECTOR_INDEX_NAME,
    });

    new ssm.StringParameter(this, 'RollupQueueUrlParam', {
      parameterName: SSM_PATHS.ROLLUP_QUEUE_URL,
      stringValue: this.rollupQueue.queueUrl,
    });

    // ─── 7. Root Directory Seeding ───────────────────────────────────────
    const rootDirs: Array<{ uri: string; contextType: string }> = [
      { uri: 'viking://resources/', contextType: 'resource' },
      { uri: 'viking://user/', contextType: 'memory' },
      { uri: 'viking://agent/', contextType: 'skill' },
      { uri: 'viking://session/', contextType: 'session' },
    ];

    const subDirs: Array<{ uri: string; parentUri: string; contextType: string }> = [];

    for (const { uri, contextType } of rootDirs) {
      const sanitizedId = uri.replace(/[:/]/g, '-');
      new cr.AwsCustomResource(this, `Seed${sanitizedId}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: this.contextTable.tableName,
            Item: {
              uri: { S: uri },
              level: { N: '0' },
              parent_uri: { S: 'viking://' },
              context_type: { S: contextType },
              is_directory: { BOOL: true },
              processing_status: { S: 'ready' },
              created_at: { S: new Date().toISOString() },
              updated_at: { S: new Date().toISOString() },
            },
            ConditionExpression: 'attribute_not_exists(uri)',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`seed-${uri}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [this.contextTable.tableArn],
        }),
      });
    }

    for (const { uri, parentUri, contextType } of subDirs) {
      const sanitizedId = uri.replace(/[:/]/g, '-');
      new cr.AwsCustomResource(this, `Seed${sanitizedId}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: this.contextTable.tableName,
            Item: {
              uri: { S: uri },
              level: { N: '0' },
              parent_uri: { S: parentUri },
              context_type: { S: contextType },
              is_directory: { BOOL: true },
              processing_status: { S: 'ready' },
              created_at: { S: new Date().toISOString() },
              updated_at: { S: new Date().toISOString() },
            },
            ConditionExpression: 'attribute_not_exists(uri)',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`seed-${uri}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [this.contextTable.tableArn],
        }),
      });
    }
  }
}
