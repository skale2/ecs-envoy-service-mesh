import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface MeshRegistryEntryProps {
  /** ARN of the mesh's shared custom-resource provider. */
  serviceToken: string;
  /** Registry table name. */
  tableName: string;
  /** Service name. May be a CloudFormation token. */
  serviceName: string;
  /** Application port, as a string. May be a CloudFormation token. */
  port: string;
}

/**
 * One row in the mesh service registry, expressed as a CloudFormation
 * resource so the stack that owns the service owns its registration.
 *
 * Nothing routes to a service until its row exists, and the row disappears
 * when the stack does — which is why this is a resource rather than an API
 * call made alongside the deploy.
 *
 * Both entrypoints use this: the `MeshService` construct creates one in the
 * mesh stack, and the per-service template creates one in its own stack. The
 * per-service template carries no assets, so it cannot define a provider of
 * its own; it reuses the mesh stack's by ARN. `serviceName` and `port` are
 * therefore sometimes concrete and sometimes CloudFormation parameters —
 * `toJsonString` renders both, emitting Fn::Join where a token needs it.
 */
export class MeshRegistryEntry extends Construct {
  public readonly resource: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: MeshRegistryEntryProps) {
    super(scope, id);

    const key = { name: { S: props.serviceName } };
    const sdkCall = (action: string, parameters: object) =>
      cdk.Stack.of(this).toJsonString({
        service: 'DynamoDB',
        action,
        parameters,
        physicalResourceId: { id: props.serviceName },
      });

    const put = sdkCall('putItem', {
      TableName: props.tableName,
      Item: { ...key, port: { N: props.port } },
    });

    this.resource = new cdk.CfnResource(this, 'Resource', {
      type: 'Custom::MeshRegistryEntry',
      properties: {
        ServiceToken: props.serviceToken,
        // Create and Update are the same PutItem: the row is keyed by name,
        // so re-putting it is how a changed port lands.
        Create: put,
        Update: put,
        Delete: sdkCall('deleteItem', { TableName: props.tableName, Key: key }),
        InstallLatestAwsSdk: false,
      },
    });
  }
}
