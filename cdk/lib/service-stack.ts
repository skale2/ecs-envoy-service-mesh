import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MeshService, meshRefFromSsm, DEFAULT_APP_PORT } from './mesh';

export interface ServiceStackProps extends cdk.StackProps {
  /** Envoy sidecar (the default) or an NLB in front; see MeshServiceProps. */
  proxy?: 'envoy' | 'nlb';
}

/**
 * The per-service CloudFormation template behind `POST /services`, in two
 * variants: Envoy-sidecar services, and NLB-fronted ones to compare against.
 *
 * Synthesized once at build time (`npm run synth:templates`); the
 * resulting service-template.json is what the service API's Lambda hands to
 * CreateStack. It therefore carries no CDK assets and needs no bootstrap:
 * per-service values arrive as stack parameters, and shared mesh
 * infrastructure is read from SSM Parameter Store.
 *
 * The resources themselves come from the same `MeshService` construct the
 * CDK app uses, so the two entrypoints cannot drift apart.
 */
export class ServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ServiceStackProps) {
    super(scope, id, {
      ...props,
      synthesizer: new cdk.BootstraplessSynthesizer(),
    });

    const prefix = 'demo';
    const mesh = meshRefFromSsm(this, prefix);

    const serviceName = new cdk.CfnParameter(this, 'ServiceName', {
      type: 'String',
      // Enforced by CloudFormation, which is also what makes the name safe to
      // interpolate into the registry row's JSON payload.
      allowedPattern: '[a-z][a-z0-9-]{1,30}',
      description: 'Logical mesh service name (DNS label)',
    });
    const imageUri = new cdk.CfnParameter(this, 'ImageUri', {
      type: 'String',
      description: 'Container image URI for the application',
    });
    const appPort = new cdk.CfnParameter(this, 'AppPort', {
      type: 'Number', default: DEFAULT_APP_PORT, minValue: 1, maxValue: 65535,
    });
    // Changed in place by PATCH /services/{name}. 200 tasks is a third of the
    // fleet's ceiling (200 instances x 3 tasks), so one service can't take it all.
    const desiredCount = new cdk.CfnParameter(this, 'DesiredCount', {
      type: 'Number', default: 1, minValue: 0, maxValue: 200,
    });

    new MeshService(this, 'Service', {
      mesh,
      serviceName: serviceName.valueAsString,
      appImage: imageUri.valueAsString,
      appPort: appPort.valueAsNumber,
      desiredCount: desiredCount.valueAsNumber,
      proxy: props?.proxy,
    });

    new cdk.CfnOutput(this, 'ServiceHostname', {
      value: cdk.Fn.join('', [serviceName.valueAsString, '.', mesh.meshDomain]),
    });
  }
}
