import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsStack } from '../../lib/vcs-stack';

describe('CORS Configuration', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VcsStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  test('INFR-01: API Gateway has OPTIONS methods for CORS preflight', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
      ApiKeyRequired: false,
    });
  });

  test('INFR-01: OPTIONS response includes Access-Control-Allow-Origin', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      MethodResponses: Match.arrayWith([
        Match.objectLike({
          ResponseParameters: Match.objectLike({
            'method.response.header.Access-Control-Allow-Origin': true,
          }),
        }),
      ]),
    });
  });
});
