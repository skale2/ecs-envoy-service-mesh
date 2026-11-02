import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { MeshRef } from './ref';
import { MeshRegistryEntry } from './registry-entry';
import {
  ENVOY_LISTENER_PORT,
  ENVOY_ADMIN_PORT,
  DEFAULT_APP_PORT,
  CLOUDWATCH_STATSD_PORT,
  CLOUDWATCH_AGENT_IMAGE,
} from './constants';

export interface MeshServiceProps {
  /** Shared mesh infrastructure. */
  mesh: MeshRef;
  /** Logical service name. Becomes the DNS label and the registry key. */
  serviceName: string;
  /** Application container image URI. */
  appImage: string;
  /** Application container port. */
  appPort?: number;
  /** Desired task count. */
  desiredCount?: number;
  /** Extra environment variables for the application container. */
  appEnvironment?: Record<string, string>;
  /**
   * Whether other services can call this one. A load generator runs in the
   * mesh, with a sidecar like any service, but nothing calls it, so it stays
   * out of the registry. Default true.
   */
  routable?: boolean;
  /**
   * How callers reach the service. 'envoy', the default, gives every task an
   * Envoy sidecar, and callers' sidecars route to the tasks directly. 'nlb'
   * runs the app alone behind an internal NLB of its own, with the service's
   * name pointed at the NLB: the conventional setup, kept to compare against.
   */
  proxy?: 'envoy' | 'nlb';
}

/**
 * A mesh service: the application container plus, by default, an Envoy
 * sidecar (see `proxy` for the NLB-fronted alternative).
 *
 * This is the only definition of what a mesh service is made of, and both
 * entrypoints use it — the CDK app instantiates it directly, and the
 * per-service template that `POST /services` deploys instantiates it from
 * CloudFormation parameters. Everything variable arrives through `MeshRef`
 * as a string, so the same code emits both.
 */
