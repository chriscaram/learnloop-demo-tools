// The Activity Simulator in AWS, so the presenter runs it from a browser instead of a
// terminal: CloudFront (asks for a password) -> VPC origin -> internal load balancer ->
// one Fargate task running `npm run simulator` in cloud mode (../Dockerfile).
//
// Decisions this stack holds, and why:
//
//  - Its own stack, its own tags (Application=telemetry-activity-simulator), deployed from THIS
//    repository and never from LearnLoop's: the Governance Agent reads LearnLoop's code and
//    scans the account by LearnLoop's application tag, and the simulator is the behaviour
//    model it must not see.
//  - The password is checked at the edge, by a CloudFront Function, before anything reaches
//    the server. The function holds only the SHA-256 of the expected Authorization header
//    (context `authHash`); the password itself is in Secrets Manager, written by
//    scripts/cloud.mjs, never in the template.
//  - No VPC of its own: the account is at its VPC (and internet gateway) limit in us-east-1, so
//    the stack uses the account's DEFAULT VPC and adds two private subnets to it
//    (PRIVATE_SUBNETS, each with its own route table holding only the local route). The load
//    balancer is internal, in those two subnets; only CloudFront's VPC origin reaches it. The
//    task sits in the default VPC's public subnets of the same two zones (a public IP for its
//    outbound calls to S3, CloudFormation, Secrets Manager and ECR, so no NAT gateway) and
//    accepts traffic from the load balancer only.
//  - One task at most (minHealthyPercent 0, maxHealthyPercent 100): the server's "one action
//    at a time" lock lives in its memory, so two tasks would be two locks over one state.
//  - desiredCount 0: it runs only when started (scripts/cloud.mjs start). A deploy sets it
//    back to 0; the deploy script starts it again when it was running.
//  - state/, out/ and the seed folder live on EFS (/data), so a restart does not forget which
//    stage is loaded on which target.
//  - The task role reads the two LearnLoop stacks' outputs and their pseudonym salts (not the
//    JWT secrets), and reads/writes/deletes in exactly their three buckets each (context
//    `learnloop`, read from the stack outputs by the deploy script). Nothing else.
//  - The image is built by CodeBuild from an S3 asset of this repository, not on the
//    operator's machine.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { basicAuthFunctionCode } from './edge-auth.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = 8790;
/** The CodeBuild source: the repository minus what the image never copies (../.dockerignore mirrors it). */
/** Added to the default VPC (172.31.0.0/16; its default subnets take 172.31.0.0 … 172.31.95.255). */
export const PRIVATE_SUBNETS = Object.freeze([
  { availabilityZone: 'us-east-1a', cidrBlock: '172.31.96.0/24' },
  { availabilityZone: 'us-east-1b', cidrBlock: '172.31.97.0/24' },
]);
export const ASSET_EXCLUDE = ['.git', 'node_modules', 'out', 'state', 'infra', 'test', 'docs'];

