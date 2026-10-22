import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * The shared mesh infrastructure a service needs, field by field.
 *
 * This list is the only place it is written down. The `MeshRef` type, the
 * mesh stack's CloudFormation exports, and the per-service template's
 * imports are all derived from it, so adding a field is a one-line change
 * and the two sides cannot drift apart.
 */
export const MESH_REF_FIELDS = [
  'clusterName',       // ECS cluster name
  'taskSgId',          // security group for awsvpc tasks
  'privateSubnets',    // comma-separated private subnet IDs
  'executionRoleArn',  // task execution role (image pull, log creation)
  'taskRoleArn',       // task role (xDS reads, SSM, CloudWatch)
  'xdsBucket',         // bucket holding generated Envoy config
  'hostedZoneId',      // private zone serving {service}.{meshDomain}
  'meshDomain',        // e.g. "demo.mesh"
  'nlbDns',            // edge proxy NLB, for the service's alias record
  'nlbHostedZoneId',   // edge proxy NLB canonical zone, for the same record
  'namespaceId',       // AWS Cloud Map namespace tasks register in
  'envoyImageUri',     // Envoy sidecar image
  'registryTable',     // service registry table
  'registryWriterArn', // custom-resource provider that writes registry rows
] as const;

/**
 * Plain strings rather than CDK objects is what lets one `MeshService`
 * construct serve both entrypoints. In the CDK app these come off the live
 * `Mesh`; in the per-service template they are `Fn::ImportValue` tokens.
 * Neither the construct nor the resources it creates can tell the
 * difference, so there is one definition of a mesh service, not one per
 * entrypoint.
 */
export type MeshRef = { [K in typeof MESH_REF_FIELDS[number]]: string };

/** SSM parameter path for one field, e.g. "/demo-mesh/clusterName". */
export function meshRefParameterName(prefix: string, field: string): string {
  return `/${prefix}-mesh/${field}`;
}

/**
 * A MeshRef read from SSM Parameter Store at deploy time.
 *
 * Parameter Store rather than CloudFormation exports, because an export that
 * someone imports is frozen: CloudFormation refuses to change its value, or
 * to delete the stack that declares it, while any consumer exists. Every
 * service created through the API is such a consumer, so with exports the
 * mesh stack becomes un-updatable as soon as anyone uses it — and
 * `envoyImageUri` changes every time the sidecar image is rebuilt.
 *
 * SSM has no such coupling. Each stack reads the current value when it
 * deploys and the mesh stack stays independently deployable.
 */
export function meshRefFromSsm(scope: Construct, prefix: string): MeshRef {
  return Object.fromEntries(
    MESH_REF_FIELDS.map(field => {
      const path = meshRefParameterName(prefix, field);
      const param = new cdk.CfnParameter(scope, `Mesh${field}`, {
        type: 'AWS::SSM::Parameter::Value<String>',
        default: path,
        description: `Resolved from SSM parameter ${path}`,
      });
      return [field, param.valueAsString];
    }),
  ) as MeshRef;
}
