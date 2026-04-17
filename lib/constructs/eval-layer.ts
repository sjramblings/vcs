import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface EvalLayerProps {
  vcsApiUrlParam: string;
  vcsApiKeyParam: string;
  sourceRepo: string;
  sourceBranch: string;
}

export class EvalLayer extends Construct {
  constructor(scope: Construct, id: string, props: EvalLayerProps) {
    super(scope, id);

    // Report groups — one per test suite for granular tracking
    const functionalReports = new codebuild.ReportGroup(this, 'FunctionalReports', {
      reportGroupName: 'vcs-eval-functional',
      type: codebuild.ReportGroupType.TEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const performanceReports = new codebuild.ReportGroup(this, 'PerformanceReports', {
      reportGroupName: 'vcs-eval-performance',
      type: codebuild.ReportGroupType.TEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CodeBuild project
    const project = new codebuild.Project(this, 'EvalProject', {
      projectName: 'vcs-evaluation',
      description: 'VCS functional + performance evaluation with JUnit reporting',

      source: codebuild.Source.gitHub({
        owner: props.sourceRepo.split('/')[0],
        repo: props.sourceRepo.split('/')[1],
        branchOrRef: props.sourceBranch,
      }),

      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Ubuntu — supports apt-get for k6
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },

      environmentVariables: {
        VCS_API_URL: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: props.vcsApiUrlParam,
        },
        VCS_API_KEY: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: props.vcsApiKeyParam,
        },
      },

      buildSpec: codebuild.BuildSpec.fromSourceFilename('tests/eval/buildspec.yml'),
      timeout: cdk.Duration.minutes(30),
    });

    // Grant report group write access
    functionalReports.grantWrite(project);
    performanceReports.grantWrite(project);

    // Grant SSM parameter read
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:*:${cdk.Stack.of(this).account}:parameter/vcs/*`,
      ],
    }));

    // Grant CloudWatch read for post-test metric collection
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
      resources: ['*'],
    }));

    // Grant API Gateway read for API key value resolution in pre_build
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [
        `arn:aws:apigateway:*::/apikeys/*`,
      ],
    }));

    // Nightly schedule — 2am AEST (16:00 UTC)
    const nightlyRule = new events.Rule(this, 'NightlyEval', {
      ruleName: 'vcs-eval-nightly',
      schedule: events.Schedule.cron({ minute: '0', hour: '16' }),
    });
    nightlyRule.addTarget(new targets.CodeBuildProject(project));
  }
}
