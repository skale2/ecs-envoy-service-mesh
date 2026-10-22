import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface MeshControlPlaneProps {
  vpc: ec2.IVpc;
  /** Mesh DNS domain, e.g. "demo.mesh". */
  meshDomain: string;
  /** Prefix for named resources, e.g. "demo". */
  prefix: string;
  /** ECS cluster whose task state changes drive config regeneration. */
  clusterArn: string;
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
  public readonly registryTable: dynamodb.Table;
  /** Custom-resource ServiceToken both entrypoints use to register a service. */
  public readonly registryWriterArn: string;

  constructor(scope: Construct, id: string, props: MeshControlPlaneProps) {
    super(scope, id);

    const { vpc } = props;

    // AWS Cloud Map HTTP namespace (API-only, no DNS records).
    // An HTTP namespace, which is API-only: it creates no DNS records. That
    // matters because mesh DNS belongs to the Route 53 zone below, and a
    // Cloud Map DNS namespace of the same name would compete with it. Cloud
    // Map's job here is purely to hold task IPs for the transformer to read.
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

    // Service registry.
    //
    // This is the list of services the mesh is supposed to have: name, port,
    // and port. It is deliberately NOT in the xDS bucket.
    // The xDS bucket holds generated Envoy config, which has to be files
    // because Envoy's filesystem xDS API reads files; the registry is
    // mutable metadata that the API writes and the transformer reads, which
    // is a table's job. Keeping them apart means a write to the registry
    // can't scribble on the config Envoy is mid-reload on.
    //
    // On-demand billing, because the whole point of the API entrypoint is
    // that a room full of people can create services at once and nobody has
    // to have provisioned capacity for it beforehand.
    this.registryTable = new dynamodb.Table(this, 'ServiceRegistry', {
      tableName: `${props.prefix}-mesh-service-registry`,
      partitionKey: { name: 'name', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Streams are what make a create visible to Envoy in ~2s instead of
      // ~12s: the write itself wakes the transformer up rather than the
      // transformer finding out on its next poll.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Shared custom-resource provider for registry rows.
    //
    // A registry row is a CloudFormation resource, created by whichever stack
    // owns the service. That ties the row to the stack's fate: a rollback
    // removes it, DeleteStack removes it, and nothing has to reconcile the
    // two by hand.
    //
    // CloudFormation has no native resource type for a DynamoDB item, so a
    // custom resource is the only way to write one, and every custom resource
    // needs a provider behind it. This AwsCustomResource is CDK's generic SDK
    // caller; declaring one here materializes that provider — a singleton
    // shared by every AwsCustomResource in the stack — and attaches the table
    // permissions to its role. Per-service stacks, which carry no assets of
    // their own and so cannot define a provider, reference this one by ARN.
    //
    // The call itself is a DescribeTable: harmless, and it keeps this
    // resource honest about being nothing more than the provider's home.
    const registryProvider = new cr.AwsCustomResource(this, 'RegistryProvider', {
      onUpdate: {
        service: 'DynamoDB',
        action: 'describeTable',
        parameters: { TableName: this.registryTable.tableName },
        physicalResourceId: cr.PhysicalResourceId.of('mesh-registry-provider'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:DescribeTable', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
          resources: [this.registryTable.tableArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    const provider = registryProvider.node.findChild('Provider') as lambda.SingletonFunction;
    this.registryWriterArn = provider.functionArn;
    // Per-service stacks are separate stacks, so CloudFormation reaches this
    // function from outside the one that defines it.
    provider.addPermission('AllowCloudFormationInvoke', {
      principal: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      sourceAccount: cdk.Stack.of(this).account,
    });

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

    // The control plane, such as it is: one Lambda that reads the registry
    // and AWS Cloud Map and writes Envoy's CDS/LDS/RDS files to S3. There
    // is no xDS server, no gRPC stream, and nothing running between
    // invocations — Envoy reads its config off a filesystem that a sidecar
    // keeps in sync with the bucket.
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
      timeout: cdk.Duration.minutes(2),
      // Lambda allocates vCPU in proportion to memory, and this function is
      // the opposite of memory-hungry: it wants cores. It fans a few thousand
      // AWS calls across a thread pool and serializes a YAML document per
      // proxy per config type, so both the waiting and the work parallelize.
      // 1769 MB is where a function gets a full vCPU; this is roughly 2.3.
      //
      // Being generous here is cheap precisely because of the concurrency
      // limit below: only one of these ever runs, for a few seconds at a time.
      memorySize: 4096,
      // One at a time, because every invocation does the identical thing:
      // read the whole registry, read all of AWS Cloud Map, write the
      // configs that changed. Two of them running together would produce the
      // same result twice.
      //
      // Serializing is also what makes a burst cheap. A mass create fires a
      // task state change per task; with one slot, the extras are throttled,
      // Lambda retries them, and whichever one runs next already sees every
      // change that accumulated. A hundred events collapse into a couple of
      // passes instead of a hundred concurrent ones racing into AWS Cloud
      // Map's request limits.
      reservedConcurrentExecutions: 1,
      environment: {
        S3_BUCKET: this.xdsBucket.bucketName,
        CLOUDMAP_NAMESPACE_ID: this.namespace.namespaceId,
        CLOUDMAP_NAMESPACE_NAME: props.meshDomain,
        MESH_DOMAIN: props.meshDomain,
        REGISTRY_TABLE: this.registryTable.tableName,
      },
    });

    this.xdsBucket.grantReadWrite(transformerFn);
    this.registryTable.grantReadData(transformerFn);
    // ListServices and ListInstances do not support resource-level IAM scoping —
    // they require 'resources: ["*"]'. The Lambda itself filters by namespace ID.
    transformerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['servicediscovery:ListServices', 'servicediscovery:ListInstances'],
      resources: ['*'],
    }));

    // Three triggers, all running the same single pass. See the docstring on
    // transformer.handler for why it doesn't matter which one fired.

    // 1. Task state changes — the events that actually move endpoints.
    //    ECS emits one whenever a task starts, stops, or is replaced, which
    //    covers deployments, scaling and host failures alike. Reacting to
    //    the event is both faster and cheaper than waking up on a timer to
    //    ask whether anything happened.
    new events.Rule(this, 'TaskStateChange', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [props.clusterArn] },
      },
      targets: [new events_targets.LambdaFunction(transformerFn)],
    });

    // 2. Registry writes — so a new service gets config as soon as it is
    //    registered, rather than when its first task happens to report in.
    transformerFn.addEventSource(new lambda_sources.DynamoEventSource(this.registryTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(1),
      retryAttempts: 2,
    }));

    // 3. A plain schedule, as the backstop. EventBridge delivery is
    //    best-effort, so this bounds how long a dropped event can leave the
    //    mesh stale.
    new events.Rule(this, 'TransformerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new events_targets.LambdaFunction(transformerFn)],
    });

    new cdk.CfnOutput(this, 'ServiceRegistryTable', {
      value: this.registryTable.tableName,
      description: 'DynamoDB table holding the mesh service registry',
    });
  }
}
