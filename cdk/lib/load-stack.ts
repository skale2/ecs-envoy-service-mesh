import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MeshService, meshRefFromSsm, DEFAULT_APP_PORT } from './mesh';

/**
 * The CloudFormation template behind `POST /load/{target}`.
 *
 * A load test is a mesh service like any other: a Fortio load generator with
 * its own Envoy sidecar, so its requests take the same path as real traffic.
 * It holds the requested TPS against the target until the stack is deleted.
 *
 * Synthesized at build time like the service template, so it carries no
 * assets: per-test values arrive as parameters, shared mesh values from SSM.
 */
export class LoadStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, { ...props, synthesizer: new cdk.BootstraplessSynthesizer() });

    const param = (name: string, props: cdk.CfnParameterProps) =>
      new cdk.CfnParameter(this, name, props).valueAsString;
    const number = (name: string, max: number, fallback = 0) =>
      param(name, { type: 'Number', default: fallback, minValue: 0, maxValue: max });

    const target = param('Target', { type: 'String', allowedPattern: '[a-z][a-z0-9-]{1,30}' });

    new MeshService(this, 'Service', {
      mesh: meshRefFromSsm(this, 'demo'),
      serviceName: cdk.Fn.join('', [target, '-load']),
      appImage: param('ImageUri', { type: 'String' }),
      routable: false,
      appEnvironment: {
        LOAD_TARGET: target,
        TARGET_PORT: number('TargetPort', 65535, DEFAULT_APP_PORT),
        TPS: param('Tps', { type: 'Number', minValue: 1, maxValue: 20000 }),
        DELAY_MS: number('DelayMs', 10000),
        RESPONSE_BYTES: number('ResponseBytes', 262144),
        REQUEST_BYTES: number('RequestBytes', 262144),
        // Restricted to URL-path characters: it is interpolated into a URL
        // inside the load generator's shell script.
        LOAD_PATH: param('Path', { type: 'String', default: '/', allowedPattern: '/[A-Za-z0-9/._-]*' }),
      },
    });
  }
}
