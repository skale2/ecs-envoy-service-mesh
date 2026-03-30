import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { Construct } from 'constructs';

import { Mesh } from './constructs/mesh';
import { MeshService } from './constructs/mesh-service';

/**
 * Demo stack: deploys an Envoy service mesh on ECS EC2 with two sample
 * services (predict + features) that call each other through the mesh,
 * plus a bastion host for testing from outside the mesh.
 */
export class EnvoyMeshStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const projectRoot = path.join(__dirname, '..', '..');
    const prefix = 'demo';

    // -------------------------------------------------------
    // VPC
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'MeshVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // -------------------------------------------------------
    // Mesh (cluster, control plane, edge proxy)
    // -------------------------------------------------------
    const mesh = new Mesh(this, 'Mesh', {
      vpc,
      prefix,
      envoySidecarDir: path.join(projectRoot, 'envoy-sidecar'),
    });

    // -------------------------------------------------------
    // Mesh Services
    // -------------------------------------------------------
    const serviceImage = new ecr_assets.DockerImageAsset(this, 'ServiceImage', {
      directory: path.join(projectRoot, 'sample-services', 'service'),
    });

    new MeshService(this, 'Predict', {
      mesh,
      serviceName: 'predict',
      appImage: serviceImage,
      dependencies: ['features'],
    });

    new MeshService(this, 'Features', {
      mesh,
      serviceName: 'features',
      appImage: serviceImage,
      dependencies: ['predict'],
    });

    // -------------------------------------------------------
    // Bastion host for testing the mesh from outside
    // -------------------------------------------------------
    const bastion = new ec2.Instance(this, 'Bastion', {
      vpc,
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ssmSessionPermissions: true,
      instanceName: `${prefix}-mesh-bastion`,
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value: bastion.instanceId,
      description: 'Bastion instance ID (use with `aws ssm start-session`)',
    });
  }
}
