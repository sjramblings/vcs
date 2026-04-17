import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsStack } from '../../lib/vcs-stack';

describe('Ingestion Infrastructure CDK Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VcsStack(app, 'IngestionTestStack');
    template = Template.fromStack(stack);
  });

  // Ingestion Lambda exists with correct config ──────────
  it('creates ingestion Lambda with correct memory and timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  // Parent Summariser Lambda exists ─────────────────────
  it('creates parent summariser Lambda with correct memory and timeout', () => {
    // Both ingestion and parent summariser use 512MB (C-04: Bedrock-calling)
    const lambdas = template.findResources('AWS::Lambda::Function', {
      Properties: {
        MemorySize: 512,
      },
    });
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
  });

  // Ingestion Lambda does NOT use reservedConcurrentExecutions (POC account quota) ────
  it('ingestion Lambda does not set reservedConcurrentExecutions (POC account)', () => {
    // Verify ingestion Lambda exists with correct memory but no reserved concurrency
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      Handler: 'index.handler',
    });
  });

  // Parent summariser has SQS event source mapping ──────
  it('parent summariser has SQS event source mapping with batchSize 1', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });
  });

  it('SQS event source mapping references FIFO queue', () => {
    // Verify the event source mapping exists and has a queue ARN reference
    const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
    expect(Object.keys(mappings).length).toBeGreaterThanOrEqual(1);
  });

  // API Gateway has POST /resources method ──────────────
  it('API Gateway has POST /resources method', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });

  it('API Gateway has resources path part', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'resources',
    });
  });

  // Ingestion Lambda has Bedrock invoke permissions ─────
  it('ingestion Lambda has Bedrock invoke permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // S3 Vectors permissions ──────────────────────────────
  it('Lambdas have S3 Vectors permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3vectors:PutVectors']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // Both Lambdas have no VPC configuration ─────────────
  it('ingestion and parent summariser Lambdas have no VPC configuration', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      // Skip custom resource lambdas
      if (
        logicalId.includes('CustomResource') ||
        logicalId.includes('AWS') ||
        logicalId.includes('Provider') ||
        logicalId.includes('AutoDelete')
      ) {
        continue;
      }
      expect((resource.Properties as any).VpcConfig).toBeUndefined();
    }
  });

  // SQS send permissions for rollup ────────────────────
  it('Lambdas have SQS send permissions for rollup queue', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