export class MeshService extends Construct {
  constructor(scope: Construct, id: string, props: MeshServiceProps) {
    super(scope, id);

    const { mesh, serviceName: name } = props;
    const proxy = props.proxy ?? 'envoy';
    const appPort = props.appPort ?? DEFAULT_APP_PORT;
    // appPort is a literal in the CDK app and a CfnParameter in the template.
    // stringifyNumber handles both; String() would mangle the token.
    const port = cdk.Tokenization.stringifyNumber(appPort);

    // One log group per service, with each container as a stream prefix
    // inside it. Per-service is the useful granularity: retention, metric
    // filters, subscriptions and Insights queries all scope to a service,
    // and deleting the service takes its logs with it. Per-container would
    // be three groups saying the same thing.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: cdk.Fn.join('', ['/ecs/', mesh.meshDomain, '/', name]),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logging = (container: string) =>
      ecs.LogDrivers.awsLogs({ streamPrefix: container, logGroup });

    // awsvpc gives the task one ENI, so every container in it shares a
    // network namespace. That is what makes transparent interception work:
    // iptables rules the Envoy container installs also apply to the app
    // container's traffic, with no cooperation from the app.
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole: iam.Role.fromRoleArn(this, 'ExecRole', mesh.executionRoleArn, { mutable: false }),
      taskRole: iam.Role.fromRoleArn(this, 'TaskRole', mesh.taskRoleArn, { mutable: false }),
    });

    const appContainer = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(props.appImage),
      essential: true,
      memoryLimitMiB: 256,
      cpu: 256,
      environment: {
        APP_PORT: port,
        SERVICE_NAME: name,
        MESH_DOMAIN: mesh.meshDomain,
        ...props.appEnvironment,
      },
      portMappings: [{ containerPort: appPort }],
      linuxParameters: new ecs.LinuxParameters(this, 'AppLinuxParams', { initProcessEnabled: true }),
      // A short interval with a high retry count, which are two different
      // things. The first check does not run until one interval has elapsed,
      // so the interval is the floor on how fast this can go HEALTHY — and
      // CloudFormation will not call the service created until it does.
      // interval x retries is the separate question of how long a container
      // may be unresponsive before ECS replaces the task; 5s x 6 keeps that
      // at a forgiving 30s rather than killing a service over a GC pause.
      // 5s is the floor ECS allows for an interval.
      healthCheck: {
        command: ['CMD-SHELL', `curl -fsS http://localhost:${port}/health || exit 1`],
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(3),
        retries: 6,
        startPeriod: cdk.Duration.seconds(60),
      },
      logging: logging('app'),
    });

    if (proxy === 'envoy') {
      // nosec: NET_ADMIN and NET_RAW are required for iptables-based interception.
      // Scoped to the Envoy container only, and Envoy drops to UID 101 once the
      // rules are installed.
      const envoyLinuxParams = new ecs.LinuxParameters(this, 'EnvoyLinuxParams', { initProcessEnabled: true });
      envoyLinuxParams.addCapabilities(ecs.Capability.NET_ADMIN, ecs.Capability.NET_RAW);

      const envoyContainer = taskDef.addContainer('envoy', {
        image: ecs.ContainerImage.fromRegistry(mesh.envoyImageUri),
        essential: true,
        memoryLimitMiB: 256,
        cpu: 256,
        linuxParameters: envoyLinuxParams,
        environment: {
          S3_BUCKET: mesh.xdsBucket,
          SERVICE_NAME: name,
          SIDECAR: '1',
          AWS_REGION: cdk.Aws.REGION,
        },
        portMappings: [
          { containerPort: ENVOY_LISTENER_PORT },
          { containerPort: ENVOY_ADMIN_PORT },
        ],
        // The app blocks on this going HEALTHY, so this interval sets the
        // floor on how fast the whole task starts. The generous startPeriod
        // costs nothing on that path: a success during it still marks the
        // container healthy immediately, it only stops early failures from
        // counting while Envoy installs iptables and fetches config from S3.
        healthCheck: {
          command: ['CMD-SHELL', `curl -fsS http://localhost:${ENVOY_ADMIN_PORT}/ready | grep -q LIVE || exit 1`],
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(3),
          retries: 6,
          startPeriod: cdk.Duration.seconds(120),
        },
        logging: logging('envoy'),
      });

      // The app must not start until Envoy is healthy. Envoy's entrypoint is
      // what installs the iptables rules, so an app that started first could
      // make calls that bypass the mesh entirely.
      appContainer.addContainerDependencies({
        container: envoyContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      });

      // Envoy emits DogStatsD over UDP to this sidecar, which forwards to
      // CloudWatch. See the stats_sinks block in the Envoy bootstrap.
      taskDef.addContainer('cw-agent', {
        image: ecs.ContainerImage.fromRegistry(CLOUDWATCH_AGENT_IMAGE),
        memoryLimitMiB: 128,
        cpu: 64,
        environment: {
          CW_CONFIG_CONTENT: JSON.stringify({
            metrics: {
              namespace: '/ecs/envoy-mesh/StatsD',
              metrics_collected: {
                statsd: {
                  service_address: `:${CLOUDWATCH_STATSD_PORT}`,
                  metrics_aggregation_interval: 60,
                },
              },
            },
          }),
        },
        portMappings: [{ containerPort: CLOUDWATCH_STATSD_PORT, protocol: ecs.Protocol.UDP }],
        // Not essential: metrics are not worth failing a service over, and
        // this keeps a slow pull of the (large) agent image from deciding
        // whether the task is considered up.
        essential: false,
        logging: logging('cw-agent'),
      });
    }

    // AWS Cloud Map registration. ECS puts each task's ENI IP in here as it
    // starts and takes it out as it stops; the transformer reads those IPs to
    // build Envoy endpoints. The namespace is API-only, so no DNS comes from
    // it — containerName/port must be omitted for an HTTP namespace.
    const cloudMapService = new servicediscovery.CfnService(this, 'CloudMapService', {
      name,
      namespaceId: mesh.namespaceId,
    });

    const nlb = proxy === 'nlb' ? nlbFrontDoor(this, mesh, name, appPort) : undefined;

    const service = new ecs.CfnService(this, 'Service', {
      cluster: mesh.clusterName,
      serviceName: cdk.Fn.join('-', ['service', name]),
      taskDefinition: taskDef.taskDefinitionArn,
      desiredCount: props.desiredCount ?? 1,
      enableExecuteCommand: true,
      capacityProviderStrategy: [{ capacityProvider: mesh.capacityProvider, weight: 1 }],
      deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200 },
      networkConfiguration: {
        awsvpcConfiguration: {
          securityGroups: [mesh.taskSgId],
          subnets: cdk.Fn.split(',', mesh.privateSubnets),
        },
      },
      serviceRegistries: [{ registryArn: cloudMapService.attrArn }],
      ...(nlb && {
        loadBalancers: [{ containerName: 'app', containerPort: appPort, targetGroupArn: nlb.targetGroup.ref }],
        healthCheckGracePeriodSeconds: 30,
      }),
    });
    service.addDependency(cloudMapService);
    // ECS rejects a target group that isn't attached to a load balancer yet.
    if (nlb) service.addDependency(nlb.listener);

    // No DNS record here. The mesh owns a single wildcard alias for
    // *.{meshDomain}, so {name}.{meshDomain} already resolves the moment the
    // service exists — nothing to create, and no waiting on a Route 53 change
    // to go INSYNC before CloudFormation calls the service done.

    // Registered last: the row is what makes the transformer generate config
    // for this service, so it should not appear before there is something for
    // that config to point at.
    if (props.routable ?? true) {
      const registryEntry = new MeshRegistryEntry(this, 'RegistryEntry', {
        serviceToken: mesh.registryWriterArn,
        tableName: mesh.registryTable,
        serviceName: name,
        port,
        // Tells the transformer to route to the NLB rather than to tasks.
        attributes: nlb && { proxy: 'nlb', address: nlb.dnsName },
      });
      registryEntry.resource.addDependency(service);
    }
  }
}

