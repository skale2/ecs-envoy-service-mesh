import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as path from 'path';
import { Construct } from 'constructs';

export interface MeshControlPlaneProps {
  vpc: ec2.IVpc;
  /** Mesh DNS domain, e.g. "demo.mesh". */
  meshDomain: string;
}

/**
 * The mesh control plane: AWS Cloud Map namespace (API-only), Amazon Route 53
 * hosted zone for service DNS, Amazon S3 xDS config bucket, and an AWS Lambda
 * function scheduled via EventBridge that generates xDS configs.
 */
export class MeshControlPlane extends Construct {
  public readonly namespace: servicediscovery.HttpNamespace;
  public readonly hostedZone: route53.PrivateHostedZone;
  public readonly xdsBucket: s3.Bucket;
  public readonly envoyTaskRole: iam.Role;

  constructor(scope: Construct, id: string, props: MeshControlPlaneProps) {
    super(scope, id);

    const { vpc } = props;

    // AWS Cloud Map HTTP namespace (API-only, no DNS records).
    // We use HttpNamespace rather than DnsNamespace because we do NOT want
    // AWS Cloud Map to create DNS records. DNS resolution for mesh services is
    // handled separately by Amazon Route 53 alias records that point to the NLB.
    // AWS Cloud Map's sole purpose here is as a service registry: ECS registers
    // task IPs, and the transformer AWS Lambda queries them via the AWS Cloud Map API.
    this.namespace = new servicediscovery.HttpNamespace(this, 'Namespace', {
      name: props.meshDomain,
    });

    // Amazon Route 53 private hosted zone for service DNS resolution.
    // Each MeshService creates an alias record (e.g. service-b.mesh.local)
    // pointing to the edge proxy NLB. This makes service names resolvable
    // from anywhere in the VPC.
    this.hostedZone = new route53.PrivateHostedZone(this, 'HostedZone', {
      zoneName: props.meshDomain,
      vpc,
    });

    // S3 bucket for xDS configs.
    // Versioning is enabled so that Envoy sidecars can use the S3 eTag
    // (which changes on every object version) to detect config updates.
    // The sidecar's refresh loop calls HeadObject, compares the eTag to
    // the last-seen value, and only downloads when it differs -- avoiding
    // unnecessary disk writes that would trigger unnecessary Envoy reloads.
    const xdsAccessLogBucket = new s3.Bucket(this, 'XdsAccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.xdsBucket = new s3.Bucket(this, 'XdsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: xdsAccessLogBucket,
      serverAccessLogsPrefix: 'xds-bucket-access/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // The service registry is generated and deployed by the Mesh construct
    // (from the set of MeshService instances), not here.

    // Envoy sidecar/edge-proxy task role — least-privilege permissions:
    //
    // 1. CRITICAL: S3 read-only on xDS bucket (grantRead below). Sidecars pull
    //    xDS configs at startup and via the refresh loop. Read-only prevents
    //    unauthorized config modification. Validate: S3 write from task should fail.
    // 2. HIGH: SSM (AmazonSSMManagedInstanceCore). Required for ECS Exec debugging
    //    via `aws ecs execute-command`. Enables secure shell access without SSH or
    //    inbound ports. Validate: SSM session works without open inbound ports.
    // 3. MEDIUM: CloudWatch (CloudWatchAgentServerPolicy). Enables the CW agent
    //    sidecar to publish Envoy StatsD metrics. Validate: metrics appear in
    //    /ecs/envoy-mesh/StatsD namespace.
    this.envoyTaskRole = new iam.Role(this, 'EnvoyTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    this.xdsBucket.grantRead(this.envoyTaskRole);

    // xDS Transformer AWS Lambda.
    // This AWS Lambda queries AWS Cloud Map to discover all registered service IPs,
    // then generates Envoy xDS configuration files (CDS, LDS, RDS) and
    // writes them to S3 for each service and the edge proxy.
    //
    // Scheduling strategy (AWS Lambda + EventBridge):
    //   - EventBridge triggers the AWS Lambda every 1 minute.
    //   - Inside each invocation, the AWS Lambda loops internally every ~10
    //     seconds until it approaches its 55-second timeout.
    //   - This gives near-real-time config updates (~10s latency) without
    //     running a persistent polling service or paying for idle compute.
    //   - The 5-second gap between the 55s timeout and the 60s schedule
    //     ensures the previous invocation finishes before the next starts.
    const projectRoot = path.join(__dirname, '..', '..', '..');
    const transformerFn = new lambda.Function(this, 'TransformerFn', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'transformer.handler',
      code: lambda.Code.fromAsset(path.join(projectRoot, 'xds-transformer'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_11.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(55),
      memorySize: 256,
      environment: {
        S3_BUCKET: this.xdsBucket.bucketName,
        CLOUDMAP_NAMESPACE_ID: this.namespace.namespaceId,
        CLOUDMAP_NAMESPACE_NAME: props.meshDomain,
        MESH_DOMAIN: props.meshDomain,
      },
    });

    this.xdsBucket.grantReadWrite(transformerFn);
    // ListServices and ListInstances do not support resource-level IAM scoping —
    // they require 'resources: ["*"]'. The Lambda itself filters by namespace ID.
    transformerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['servicediscovery:ListServices', 'servicediscovery:ListInstances'],
      resources: ['*'],
    }));

    // EventBridge rule: invoke transformer every 1 minute.
    // See the scheduling strategy comment above for why this pairs with
    // the AWS Lambda's internal polling loop.
    new events.Rule(this, 'TransformerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new events_targets.LambdaFunction(transformerFn)],
    });
  }
}
