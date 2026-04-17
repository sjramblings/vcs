import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsStack } from '../../lib/vcs-stack';

function getTemplate(): Template {
  const app = new cdk.App();
  const stack = new VcsStack(app, 'TestStack');
  return Template.fromStack(stack);
}

describe('CDK session infrastructure', () => {
  it('creates Session Lambda with 120-second timeout', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 120,
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'vcs-session',
        }),
      },
    });
  });

  it('Session Lambda has DynamoDB read/write on both tables', () => {
    const template = getTemplate();

    // Find the session Lambda's IAM policy with write actions
    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'dynamodb:BatchWriteItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*SessionHandler.*'),
          }),
        ]),
      },
    });

    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });

  it('Session Lambda has Bedrock InvokeModel permission', () => {
    const template = getTemplate();

    // Find policy attached to session handler with Bedrock action
    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'bedrock:InvokeModel',
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*SessionHandler.*'),
          }),
        ]),
      },
    });

    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });

  it('Session Lambda has S3 Vectors permissions (Put, Delete only)', () => {
    const template = getTemplate();

    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                's3vectors:PutVectors',
                's3vectors:DeleteVectors',
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*SessionHandler.*'),
          }),
        ]),
      },
    });

    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });

  it('Session Lambda has SQS send permission for rollup', () => {
    const template = getTemplate();

    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'sqs:SendMessage',
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*SessionHandler.*'),
          }),
        ]),
      },
    });

    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });

  it('API Gateway has POST method on /sessions resource', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*sessions(?!.*messages|.*used|.*commit|.*id).*'),
      }),
    });
  });

  it('API Gateway has POST method on /sessions/{id}/messages', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*messages.*'),
      }),
    });
  });

  it('API Gateway has DELETE method on /fs/rm resource', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'DELETE',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*rm.*'),
      }),
    });
  });

  it('API Gateway has POST method on /fs/mv resource', () => {
    const template = getTemplate();

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ResourceId: Match.objectLike({
        Ref: Match.stringLikeRegexp('.*mv.*'),
      }),
    });
  });

  it('Filesystem Lambda has S3 Vectors permissions for rm/mv operations', () => {
    const template = getTemplate();

    const resources = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                's3vectors:PutVectors',
                's3vectors:DeleteVectors',
                's3vectors:GetVectors',
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('.*FilesystemHandler.*'),
          }),
        ]),
      },
    });

    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });
});
