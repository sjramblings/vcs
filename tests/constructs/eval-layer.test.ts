import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VcsEvalStack } from '../../lib/vcs-eval-stack';

describe('EvalLayer Canaries', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VcsEvalStack(app, 'TestEvalStack', {
      env: { account: '123456789012', region: 'ap-southeast-2' },
    });
    template = Template.fromStack(stack);
  });

  // ─── Canary resource count ─────────────────────────────────────

  it('creates 3 synthetics canaries', () => {
    template.resourceCountIs('AWS::Synthetics::Canary', 3);
  });

  // ─── Schedule assertions ───────────────────────────────────────

  it('health canary runs every 5 minutes', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-health',
      Schedule: Match.objectLike({
        Expression: 'rate(5 minutes)',
      }),
    });
  });

  it('ISR canary runs every 15 minutes', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-isr',
      Schedule: Match.objectLike({
        Expression: 'rate(15 minutes)',
      }),
    });
  });

  it('session canary runs every 30 minutes', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-session',
      Schedule: Match.objectLike({
        Expression: 'rate(30 minutes)',
      }),
    });
  });

  // ─── Runtime assertions ────────────────────────────────────────

  it('all canaries use puppeteer 13.0 runtime', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-health',
      RuntimeVersion: 'syn-nodejs-puppeteer-13.0',
    });
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-isr',
      RuntimeVersion: 'syn-nodejs-puppeteer-13.0',
    });
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'vcs-session',
      RuntimeVersion: 'syn-nodejs-puppeteer-13.0',
    });
  });

  // ─── Alarm assertions ─────────────────────────────────────────

  it('creates CloudWatch alarm for health canary with 3 evaluation periods', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'vcs-canary-health',
      EvaluationPeriods: 3,
      Threshold: 100,
      ComparisonOperator: 'LessThanThreshold',
    });
  });

  it('creates CloudWatch alarm for ISR canary with 2 evaluation periods', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'vcs-canary-isr',
      EvaluationPeriods: 2,
      Threshold: 100,
      ComparisonOperator: 'LessThanThreshold',
    });
  });

  it('creates CloudWatch alarm for session canary with 2 evaluation periods', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'vcs-canary-session',
      EvaluationPeriods: 2,
      Threshold: 100,
      ComparisonOperator: 'LessThanThreshold',
    });
  });
});
