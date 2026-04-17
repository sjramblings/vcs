import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { aws_apigateway as apigw, aws_ssm as ssm } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ComputeLayer } from './compute-layer';

export interface ApiLayerProps {
  computeLayer: ComputeLayer;
}

export class ApiLayer extends Construct {
  public readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: ApiLayerProps) {
    super(scope, id);

    // API Gateway access logging
    const apiLogGroup = new LogGroup(this, 'ApiAccessLogs', {
      retention: RetentionDays.ONE_MONTH,
    });

    this.api = new apigw.RestApi(this, 'VcsApi', {
      restApiName: 'Viking Context Service',
      description: 'VCS REST API',
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigw.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
      defaultMethodOptions: { apiKeyRequired: true },
      defaultCorsPreflightOptions: {
        allowOrigins: [
          'http://localhost:3000',                    // Local development
          'http://localhost:5173',                    // Vite dev server
          'https://d2zoz9ifddco45.cloudfront.net',   // UAT
          'https://d13zrodgzf45sx.cloudfront.net',   // Production
        ],
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
      },
    });

    // API Key + Usage Plan
    const apiKey = this.api.addApiKey('VcsApiKey', { apiKeyName: 'vcs-api-key' });
    const usagePlan = this.api.addUsagePlan('VcsUsagePlan', {
      name: 'vcs-usage-plan',
      throttle: { rateLimit: 50, burstLimit: 100 },
      quota: { limit: 10000, period: apigw.Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    // Filesystem routes
    const fsIntegration = new apigw.LambdaIntegration(props.computeLayer.filesystemFn);
    const fs = this.api.root.addResource('fs');
    const ls = fs.addResource('ls');
    ls.addMethod('GET', fsIntegration);

    const tree = fs.addResource('tree');
    tree.addMethod('GET', fsIntegration);

    const read = fs.addResource('read');
    read.addMethod('GET', fsIntegration);

    const mkdir = fs.addResource('mkdir');
    mkdir.addMethod('POST', fsIntegration);

    // Ingestion route: POST /resources
    const resources = this.api.root.addResource('resources');
    resources.addMethod('POST', new apigw.LambdaIntegration(props.computeLayer.ingestionFn));

    // Search routes
    const queryIntegration = new apigw.LambdaIntegration(props.computeLayer.queryFn);
    const search = this.api.root.addResource('search');
    const find = search.addResource('find');
    find.addMethod('POST', queryIntegration);
    const searchEndpoint = search.addResource('search');
    searchEndpoint.addMethod('POST', queryIntegration);

    // Filesystem mutation routes (rm/mv use existing fsIntegration)
    const rm = fs.addResource('rm');
    rm.addMethod('DELETE', fsIntegration);

    const mv = fs.addResource('mv');
    mv.addMethod('POST', fsIntegration);

    // Session routes
    const sessionIntegration = new apigw.LambdaIntegration(props.computeLayer.sessionFn);
    const sessions = this.api.root.addResource('sessions');
    sessions.addMethod('POST', sessionIntegration); // POST /sessions (create)

    const sessionById = sessions.addResource('{id}');
    sessionById.addMethod('DELETE', sessionIntegration); // DELETE /sessions/{id}

    const sessionMessages = sessionById.addResource('messages');
    sessionMessages.addMethod('POST', sessionIntegration); // POST /sessions/{id}/messages

    const sessionUsed = sessionById.addResource('used');
    sessionUsed.addMethod('POST', sessionIntegration); // POST /sessions/{id}/used

    const sessionCommit = sessionById.addResource('commit');
    sessionCommit.addMethod('POST', sessionIntegration); // POST /sessions/{id}/commit

    // SSM parameter for API URL
    new cdk.aws_ssm.StringParameter(this, 'ApiUrl', {
      parameterName: '/vcs/api/rest-api-url',
      stringValue: this.api.url,
    });

    // SSM parameter for API key ID (MCP Lambda retrieves key value at runtime via apigateway:GET)
    new ssm.StringParameter(this, 'ApiKeyIdParam', {
      parameterName: '/vcs/api/api-key-id',
      stringValue: apiKey.keyId,
    });

    // Output API URL + API Key ID
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
  }
}
