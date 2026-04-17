import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsStack } from '../../lib/vcs-stack';

function getTemplate(): Template {
  const app = new cdk.App();
  const stack = new VcsStack(app, 'TestStack');
  return Template.fromStack(stack);
}

describe('CDK retrieval infrastructure', () => {
  it('creates Query Lambda with Node.js 22 runtime', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'vcs-query',
        }),
      },
    });
  });

  it('Query Lambda has no VPC config', () => {
    const template = getTemplate();

    // Find all Lambda functions with vcs-query service name
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            POWERTOOLS_SERVICE_NAME: 'vcs-query',
          }),
        },
      },
    });

    // Verify none of them have VpcConfig
    for (const [, resource] of Object.entries(resources)) {
      expect((resource as Record<string, unknown>).Properties).not.toHaveProperty('VpcConfig');
    }
  });

  it('Query Lambda has DynamoDB read permissions on both tables', () => {
    const template = getTemplate();

    // Find the query Lambda's IAM policy -- it should have read-only actions
    // grantReadData grants: BatchGetItem, GetRecords, GetShardIterator, Query, GetItem, Scan, ConditionCheckItem, DescribeTable
    // The key assertion: query Lambda has grantReadData (not grantReadWriteData) on both tables
    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'dynamodb:BatchGetItem',
                'dynamodb:GetItem',
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*QueryHandler.*'),
          }),
        ]),
      },
    });

    // Should find at least one policy for the query handler
    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);

    // Verify no write actions on query handler policy (read-only)
    for (const [, resource] of Object.entries(resources)) {
      const statements = (resource as any).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        if (Array.isArray(stmt.Action) && stmt.Action.includes('dynamodb:BatchGetItem')) {
          expect(stmt.Action).not.toContain('dynamodb:PutItem');
          expect(stmt.Action).not.toContain('dynamodb:UpdateItem');
          expect(stmt.Action).not.toContain('dynamodb:DeleteItem');
        }
      }
    }
  });

  it('Query Lambda has S3 Vectors QueryVectors AND GetVectors permissions', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              's3vectors:QueryVectors',
              's3vectors:GetVectors',
            ]),
          }),
        ]),
      },
    });
  });

  it('Query Lambda has Bedrock InvokeModel permission', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
          }),
        ]),
      },
    });
  });

  it('Query Lambda has SSM GetParameter/GetParameters permissions', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ssm:GetParameter',
              'ssm:GetParameters',
            ]),
          }),
        ]),
      },
    });
  });

  it('API Gateway has POST method on /search/find resource', () => {
    const template = getTemplate();

    // Verify API Gateway Method exists with POST
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*find.*'),
      }),
    });
  });

  it('API Gateway has POST method on /search/search resource', () => {
    const template = getTemplate();

    // Verify API Gateway Method exists with POST for search
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*search.*'),
      }),
    });
  });
});
