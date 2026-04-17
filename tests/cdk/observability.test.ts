import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataLayer } from '../../lib/constructs/data-layer';
import { ComputeLayer } from '../../lib/constructs/compute-layer';
import { ObservabilityLayer } from '../../lib/constructs/observability-layer';

describe('ObservabilityLayer CDK Assertions', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestObservabilityStack');

    const dataLayer = new DataLayer(stack, 'DataLayer');
    const computeLayer = new ComputeLayer(stack, 'ComputeLayer', {
      dataLayer,
      memoryPayloadTopic: dataLayer.memoryPayloadTopic,
      memoryBridgeDlq: dataLayer.memoryBridgeDlq,
      memoryArn: dataLayer.memoryArn,
    });

    new ObservabilityLayer(stack, 'ObservabilityLayer', {
      lambdaFunctions: {
        filesystem: computeLayer.filesystemFn,
        ingestion: computeLayer.ingestionFn,
        parentSummariser: computeLayer.parentSummariserFn,
        query: computeLayer.queryFn,
        session: computeLayer.sessionFn,
        memoryBridge: computeLayer.memoryBridgeFn,
      },
      contextTable: dataLayer.contextTable,
      sessionsTable: dataLayer.sessionsTable,
      rollupQueue: dataLayer.rollupQueue,
      rollupDlq: dataLayer.rollupDlq,
      memoryBridgeDlq: dataLayer.memoryBridgeDlq,
    });

    template = Template.fromStack(stack);
  });

  test('creates SNS topic for alarm notifications', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'vcs-alarms',
    });
  });

  test('creates DLQ depth alarm with threshold 0', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      Threshold: 0,
      AlarmDescription: Match.stringLikeRegexp('DLQ'),
    }));
  });

  test('creates Lambda error alarms for all application functions', () => {
    // v1-stable: 5 core + 1 mcp-tools = 6 (mcpToolExecutor always created even when Gateway is off)
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const errorAlarms = Object.entries(alarms).filter(([, resource]) => {
      const desc = (resource.Properties as Record<string, unknown>).AlarmDescription as string;
      return desc && desc.includes('errors detected');
    });
    expect(errorAlarms.length).toBe(6);
  });

  test('creates P99 ingestion latency alarm with 30s threshold', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      Threshold: 30000,
      AlarmDescription: Match.stringLikeRegexp('ingestion'),
    }));
  });

  test('creates P99 retrieval latency alarm with 2s threshold', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      Threshold: 2000,
      AlarmDescription: Match.stringLikeRegexp('retrieval'),
    }));
  });

  test('creates Bedrock cost alarm with $5 threshold', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      Threshold: 5,
      AlarmDescription: Match.stringLikeRegexp('Bedrock'),
    }));
  });

  test('creates CloudWatch dashboard', () => {
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'VCS-Operations',
    });
  });

  test('dashboard body contains all expected widget titles', () => {
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    const dashboardKeys = Object.keys(dashboards);
    expect(dashboardKeys.length).toBe(1);

    const dashboard = dashboards[dashboardKeys[0]];
    const bodyStr = JSON.stringify((dashboard.Properties as Record<string, unknown>).DashboardBody);

    expect(bodyStr).toContain('Lambda Errors');
    expect(bodyStr).toContain('Ingestion Rate');
    expect(bodyStr).toContain('Retrieval Latency');
    expect(bodyStr).toContain('DynamoDB Consumed Capacity');
    expect(bodyStr).toContain('SQS Queue Depth');
    expect(bodyStr).toContain('DLQ Messages');
    expect(bodyStr).toContain('Lambda Duration');
    expect(bodyStr).toContain('Lambda Invocations');
    expect(bodyStr).toContain('Session Commits');
  });

  test('dashboard body contains Bedrock widget titles', () => {
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    const dashboardKeys = Object.keys(dashboards);
    const dashboard = dashboards[dashboardKeys[0]];
    const bodyStr = JSON.stringify((dashboard.Properties as Record<string, unknown>).DashboardBody);

    expect(bodyStr).toContain('Bedrock Invocations');
    expect(bodyStr).toContain('Bedrock Latency');
    expect(bodyStr).toContain('Bedrock Token Counts');
    expect(bodyStr).toContain('Bedrock Errors + Throttles');
  });

  test('creates Bedrock error alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      AlarmDescription: Match.stringLikeRegexp('Bedrock.*server errors'),
    }));
  });

  test('creates Bedrock throttle alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      AlarmDescription: Match.stringLikeRegexp('Bedrock.*throttl'),
    }));
  });

  test('all alarms have SNS action', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const [, alarm] of Object.entries(alarms)) {
      const actions = (alarm.Properties as Record<string, unknown>).AlarmActions as unknown[];
      expect(actions).toBeDefined();
      expect(actions.length).toBeGreaterThan(0);
    }
  });
});
