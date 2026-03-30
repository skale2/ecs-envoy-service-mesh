import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { MeshConfig } from './mesh-config';

export interface MeshEdgeProxyProps {
  meshConfig: MeshConfig;
  vpc: ec2.IVpc;
}

/**
 * Envoy edge proxy behind an NLB. Routes external traffic into the
 * mesh based on Host header, using the same xDS configuration as
 * sidecar proxies.
 *
 * Unlike MeshService, the edge proxy is a standalone Envoy instance with
 * no application container and no iptables interception. It acts as the
 * mesh ingress: external clients hit the NLB, which forwards to this
 * Envoy, which routes to the correct backend service based on the Host
 * header in the request.
 */
export class MeshEdgeProxy extends Construct {
  public readonly nlb: elbv2.NetworkLoadBalancer;
  public readonly ecsService: ecs.Ec2Service;

  constructor(scope: Construct, id: string, props: MeshEdgeProxyProps) {
    super(scope, id);

    const { meshConfig: mesh } = props;
    const region = cdk.Stack.of(this).region;

    // Edge proxy task definition: Envoy only, no app container, no iptables.
    // Since there is no companion app whose traffic needs intercepting,
    // the edge proxy skips iptables setup entirely (SIDECAR='0').
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole: mesh.executionRole,
      taskRole: mesh.envoyTaskRole,
    });

    const envoyLinuxParams = new ecs.LinuxParameters(this, 'EnvoyLinuxParams', {
      initProcessEnabled: true,
    });
    taskDef.addContainer('envoy', {
      image: ecs.ContainerImage.fromDockerImageAsset(mesh.envoySidecarImage),
      essential: true,
      memoryLimitMiB: 512,
      cpu: 512,
      linuxParameters: envoyLinuxParams,
      environment: {
        S3_BUCKET: mesh.xdsBucket.bucketName,
        SERVICE_NAME: 'edge-proxy',
        // SIDECAR='0' tells the entrypoint script to skip iptables setup.
        // The edge proxy receives traffic directly on its listener port
        // (via the NLB) rather than via iptables interception.
        SIDECAR: '0',
        AWS_REGION: region,
      },
      portMappings: [
        { containerPort: 15000 },  // Envoy listener (receives NLB traffic)
        { containerPort: 9901 },   // Envoy admin interface (/ready health check)
      ],
      healthCheck: {
        // Envoy's admin interface exposes /ready, which returns "LIVE"
        // when the proxy is initialized and ready to accept traffic.
        command: ['CMD-SHELL', 'curl -s http://localhost:9901/ready | grep -q LIVE || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      // Run as UID 101 (the default envoy user). Since the edge proxy
      // does not need iptables (no sidecar interception), it never needs
      // root privileges. The entrypoint skips iptables when SIDECAR='0',
      // so running as non-root from the start is safe.
      user: '101',
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'edge-proxy-envoy' }),
    });

    // CloudWatch agent: receives DogStatsD metrics from Envoy on UDP 8126
    const cwAgentConfig = JSON.stringify({
      metrics: {
        namespace: '/ecs/envoy-mesh/StatsD',
        metrics_collected: {
          statsd: { service_address: ':8126', metrics_aggregation_interval: 60 },
        },
      },
    });
    taskDef.addContainer('cw-agent', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest'),
      memoryLimitMiB: 128,
      cpu: 64,
      environment: { CW_CONFIG_CONTENT: cwAgentConfig },
      portMappings: [{ containerPort: 8126, protocol: ecs.Protocol.UDP }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'edge-proxy-cw-agent' }),
    });

    // Cloud Map service for API-based discovery (HTTP namespace, no DNS)
    const cmService = new servicediscovery.Service(this, 'CloudMapService', {
      namespace: mesh.namespace,
      name: 'edge-proxy',
    });

    this.ecsService = new ecs.Ec2Service(this, 'Service', {
      cluster: mesh.cluster,
      serviceName: 'edge-proxy',
      taskDefinition: taskDef,
      desiredCount: 1,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [mesh.taskSecurityGroup],
    });
    this.ecsService.associateCloudMapService({ service: cmService });

    // Allow NLB traffic into task security group
    const sg = mesh.taskSecurityGroup as ec2.SecurityGroup;
    sg.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(15000),
      'Allow NLB traffic to edge proxy on Envoy port',
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(9901),
      'Allow NLB health checks on admin port',
    );

    // Network Load Balancer -- the single entry point for external traffic.
    this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc: props.vpc,
      internetFacing: true,
      crossZoneEnabled: true,
      // AZ affinity: prefer routing clients to edge proxy tasks in the same
      // AZ, reducing cross-AZ hops and latency. Envoy then does its own
      // zone-aware routing to pick same-AZ backends when possible.
      clientRoutingPolicy: elbv2.ClientRoutingPolicy.AVAILABILITY_ZONE_AFFINITY,
    });

    // NLB port mapping: listens on 8080 (the service port callers use)
    // and forwards to 15000 (Envoy's listener port inside the container).
    // This means callers use the same address:port whether they are inside
    // or outside the mesh -- e.g. service-b.mesh.local:8080 always works.
    // Inside the mesh, iptables intercepts before traffic reaches the NLB.
    // Outside the mesh, the NLB forwards to the edge proxy's Envoy.
    const listener = this.nlb.addListener('ServicePortListener', { port: 8080 });
    listener.addTargets('Target', {
      port: 15000,
      targets: [
        this.ecsService.loadBalancerTarget({
          containerName: 'envoy',
          containerPort: 15000,
        }),
      ],
      healthCheck: {
        // HTTP health check against Envoy's admin interface on port 9901.
        // The /ready endpoint returns 200 with body "LIVE" when Envoy has
        // loaded its configuration and is ready to route traffic.
        protocol: elbv2.Protocol.HTTP,
        port: '9901',
        path: '/ready',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
  }
}
