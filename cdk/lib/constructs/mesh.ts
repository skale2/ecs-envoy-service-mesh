import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

import { MeshControlPlane } from './mesh-control-plane';
import { MeshConfig } from './mesh-config';
import { MeshEdgeProxy } from './mesh-edge-proxy';

export interface MeshProps {
  /** VPC to deploy the mesh into. Must have private subnets with egress. */
  vpc: ec2.IVpc;
  /** Path to the envoy-sidecar Docker build context. */
  envoySidecarDir: string;
  /** Prefix for globally-named resources and the mesh DNS domain ({prefix}.mesh). */
  prefix: string;
  /** EC2 instance type for ECS capacity. */
  instanceType?: ec2.InstanceType;
  /** Minimum number of EC2 instances in the ASG. */
  minCapacity?: number;
  /** Maximum number of EC2 instances in the ASG. */
  maxCapacity?: number;
}

/**
 * An Envoy service mesh on ECS/EC2.
 *
 * Creates everything needed for a working mesh: ECS cluster, control plane,
 * edge proxy. Users create MeshService constructs passing this Mesh, and
 * the service registry is generated automatically from the registered services.
 *
 * Usage:
 * ```ts
 * const mesh = new Mesh(this, 'Mesh', { vpc, prefix: 'demo', envoySidecarDir: './envoy-sidecar' });
 * new MeshService(this, 'Predict', { mesh, serviceName: 'predict', appImage, dependencies: ['features'] });
 * new MeshService(this, 'Features', { mesh, serviceName: 'features', appImage, dependencies: ['predict'] });
 * ```
 */
export class Mesh extends Construct {
  public readonly nlb: elbv2.NetworkLoadBalancer;
  public readonly meshConfig: MeshConfig;
  public readonly cluster: ecs.Cluster;

  // Accumulated by MeshService constructors, used to generate the service registry
  private readonly _services: Record<string, { port: number; dependencies: string[] }> = {};
  private readonly _edgeProxy: MeshEdgeProxy;

  constructor(scope: Construct, id: string, props: MeshProps) {
    super(scope, id);

    const { vpc } = props;
    const meshDomain = `${props.prefix}.mesh`;

    // -------------------------------------------------------
    // SSM VPC endpoints (required for ECS Exec in private subnets)
    // -------------------------------------------------------
    vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
    });
    vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    });

    // -------------------------------------------------------
    // ECS Cluster with EC2 capacity
    // -------------------------------------------------------
    const clusterSg = new ec2.SecurityGroup(this, 'ClusterSg', {
      vpc,
      description: 'ECS cluster instances',
      allowAllOutbound: true,
    });
    // nosec: Allow-all intra-VPC for demo debuggability (e.g., direct task IP access
    // from bastion). For production, restrict to specific ports: 8080 (app), 15000
    // (Envoy), 9901 (admin/health checks), 8126/UDP (StatsD).
    clusterSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all intra-VPC traffic',
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands('echo ECS_ENABLE_TASK_ENI_TRUNKING=true >> /etc/ecs/ecs.config');

    // Security controls (implementation priority):
    // 1. CRITICAL: IMDSv2 enforced (requireImdsv2: true) — prevents SSRF-based
    //    credential theft by requiring token-based metadata requests.
    //    Validate: `curl http://169.254.169.254/latest/meta-data/` without token fails.
    // 2. HIGH: Security groups restrict network access (see clusterSg/taskSg above).
    //    Validate: verify only expected ports are reachable from outside the VPC.
    // 3. MEDIUM: Instance role scoped to ECS + SSM only — no broad admin access.
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: props.instanceType ?? new ec2.InstanceType('t3.medium'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      securityGroup: clusterSg,
      requireImdsv2: true,
      userData,
      role: new iam.Role(this, 'InstanceRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ],
      }),
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'AsgCapacity', {
      vpc,
      launchTemplate,
      minCapacity: props.minCapacity ?? 2,
      maxCapacity: props.maxCapacity ?? 4,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${props.prefix}-envoy-mesh`,
    });
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg,
      enableManagedTerminationProtection: false,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);

    // Task security group (shared by all awsvpc tasks)
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'ECS tasks (awsvpc mode)',
      allowAllOutbound: true,
    });
    // nosec: Allow-all intra-VPC for demo debuggability (e.g., direct task IP access
    // from bastion). For production, restrict to specific ports: 8080 (app), 15000
    // (Envoy), 9901 (admin/health checks), 8126/UDP (StatsD).
    taskSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all intra-VPC traffic',
    );

    // Shared execution role
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // -------------------------------------------------------
    // Control Plane (AWS Cloud Map, Amazon Route 53, Amazon S3, AWS Lambda transformer)
    // -------------------------------------------------------
    const controlPlane = new MeshControlPlane(this, 'ControlPlane', { vpc, meshDomain });

    const envoySidecarImage = new ecr_assets.DockerImageAsset(this, 'EnvoySidecarImage', {
      directory: props.envoySidecarDir,
    });

    // -------------------------------------------------------
    // MeshConfig
    // -------------------------------------------------------
    this.meshConfig = {
      cluster: this.cluster,
      namespace: controlPlane.namespace,
      hostedZone: controlPlane.hostedZone,
      meshDomain,
      taskSecurityGroup: taskSg,
      executionRole,
      envoyTaskRole: controlPlane.envoyTaskRole,
      xdsBucket: controlPlane.xdsBucket,
      envoySidecarImage,
    };

    // -------------------------------------------------------
    // Edge Proxy (NLB + standalone Envoy)
    // -------------------------------------------------------
    this._edgeProxy = new MeshEdgeProxy(this, 'EdgeProxy', {
      meshConfig: this.meshConfig,
      vpc,
    });
    this.nlb = this._edgeProxy.nlb;

    // -------------------------------------------------------
    // Service Registry (generated lazily at synth time)
    //
    // MeshService constructors call registerService() to add themselves.
    // At synthesis, Lazy.string produces the JSON from the accumulated map.
    // -------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployServiceRegistry', {
      sources: [
        s3deploy.Source.data(
          'service-registry.json',
          cdk.Lazy.string({
            produce: () => JSON.stringify({ services: this._services }, null, 2),
          }),
        ),
      ],
      destinationBucket: controlPlane.xdsBucket,
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: this.nlb.loadBalancerDnsName,
      description: 'Edge proxy NLB DNS name',
    });
    new cdk.CfnOutput(this, 'XdsBucketName', {
      value: controlPlane.xdsBucket.bucketName,
      description: 'S3 bucket for xDS configurations',
    });
    new cdk.CfnOutput(this, 'CloudMapNamespaceId', {
      value: controlPlane.namespace.namespaceId,
      description: 'AWS Cloud Map namespace ID',
    });
  }

  /** Called by MeshService to register itself in the service registry. */
  registerService(name: string, port: number, dependencies: string[]) {
    this._services[name] = { port, dependencies };
    this._edgeProxy.addListenerForPort(port);
  }

  /** Returns the registered port for a service, or undefined if not yet registered. */
  getServicePort(name: string): number | undefined {
    return this._services[name]?.port;
  }
}
