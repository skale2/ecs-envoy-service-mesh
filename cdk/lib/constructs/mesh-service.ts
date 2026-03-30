import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { Mesh } from './mesh';

export interface MeshServiceProps {
  /** The Mesh this service belongs to. */
  mesh: Mesh;

  /** Logical service name (used for Cloud Map, S3 paths, DNS, logging). */
  serviceName: string;
  /** Docker image for the application container. */
  appImage: ecr_assets.DockerImageAsset;
  /** Names of other mesh services this service calls. Used to generate
   *  the service registry and the DOWNSTREAM_TARGETS env var. */
  dependencies?: string[];
  /** Application container port. */
  appPort?: number;
  /** Extra environment variables for the application container. */
  appEnvironment?: Record<string, string>;
  /** Desired task count. */
  desiredCount?: number;
}

/**
 * A mesh-enabled ECS service: application container + Envoy sidecar.
 *
 * The Envoy container runs as UID 101 (envoy) with NET_ADMIN capability
 * to set up iptables egress interception in the entrypoint.
 */
export class MeshService extends Construct {
  public readonly ecsService: ecs.Ec2Service;

  constructor(scope: Construct, id: string, props: MeshServiceProps) {
    super(scope, id);

    const { mesh: { meshConfig: mesh, nlb } } = props;
    const appPort = props.appPort ?? 8080;
    const dependencies = props.dependencies ?? [];
    const desiredCount = props.desiredCount ?? 1;
    const region = cdk.Stack.of(this).region;

    // Register this service in the mesh's service registry.
    // The Mesh construct generates the registry JSON at synth time.
    props.mesh.registerService(props.serviceName, appPort, dependencies);

    // Auto-derive DOWNSTREAM_TARGETS from declared dependencies.
    // e.g. dependencies: ['features'] → DOWNSTREAM_TARGETS: 'features.demo.mesh:8080'
    const downstreamTargets = dependencies
      .map(dep => `${dep}.${mesh.meshDomain}:${appPort}`)
      .join(',');

    // Route 53 alias record: {serviceName}.mesh.local -> edge proxy NLB.
    //
    // This is what makes `service-b.mesh.local` resolve to an IP address.
    // The record points to the NLB, but traffic only reaches it from
    // *outside* the mesh. From inside the mesh, the app resolves the same
    // DNS name but iptables intercepts the outgoing TCP connection before
    // it ever reaches the NLB, redirecting it to the local Envoy sidecar
    // on 127.0.0.1:15000. Envoy then routes directly to the target
    // service's task IPs (learned from xDS), bypassing the NLB entirely.
    new route53.ARecord(this, 'DnsRecord', {
      zone: mesh.hostedZone,
      recordName: props.serviceName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(nlb),
      ),
    });

    // Task definition using awsvpc network mode.
    // awsvpc gives each task its own ENI, meaning all containers in the
    // task share a single network namespace. This is critical: iptables
    // rules set up by the Envoy container's entrypoint (running as root
    // initially) also affect the app container's traffic, enabling
    // transparent egress interception without any app-side changes.
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole: mesh.executionRole,
      taskRole: mesh.envoyTaskRole,
    });

    // --- Application container ---
    const appLinuxParams = new ecs.LinuxParameters(this, 'AppLinuxParams', {
      initProcessEnabled: true,
    });
    const appContainer = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromDockerImageAsset(props.appImage),
      essential: true,
      memoryLimitMiB: 256,
      cpu: 256,
      environment: {
        APP_PORT: String(appPort),
        SERVICE_NAME: props.serviceName,
        ...(downstreamTargets ? { DOWNSTREAM_TARGETS: downstreamTargets } : {}),
        ...props.appEnvironment,
      },
      portMappings: [{ containerPort: appPort }],
      linuxParameters: appLinuxParams,
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${appPort}/health || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${props.serviceName}-app`,
      }),
    });

    // --- Envoy sidecar container ---
    const envoyLinuxParams = new ecs.LinuxParameters(this, 'EnvoyLinuxParams', {
      initProcessEnabled: true,
    });
    // NET_ADMIN: required to create and manipulate iptables rules in the
    //   task's network namespace (nat table, custom chains, REDIRECT target).
    // NET_RAW: required for iptables to use raw sockets when setting up
    //   the REDIRECT rules.
    envoyLinuxParams.addCapabilities(ecs.Capability.NET_ADMIN, ecs.Capability.NET_RAW);

    const envoyContainer = taskDef.addContainer('envoy', {
      image: ecs.ContainerImage.fromDockerImageAsset(mesh.envoySidecarImage),
      essential: true,
      memoryLimitMiB: 256,
      cpu: 256,
      linuxParameters: envoyLinuxParams,
      environment: {
        S3_BUCKET: mesh.xdsBucket.bucketName,
        SERVICE_NAME: props.serviceName,
        SIDECAR: '1',
        APP_PORT: String(appPort),
        AWS_REGION: region,
      },
      portMappings: [
        { containerPort: 15000 },  // Envoy listener (receives intercepted traffic)
        { containerPort: 9901 },   // Envoy admin interface (/ready health check)
      ],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -s http://localhost:9901/ready | grep -q LIVE || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${props.serviceName}-envoy`,
      }),
    });

    // --- CloudWatch agent container ---
    // Receives DogStatsD metrics from Envoy on UDP port 8126 and forwards
    // them to CloudWatch. Envoy's bootstrap config includes a stats_sinks
    // section that points to 127.0.0.1:8126, so metrics flow:
    //   Envoy -> DogStatsD UDP -> cw-agent -> CloudWatch Metrics
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
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${props.serviceName}-cw-agent`,
      }),
    });

    // The app container MUST wait for Envoy to be HEALTHY before starting.
    // The Envoy entrypoint sets up iptables rules that redirect all outgoing
    // TCP traffic to the local Envoy listener. If the app starts first and
    // makes network calls before iptables is configured, those calls would
    // bypass the mesh (or worse, fail if iptables is half-configured).
    appContainer.addContainerDependencies({
      container: envoyContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    // Cloud Map service for API-based discovery (HTTP namespace, no DNS).
    // ECS automatically registers/deregisters task IPs with this Cloud Map
    // service via associateCloudMapService() below. The transformer Lambda
    // queries these registrations to discover which IPs back each service,
    // then generates xDS configs with those IPs as upstream endpoints.
    const cmService = new servicediscovery.Service(this, 'CloudMapService', {
      namespace: mesh.namespace,
      name: props.serviceName,
    });

    this.ecsService = new ecs.Ec2Service(this, 'Service', {
      cluster: mesh.cluster,
      serviceName: `service-${props.serviceName}`,
      taskDefinition: taskDef,
      desiredCount,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [mesh.taskSecurityGroup],
    });
    // Binds the ECS service to Cloud Map so that task IPs are automatically
    // registered/deregistered as tasks start and stop.
    this.ecsService.associateCloudMapService({ service: cmService });
  }
}
