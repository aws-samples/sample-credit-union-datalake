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
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as glue from 'aws-cdk-lib/aws-glue';
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

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // AWS Key Management Service (AWS KMS) key for encryption
    this.kmsKey = new kms.Key(this, 'CreditUnionKMSKey', {
      description: 'KMS key for Credit Union Analytics Platform',
      enableKeyRotation: true,
      alias: 'creditunion-analytics-key'
    });

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
        version: rds.MysqlEngineVersion.VER_8_0_40
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

    new cloudtrail.Trail(this, 'CreditUnionTrail', {
      bucket: trailBucket,
      trailName: 'creditunion-audit-trail',
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: new logs.LogGroup(this, 'CloudTrailLogGroup', {
        logGroupName: '/aws/cloudtrail/creditunion',
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      })
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
          reason: 'Object-level access (read/write individual keys) within scoped S3 buckets is required for ETL job execution. Wildcards apply only to object paths within specific bucket ARNs.',
          appliesTo: [
            'Resource::<CollectBucket1C9CFA0A.Arn>/*',
            'Resource::<CleanseBucket5BF2E7B2.Arn>/*',
            'Resource::<ConsumeBucketC306BBE5.Arn>/*'
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

    // Secrets Manager automatic rotation
    NagSuppressions.addResourceSuppressions(this.databaseSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Automatic rotation is documented as a post-deployment customer responsibility (P5 in README.md). Enabling rotation requires a rotation Lambda with database-specific configuration, which is intentionally left to the customer.'
      }
    ]);

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
