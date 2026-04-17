import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cw_actions,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_dynamodb as dynamodb,
} from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getFastModelId, getStandardModelId, getTitanEmbedModelId } from '../config';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

export interface ObservabilityLayerProps {
  lambdaFunctions: {
    filesystem: NodejsFunction;
    ingestion: NodejsFunction;
    parentSummariser: NodejsFunction;
    query: NodejsFunction;
    session: NodejsFunction;
  };
  contextTable: dynamodb.Table;
  sessionsTable: dynamodb.Table;
  rollupQueue: sqs.Queue;
  rollupDlq: sqs.Queue;
}

export class ObservabilityLayer extends Construct {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityLayerProps) {
    super(scope, id);

    const { lambdaFunctions, contextTable, sessionsTable, rollupQueue, rollupDlq } = props;
    const allFunctions = [
      { name: 'Filesystem', fn: lambdaFunctions.filesystem },
      { name: 'Ingestion', fn: lambdaFunctions.ingestion },
      { name: 'ParentSummariser', fn: lambdaFunctions.parentSummariser },
      { name: 'Query', fn: lambdaFunctions.query },
      { name: 'Session', fn: lambdaFunctions.session },
    ];

    // ─── 1. SNS Topic for Alarm Notifications ─────────────────────────
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'vcs-alarms',
    });

    // Email subscription for alarm notifications (opt-in via CDK context)
    const alarmEmail = this.node.tryGetContext('alarmEmail');
    if (alarmEmail) {
      this.alarmTopic.addSubscription(
        new subscriptions.EmailSubscription(alarmEmail)
      );
    }

    // ─── 2. CloudWatch Alarms ─────────────────────────────────────────

    // 2a. DLQ Depth > 0 (critical)
    const dlqAlarm = new cw.Alarm(this, 'DlqDepthAlarm', {
      metric: rollupDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'DLQ has messages - failed rollups mean data loss',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // 2b. Lambda Errors > 0 (one alarm per function)
    for (const { name, fn } of allFunctions) {
      const alarm = new cw.Alarm(this, `${name}ErrorAlarm`, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda function errors detected`,
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
    }

    // 2c. P99 Ingestion > 30s
    const ingestionLatencyAlarm = new cw.Alarm(this, 'IngestionP99Alarm', {
      metric: lambdaFunctions.ingestion.metricDuration({
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 30000,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'P99 ingestion latency exceeds 30 seconds',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    ingestionLatencyAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // 2d. P99 Retrieval > 2s
    const retrievalLatencyAlarm = new cw.Alarm(this, 'RetrievalP99Alarm', {
      metric: lambdaFunctions.query.metricDuration({
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 2000,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'P99 retrieval latency exceeds 2 seconds',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    retrievalLatencyAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // 2e. Daily Bedrock Spend > $5
    // Note: Requires Lambdas to publish this custom metric via Powertools Metrics (future enhancement)
    const bedrockCostAlarm = new cw.Alarm(this, 'BedrockCostAlarm', {
      metric: new cw.Metric({
        namespace: 'VCS',
        metricName: 'BedrockEstimatedCostUSD',
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Daily Bedrock estimated spend exceeds $5',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    bedrockCostAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // 2f. Bedrock Server Errors > 0
    const bedrockErrorAlarm = new cw.Alarm(this, 'BedrockErrorAlarm', {
      metric: new cw.MathExpression({
        expression: 'm1 + m2 + m3',
        usingMetrics: {
          m1: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          m2: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          m3: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        },
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Bedrock model invocation server errors detected',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    bedrockErrorAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // 2g. Bedrock Throttles > 0
    const bedrockThrottleAlarm = new cw.Alarm(this, 'BedrockThrottleAlarm', {
      metric: new cw.MathExpression({
        expression: 'm1 + m2 + m3',
        usingMetrics: {
          m1: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          m2: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          m3: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        },
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Bedrock model throttling detected',
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    bedrockThrottleAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // ─── 3. CloudWatch Dashboard ──────────────────────────────────────
    // Single screen layout: 3 rows x 3 widgets, width=24, height=6 each

    // Row 1 - Lambda Health
    const lambdaErrorsWidget = new cw.GraphWidget({
      title: 'Lambda Errors',
      width: 8,
      height: 6,
      left: allFunctions.map(({ fn }) =>
        fn.metricErrors({ period: cdk.Duration.minutes(5) })
      ),
    });

    const lambdaDurationWidget = new cw.GraphWidget({
      title: 'Lambda Duration (P50/P99)',
      width: 8,
      height: 6,
      left: [
        lambdaFunctions.ingestion.metricDuration({ statistic: 'p50', period: cdk.Duration.minutes(5) }),
        lambdaFunctions.ingestion.metricDuration({ statistic: 'p99', period: cdk.Duration.minutes(5) }),
        lambdaFunctions.query.metricDuration({ statistic: 'p50', period: cdk.Duration.minutes(5) }),
        lambdaFunctions.query.metricDuration({ statistic: 'p99', period: cdk.Duration.minutes(5) }),
      ],
    });

    const lambdaInvocationsWidget = new cw.SingleValueWidget({
      title: 'Lambda Invocations',
      width: 8,
      height: 6,
      metrics: allFunctions.map(({ fn }) =>
        fn.metricInvocations({ period: cdk.Duration.minutes(5) })
      ),
    });

    // Row 2 - Ingestion + Retrieval
    const ingestionRateWidget = new cw.GraphWidget({
      title: 'Ingestion Rate',
      width: 8,
      height: 6,
      left: [
        lambdaFunctions.ingestion.metricInvocations({ period: cdk.Duration.minutes(5) }),
      ],
    });

    const retrievalLatencyWidget = new cw.GraphWidget({
      title: 'Retrieval Latency',
      width: 8,
      height: 6,
      left: [
        lambdaFunctions.query.metricDuration({ statistic: 'p50', period: cdk.Duration.minutes(5) }),
        lambdaFunctions.query.metricDuration({ statistic: 'p90', period: cdk.Duration.minutes(5) }),
        lambdaFunctions.query.metricDuration({ statistic: 'p99', period: cdk.Duration.minutes(5) }),
      ],
    });

    const sessionCommitsWidget = new cw.GraphWidget({
      title: 'Session Commits',
      width: 8,
      height: 6,
      left: [
        lambdaFunctions.session.metricInvocations({ period: cdk.Duration.minutes(5) }),
      ],
    });

    // Row 3 - Infrastructure
    const dynamoCapacityWidget = new cw.GraphWidget({
      title: 'DynamoDB Consumed Capacity',
      width: 8,
      height: 6,
      left: [
        contextTable.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5) }),
        contextTable.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(5) }),
        sessionsTable.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5) }),
        sessionsTable.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(5) }),
      ],
    });

    const sqsDepthWidget = new cw.GraphWidget({
      title: 'SQS Queue Depth',
      width: 8,
      height: 6,
      left: [
        rollupQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
        rollupDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      ],
    });

    const dlqMessagesWidget = new cw.SingleValueWidget({
      title: 'DLQ Messages',
      width: 8,
      height: 6,
      metrics: [
        rollupDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      ],
    });

    // Row 4 - Bedrock Model Metrics
    const bedrockInvocationsWidget = new cw.GraphWidget({
      title: 'Bedrock Invocations',
      width: 6,
      height: 6,
      left: [
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'Invocations', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'Invocations', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'Invocations', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      ],
    });

    const bedrockLatencyWidget = new cw.GraphWidget({
      title: 'Bedrock Latency',
      width: 6,
      height: 6,
      left: [
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationLatency', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'p50', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationLatency', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'p50', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationLatency', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'p50', period: cdk.Duration.minutes(5) }),
      ],
    });

    const bedrockTokensWidget = new cw.GraphWidget({
      title: 'Bedrock Token Counts',
      width: 6,
      height: 6,
      left: [
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InputTokenCount', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'OutputTokenCount', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InputTokenCount', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'OutputTokenCount', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      ],
    });

    const bedrockErrorsWidget = new cw.GraphWidget({
      title: 'Bedrock Errors + Throttles',
      width: 6,
      height: 6,
      left: [
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationServerErrors', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getFastModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getStandardModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'ThrottledCount', dimensionsMap: { ModelId: getTitanEmbedModelId() }, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      ],
    });

    new cw.Dashboard(this, 'VcsDashboard', {
      dashboardName: 'VCS-Operations',
      widgets: [
        // Row 1: Lambda Health
        [lambdaErrorsWidget, lambdaDurationWidget, lambdaInvocationsWidget],
        // Row 2: Ingestion + Retrieval
        [ingestionRateWidget, retrievalLatencyWidget, sessionCommitsWidget],
        // Row 3: Infrastructure
        [dynamoCapacityWidget, sqsDepthWidget, dlqMessagesWidget],
        // Row 4: Bedrock Model Metrics
        [bedrockInvocationsWidget, bedrockLatencyWidget, bedrockTokensWidget, bedrockErrorsWidget],
      ],
    });

    // NOTE: X-Ray tracing (lambda.Tracing.ACTIVE) must be set in compute-layer.ts
    // CDK automatically grants xray:PutTraceSegments when tracing is ACTIVE
  }
}
