import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsEvalStack } from '../../lib/vcs-eval-stack';

describe('VcsEvalStack CDK Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VcsEvalStack(app, 'TestEvalStack', {
      env: { account: '123456789012', region: 'ap-southeast-2' },
    });
    template = Template.fromStack(stack);
  });

  // CodeBuild project ──────────────────────────────────

  test('CodeBuild project vcs-evaluation exists with SMALL compute', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'vcs-evaluation',
      Environment: Match.objectLike({
        ComputeType: 'BUILD_GENERAL1_SMALL',
      }),
    });
  });

  test('functional report group exists', () => {
    template.hasResourceProperties('AWS::CodeBuild::ReportGroup', {
      Name: 'vcs-eval-functional',
      Type: 'TEST',
    });
  });

  test('performance report group exists', () => {
    template.hasResourceProperties('AWS::CodeBuild::ReportGroup', {
      Name: 'vcs-eval-performance',
      Type: 'TEST',
    });
  });

  test('CodeBuild has SSM env vars for API URL and key', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({
            Name: 'VCS_API_URL',
            Type: 'PARAMETER_STORE',
          }),
          Match.objectLike({
            Name: 'VCS_API_KEY',
            Type: 'PARAMETER_STORE',
          }),
        ]),
      }),
    });
  });

  // EventBridge nightly schedule ───────────────────────

  test('EventBridge nightly rule at 16:00 UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'vcs-eval-nightly',
      ScheduleExpression: 'cron(0 16 * * ? *)',
    });
  });

  // ─── IAM policies ─────────────────────────────────────────────────

  test('IAM policy grants CloudWatch read', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['cloudwatch:GetMetricData']),
          }),
        ]),
      }),
    });
  });

  test('IAM policy grants API Gateway read for key resolution', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'apigateway:GET',
          }),
        ]),
      }),
    });
  });

  // ─── Stack synthesis ──────────────────────────────────────────────

  test('stack synthesises without errors and produces resources', () => {
    const resources = template.toJSON().Resources;
    expect(resources).toBeDefined();
    expect(Object.keys(resources).length).toBeGreaterThan(0);
  });
});
