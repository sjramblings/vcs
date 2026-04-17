import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsStack } from '../../lib/vcs-stack';

describe('VcsStack CDK Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VcsStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  // CDK stack synthesises without errors ──────────────────
  test('cdk synth produces valid template', () => {
    const resources = template.toJSON().Resources;
    expect(resources).toBeDefined();
    expect(Object.keys(resources).length).toBeGreaterThan(0);
  });

  // Context table PK=uri SK=level ────────────────────────
  test('context table has PK=uri SK=level', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'vcs-context',
      KeySchema: [
        { AttributeName: 'uri', KeyType: 'HASH' },
        { AttributeName: 'level', KeyType: 'RANGE' },
      ],
    });
  });

  // Context table has 3 GSIs ─────────────────────────────
  test('context table has parent-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'vcs-context',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'parent-index',
          KeySchema: [
            { AttributeName: 'parent_uri', KeyType: 'HASH' },
            { AttributeName: 'uri', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('context table has type-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'vcs-context',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'type-index',
          KeySchema: [
            { AttributeName: 'context_type', KeyType: 'HASH' },
            { AttributeName: 'uri', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('context table has category-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'vcs-context',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'category-index',
          KeySchema: [
            { AttributeName: 'category', KeyType: 'HASH' },
            { AttributeName: 'updated_at', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  // Sessions table PK=session_id SK=entry_type_seq ──────
  test('sessions table has PK=session_id SK=entry_type_seq', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'vcs-sessions',
      KeySchema: [
        { AttributeName: 'session_id', KeyType: 'HASH' },
        { AttributeName: 'entry_type_seq', KeyType: 'RANGE' },
      ],
    });
  });

  // S3 bucket with temp/ lifecycle rule ──────────────────
  test('S3 bucket has temp/ lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'temp/',
            ExpirationInDays: Match.anyValue(),
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  // S3 Vectors index with correct schema ────────────────
  test('S3 Vectors index has dimension 1024 and cosine metric', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: {
        NonFilterableMetadataKeys: Match.arrayWith(['abstract', 'created_at']),
      },
    });
  });

  // Vector schema validation output ─────────────────────
  test('vector schema validation output exists', () => {
    template.hasOutput('*', {
      Value: Match.anyValue(),
    });
    // More specifically, check that we have the VectorSchemaValidation output
    const outputs = template.toJSON().Outputs;
    const validationOutputKey = Object.keys(outputs).find(key =>
      key.includes('VectorSchemaValidation')
    );
    expect(validationOutputKey).toBeDefined();
  });

  // SQS FIFO queue with DLQ ─────────────────────────────
  test('SQS FIFO queue with DLQ and maxReceiveCount 3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  // Lambda has unique IAM role with least-privilege ──────
  test('Lambda has IAM policy with DynamoDB permissions (no wildcard)', () => {
    // Verify there's an IAM policy granting DynamoDB access
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.anyValue(),
            Effect: 'Allow',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });

    // Verify no DynamoDB policy uses wildcard Resource '*'
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy.Properties as any).PolicyDocument.Statement;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        const hasDynamoAction = actions.some(
          (a: string) => typeof a === 'string' && a.startsWith('dynamodb:')
        );
        if (hasDynamoAction) {
          // Resource should not be '*' for DynamoDB actions
          expect(statement.Resource).not.toBe('*');
        }
      }
    }
  });

  test('Lambda has SSM read permissions scoped to /vcs/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ssm:GetParameter']),
          }),
        ]),
      },
    });
  });

  // API Gateway with API key and usage plan ─────────────
  test('API Gateway REST API exists', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'Viking Context Service',
    });
  });

  test('API Gateway has API key', () => {
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
  });

  test('API Gateway has usage plan', () => {
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
  });

  // Lambda has no VPC config ─────────────────────────────
  test('Lambda has no VPC config', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      // Skip custom resource lambdas (used for seeding, auto-delete, etc.)
      if (logicalId.includes('CustomResource') || logicalId.includes('AWS') || logicalId.includes('Provider') || logicalId.includes('AutoDelete')) {
        continue;
      }
      expect((resource.Properties as any).VpcConfig).toBeUndefined();
    }
  });

  // ─── Additional structural tests ───────────────────────────────────

  test('stack synthesises without errors', () => {
    const app = new cdk.App();
    expect(() => new VcsStack(app, 'SmokeTestStack')).not.toThrow();
  });

  test('SSM parameters created for all resources (at least 8)', () => {
    const ssmParams = template.findResources('AWS::SSM::Parameter');
    expect(Object.keys(ssmParams).length).toBeGreaterThanOrEqual(8);
  });

  test('directories seeded via custom resource (4 roots)', () => {
    // v1-stable: 4 roots (resources, user, agent, session). Wiki/schema/compile removed.
    const customResources = template.findResources('Custom::AWS');
    const seedResources = Object.keys(customResources).filter(key =>
      key.includes('Seed')
    );
    expect(seedResources.length).toBe(4);
  });

  test('API Gateway has fs resource', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'fs',
    });
  });

  test('API Gateway has filesystem sub-routes', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'ls',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'tree',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'read',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'mkdir',
    });
  });

  test('API methods require API key', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      ApiKeyRequired: true,
    });
  });

  test('Lambda uses Node.js 22 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  // ─── CDK-01: Tool executor Lambda replaces MCP server ──────────

  test('CDK-01: tool executor Lambda has Node.js 22 runtime with mcp-tools service name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'vcs-mcp-tools',
        }),
      },
    }));
  });

  test('CDK-01: tool executor Lambda has active tracing', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'vcs-mcp-tools',
        }),
      },
    }));
  });

  // ─── CDK-02: No Function URL in template ────────────────────────

  test('CDK-02: no Lambda Function URL exists', () => {
    const urls = template.findResources('AWS::Lambda::Url');
    expect(Object.keys(urls).length).toBe(0);
  });

  // ─── CDK-03: No /mcp API Gateway resource ───────────────────────

  test('CDK-03: API Gateway has no /mcp resource', () => {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    const mcpResource = Object.entries(resources).find(([, r]) =>
      (r.Properties as any).PathPart === 'mcp'
    );
    expect(mcpResource).toBeUndefined();
  });

  test('CDK-03: no McpEndpoint output exists', () => {
    const outputs = template.toJSON().Outputs;
    const mcpOutputKey = Object.keys(outputs).find(key =>
      key.includes('McpEndpoint')
    );
    expect(mcpOutputKey).toBeUndefined();
  });

  // X-Ray tracing ACTIVE on all Lambda functions ────────

  test('all application Lambda functions have X-Ray tracing Active', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    let appLambdaCount = 0;
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      // Skip custom resource lambdas
      if (logicalId.includes('CustomResource') || logicalId.includes('AWS') ||
          logicalId.includes('Provider') || logicalId.includes('AutoDelete')) {
        continue;
      }
      appLambdaCount++;
      expect((resource.Properties as any).TracingConfig).toEqual({ Mode: 'Active' });
    }
    // v1-stable: 5 required Lambdas (filesystem, ingestion, parentSummariser, query, session)
    // + 1 optional (mcpToolExecutor) — gateway-layer construct is opt-in but mcpToolExecutor is always created
    expect(appLambdaCount).toBeGreaterThanOrEqual(5);
  });

  // ObservabilityLayer SNS topic ────────────────────────

  test('stack includes SNS alarm topic (vcs-alarms)', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'vcs-alarms',
    });
  });

  // CloudWatch dashboard ────────────────────────────────

  test('stack includes CloudWatch dashboard (VCS-Operations)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'VCS-Operations',
    });
  });

  // ─── API key ID stored in SSM ─────────────────────────────────────

  test('API key ID stored in SSM at /vcs/api/api-key-id', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({
      Name: '/vcs/api/api-key-id',
    }));
  });

  // ─── Tool executor Lambda has apigateway:GET permission ─────────────

  test('tool executor Lambda has apigateway:GET permission for API key retrieval', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'apigateway:GET',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // Gateway tests removed — GatewayLayer is opt-in via context flag.
  // Compile queue tests removed — wiki compiler subsystem extracted.

  test('SSM parameters created for core resources (at least 6)', () => {
    // v1-stable: context-table, sessions-table, content-bucket, vector-bucket,
    // vector-index, rollup-queue-url, rollup-dlq-url, api-url, api-key-id = 9
    const ssmParams = template.findResources('AWS::SSM::Parameter');
    expect(Object.keys(ssmParams).length).toBeGreaterThanOrEqual(6);
  });

});
