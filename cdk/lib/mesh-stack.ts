import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { Construct } from 'constructs';

import { Mesh, MeshService } from './mesh';
import { MeshServiceApi } from './service-api/api';

/**
 * Demo stack: deploys an Envoy service mesh on ECS EC2 with two sample
 * services (predict + features) that call each other through the mesh,
 * plus a bastion host for testing from outside the mesh.
 */
export class ServiceMeshStack extends cdk.Stack {
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
        // /20, not /24. Every awsvpc task consumes a private IP for its own
        // ENI, so the subnet size — not CPU — is what caps how many services
        // the mesh can hold. /24 would run out at ~360 services; /20 gives
        // 4091 addresses per subnet, which puts the ceiling back on the
        // account's vCPU quota instead of on addressing.
        { cidrMask: 20, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // The two sample apps: "demo" is the Python app the services below run,
    // "perf" is Fortio, which serves as both perf target and load generator.
    // Declared before the Mesh so their layers can be warmed onto each
    // instance at boot along with the mesh's own images.
    const image = (app: string) => new ecr_assets.DockerImageAsset(this, `${app}Image`, {
      directory: path.join(projectRoot, 'sample-services', app),
    }).imageUri;
    const images = { demo: image('demo'), perf: image('perf') };
    // -------------------------------------------------------
    // Mesh (cluster, control plane, edge proxy)
    // -------------------------------------------------------
    const mesh = new Mesh(this, 'Mesh', {
      vpc,
      prefix,
      envoySidecarDir: path.join(projectRoot, 'envoy-sidecar'),
      // Capacity is bounded by ENIs, not CPU. Every task runs awsvpc, so
      // each needs its own ENI, and a t3.xlarge attaches 4 — one for the
      // host, leaving 3 tasks. CPU and memory are nowhere near binding: 3
      // tasks want ~1.7 of 4 vCPUs and ~2 of 16 GiB.
      //
      // So 3 services per instance. A fully packed instance consumes 4
      // private IPs — its own plus one per task ENI — which is why the
      // private subnets are /20: 8182 addresses across the two of them, so
      // addressing is not the limit. The binding limit is the account's
      // 1152 vCPU quota, i.e. 288 t3.xlarge, i.e. ~864 services.
      //
      // minCapacity is a bill, not a ceiling: 50 t3.xlarge is about $8/hour
      // whether or not anybody creates anything. It is set high so that
      // creating a service never waits for an instance to boot, which is
      // otherwise 2-4 minutes on the critical path. Drop it back to 2 when
      // not rehearsing.
      //
      // Fargate would delete this entire consideration, and is not available:
      // the sidecar needs NET_ADMIN to install iptables rules.
      instanceType: new ec2.InstanceType('t3.xlarge'),
      minCapacity: 50,
      maxCapacity: 200,
      prePullImages: Object.values(images),
    });

    // -------------------------------------------------------
    // Mesh Services
    // -------------------------------------------------------

    // No dependency declarations: the mesh is fully connected, so every
    // service can reach every other one by hostname. See the transformer.
    for (const serviceName of ['predict', 'features']) {
      new MeshService(this, serviceName, {
        mesh: mesh.ref,
        serviceName,
        appImage: images.demo,
      });
    }

    // -------------------------------------------------------
    // Service API: creates services and load tests, each as its own
    // CloudFormation stack from a pre-synthesized template. The MeshService
    // constructs above are the CDK path; this is the same capability for
    // callers without CDK.
    // -------------------------------------------------------
    new MeshServiceApi(this, 'ServiceApi', {
      xdsBucket: mesh.xdsBucket,
      registryTable: mesh.registryTable,
      mesh: mesh.ref,
      prefix,
      passRoleArns: [mesh.ref.executionRoleArn, mesh.ref.taskRoleArn],
      images,
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
