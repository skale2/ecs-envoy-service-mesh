import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';

/**
 * Shared mesh infrastructure passed to MeshService, MeshEdgeProxy, etc.
 */
export interface MeshConfig {
  cluster: ecs.ICluster;
  namespace: servicediscovery.INamespace;
  hostedZone: route53.IHostedZone;
  /** The mesh DNS domain, e.g. "demo.mesh". Services are addressed as {name}.{meshDomain}. */
  meshDomain: string;
  taskSecurityGroup: ec2.ISecurityGroup;
  executionRole: iam.IRole;
  envoyTaskRole: iam.IRole;
  xdsBucket: s3.IBucket;
  envoySidecarImage: ecr_assets.DockerImageAsset;
}