export class SimulatorStack extends cdk.Stack {
  /**
   * props.authHash  hex SHA-256 of "Basic base64(user:password)"
   * props.learnloop [{ stack, buckets: [3 names], saltSecret }] one per deployed LearnLoop stack
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const { authHash, learnloop } = props;
    if (!Array.isArray(learnloop) || learnloop.length === 0) throw new Error('context learnloop must list at least one deployed LearnLoop stack (scripts/cloud.mjs deploy reads them)');

    // ------------------------------------------------------------------ image
    const repo = new ecr.Repository(this, 'Repo', {
      repositoryName: 'telemetry-activity-simulator',
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 5 }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    const source = new s3assets.Asset(this, 'Source', { path: REPO_ROOT, exclude: ASSET_EXCLUDE });
    const build = new codebuild.Project(this, 'ImageBuild', {
      projectName: 'telemetry-activity-simulator-image',
      description: 'Builds the Activity Simulator image from this repository and pushes it as :latest',
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, privileged: true, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: { REPO_URI: { value: repo.repositoryUri } },
      timeout: cdk.Duration.minutes(20),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: ['aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPO_URI%%/*}"'] },
          build: { commands: ['docker build -t "$REPO_URI:latest" .'] },
          post_build: { commands: ['docker push "$REPO_URI:latest"'] },
        },
      }),
    });
    repo.grantPullPush(build);
    source.grantRead(build);

    // ------------------------------------------------------------------ network
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });
    const zones = PRIVATE_SUBNETS.map((p) => p.availabilityZone);
    // ec2.Subnet makes a route table of its own with only the local route: no way out
    const privateSubnets = PRIVATE_SUBNETS.map((p, i) => new ec2.Subnet(this, `Private${i + 1}`, { vpcId: vpc.vpcId, ...p, mapPublicIpOnLaunch: false }));
    // the zones of the private subnets; on the lookup's first pass (a placeholder VPC with
    // dummy zones, before the CDK has read the account) the first two, so the lookup can happen
    const publicSubnets = zones.map((az, i) => vpc.publicSubnets.find((x) => x.availabilityZone === az) ?? vpc.publicSubnets[i]);
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'Simulator load balancer: CloudFront VPC origin only', allowAllOutbound: true });
    const cloudfrontPl = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', { prefixListName: 'com.amazonaws.global.cloudfront.origin-facing' });
    albSg.addIngressRule(ec2.Peer.prefixList(cloudfrontPl.prefixListId), ec2.Port.tcp(80), 'CloudFront origin-facing');
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: privateSubnets },
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(120),
    });
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', { vpc, description: 'Simulator task: the load balancer only', allowAllOutbound: true });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(PORT), 'from the load balancer');

    // ------------------------------------------------------------------ storage
    const fs = new efs.FileSystem(this, 'Data', {
      vpc,
      vpcSubnets: { subnets: publicSubnets },
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });
    fs.connections.allowDefaultPortFrom(taskSg);
    const ap = fs.addAccessPoint('SimulatorData', {
      path: '/simulator',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
    });

    // ------------------------------------------------------------------ edge
    const authFn = new cloudfront.Function(this, 'BasicAuth', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Asks for the simulator password',
      code: cloudfront.FunctionCode.fromInline(basicAuthFunctionCode(authHash)),
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Telemetry Activity Simulator',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
          readTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // never compressed: a compressed event stream would be held back in chunks
        compress: false,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // the viewer's Host (the CloudFront domain) and Origin reach the server, which checks both
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        functionAssociations: [{ function: authFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
    });

    // ------------------------------------------------------------------ service
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: 'telemetry-activity-simulator' });
    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      volumes: [{
        name: 'data',
        efsVolumeConfiguration: { fileSystemId: fs.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: ap.accessPointId, iam: 'ENABLED' } },
      }],
    });
    fs.grant(taskDef.taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const container = taskDef.addContainer('simulator', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      portMappings: [{ containerPort: PORT }],
      environment: {
        SIMULATOR_PUBLIC_HOST: distribution.distributionDomainName,
        AWS_REGION: this.region,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'simulator', logGroup }),
    });
    container.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false });

    // what the simulator touches, and nothing else
    const role = taskDef.taskRole;
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: learnloop.map((l) => `arn:aws:cloudformation:${this.region}:${this.account}:stack/${l.stack}/*`),
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: learnloop.map((l) => `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${l.saltSecret}-*`),
    }));
    const buckets = learnloop.flatMap((l) => l.buckets);
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: buckets.map((b) => `arn:aws:s3:::${b}`) }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: buckets.map((b) => `arn:aws:s3:::${b}/*`) }));

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: 'telemetry-activity-simulator',
      taskDefinition: taskDef,
      desiredCount: 0,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      assignPublicIp: true,
      vpcSubnets: { subnets: publicSubnets },
      securityGroups: [taskSg],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
    });
    const listener = alb.addListener('Http', { port: 80, open: false });
    listener.addTargets('Simulator', {
      port: PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(10),
      healthCheck: { path: '/healthz', healthyHttpCodes: '200', interval: cdk.Duration.seconds(15), healthyThresholdCount: 2 },
    });

    new cdk.CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'ImageBuildProject', { value: build.projectName });
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}
