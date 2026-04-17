#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VcsEvalStack } from '../lib/vcs-eval-stack';

// Separate CDK app entry for the evaluation harness. Not instantiated by the
// default `cdk deploy VcsStack` so eval infrastructure never lands in the
// customer stack. Deploy with:
//
//   cdk deploy VcsEvalStack --app 'npx ts-node bin/vcs-eval.ts'
//
// Requires VcsStack outputs (API URL + API key ID) to already exist in SSM.

const app = new cdk.App();
new VcsEvalStack(app, 'VcsEvalStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
});
