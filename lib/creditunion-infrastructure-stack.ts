// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as config from 'aws-cdk-lib/aws-config';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export class CreditUnionInfrastructureStack extends cdk.Stack {
  public readonly collectBucket: s3.Bucket;
  public readonly cleanseBucket: s3.Bucket;
  public readonly consumeBucket: s3.Bucket;
  public readonly kmsKey: kms.Key;
  public readonly glueRoleMysql: iam.Role;
  public readonly glueRoleXml: iam.Role;
  public readonly glueRoleCsv: iam.Role;
  public readonly glueRoleMember360: iam.Role;
  public readonly glueSecurityGroup: ec2.SecurityGroup;
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.Secret;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly vpc: ec2.Vpc;
  public readonly secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly glueSecurityConfiguration: glue.CfnSecurityConfiguration;
  public readonly breakGlassRole: iam.Role;
  public readonly dataAnalystRole: iam.Role;
  public readonly securityNotificationTopic: sns.Topic;
  public readonly lakeFormationSettings: lakeformation.CfnDataLakeSettings;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // AWS Key Management Service (AWS KMS) key for encryption
    this.kmsKey = new kms.Key(this, 'CreditUnionKMSKey', {
      description: 'KMS key for Credit Union Analytics Platform',
      enableKeyRotation: true,
      alias: 'creditunion-analytics-key'
    });

    // Allow the Amazon CloudWatch Logs service to use the key to encrypt AWS Glue job
    // log groups (the Glue security configuration enables SSE-KMS on those log groups).
    // Scoped via the encryption-context condition to log groups in this account/region.
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogsEncryption',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`)],
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:DescribeKey'
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`
        }
      }
    }));

    // AWS Glue Security Configuration — encrypts CloudWatch logs, S3 data, and job bookmarks
    // with the customer-managed AWS KMS key. Addresses cdk-nag AwsSolutions-GL1 / GL3.
    this.glueSecurityConfiguration = new glue.CfnSecurityConfiguration(this, 'GlueSecurityConfiguration', {
      name: 'creditunion-glue-security-config',
      encryptionConfiguration: {
        cloudWatchEncryption: {
          cloudWatchEncryptionMode: 'SSE-KMS',
          kmsKeyArn: this.kmsKey.keyArn
        },
        s3Encryptions: [{
          s3EncryptionMode: 'SSE-KMS',
          kmsKeyArn: this.kmsKey.keyArn
        }],
        jobBookmarksEncryption: {
          jobBookmarksEncryptionMode: 'CSE-KMS',
          kmsKeyArn: this.kmsKey.keyArn
        }
      }
    });

    // Amazon Virtual Private Cloud (Amazon VPC) for Amazon Relational Database Service (Amazon RDS) and AWS Glue
    this.vpc = new ec2.Vpc(this, 'CreditUnionVPC', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ]
    });

    // Amazon VPC endpoint for AWS Secrets Manager
    this.secretsManagerEndpoint = this.vpc.addInterfaceEndpoint('SecretsManagerVPCEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // Amazon VPC endpoint for Amazon S3
    this.vpc.addGatewayEndpoint('S3VPCEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }]
    });

    // Amazon VPC Flow Logs for network monitoring
    // Post-deployment: Configure AWS Config rules for security group change detection
    // (ec2-security-group-attached-to-eni-periodic, vpc-sg-open-only-to-authorized-ports).
    // See the Customer responsibilities section in README.md for details.
    this.vpc.addFlowLog('VpcFlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogGroup', {
          logGroupName: '/aws/vpc/creditunion-flow-logs',
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY
        })
      ),
      trafficType: ec2.FlowLogTrafficType.ALL
    });

    // Amazon S3 access logging bucket
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-access-logs`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'ExpireOldLogs', expiration: cdk.Duration.days(90) }]
    });

    // Amazon S3 buckets for data lake
    // Note: MFA Delete is not enabled because it requires root account credentials
    // and cannot be configured via AWS CDK. Approved security exception: see
    // docs/security-exceptions.md Exception 4. Post-deployment customer action (Priority P2).
    this.collectBucket = new s3.Bucket(this, 'CollectBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-collect`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'collect/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id: 'DeleteOldVersions',
        noncurrentVersionExpiration: cdk.Duration.days(30)
      }]
    });

    this.cleanseBucket = new s3.Bucket(this, 'CleanseBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-cleanse`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'cleanse/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id: 'DeleteOldVersions',
        noncurrentVersionExpiration: cdk.Duration.days(30)
      }]
    });

    this.consumeBucket = new s3.Bucket(this, 'ConsumeBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-consume`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'consume/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id: 'DeleteOldVersions',
        noncurrentVersionExpiration: cdk.Duration.days(30)
      }]
    });

    // Deploy sample data files to collect bucket
    // Deploy core banking CSV to RDS-specific folder
    new s3deploy.BucketDeployment(this, 'SampleDataDeployment', {
      sources: [s3deploy.Source.asset('./sample-data')],
      destinationBucket: this.collectBucket,
      destinationKeyPrefix: 'CreditUnionData/CoreBanking_RDS_LoadOnly/',
      exclude: ['*.xml', 'digital_banking.csv', 'loan_system_members.csv'],
      extract: true,
      prune: false
    });

    // Deploy XML files to subfolders for crawler compatibility
    new s3deploy.BucketDeployment(this, 'CreditCardsXmlDeployment', {
      sources: [s3deploy.Source.asset('./sample-data')],
      destinationBucket: this.collectBucket,
      destinationKeyPrefix: 'CreditUnionData/CreditCards/',
      exclude: ['*.csv', 'crm_system.xml'],
      extract: true,
      prune: false
    });

    new s3deploy.BucketDeployment(this, 'CrmXmlDeployment', {
      sources: [s3deploy.Source.asset('./sample-data')],
      destinationBucket: this.collectBucket,
      destinationKeyPrefix: 'CreditUnionData/CRMSystem/',
      exclude: ['*.csv', 'credit_cards.xml'],
      extract: true,
      prune: false
    });

    // Deploy CSV files to subfolders for ETL job compatibility
    new s3deploy.BucketDeployment(this, 'DigitalBankingCsvDeployment', {
      sources: [s3deploy.Source.asset('./sample-data')],
      destinationBucket: this.collectBucket,
      destinationKeyPrefix: 'CreditUnionData/DigitalBanking/',
      exclude: ['*.xml', 'core_banking_members.csv', 'loan_system_members.csv'],
      extract: true,
      prune: false
    });

    new s3deploy.BucketDeployment(this, 'LoanSystemCsvDeployment', {
      sources: [s3deploy.Source.asset('./sample-data')],
      destinationBucket: this.collectBucket,
      destinationKeyPrefix: 'CreditUnionData/LoanSystem/',
      exclude: ['*.xml', 'core_banking_members.csv', 'digital_banking.csv'],
      extract: true,
      prune: false
    });

    // Amazon Relational Database Service (Amazon RDS) for MySQL database
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      vpc: this.vpc,
      description: 'Subnet group for Credit Union database',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      }
    });

    // Security group for Amazon Relational Database Service (Amazon RDS)
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Credit Union database',
      allowAllOutbound: false
    });

    // Security group for AWS Glue jobs
    this.glueSecurityGroup = new ec2.SecurityGroup(this, 'GlueSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for AWS Glue jobs',
      allowAllOutbound: true
    });

    // AWS Glue workers communicate on all TCP ports (required by AWS Glue)
    this.glueSecurityGroup.addIngressRule(
      this.glueSecurityGroup,
      ec2.Port.allTcp(),
      'Self-referencing rule for AWS Glue worker communication'
    );

    // Allow AWS Glue to connect to Amazon RDS
    this.databaseSecurityGroup.addIngressRule(
      this.glueSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow AWS Glue jobs to connect to MySQL'
    );

    // Allow AWS Lambda (using database security group) to connect to itself for RDS access
    this.databaseSecurityGroup.addIngressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow AWS Lambda to connect to Amazon RDS for MySQL'
    );

    // Allow AWS Lambda outbound to Amazon RDS for MySQL
    this.databaseSecurityGroup.addEgressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow AWS Lambda outbound to Amazon RDS for MySQL'
    );

    // Allow AWS Lambda outbound HTTPS for S3 VPC endpoint
    this.databaseSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow Lambda HTTPS outbound for S3 and Secrets Manager VPC endpoints'
    );

    // Allow AWS Lambda to access Secrets Manager VPC endpoint
    this.secretsManagerEndpoint.connections.allowDefaultPortFrom(
      this.databaseSecurityGroup,
      'Allow Lambda to access Secrets Manager VPC endpoint'
    );

    // Note: AWS Glue connection security group access is added in the data stack

    // Create database secret
    this.databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      description: 'Credentials for Credit Union MySQL database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\'
      }
    });

    // Amazon RDS for MySQL instance
    this.database = new rds.DatabaseInstance(this, 'CreditUnionDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        // AWS retires older MySQL minor versions over time. If deployment fails with
        // "Cannot find version X for mysql", list currently available versions with:
        //   aws rds describe-db-engine-versions --engine mysql \
        //     --query "DBEngineVersions[?starts_with(EngineVersion,'8.0')].EngineVersion" --output text
        // and update the version string below to an available one.
        version: rds.MysqlEngineVersion.of('8.0.46', '8.0')
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromSecret(this.databaseSecret),
      vpc: this.vpc,
      subnetGroup: dbSubnetGroup,
      securityGroups: [this.databaseSecurityGroup],
      databaseName: 'creditunion',
      storageEncrypted: true,
      storageEncryptionKey: this.kmsKey,
      backupRetention: cdk.Duration.days(7),
      // Deletion protection prevents accidental deletion of the database.
      // Addresses cdk-nag AwsSolutions-RDS10.
      deletionProtection: true,
      // RemovalPolicy.DESTROY is used because this is a demo/sample project intended
      // to be torn down with `cdk destroy`. Production deployments should use
      // RemovalPolicy.RETAIN or SNAPSHOT to prevent data loss.
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // ==========================================================================
    // Secrets Manager automatic rotation
    // 30-day hosted single-user rotation for the RDS MySQL credential secret.
    // The rotation Lambda runs in the same VPC isolated subnets as the database,
    // behind a dedicated security group that permits only egress to the RDS
    // instance (TCP 3306) and to the Secrets Manager VPC interface endpoint
    // (TCP 443). No public access, NAT egress, or inbound is configured
    //. Single-user rotation keeps the same username, so the Glue
    // JDBC connection's resolved username stays valid.
    // ==========================================================================

    // Security group for the Secrets Manager rotation Lambda (no inbound, no
    // public access; egress is added explicitly below).
    const rotationSecurityGroup = new ec2.SecurityGroup(this, 'RotationSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Secrets Manager rotation Lambda',
      allowAllOutbound: false
    });

    // Allow the rotation Lambda outbound to the Amazon RDS instance on MySQL port
    rotationSecurityGroup.addEgressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Secrets Manager rotation Lambda outbound to Amazon RDS for MySQL'
    );

    // Allow the Amazon RDS instance to receive connections from the rotation Lambda
    this.databaseSecurityGroup.addIngressRule(
      rotationSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Secrets Manager rotation Lambda to connect to Amazon RDS for MySQL'
    );

    // Allow the rotation Lambda outbound HTTPS to the Secrets Manager VPC endpoint
    // (adds egress on the rotation SG and ingress on the endpoint SG).
    this.secretsManagerEndpoint.connections.allowDefaultPortFrom(
      rotationSecurityGroup,
      'Allow Secrets Manager rotation Lambda to access the Secrets Manager VPC endpoint'
    );

    // 30-day hosted single-user rotation. rotateImmediatelyOnUpdate is false
    // so the first rotation is deferred past deploy — an initial rotation failure
    // cannot break the hands-off deploy or stale the live credential.
    //
    // The construct id is deliberately the short 'Rotation' (not
    // 'DatabaseSecretRotation'): Secrets Manager names the generated hosted
    // rotation Lambda `<RotationSchedule logical id>-MySQLSingleUser-Lambda`, and
    // the Lambda functionName has a hard 64-character limit. A longer id pushes
    // the generated name over 64 and fails CREATE.
    this.databaseSecret.addRotationSchedule('Rotation', {
      hostedRotation: secretsmanager.HostedRotation.mysqlSingleUser({
        vpc: this.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [rotationSecurityGroup]
      }),
      automaticallyAfter: cdk.Duration.days(30),
      rotateImmediatelyOnUpdate: false
    });

    // Per-job AWS IAM roles for AWS Glue — least privilege per ETL job
    const glueBasePolicy = (buckets: s3.Bucket[]) => ({
      S3Access: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
            resources: buckets.flatMap(b => [b.bucketArn, `${b.bucketArn}/*`])
          })
        ]
      }),
      KMSAccess: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
            resources: [this.kmsKey.keyArn],
            conditions: {
              StringEquals: {
                'kms:ViaService': [
                  `s3.${cdk.Aws.REGION}.amazonaws.com`,
                  `glue.${cdk.Aws.REGION}.amazonaws.com`
                ]
              }
            }
          })
        ]
      }),
      LogsAccess: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            // The Glue security configuration enables SSE-KMS encryption on the job's
            // CloudWatch log group. AWS Glue calls logs:AssociateKmsKey at job start to
            // attach the customer-managed key; without this the job fails. Scoped to the
            // AWS Glue managed log-group path.
            actions: [
              'logs:AssociateKmsKey',
              'logs:CreateLogGroup',
              'logs:CreateLogStream',
              'logs:PutLogEvents'
            ],
            resources: [
              `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws-glue/*`
            ]
          })
        ]
      }),
      VPCAccess: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'ec2:DescribeNetworkInterfaces', 'ec2:DescribeVpcs',
              'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups'
            ],
            // AWS requires resource: '*' for EC2 Describe APIs — cannot be scoped to specific ARNs.
            // Approved security exception: see docs/security-exceptions.md Exception 1.
            // Compensated with aws:RequestedRegion condition and AWS CloudTrail auditing.
            resources: ['*'],
            conditions: {
              StringEquals: {
                'aws:RequestedRegion': [cdk.Aws.REGION]
              }
            }
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'
            ],
            resources: [
              `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:network-interface/*`,
              `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:subnet/*`,
              `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:security-group/*`
            ]
          })
        ]
      })
    });

    // MySQL ETL (AWS Glue): reads from RDS (collect), writes to cleanse
    // Note: AWSGlueServiceRole managed policy is required by AWS Glue service and contains
    // broad permissions. Approved security exception: see docs/security-exceptions.md Exception 2.
    // Compensated with per-job roles limiting Amazon S3 access to specific
    // bucket ARNs and AWS KMS access via kms:ViaService conditions. Audited via AWS CloudTrail.
    this.glueRoleMysql = new iam.Role(this, 'GlueRoleMysql', {
      roleName: `creditunion-${cdk.Aws.REGION}-glue-mysql`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      inlinePolicies: {
        ...glueBasePolicy([this.collectBucket, this.cleanseBucket]),
        SecretsManagerAccess: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            resources: [this.databaseSecret.secretArn]
          })]
        })
      }
    });

    // XML ETL (AWS Glue): reads from collect, writes to cleanse
    this.glueRoleXml = new iam.Role(this, 'GlueRoleXml', {
      roleName: `creditunion-${cdk.Aws.REGION}-glue-xml`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      inlinePolicies: glueBasePolicy([this.collectBucket, this.cleanseBucket])
    });

    // CSV ETL (AWS Glue): reads from collect, writes to cleanse
    this.glueRoleCsv = new iam.Role(this, 'GlueRoleCsv', {
      roleName: `creditunion-${cdk.Aws.REGION}-glue-csv`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      inlinePolicies: glueBasePolicy([this.collectBucket, this.cleanseBucket])
    });

    // Member 360 ETL (AWS Glue): reads from cleanse, writes to consume
    this.glueRoleMember360 = new iam.Role(this, 'GlueRoleMember360', {
      roleName: `creditunion-${cdk.Aws.REGION}-glue-member360`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      inlinePolicies: glueBasePolicy([this.cleanseBucket, this.consumeBucket])
    });

    // Amazon CloudWatch log groups
    new logs.LogGroup(this, 'GlueJobLogGroup', {
      logGroupName: '/aws-glue/jobs/creditunion',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // AWS CloudTrail for auditing all API calls
    const trailBucket = new s3.Bucket(this, 'CloudTrailBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-cloudtrail`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'cloudtrail/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const cloudTrailLogGroup = new logs.LogGroup(this, 'CloudTrailLogGroup', {
      logGroupName: '/aws/cloudtrail/creditunion',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    new cloudtrail.Trail(this, 'CreditUnionTrail', {
      bucket: trailBucket,
      trailName: 'creditunion-audit-trail',
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: cloudTrailLogGroup
    });

    // Amazon S3 bucket policies — deny access unless from approved IAM roles
    // This allows CDK deployment roles, AWS Glue roles, and Lambda roles while blocking direct access
    for (const bucket of [this.collectBucket, this.cleanseBucket, this.consumeBucket]) {
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyUnauthorizedAccess',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: {
          'ArnNotLike': {
            'aws:PrincipalArn': [
              `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/creditunion-*`,
              `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`,
              `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/CreditUnion*`,
            ]
          },
          'StringNotEquals': {
            'aws:PrincipalServiceName': [
              'cloudformation.amazonaws.com',
            ]
          }
        }
      }));
    }

    // ==========================================================================
    // Shared security principals
    // The Break_Glass_Role and Data_Analyst_Role are provisioned here and shared
    // with the Data_Stack via stack props (same pattern used for buckets/roles/VPC).
    // They are referenced as principals by the S3 version-deletion deny and
    // KMS deletion-guard policies, and as Lake Formation grant principals.
    // ==========================================================================

    // Break-glass administrative role — the only principal permitted destructive
    // KMS and S3 version-deletion actions. Scoped inline permissions only; no
    // managed policy attached. Used primarily as a stable principal reference for
    // the R3/R4 deny exceptions and R1 Lake Formation full-access grants.
    this.breakGlassRole = new iam.Role(this, 'BreakGlassRole', {
      roleName: 'creditunion-break-glass-admin',
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Emergency break-glass role for destructive KMS and S3 version-deletion actions',
      inlinePolicies: {
        // Destructive KMS actions scoped to the CUDL customer-managed key only.
        BreakGlassKmsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'],
              resources: [this.kmsKey.keyArn]
            })
          ]
        }),
        // Version-deletion and versioning-configuration actions scoped to the three
        // data-lake buckets only. DeleteObjectVersion requires object-level ARNs;
        // PutBucketVersioning targets the bucket ARN itself.
        BreakGlassS3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:DeleteObjectVersion'],
              resources: [
                `${this.collectBucket.bucketArn}/*`,
                `${this.cleanseBucket.bucketArn}/*`,
                `${this.consumeBucket.bucketArn}/*`
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:PutBucketVersioning'],
              resources: [
                this.collectBucket.bucketArn,
                this.cleanseBucket.bucketArn,
                this.consumeBucket.bucketArn
              ]
            })
          ]
        })
      }
    });

    // Data-analyst role — the concrete analyst principal targeted by the R1
    // Lake Formation column-excluded SELECT grants. Carries no IAM data-access
    // policy of its own; all data access is governed by Lake Formation.
    this.dataAnalystRole = new iam.Role(this, 'DataAnalystRole', {
      roleName: 'creditunion-data-analyst',
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Data analyst role; data access governed by Lake Formation column-level grants'
    });

    // ==========================================================================
    // AWS Lake Formation data lake administrators
    // Designate the CDK deployment / CloudFormation execution role and the
    // Break_Glass_Role as data lake administrators so the Data_Stack's Lake
    // Formation location registrations and column-level grants succeed hands-off.
    //
    // This is intentionally created in the Infrastructure_Stack (not the
    // Data_Stack where the grants live): PutDataLakeSettings is eventually
    // consistent, and designating the admin in the SAME CloudFormation operation
    // as the grants races the propagation and fails with AccessDenied
    // ("requester is not authorized"). The Infrastructure_Stack deploys and fully
    // completes before the Data_Stack changeset runs, so the admin designation is
    // propagated well before the registrations/grants execute.
    // ==========================================================================
    const bootstrapQualifier =
      this.node.tryGetContext('@aws-cdk/core:bootstrapQualifier') ??
      cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const lakeFormationAdminRoleArn = `arn:${cdk.Aws.PARTITION}:iam::${this.account}:role/cdk-${bootstrapQualifier}-cfn-exec-role-${this.account}-${this.region}`;
    this.lakeFormationSettings = new lakeformation.CfnDataLakeSettings(this, 'DataLakeSettings', {
      admins: [
        { dataLakePrincipalIdentifier: lakeFormationAdminRoleArn },
        { dataLakePrincipalIdentifier: this.breakGlassRole.roleArn }
      ]
    });

    // Break-glass role — scoped object-level S3 access for emergency version deletion.
    // s3:DeleteObjectVersion is an object-level action and requires object-path ARNs;
    // the wildcard applies only to objects within the three specific data-lake bucket
    // ARNs (not Resource::*), matching the object-level convention used by the Glue roles.
    NagSuppressions.addResourceSuppressions(this.breakGlassRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Break-glass emergency role: s3:DeleteObjectVersion is an object-level action that requires object-path ARNs. Wildcards are scoped to objects within the collect, cleanse, and consume bucket ARNs only. KMS and PutBucketVersioning permissions carry no wildcard. See docs/security-exceptions.md.',
        appliesTo: [
          'Resource::<CollectBucket1C9CFA0A.Arn>/*',
          'Resource::<CleanseBucket5BF2E7B2.Arn>/*',
          'Resource::<ConsumeBucketC306BBE5.Arn>/*'
        ]
      }
    ], true);

    // Literal ARN of the break-glass role (its physical name is fixed above).
    // Used in the R3 S3 deny and R4 KMS deny conditions INSTEAD of
    // this.breakGlassRole.roleArn. Referencing the role via Fn::GetAtt in those
    // resource policies — while the role's own inline policy references the bucket
    // and KMS key ARNs — would create a CloudFormation dependency cycle
    // (key/bucket <-> role). A literal ARN string carries no resource dependency,
    // breaking the cycle while matching identically under ArnNotLike. Partition is
    // pinned to `aws`, consistent with the existing role/cdk-* exemptions above.
    const breakGlassRoleArn = `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/creditunion-break-glass-admin`;

    // ==========================================================================
    // S3 version-deletion and versioning deny policies
    // For the three data-lake buckets ONLY (collect, cleanse, consume) — NOT the
    // access-logs or CloudTrail buckets — deny destructive version-level
    // operations to every principal except the Break_Glass_Role and the CDK /
    // CloudFormation deployment principals:
    //   - s3:DeleteObjectVersion on ${bucketArn}/*
    //   - s3:PutBucketVersioning  on ${bucketArn}
    // These statements deliberately OMIT s3:DeleteObject and s3:PutObject so the
    // ETL_Writer_Role keeps normal overwrite / current-version delete-marker
    // behavior; versioning stays enabled. Exemptions are expressed
    // via an aws:PrincipalArn ArnNotLike condition (Break_Glass_Role ARN, the CDK
    // deployment principals role/cdk-* and role/CreditUnion* — which covers the
    // autoDeleteObjects purge role created under the stack name) plus a
    // StringNotEquals carve-out for the cloudformation.amazonaws.com service
    // principal, mirroring the DenyUnauthorizedAccess statement above. Because the
    // deny only applies when ALL conditions are true, any exempted principal (or a
    // CloudFormation service-principal call) is not denied, so autoDeleteObjects
    // still empties the buckets on destroy and create/update versioning
    // configuration is not blocked.
    const versionDenyExemptions = {
      ArnNotLike: {
        'aws:PrincipalArn': [
          breakGlassRoleArn,
          `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`,
          `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/CreditUnion*`,
        ]
      },
      StringNotEquals: {
        'aws:PrincipalServiceName': [
          'cloudformation.amazonaws.com',
        ]
      }
    };

    for (const bucket of [this.collectBucket, this.cleanseBucket, this.consumeBucket]) {
      // Deny s3:DeleteObjectVersion on object versions (object-level ARN)
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyObjectVersionDeletion',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:DeleteObjectVersion'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: versionDenyExemptions
      }));

      // Deny s3:PutBucketVersioning on the bucket itself
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyVersioningConfigurationChange',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutBucketVersioning'],
        resources: [bucket.bucketArn],
        conditions: versionDenyExemptions
      }));
    }

    // ==========================================================================
    // Shared security notification topic
    // A single KMS-encrypted, SSL-enforced Amazon SNS topic is shared by the
    // R4 KMS-deletion EventBridge rule and the three R6 CloudWatch alarms. It is
    // exposed as a public readonly property and consumed by those controls.
    // ==========================================================================
    this.securityNotificationTopic = new sns.Topic(this, 'SecurityNotificationTopic', {
      topicName: 'creditunion-security-notifications',
      masterKey: this.kmsKey,   // AwsSolutions-SNS2 — encryption at rest with the CUDL CMK
      enforceSSL: true          // AwsSolutions-SNS3 — deny non-TLS publish/subscribe via topic policy
    });

    // KMS key-policy grants so EventBridge and CloudWatch can publish to
    // the encrypted topic. Both services must call kms:GenerateDataKey* and kms:Decrypt
    // to produce the data key that encrypts the published message. Scoped by
    // aws:SourceArn to CUDL EventBridge rules and CloudWatch alarms in this account/region.
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEventBridgePublishToEncryptedTopic',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'aws:SourceArn': `arn:aws:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:rule/*`
        }
      }
    }));

    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsPublishToEncryptedTopic',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'aws:SourceArn': `arn:aws:cloudwatch:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alarm:*`
        }
      }
    }));

    // ==========================================================================
    // KMS key deletion guard and monitoring
    // Destructive KMS operations on the CUDL customer-managed key are restricted
    // to the Break_Glass_Role (and, for ScheduleKeyDeletion, the CDK deployment
    // role so `cdk destroy` works), and an EventBridge rule routes any such API
    // call to the shared security SNS topic for detection.
    //
    // Lockout avoidance: denials are CONDITION-based on an
    // aws:PrincipalArn ArnNotLike condition, NEVER NotPrincipal, and the account
    // root ARN is ALWAYS in the exception list. A Deny that catches root (or uses
    // NotPrincipal) can produce an unrecoverable key policy. Because the deny only
    // applies when the calling principal is NOT in the exemption list, root, the
    // Break_Glass_Role, and the CDK deployment role are never denied, keeping the
    // key recoverable and `cdk destroy` (which schedules deletion via the
    // deployment role under RemovalPolicy.DESTROY) unblocked. Auto key
    // rotation (enableKeyRotation: true) is retained on the key above.
    // ==========================================================================

    // The account root ARN is always exempt so the key never becomes unrecoverable.
    const accountRootArn = `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:root`;
    // The CDK deployment role pattern (consistent with the role/cdk-* exemptions
    // used in the S3 bucket policies above) — schedules key deletion on destroy.
    const cdkDeploymentRoleArn = `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`;

    // Deny kms:ScheduleKeyDeletion to every principal except the account root,
    // the Break_Glass_Role, and the CDK deployment role.
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyScheduleKeyDeletion',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['kms:ScheduleKeyDeletion'],
      resources: ['*'],
      conditions: {
        ArnNotLike: {
          'aws:PrincipalArn': [
            accountRootArn,
            breakGlassRoleArn,
            cdkDeploymentRoleArn
          ]
        }
      }
    }));

    // Deny kms:DisableKey to every principal except the account root and the
    // Break_Glass_Role. cdk deploy/destroy never disables the key, so the
    // CDK deployment role is intentionally not exempted here.
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyDisableKey',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['kms:DisableKey'],
      resources: ['*'],
      conditions: {
        ArnNotLike: {
          'aws:PrincipalArn': [
            accountRootArn,
            breakGlassRoleArn
          ]
        }
      }
    }));

    // EventBridge rule on the default bus matching CloudTrail-delivered KMS API
    // calls (ScheduleKeyDeletion / DisableKey) against the CUDL key, routed to the
    // shared security SNS topic. The existing CloudTrail trail already
    // captures management events; delivery is within the CloudTrail
    // management-event window. The rule and topic are stack-managed and
    // removed on destroy.
    new events.Rule(this, 'KmsKeyDeletionGuardRule', {
      ruleName: 'creditunion-kms-deletion-guard',
      description: 'Alerts on kms:ScheduleKeyDeletion / kms:DisableKey against the CUDL key',
      eventPattern: {
        source: ['aws.kms'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['kms.amazonaws.com'],
          eventName: ['ScheduleKeyDeletion', 'DisableKey'],
          requestParameters: {
            keyId: [this.kmsKey.keyArn, this.kmsKey.keyId]
          }
        }
      },
      targets: [new targets.SnsTopic(this.securityNotificationTopic)]
    });

    // ==========================================================================
    // Detective CloudWatch metric filters and alarms
    // Two metric filters on the existing /aws/cloudtrail/creditunion log group
    // turn CloudTrail-delivered events into custom metrics, and three alarms route
    // to the shared security SNS topic. All alarms use a threshold of
    // >= 1, a 300-second period, and treatMissingData = NOT_BREACHING so that an
    // absence of matching events does not place the alarm in ALARM state.
    // The CloudTrail log group and trail are pre-existing/stack-managed and retained
    // independently; the metric filters and alarms are stack-managed and removed on
    // destroy.
    // ==========================================================================

    const SECURITY_METRIC_NAMESPACE = 'CreditUnion/Security';
    const alarmSnsAction = new cloudwatch_actions.SnsAction(this.securityNotificationTopic);

    // Metric filter: KMS deletion/disable attempts.
    // Matches CloudTrail records for kms:ScheduleKeyDeletion or kms:DisableKey.
    const kmsDeletionMetricFilter = cloudTrailLogGroup.addMetricFilter('KmsDeletionMetricFilter', {
      filterName: 'creditunion-kms-deletion',
      filterPattern: logs.FilterPattern.any(
        logs.FilterPattern.stringValue('$.eventName', '=', 'ScheduleKeyDeletion'),
        logs.FilterPattern.stringValue('$.eventName', '=', 'DisableKey')
      ),
      metricNamespace: SECURITY_METRIC_NAMESPACE,
      metricName: 'KmsDeletionAttempts',
      metricValue: '1',
      defaultValue: 0
    });

    // Metric filter: unauthorized API calls.
    // Matches CloudTrail records whose errorCode is *UnauthorizedOperation or AccessDenied*.
    const unauthorizedApiMetricFilter = cloudTrailLogGroup.addMetricFilter('UnauthorizedApiMetricFilter', {
      filterName: 'creditunion-unauthorized-api',
      filterPattern: logs.FilterPattern.any(
        logs.FilterPattern.stringValue('$.errorCode', '=', '*UnauthorizedOperation'),
        logs.FilterPattern.stringValue('$.errorCode', '=', 'AccessDenied*')
      ),
      metricNamespace: SECURITY_METRIC_NAMESPACE,
      metricName: 'UnauthorizedApiCalls',
      metricValue: '1',
      defaultValue: 0
    });

    // Alarm 1: KMS ScheduleKeyDeletion / DisableKey attempts.
    new cloudwatch.Alarm(this, 'KmsDeletionAlarm', {
      alarmName: 'creditunion-kms-deletion-attempts',
      alarmDescription: 'Triggers on kms:ScheduleKeyDeletion / kms:DisableKey attempts against the CUDL key',
      metric: kmsDeletionMetricFilter.metric({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5)
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }).addAlarmAction(alarmSnsAction);

    // Alarm 2: Step Functions ExecutionsFailed for the ETL state machine.
    // The metric is built BY ARN/dimensions using the known state-machine name to
    // avoid a circular cross-stack reference (Infrastructure is created before ETL).
    const etlStateMachineArn = `arn:aws:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:creditunion-etl-state-machine`;
    new cloudwatch.Alarm(this, 'EtlExecutionsFailedAlarm', {
      alarmName: 'creditunion-etl-executions-failed',
      alarmDescription: 'Triggers when the creditunion-etl-state-machine reports a failed execution',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName: 'ExecutionsFailed',
        dimensionsMap: {
          StateMachineArn: etlStateMachineArn
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5)
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }).addAlarmAction(alarmSnsAction);

    // Alarm 3: unauthorized API calls.
    new cloudwatch.Alarm(this, 'UnauthorizedApiAlarm', {
      alarmName: 'creditunion-unauthorized-api-calls',
      alarmDescription: 'Triggers on AccessDenied / UnauthorizedOperation API calls recorded in CloudTrail',
      metric: unauthorizedApiMetricFilter.metric({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5)
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }).addAlarmAction(alarmSnsAction);

    // ==========================================================================
    // AWS Config rules + optional configuration recorder
    // Two AWS managed Config rules are ALWAYS emitted regardless of the flag
    //; they evaluate against whatever configuration
    // recorder is present in the account/region. The recorder, delivery channel,
    // and Config role are gated behind the `provisionConfigRecorder` CDK context
    // flag, which DEFAULTS TO FALSE. Because an account/region
    // supports only one configuration recorder, AWS::Config::ConfigurationRecorder
    // creation FAILS the deployment if one already exists and CloudFormation does
    // NOT overwrite it — this is the natural CFN behavior, no extra code.
    // On destroy, only CUDL-provisioned resources are removed; a pre-existing
    // recorder is never deleted or modified.
    // ==========================================================================

    // Rule 1: security groups may only open ports in an authorized set,
    // which defaults to EMPTY (any 0.0.0.0/0 or ::/0 inbound TCP/UDP port is
    // non-compliant). The optional authorizedTcpPorts/authorizedUdpPorts input
    // parameters are intentionally OMITTED rather than passed as empty strings:
    // AWS Config rejects blank parameter values ("Blank spaces are not acceptable
    // for input parameter") at create time, and an absent parameter is treated as
    // an empty authorized set — i.e. no open port is permitted by default.
    new config.CfnConfigRule(this, 'SgOpenOnlyToAuthorizedPortsRule', {
      configRuleName: 'creditunion-vpc-sg-open-only-to-authorized-ports',
      description: 'Flags security groups that allow unrestricted inbound access (0.0.0.0/0 or ::/0) on TCP or UDP ports outside the authorized set (defaults to empty).',
      source: {
        owner: 'AWS',
        sourceIdentifier: 'VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS'
      }
    });

    // Rule 2: the CUDL VPC's default security group must allow no inbound
    // or outbound traffic. Scoped to the VPC default security group resource id
    // so the rule targets only the CUDL VPC's default SG.
    new config.CfnConfigRule(this, 'DefaultSecurityGroupClosedRule', {
      configRuleName: 'creditunion-default-security-group-closed',
      description: 'Flags the CUDL VPC default security group as non-compliant if it allows any inbound or outbound traffic.',
      source: {
        owner: 'AWS',
        sourceIdentifier: 'VPC_DEFAULT_SECURITY_GROUP_CLOSED'
      },
      scope: {
        complianceResourceTypes: ['AWS::EC2::SecurityGroup'],
        complianceResourceId: this.vpc.vpcDefaultSecurityGroup
      }
    });

    // Optional configuration recorder / delivery channel / Config role.
    // Read the flag from CDK context; only `=== true` enables provisioning so an
    // unset or non-true value defaults to false.
    const provisionConfigRecorder = this.node.tryGetContext('provisionConfigRecorder') === true;
    if (provisionConfigRecorder) {
      // Dedicated S3 bucket for AWS Config snapshot/history delivery, following
      // the existing data-lake bucket conventions (KMS encryption, block public
      // access, enforce SSL, versioned, DESTROY + autoDelete, access logging).
      const configBucket = new s3.Bucket(this, 'ConfigBucket', {
        bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-config`,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: this.kmsKey,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        serverAccessLogsBucket: this.accessLogsBucket,
        serverAccessLogsPrefix: 'config/',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true
      });

      // Config service role using the AWS managed AWS_ConfigRole policy. This
      // raises AwsSolutions-IAM4; the suppression (appliesTo pinned to
      // AWS_ConfigRole) is deferred to task 5.1. Because the recorder is gated
      // behind a default-false flag, the default synth path never includes this
      // role, so the default cdk-nag run stays clean.
      const configRole = new iam.Role(this, 'ConfigRole', {
        roleName: `creditunion-${cdk.Aws.REGION}-config-recorder`,
        assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
        description: 'Service role for the optional AWS Config configuration recorder',
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')
        ]
      });

      // Allow AWS Config to write encrypted snapshots to the Config bucket.
      configBucket.grantWrite(configRole);

      // Exactly one configuration recorder. Records all supported
      // resource types so the security-group rules have configuration items to
      // evaluate against.
      const configurationRecorder = new config.CfnConfigurationRecorder(this, 'ConfigurationRecorder', {
        name: 'creditunion-config-recorder',
        roleArn: configRole.roleArn,
        recordingGroup: {
          allSupported: true,
          includeGlobalResourceTypes: true
        }
      });

      // Exactly one delivery channel delivering to the dedicated bucket.
      const deliveryChannel = new config.CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
        name: 'creditunion-config-delivery-channel',
        s3BucketName: configBucket.bucketName
      });

      // The delivery channel must exist alongside the recorder; order their
      // creation so the bucket grant is in place before the recorder starts.
      deliveryChannel.node.addDependency(configurationRecorder);

      // cdk-nag suppressions for the optional Config recorder role.
      // Added inside the gated block so they only apply when the role exists.
      // See docs/security-exceptions.md (Exception 6).
      NagSuppressions.addResourceSuppressions(configRole, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'The AWS managed AWS_ConfigRole policy is required by the AWS Config configuration recorder service role to read configuration items across supported resource types. It cannot be replaced with a custom policy without breaking AWS Config. Exception 6 in docs/security-exceptions.md.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWS_ConfigRole']
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Object-level write access (s3:PutObject* / s3:Abort*) plus the corresponding KMS wildcards (kms:GenerateDataKey* / kms:ReEncrypt*) on the dedicated, KMS-encrypted Config delivery bucket are required for AWS Config to deliver configuration snapshots/history. The wildcards are scoped to the Config bucket object path and the data-lake customer-managed key only. Exception 6 in docs/security-exceptions.md.'
        }
      ], true);
    }

    // Outputs
    new cdk.CfnOutput(this, 'CollectBucketName', {
      value: this.collectBucket.bucketName,
      description: 'S3 bucket for raw data collection'
    });

    new cdk.CfnOutput(this, 'CleanseBucketName', {
      value: this.cleanseBucket.bucketName,
      description: 'S3 bucket for cleansed data'
    });

    new cdk.CfnOutput(this, 'ConsumeBucketName', {
      value: this.consumeBucket.bucketName,
      description: 'S3 bucket for analytics-ready data'
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      description: 'Amazon RDS for MySQL database endpoint'
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'Secret ARN for database credentials'
    });

    new cdk.CfnOutput(this, 'GlueRoleArn', {
      value: this.glueRoleMysql.roleArn,
      description: 'IAM role for MySQL AWS Glue job'
    });

    // ==========================================================================
    // cdk-nag suppressions — documented security exceptions
    // See docs/security-exceptions.md for full justification of each item.
    // ==========================================================================

    // VPC endpoint SecurityGroup — EC23 false positive due to intrinsic function
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/CreditUnionVPC/SecretsManagerVPCEndpoint/SecurityGroup/Resource`
    ], [
      {
        id: 'CdkNagValidationFailure',
        reason: 'Rule cannot be evaluated because the VPC CIDR block is a CDK token resolved at deploy time. The security group is scoped to this VPC only and is only reachable by the Lambda security group via allowDefaultPortFrom.'
      }
    ]);

    // All 4 Glue per-job roles + EC2 Describe wildcards (Exceptions 1 and 2)
    for (const glueRole of [this.glueRoleMysql, this.glueRoleXml, this.glueRoleCsv, this.glueRoleMember360]) {
      NagSuppressions.addResourceSuppressions(glueRole, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSGlueServiceRole managed policy is required by the AWS Glue service for job execution. Exception 2 in docs/security-exceptions.md. Compensating controls: per-job roles, scoped inline policies, kms:ViaService conditions, CloudTrail auditing.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSGlueServiceRole']
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Object-level access (read/write individual keys) within scoped S3 buckets, and logs:AssociateKmsKey on the AWS Glue managed log-group path, are required for ETL job execution with the Glue security configuration. Wildcards apply only to object paths within specific bucket ARNs and to the /aws-glue/* log-group namespace.',
          appliesTo: [
            'Resource::<CollectBucket1C9CFA0A.Arn>/*',
            'Resource::<CleanseBucket5BF2E7B2.Arn>/*',
            'Resource::<ConsumeBucketC306BBE5.Arn>/*',
            'Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws-glue/*'
          ]
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'AWS EC2 Describe APIs require resource: \'*\' and do not support resource-level permissions. Exception 1 in docs/security-exceptions.md. Compensated with aws:RequestedRegion condition and CloudTrail auditing.',
          appliesTo: [
            'Resource::*',
            'Resource::arn:aws:ec2:<AWS::Region>:<AWS::AccountId>:network-interface/*',
            'Resource::arn:aws:ec2:<AWS::Region>:<AWS::AccountId>:security-group/*',
            'Resource::arn:aws:ec2:<AWS::Region>:<AWS::AccountId>:subnet/*'
          ]
        }
      ], true);
    }

    // RDS findings
    NagSuppressions.addResourceSuppressions(this.database, [
      {
        id: 'AwsSolutions-RDS3',
        reason: 'Multi-AZ is not enabled for this demo/sample project to minimize cost. Production deployments should enable multi-AZ via the `multiAz: true` property. Documented as customer responsibility.'
      },
      {
        id: 'AwsSolutions-RDS11',
        reason: 'Default port 3306 is retained for compatibility with standard MySQL tooling. Network-level protection is provided via isolated subnets and security group scoping (only Glue and Lambda security groups can reach the database).'
      }
    ]);

    // Secrets Manager automatic rotation is configured via a 30-day hosted
    // single-user rotation schedule (see the rotation block above), so the
    // AwsSolutions-SMG4 suppression is intentionally removed.

    // CDK-generated BucketDeployment Lambda (internal CDK construct)
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource`,
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is applied by the CDK BucketDeployment construct. The construct is managed by AWS CDK and cannot be customized.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions are defined by the CDK BucketDeployment construct to support uploading sample data to the target bucket. The construct is managed by AWS CDK and its DefaultPolicy cannot be customized. Suppression is account/region-agnostic because the resolved bucket ARNs include the account ID and region.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Lambda runtime is managed by the AWS CDK BucketDeployment construct and updates with CDK library upgrades.'
      }
    ]);
  }
}
