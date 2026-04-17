import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DataLayer } from './constructs/data-layer';
import { ComputeLayer } from './constructs/compute-layer';
import { ApiLayer } from './constructs/api-layer';
import { ObservabilityLayer } from './constructs/observability-layer';
import { GatewayLayer } from './constructs/gateway-layer';

export class VcsStack extends cdk.Stack {
  public readonly dataLayer: DataLayer;
  public readonly computeLayer: ComputeLayer;
  public readonly apiLayer: ApiLayer;
  public readonly gatewayLayer?: GatewayLayer;
  public readonly observabilityLayer: ObservabilityLayer;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.dataLayer = new DataLayer(this, 'DataLayer');
    this.computeLayer = new ComputeLayer(this, 'ComputeLayer', {
      dataLayer: this.dataLayer,
    });
    this.apiLayer = new ApiLayer(this, 'ApiLayer', { computeLayer: this.computeLayer });

    // NOTE: MCP Lambda reads API_URL from SSM (/vcs/api/rest-api-url) at cold start
    // to avoid cyclic dependency between ComputeLayer and ApiLayer.

    // AgentCore Gateway with tool schemas — opt-in only.
    // Deploy with: cdk deploy VcsStack -c useAgentCoreGateway=true
    // Default v1-stable deployment is REST-only; agents hit the API
    // Gateway directly with an API key.
    if (this.node.tryGetContext('useAgentCoreGateway') === 'true') {
      this.gatewayLayer = new GatewayLayer(this, 'GatewayLayer', {
        toolExecutorFn: this.computeLayer.mcpToolExecutorFn,
      });
    }

    // Observability: dashboard, alarms, SNS notifications
    this.observabilityLayer = new ObservabilityLayer(this, 'ObservabilityLayer', {
      lambdaFunctions: {
        filesystem: this.computeLayer.filesystemFn,
        ingestion: this.computeLayer.ingestionFn,
        parentSummariser: this.computeLayer.parentSummariserFn,
        query: this.computeLayer.queryFn,
        session: this.computeLayer.sessionFn,
      },
      contextTable: this.dataLayer.contextTable,
      sessionsTable: this.dataLayer.sessionsTable,
      rollupQueue: this.dataLayer.rollupQueue,
      rollupDlq: this.dataLayer.rollupDlq,
    });
  }
}
