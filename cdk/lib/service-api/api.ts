import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';
import { MeshRef } from '../mesh';

export interface MeshServiceApiProps {
  /** Bucket the pre-synthesized templates are uploaded to. */
  xdsBucket: s3.IBucket;
  /** Service registry table, read to answer GET /services. */
  registryTable: dynamodb.ITable;
  /** Shared mesh infrastructure. */
  mesh: MeshRef;
  /** Prefix the mesh publishes its SSM parameters under. */
  prefix: string;
  /** Roles the templates attach to task definitions; CloudFormation needs
   *  iam:PassRole on them. */
  passRoleArns: string[];
  /** Images behind the "demo" and "perf" shortcuts. */
  images: { demo: string; perf: string };
}

/**
 * REST entrypoint for the mesh: services and load tests, each created as its
 * own CloudFormation stack from a template synthesized at build time (see
 * `npm run synth:templates`).
 */
export class MeshServiceApi extends Construct {
  public readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: MeshServiceApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const apiDir = path.join(__dirname, '..', '..', '..', 'service-api');

    new s3deploy.BucketDeployment(this, 'DeployTemplates', {
      sources: [s3deploy.Source.asset(apiDir, { exclude: ['*', '!*-template.json'] })],
      destinationBucket: props.xdsBucket,
      destinationKeyPrefix: 'service-api',
      prune: false,
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(apiDir, { exclude: ['*-template.json'] }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SERVICE_TEMPLATE_URL: props.xdsBucket.urlForObject('service-api/service-template.json'),
        LOAD_TEMPLATE_URL: props.xdsBucket.urlForObject('service-api/load-template.json'),
        DEMO_IMAGE: props.images.demo,
        PERF_IMAGE: props.images.perf,
        REGISTRY_TABLE: props.registryTable.tableName,
        CLUSTER: props.mesh.clusterName,
        MESH_DOMAIN: props.mesh.meshDomain,
      },
    });
    props.registryTable.grantReadData(fn);
    props.xdsBucket.grantRead(fn);

    const allow = (actions: string[], resources: string[]) =>
      fn.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));

    // Create and delete service and load-test stacks, and nothing else.
    allow(['cloudformation:CreateStack', 'cloudformation:DeleteStack'], ['mesh-svc-*', 'mesh-load-*']
      .map(resourceName => stack.formatArn({
        service: 'cloudformation', resource: 'stack', resourceName,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      })));
    allow(['cloudformation:DescribeStacks', 'cloudformation:ListStacks'], ['*']);

    // CloudFormation runs those templates with this role's identity, so it
    // needs everything their resources do across create and delete, including
    // the tagging and describe calls the resource handlers make internally.
    allow([
      'ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeTaskDefinition',
      'ecs:CreateService', 'ecs:DeleteService', 'ecs:UpdateService', 'ecs:DescribeServices',
      'ecs:TagResource', 'ecs:UntagResource',
      'servicediscovery:CreateService', 'servicediscovery:DeleteService', 'servicediscovery:GetService',
      'servicediscovery:TagResource', 'servicediscovery:UntagResource',
      'servicediscovery:ListTagsForResource',
      'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DescribeLogGroups',
      'logs:PutRetentionPolicy', 'logs:TagResource', 'logs:UntagResource',
      'logs:ListTagsForResource',
    ], ['*']);
    allow(['iam:PassRole'], props.passRoleArns);
    allow(['ssm:GetParameters'], [stack.formatArn({
      service: 'ssm', resource: 'parameter', resourceName: `${props.prefix}-mesh/*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    })]);
    allow(['lambda:InvokeFunction'], [props.mesh.registryWriterArn]);

    // GET /load/{target} reads each window's results from the load
    // generator's logs.
    allow(['logs:FilterLogEvents'], [stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: `/ecs/${props.mesh.meshDomain}/*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })]);

    // /execute: find a service's task and host, then docker exec through SSM.
    // AWS-managed SSM documents live in the `aws` namespace, not this account.
    allow(['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:DescribeContainerInstances'], ['*']);
    allow(['ssm:SendCommand'], [
      `arn:aws:ec2:${stack.region}:${stack.account}:instance/*`,
      'arn:aws:ssm:*::document/AWS-RunShellScript',
    ]);
    allow(['ssm:GetCommandInvocation'], ['*']);

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: 'mesh-service-api',
      description: 'Mesh services and load tests',
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
      // Sized for a room creating services at once. The stage limit is one
      // bucket shared by every method, so 10/s would turn a few hundred
      // simultaneous POSTs into a few hundred 429s.
      deployOptions: { stageName: 'v1', throttlingRateLimit: 500, throttlingBurstLimit: 1000 },
    });
    const integration = new apigw.LambdaIntegration(fn);
    const crud = (collection: string, key: string) => {
      const list = this.api.root.addResource(collection);
      list.addMethod('GET', integration);
      const item = list.addResource(`{${key}}`);
      for (const method of ['POST', 'GET', 'DELETE']) item.addMethod(method, integration);
      return item;
    };

    crud('services', 'name').addResource('execute').addMethod('POST', integration);
    crud('load', 'target');
  }
}
