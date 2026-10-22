#!/usr/bin/env node
/**
 * Synthesizes the CloudFormation templates the service API deploys, into
 * service-api/, where the next CDK deploy uploads them. Run via
 * `npm run synth:templates` after changing either stack.
 *
 * The CDK metadata resource is dropped: it carries no mesh behaviour, and
 * the condition it depends on is noise in a template meant to be read.
 */
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceStack } from '../lib/service-stack';
import { LoadStack } from '../lib/load-stack';

const app = new cdk.App();
const templates = {
  'service-template.json': new ServiceStack(app, 'MeshServiceTemplate'),
  'load-template.json': new LoadStack(app, 'MeshLoadTemplate'),
};
const assembly = app.synth();

for (const [file, stack] of Object.entries(templates)) {
  const template = assembly.getStackByName(stack.stackName).template as Record<string, any>;
  delete template.Resources?.CDKMetadata;
  delete template.Conditions?.CDKMetadataAvailable;
  if (Object.keys(template.Conditions ?? {}).length === 0) delete template.Conditions;

  const out = path.join(__dirname, '..', '..', 'service-api', file);
  fs.writeFileSync(out, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`wrote service-api/${file}`);
}
