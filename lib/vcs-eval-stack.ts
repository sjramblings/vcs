import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EvalLayer } from './constructs/eval-layer';
import { SyntheticsLayer } from './constructs/synthetics-layer';

export class VcsEvalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vcsApiUrlParam = '/vcs/api/rest-api-url';
    const vcsApiKeyParam = '/vcs/api/api-key-id';

    new EvalLayer(this, 'EvalLayer', {
      vcsApiUrlParam,
      vcsApiKeyParam,
      sourceRepo: 'sjramblings/vcs',
      sourceBranch: 'main',
    });

    new SyntheticsLayer(this, 'SyntheticsLayer', {
      vcsApiUrlParam,
      vcsApiKeyParam,
    });
  }
}
