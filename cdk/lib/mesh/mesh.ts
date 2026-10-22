import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

import { MeshControlPlane } from './control-plane';
import { MeshEdgeProxy } from './edge-proxy';
import { MeshRef, MESH_REF_FIELDS, meshRefParameterName } from './ref';
import { DEFAULT_APP_PORT, CLOUDWATCH_AGENT_IMAGE } from './constants';

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
  /** Ports the edge proxy accepts external traffic on. */
  edgeProxyPorts?: number[];
  /**
   * Application images to pull onto each instance at boot.
   *
   * Warming the cache is what keeps image pull off the critical path of
   * creating a service. It matters more the more instances there are: ECS
   * spreads tasks, so with spare capacity standing by, every new task lands
   * on an instance that has never pulled anything.
   */
  prePullImages?: string[];
}

/**
 * An Envoy service mesh on ECS/EC2.
 *
 * Creates everything a working mesh needs: ECS cluster, control plane, edge
 * proxy. Services are added with MeshService, passing `mesh.ref`. There is
 * nothing to declare about who calls whom — the mesh is fully connected.
 *
 * Usage:
 * ```ts
 * const mesh = new Mesh(this, 'Mesh', { vpc, prefix: 'demo', envoySidecarDir: './envoy-sidecar' });
 * new MeshService(this, 'predict', { mesh: mesh.ref, serviceName: 'predict', appImage: image.imageUri });
 * new MeshService(this, 'features', { mesh: mesh.ref, serviceName: 'features', appImage: image.imageUri });
 * ```
 */
export class Mesh extends Construct {
  public readonly nlb: elbv2.NetworkLoadBalancer;
  /** xDS config bucket, for constructs that need the bucket object itself. */
  public readonly xdsBucket: s3.IBucket;
  public readonly cluster: ecs.Cluster;
  /** The service registry. Both entrypoints write here; the transformer reads it. */
  public readonly registryTable: dynamodb.Table;
  /** What a MeshService needs from this mesh. Also what gets exported. */
  public readonly ref: MeshRef;

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
    // Every proxy polls S3 for config every 5 seconds, so S3 traffic grows
    // with the mesh while the NAT gateway it would otherwise cross does not.
    // A gateway endpoint routes it inside the VPC instead, and costs nothing.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
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
    // Deliberately leaving ECS_IMAGE_PULL_BEHAVIOR at its default, which
    // always checks the registry. prefer-cached would skip the check, but it
    // matches on tag rather than digest, so a service created with a mutable
    // tag like :latest would keep running whatever was cached on that
    // instance. The default costs a manifest round-trip and nothing more —
    // layers already on disk are not downloaded again.
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
    const controlPlane = new MeshControlPlane(this, 'ControlPlane', {
      vpc,
      meshDomain,
      prefix: props.prefix,
      clusterArn: this.cluster.clusterArn,
    });
    this.registryTable = controlPlane.registryTable;

    const envoySidecarImage = new ecr_assets.DockerImageAsset(this, 'EnvoySidecarImage', {
      directory: props.envoySidecarDir,
    });

    // Pull the images every task needs while the instance is booting, rather
    // than when somebody is waiting for a service. The sidecar and the
    // CloudWatch agent are identical for every service in the mesh, so this
    // is the same few hundred MB that each new task would otherwise fetch.
    //
    // UserData renders at synth time, so adding to it here is fine even
    // though the launch template above already references it. Failures are
    // swallowed: a cold cache costs latency, a failed boot costs a whole
    // instance.
    const registry = `${cdk.Stack.of(this).account}.dkr.ecr.${cdk.Stack.of(this).region}.amazonaws.com`;
    userData.addCommands(
      'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done',
      `aws ecr get-login-password --region ${cdk.Stack.of(this).region} | docker login --username AWS --password-stdin ${registry} || true`,
      ...[
        envoySidecarImage.imageUri,
        CLOUDWATCH_AGENT_IMAGE,
        ...(props.prePullImages ?? []),
      ].map(image => `docker pull ${image} || true`),
    );


    // -------------------------------------------------------
    // Edge Proxy (NLB + standalone Envoy)
    // -------------------------------------------------------
    this.xdsBucket = controlPlane.xdsBucket;

    const edgeLogGroup = new logs.LogGroup(this, 'EdgeProxyLogs', {
      logGroupName: `/ecs/${meshDomain}/edge-proxy`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this._edgeProxy = new MeshEdgeProxy(this, 'EdgeProxy', {
      vpc,
      cluster: this.cluster,
      namespace: controlPlane.namespace,
      taskSecurityGroup: taskSg,
      executionRole,
      taskRole: controlPlane.envoyTaskRole,
      xdsBucketName: controlPlane.xdsBucket.bucketName,
      envoyImage: envoySidecarImage,
      logGroup: edgeLogGroup,
    });
    this.nlb = this._edgeProxy.nlb;

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

    // One wildcard DNS record for the whole mesh. A per-service record would
    // make CloudFormation wait for a Route 53 change to go INSYNC before
    // calling the service created, which is pure latency given the answer is
    // the same NLB every time.
    // Envoy routes on the Host header, so a name that resolves here but has
    // no service behind it gets a 404 from the edge proxy rather than
    // NXDOMAIN. That is the better failure for a caller to see.
    new route53.ARecord(this, 'WildcardDnsRecord', {
      zone: controlPlane.hostedZone,
      recordName: '*',
      target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(this.nlb)),
    });

    // -------------------------------------------------------
    // What a service needs from the mesh, published so that API-created
    // services in their own stacks can read it.
    //
    // The parameters are generated from the ref itself, so the two are the
    // same list by construction.
    // -------------------------------------------------------
    this.ref = {
      clusterName: this.cluster.clusterName,
      taskSgId: taskSg.securityGroupId,
      privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
        .subnetIds.join(','),
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: controlPlane.envoyTaskRole.roleArn,
      xdsBucket: controlPlane.xdsBucket.bucketName,
      hostedZoneId: controlPlane.hostedZone.hostedZoneId,
      meshDomain,
      nlbDns: this.nlb.loadBalancerDnsName,
      nlbHostedZoneId: this.nlb.loadBalancerCanonicalHostedZoneId,
      namespaceId: controlPlane.namespace.namespaceId,
      envoyImageUri: envoySidecarImage.imageUri,
      registryTable: controlPlane.registryTable.tableName,
      registryWriterArn: controlPlane.registryWriterArn,
    };

    for (const field of MESH_REF_FIELDS) {
      new ssm.StringParameter(this, `Param${field}`, {
        parameterName: meshRefParameterName(props.prefix, field),
        stringValue: this.ref[field],
      });
    }

    // The edge proxy needs an NLB listener on every port a service is
    // exposed on. They are declared here rather than discovered from the
    // services, because an NLB listener belongs to the mesh and a service
    // created later through the API cannot add one to it.
    for (const port of props.edgeProxyPorts ?? [DEFAULT_APP_PORT]) {
      this._edgeProxy.addListenerForPort(port);
    }
  }

}
