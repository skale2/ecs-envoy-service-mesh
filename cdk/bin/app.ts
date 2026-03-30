#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EnvoyMeshStack } from '../lib/mesh-stack';

const app = new cdk.App();
new EnvoyMeshStack(app, 'DemoEnvoyServiceMesh', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
