import * as cdk from 'aws-cdk-lib';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export interface SyntheticsLayerProps {
  /** SSM parameter path for the VCS API URL */
  vcsApiUrlParam: string;
  /** SSM parameter path for the VCS API key ID */
  vcsApiKeyParam: string;
}

export class SyntheticsLayer extends Construct {
  constructor(scope: Construct, id: string, props: SyntheticsLayerProps) {
    super(scope, id);

    const canariesDir = path.join(__dirname, '..', '..', 'tests', 'canaries');

    const canaryEnv = {
      VCS_API_URL_PARAM: props.vcsApiUrlParam,
      VCS_API_KEY_PARAM: props.vcsApiKeyParam,
    };

    // --- Health Canary (every 5 minutes) ---
    const healthCanary = new synthetics.Canary(this, 'HealthCanary', {
      canaryName: 'vcs-health',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(canariesDir),
        handler: 'health-canary.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
      environmentVariables: canaryEnv,
      startAfterCreation: true,
      provisionedResourceCleanup: true,
    });

    // Health alarm: 3 consecutive failures
    new cloudwatch.Alarm(this, 'HealthAlarm', {
      alarmName: 'vcs-canary-health',
      alarmDescription: 'VCS health canary failed 3 consecutive times',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: 'vcs-health' },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // --- ISR Canary (every 15 minutes) ---
    const isrCanary = new synthetics.Canary(this, 'IsrCanary', {
      canaryName: 'vcs-isr',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(canariesDir),
        handler: 'isr-canary.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(15)),
      environmentVariables: canaryEnv,
      startAfterCreation: true,
      timeout: cdk.Duration.minutes(5),
      provisionedResourceCleanup: true,
    });

    // ISR alarm: 2 consecutive failures
    new cloudwatch.Alarm(this, 'IsrAlarm', {
      alarmName: 'vcs-canary-isr',
      alarmDescription: 'VCS ISR canary failed 2 consecutive times',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: 'vcs-isr' },
        statistic: 'Average',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // --- Session Canary (every 30 minutes) ---
    const sessionCanary = new synthetics.Canary(this, 'SessionCanary', {
      canaryName: 'vcs-session',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(canariesDir),
        handler: 'session-canary.handler',
      }),
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(30)),
      environmentVariables: canaryEnv,
      startAfterCreation: true,
      timeout: cdk.Duration.minutes(5),
      provisionedResourceCleanup: true,
    });

    // Session alarm: 2 consecutive failures
    new cloudwatch.Alarm(this, 'SessionAlarm', {
      alarmName: 'vcs-canary-session',
      alarmDescription: 'VCS session lifecycle canary failed 2 consecutive times',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: 'vcs-session' },
        statistic: 'Average',
        period: cdk.Duration.minutes(30),
      }),
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // Grant SSM parameter read + API Gateway key resolution to all canary roles
    const canaryPolicy = new iam.PolicyStatement({
      actions: [
        'ssm:GetParameters',
        'ssm:GetParameter',
        'apigateway:GET',
      ],
      resources: [
        `arn:aws:ssm:*:${cdk.Stack.of(this).account}:parameter/vcs/*`,
        `arn:aws:apigateway:*::/apikeys/*`,
      ],
    });

    [healthCanary, isrCanary, sessionCanary].forEach((canary) => {
      canary.role.addToPrincipalPolicy(canaryPolicy);
    });
  }
}
