import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Construct } from 'constructs';

export class EcsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub リポジトリ情報をパラメータとして定義
    const githubUserName = new cdk.CfnParameter(this, "githubUserName", {
      type: "String",
      description: "Github username for source code repository"
    });

    const githubRepository = new cdk.CfnParameter(this, "githubRespository", {
      type: "String",
      description: "Github source code repository",
      default: "amazon-ecs-fargate-cdk-v2-cicd"
    });

    const githubPersonalTokenSecretName = new cdk.CfnParameter(this, "githubPersonalTokenSecretName", {
      type: "String",
      description: "The name of the AWS Secrets Manager Secret which holds the GitHub Personal Access Token for this project.",
      default: "/aws-samples/amazon-ecs-fargate-cdk-v2-cicd/github/personal_access_token"
    });

    // Amazon ECR リポジトリを作成
    const ecrRepo = new ecr.Repository(this, 'ecrRepo');

    /**
     * 新しい VPC を作成。パブリックサブネットを含み、1つの NAT Gateway を利用。
     */
    const vpc = new ec2.Vpc(this, 'ecs-cdk-vpc', {
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        // 必要に応じてプライベートや分離されたサブネットを追加
      ],
      natGateways: 1,
      maxAzs: 2
    });

    // ECS クラスターの管理者 IAM ロール
    const clusteradmin = new iam.Role(this, 'adminrole', {
      assumedBy: new iam.AccountRootPrincipal()
    });

    // ECS クラスターの作成
    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc: vpc,
    });

    // ログ設定
    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs"
    });

    // ECS タスク IAM ロールを作成
    const taskrole = new iam.Role(this, `ecs-taskrole-${this.stackName}`, {
      roleName: `ecs-taskrole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    // タスク実行用ポリシー
    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:getdownloadurlforlayer",
        "ecr:batchgetimage",
        "logs:createlogstream",
        "logs:putlogevents"
      ]
    });

    // Fargate タスク定義を作成
    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskrole,
      family: `ecs-taskdef-${this.stackName}`,
    });

    // 実行ロールにポリシーを追加
    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    // Streamlit アプリ用のコンテナ設定
    const baseImage = 'public.ecr.aws/docker/library/python:3.11-slim';
    const container = taskDef.addContainer('streamlit-app', {
      image: ecs.ContainerImage.fromRegistry(baseImage), // Streamlit用のイメージ
      memoryLimitMiB: 512, // メモリを増やす（推奨）
      cpu: 256,
      logging
    });

    // コンテナポートのマッピング
    container.addPortMappings({
      containerPort: 8501, // Streamlitのデフォルトポート
      protocol: ecs.Protocol.TCP
    });

    // Fargate サービスの作成（ALB 経由）
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "ecs-service", {
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      desiredCount: 1,
      listenerPort: 80
    });    

    // Auto Scaling 設定
    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 4 });
    scaling.scaleOnCpuUtilization('cpuscaling', {
      targetUtilizationPercent: 10,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });

    // GitHub ソースコード設定
    const gitHubSource = codebuild.Source.gitHub({
      owner: githubUserName.valueAsString,
      repo: githubRepository.valueAsString,
      webhook: true,
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
      ],
    });

    // CodeBuild プロジェクト設定
    const project = new codebuild.Project(this, 'myProject', {
      projectName: `${this.stackName}`,
      source: gitHubSource,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
        privileged: true
      },
      environmentVariables: {
        'cluster_name': {
          value: `${cluster.clusterName}`
        },
        'ecr_repo_uri': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      badge: true,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export tag=latest',
            ]
          },
          build: {
            commands: [
              `docker build -t $ecr_repo_uri:$tag .`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ecr_repo_uri:$tag'
            ]
          },
          post_build: {
            commands: [
              'echo "in post-build stage"',
              'cd ..',
              "printf '[{\"name\":\"streamlit-app\",\"imageUri\":\"%s\"}]' $ecr_repo_uri:$tag > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })      
    });

    // パイプライン設定
    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();
    const nameOfGithubPersonTokenParameterAsString = githubPersonalTokenSecretName.valueAsString;

    // GitHub からソースコードを取得
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'github_source',
      owner: githubUserName.valueAsString,
      repo: githubRepository.valueAsString,
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager(nameOfGithubPersonTokenParameterAsString),
      output: sourceOutput
    });

    // CodeBuild アクション
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'codebuild',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    // 手動承認ステージ
    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'approve',
    });

    // ECS デプロイアクション
    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'deployAction',
      service: fargateService.service,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });

    // パイプラインのステージ定義
    new codepipeline.Pipeline(this, 'myecspipeline', {
      stages: [
        {
          stageName: 'source',
          actions: [sourceAction],
        },
        {
          stageName: 'build',
          actions: [buildAction],
        },
        {
          stageName: 'approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'deploy-to-ecs',
          actions: [deployAction],
        }
      ]
    });

    // ECR リポジトリへのアクセス許可
    ecrRepo.grantPullPush(project.role!);
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:describecluster",
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:batchgetimage",
        "ecr:getdownloadurlforlayer"
      ],
      resources: [`${cluster.clusterArn}`],
    }));

    // 出力設定
    new cdk.CfnOutput(this, "image", { value: ecrRepo.repositoryUri + ":latest" });
    new cdk.CfnOutput(this, 'loadbalancerdns', { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}
