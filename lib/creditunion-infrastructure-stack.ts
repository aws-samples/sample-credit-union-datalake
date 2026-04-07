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
import { Construct } from 'constructs';

export class CreditUnionInfrastructureStack extends cdk.Stack {
  public readonly collectBucket: s3.Bucket;
  public readonly cleanseBucket: s3.Bucket;
  public readonly consumeBucket: s3.Bucket;
  public readonly kmsKey: kms.Key;
  public readonly glueRole: iam.Role;
  public readonly glueSecurityGroup: ec2.SecurityGroup;
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.Secret;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly vpc: ec2.Vpc;
  public readonly secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS Key for encryption
    this.kmsKey = new kms.Key(this, 'CreditUnionKMSKey', {
      description: 'KMS key for Credit Union Analytics Platform',
      enableKeyRotation: true,
      alias: 'creditunion-analytics-key'
    });

    // VPC for RDS and Glue
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

    // VPC Endpoint for Secrets Manager
    this.secretsManagerEndpoint = this.vpc.addInterfaceEndpoint('SecretsManagerVPCEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // VPC Endpoint for S3
    this.vpc.addGatewayEndpoint('S3VPCEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }]
    });

    // S3 Buckets for Data Lake
    this.collectBucket = new s3.Bucket(this, 'CollectBucket', {
      bucketName: `creditunion-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}-collect`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
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

    // RDS MySQL Database
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      vpc: this.vpc,
      description: 'Subnet group for Credit Union database',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      }
    });

    // Security group for RDS
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Credit Union database',
      allowAllOutbound: false
    });

    // Security group for Glue jobs
    this.glueSecurityGroup = new ec2.SecurityGroup(this, 'GlueSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Glue jobs',
      allowAllOutbound: true
    });

    // Add self-referencing rule for Glue workers to communicate
    this.glueSecurityGroup.addIngressRule(
      this.glueSecurityGroup,
      ec2.Port.allTraffic(),
      'Self-referencing rule for Glue workers'
    );

    // Allow Glue to connect to RDS
    this.databaseSecurityGroup.addIngressRule(
      this.glueSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Glue jobs to connect to MySQL'
    );

    // Allow Lambda (using database security group) to connect to itself for RDS access
    this.databaseSecurityGroup.addIngressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Lambda to connect to RDS MySQL'
    );

    // Allow Lambda outbound to RDS MySQL
    this.databaseSecurityGroup.addEgressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Lambda outbound to RDS MySQL'
    );

    // Allow Lambda outbound HTTPS for S3 VPC endpoint
    this.databaseSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow Lambda HTTPS outbound for S3 and Secrets Manager VPC endpoints'
    );

    // Allow Lambda to access Secrets Manager VPC endpoint
    this.secretsManagerEndpoint.connections.allowDefaultPortFrom(
      this.databaseSecurityGroup,
      'Allow Lambda to access Secrets Manager VPC endpoint'
    );

    // Note: Glue connection security group access is added in the data stack

    // Create database secret
    this.databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      description: 'Credentials for Credit Union MySQL database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\'
      }
    });

    // RDS MySQL Instance
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
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // IAM Role for Glue Jobs
    this.glueRole = new iam.Role(this, 'CreditUnionGlueRole', {
      roleName: `creditunion-${cdk.Aws.REGION}-glue-role`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')
      ],
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
                's3:ListBucket'
              ],
              resources: [
                this.collectBucket.bucketArn,
                `${this.collectBucket.bucketArn}/*`,
                this.cleanseBucket.bucketArn,
                `${this.cleanseBucket.bucketArn}/*`,
                this.consumeBucket.bucketArn,
                `${this.consumeBucket.bucketArn}/*`
              ]
            })
          ]
        }),
        KMSAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'kms:Decrypt',
                'kms:GenerateDataKey',
                'kms:DescribeKey'
              ],
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
        SecretsManagerAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret'
              ],
              resources: [this.databaseSecret.secretArn]
            })
          ]
        }),
        VPCAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:CreateNetworkInterface',
                'ec2:DeleteNetworkInterface',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeVpcs',
                'ec2:DescribeSubnets',
                'ec2:DescribeSecurityGroups'
              ],
              resources: ['*']
            })
          ]
        })
      }
    });

    // CloudWatch Log Groups
    new logs.LogGroup(this, 'GlueJobLogGroup', {
      logGroupName: '/aws-glue/jobs/creditunion',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

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
      description: 'RDS MySQL database endpoint'
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'Secret ARN for database credentials'
    });

    new cdk.CfnOutput(this, 'GlueRoleArn', {
      value: this.glueRole.roleArn,
      description: 'IAM role for Glue jobs'
    });
  }
}
