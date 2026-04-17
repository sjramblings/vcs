#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VcsStack } from '../lib/vcs-stack';

const app = new cdk.App();
new VcsStack(app, 'VcsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
});