/**
 * The NLB in front of a service that has no sidecar: a TCP listener on the
 * app's port, the tasks as IP targets, and the service's name as a CNAME to
 * the NLB in the mesh's zone. A specific record takes precedence over the
 * zone's wildcard, so this service's name alone resolves to its NLB.
 * Cross-zone load balancing is left at the NLB default, off, as in most
 * real deployments, so callers pay what NLB callers usually pay.
 */
function nlbFrontDoor(scope: Construct, mesh: MeshRef, name: string, appPort: number) {
  const lb = new elbv2.CfnLoadBalancer(scope, 'Nlb', {
    type: 'network',
    scheme: 'internal',
    subnets: cdk.Fn.split(',', mesh.privateSubnets),
  });
  const targetGroup = new elbv2.CfnTargetGroup(scope, 'NlbTargets', {
    vpcId: mesh.vpcId,
    protocol: 'TCP',
    port: appPort,
    targetType: 'ip',
    healthCheckProtocol: 'HTTP',
    healthCheckPath: '/health',
    healthCheckIntervalSeconds: 10,
    healthyThresholdCount: 2,
    unhealthyThresholdCount: 2,
    // Seconds, not the default five minutes, for a task to leave the group.
    targetGroupAttributes: [{ key: 'deregistration_delay.timeout_seconds', value: '10' }],
  });
  const listener = new elbv2.CfnListener(scope, 'NlbListener', {
    loadBalancerArn: lb.ref,
    port: appPort,
    protocol: 'TCP',
    defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
  });
  new route53.CfnRecordSet(scope, 'NlbName', {
    hostedZoneId: mesh.hostedZoneId,
    name: cdk.Fn.join('', [name, '.', mesh.meshDomain]),
    type: 'CNAME',
    ttl: '60',
    resourceRecords: [lb.attrDnsName],
  });
  return { targetGroup, listener, dnsName: lb.attrDnsName };
}
