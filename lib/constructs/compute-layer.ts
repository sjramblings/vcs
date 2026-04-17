import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DataLayer } from './data-layer';

export interface ComputeLayerProps {
  dataLayer: DataLayer;
}

export class ComputeLayer extends Construct {
  public readonly filesystemFn: NodejsFunction;
  public readonly ingestionFn: NodejsFunction;
  public readonly parentSummariserFn: NodejsFunction;
  public readonly queryFn: NodejsFunction;
  public readonly sessionFn: NodejsFunction;
  public readonly mcpToolExecutorFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ComputeLayerProps) {
    super(scope, id);

    // ─── Filesystem Lambda ──────────────────────────────────────────────
    const filesystemLogGroup = new logs.LogGroup(this, 'FilesystemLogs', {
      logGroupName: '/aws/lambda/vcs-filesystem',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.filesystemFn = new NodejsFunction(this, 'FilesystemHandler', {
      entry: 'src/lambdas/filesystem/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: filesystemLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-filesystem',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],  // CRITICAL: Bundle everything including AWS SDK v3
      },
    });

    // NO VPC attachment
    // NodejsFunction creates unique IAM role per function

    // Grant least-privilege permissions:
    // - DynamoDB read/write on context table (for ls, tree, read, mkdir)
    props.dataLayer.contextTable.grantReadWriteData(this.filesystemFn);
    // - SSM read for parameter discovery
    this.filesystemFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));

    // ─── Ingestion Lambda ───────────────────────────────────────────────
    const ingestionLogGroup = new logs.LogGroup(this, 'IngestionLogs', {
      logGroupName: '/aws/lambda/vcs-ingestion',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.ingestionFn = new NodejsFunction(this, 'IngestionHandler', {
      entry: 'src/lambdas/ingestion/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: ingestionLogGroup,
      // reservedConcurrentExecutions removed — POC account concurrency quota too low
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-ingestion',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],  // Bundle everything including AWS SDK v3
      },
    });

    // NO VPC attachment

    // Ingestion IAM grants:
    // - DynamoDB read/write
    props.dataLayer.contextTable.grantReadWriteData(this.ingestionFn);
    // - S3 read/write for L2 content storage
    props.dataLayer.contentBucket.grantReadWrite(this.ingestionFn);
    // - SSM read for parameter discovery
    this.ingestionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));
    // - Bedrock invoke for summarisation and embedding
    // Cross-region inference profiles (us.*) route to multiple regions, so grant on * region
    this.ingestionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Nova Micro (fast tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
        // Nova Lite (standard tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0`,
        // Titan Embeddings V2
        `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));
    // - Marketplace subscriptions required for Bedrock model access
    this.ingestionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions'],
      resources: ['*'],
    }));
    // - S3 Vectors for embedding storage + verify-after-write ANN check
    this.ingestionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:GetVectors', 's3vectors:QueryVectors'],
      resources: [`arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/${props.dataLayer.vectorBucketName}/*`],
    }));
    // - SQS send for parent rollup trigger
    props.dataLayer.rollupQueue.grantSendMessages(this.ingestionFn);

    // ─── Parent Summariser Lambda ───────────────────────────────────────
    const parentSummariserLogGroup = new logs.LogGroup(this, 'ParentSummariserLogs', {
      logGroupName: '/aws/lambda/vcs-parent-summariser',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.parentSummariserFn = new NodejsFunction(this, 'ParentSummariserHandler', {
      entry: 'src/lambdas/parent-summariser/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: parentSummariserLogGroup,
      // reservedConcurrentExecutions removed — POC account concurrency quota too low
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-parent-summariser',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],  // Bundle everything including AWS SDK v3
      },
    });

    // SQS event source: batchSize=1 for FIFO ensures one parent processed at a time per MessageGroupId
    this.parentSummariserFn.addEventSource(
      new SqsEventSource(props.dataLayer.rollupQueue, {
        batchSize: 1,
        maxConcurrency: 2,
      }),
    );

    // NO VPC attachment

    // Parent Summariser IAM grants:
    // - DynamoDB read children + write parent
    props.dataLayer.contextTable.grantReadWriteData(this.parentSummariserFn);
    // - SSM read for parameter discovery
    this.parentSummariserFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));
    // - Bedrock invoke for summarisation and embedding
    // Cross-region inference profiles (us.*) route to multiple regions, so grant on * region
    this.parentSummariserFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Nova Micro (fast tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
        // Nova Lite (standard tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0`,
        // Titan Embeddings V2
        `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));
    // - Marketplace subscriptions required for Bedrock model access
    this.parentSummariserFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions'],
      resources: ['*'],
    }));
    // - S3 Vectors for embedding storage + verify-after-write ANN check
    // GetVectors required: S3 Vectors resolves metadata filters internally via GetVectors
    this.parentSummariserFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:GetVectors', 's3vectors:QueryVectors'],
      resources: [`arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/${props.dataLayer.vectorBucketName}/*`],
    }));
    // - SQS send for grandparent rollup
    props.dataLayer.rollupQueue.grantSendMessages(this.parentSummariserFn);
    // Note: SQS consume is auto-granted by SqsEventSource

    // ─── Query Lambda ────────────────────────────────────────────────────
    const queryLogGroup = new logs.LogGroup(this, 'QueryLogs', {
      logGroupName: '/aws/lambda/vcs-query',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.queryFn = new NodejsFunction(this, 'QueryHandler', {
      entry: 'src/lambdas/query/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: queryLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-query',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],  // Bundle everything including AWS SDK v3
      },
    });

    // NO VPC attachment

    // Query Lambda IAM grants:
    // - DynamoDB read-only on context table (retrieval reads L0 abstracts)
    props.dataLayer.contextTable.grantReadData(this.queryFn);
    // - DynamoDB read-only on sessions table (session context for search)
    props.dataLayer.sessionsTable.grantReadData(this.queryFn);
    // - SSM read for parameter discovery
    this.queryFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));
    // - Bedrock invoke for intent analysis and embedding generation
    this.queryFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Nova Micro (fast tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
        // Nova Lite (standard tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0`,
        // Titan Embeddings V2
        `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));
    // - Marketplace subscriptions required for Bedrock model access
    this.queryFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions'],
      resources: ['*'],
    }));
    // - S3 Vectors QueryVectors + GetVectors (GetVectors needed for returnMetadata and filter)
    this.queryFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
      resources: [`arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/${props.dataLayer.vectorBucketName}/*`],
    }));

    // ─── Session Lambda ───────────────────────────────────────────────────
    const sessionLogGroup = new logs.LogGroup(this, 'SessionLogs', {
      logGroupName: '/aws/lambda/vcs-session',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.sessionFn = new NodejsFunction(this, 'SessionHandler', {
      entry: 'src/lambdas/session/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120), // 120 seconds for commit with multiple Bedrock calls
      tracing: lambda.Tracing.ACTIVE,
      logGroup: sessionLogGroup, // TWO_WEEKS — contains user content
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-session',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [], // Bundle everything including AWS SDK v3
      },
    });

    // NO VPC attachment

    // Session Lambda IAM grants:
    // - DynamoDB read/write on context table (for commit operations)
    props.dataLayer.contextTable.grantReadWriteData(this.sessionFn);
    // - DynamoDB read/write on sessions table (for session CRUD)
    props.dataLayer.sessionsTable.grantReadWriteData(this.sessionFn);
    // - S3 read/write for archives
    props.dataLayer.contentBucket.grantReadWrite(this.sessionFn);
    // - SSM read for parameter discovery
    this.sessionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));
    // - Bedrock invoke for summarisation and embedding during commit
    this.sessionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Nova Micro (fast tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
        // Nova Lite (standard tier)
        `arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0`,
        // Titan Embeddings V2
        `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));
    // - Marketplace subscriptions required for Bedrock model access
    this.sessionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions'],
      resources: ['*'],
    }));
    // - S3 Vectors for embedding storage during commit
    this.sessionFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors'],  // QueryVectors + GetVectors REMOVED
      resources: [`arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/${props.dataLayer.vectorBucketName}/*`],
    }));
    // - SQS send messages for parent rollup trigger during commit
    props.dataLayer.rollupQueue.grantSendMessages(this.sessionFn);

    // ─── Filesystem Lambda Permission Upgrades (for rm/mv) ────────────────
    // - S3 read/write for deleting L2 content during rm/mv
    props.dataLayer.contentBucket.grantReadWrite(this.filesystemFn);
    // - S3 Vectors delete + get for removing/reading vectors during rm/mv
    this.filesystemFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:GetVectors'],
      resources: [`arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/${props.dataLayer.vectorBucketName}/*`],
    }));

    // ─── MCP Tool Executor Lambda ─────────────────────────────────────
    const mcpToolLogGroup = new logs.LogGroup(this, 'McpToolLogs', {
      logGroupName: '/aws/lambda/vcs-mcp-tools',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.mcpToolExecutorFn = new NodejsFunction(this, 'McpToolExecutor', {
      entry: 'src/lambdas/mcp-tools/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: mcpToolLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'vcs-mcp-tools',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    // NO Function URL — Gateway invokes via IAM lambda:InvokeFunction

    // NO VPC attachment

    // MCP Tool Executor IAM grants (same as old MCP server):
    // - SSM read for parameter discovery (API URL + API key ID)
    this.mcpToolExecutorFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/vcs/*`],
    }));
    // - API Gateway GetApiKey (to retrieve API key value at runtime from key ID)
    this.mcpToolExecutorFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [`arn:aws:apigateway:${cdk.Aws.REGION}::/apikeys/*`],
    }));

  }
}
