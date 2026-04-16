// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as signer from 'aws-cdk-lib/aws-signer';
import { RdsDataLoader } from './rds-data-loader';
import { Construct } from 'constructs';

interface CreditUnionDataStackProps extends cdk.StackProps {
  collectBucket: s3.Bucket;
  cleanseBucket: s3.Bucket;
  consumeBucket: s3.Bucket;
  glueRoleMysql: iam.Role;
  glueSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.Secret;
  databaseSecurityGroup: ec2.SecurityGroup;
  vpc: ec2.Vpc;
  secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
}

export class CreditUnionDataStack extends cdk.Stack {
  public readonly glueConnection: glue.CfnConnection;
  public readonly cleanseDatabase: glue.CfnDatabase;
  public readonly consumeDatabase: glue.CfnDatabase;
  public readonly xmlCatalogDatabase: glue.CfnDatabase;
  public readonly rdsDataLoader: RdsDataLoader;
  public readonly crawlerTriggerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: CreditUnionDataStackProps) {
    super(scope, id, props);

    // Amazon Relational Database Service (Amazon RDS) data loader - runs after all networking is established
    this.rdsDataLoader = new RdsDataLoader(this, 'RdsDataLoader', {
      vpc: props.vpc,
      database: props.database,
      databaseSecret: props.databaseSecret,
      collectBucket: props.collectBucket,
      secretsManagerEndpoint: props.secretsManagerEndpoint
    });

    // AWS Glue databases
    this.cleanseDatabase = new glue.CfnDatabase(this, 'CleanseDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'creditunion_cleanse',
        description: 'Credit Union cleansed data catalog'
      }
    });

    this.consumeDatabase = new glue.CfnDatabase(this, 'ConsumeDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'creditunion_consume',
        description: 'Credit Union analytics-ready data catalog'
      }
    });

    this.xmlCatalogDatabase = new glue.CfnDatabase(this, 'XMLCatalogDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'creditunion_xml_catalog',
        description: 'Credit Union XML data catalog'
      }
    });

    // AWS Glue connection for MySQL
    this.glueConnection = new glue.CfnConnection(this, 'MySQLConnection', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      connectionInput: {
        name: 'creditunion-mysql-connection',
        description: 'Connection to Credit Union MySQL database',
        connectionType: 'JDBC',
        connectionProperties: {
          JDBC_CONNECTION_URL: `jdbc:mysql://${props.database.instanceEndpoint.hostname}:3306/creditunion?useSSL=true&requireSSL=true`,
          USERNAME: `{{resolve:secretsmanager:${props.databaseSecret.secretArn}:SecretString:username}}`,
          PASSWORD: `{{resolve:secretsmanager:${props.databaseSecret.secretArn}:SecretString:password}}`
        },
        physicalConnectionRequirements: {
          availabilityZone: props.vpc.availabilityZones[0],
          subnetId: props.vpc.privateSubnets[0].subnetId,
          securityGroupIdList: [props.glueSecurityGroup.securityGroupId]
        }
      }
    });

    // Core Banking Members Table (Cleanse)
    new glue.CfnTable(this, 'CoreBankingMembersTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.cleanseDatabase.ref,
      tableInput: {
        name: 'core_banking_members',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          columns: [
            { name: 'member_number', type: 'int' },
            { name: 'ssn', type: 'string' },
            { name: 'first_name', type: 'string' },
            { name: 'last_name', type: 'string' },
            { name: 'dob', type: 'date' },
            { name: 'address', type: 'string' },
            { name: 'city', type: 'string' },
            { name: 'state', type: 'string' },
            { name: 'zip', type: 'string' },
            { name: 'phone', type: 'string' },
            { name: 'join_date', type: 'date' },
            { name: 'checking_balance', type: 'decimal(10,2)' },
            { name: 'savings_balance', type: 'decimal(10,2)' },
            { name: 'created_date', type: 'timestamp' },
            { name: 'updated_date', type: 'timestamp' }
          ],
          location: `s3://${props.cleanseBucket.bucketName}/CreditUnionData/core_banking_members/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
          }
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
          { name: 'hour', type: 'string' }
        ]
      }
    });

    // Digital Banking Table (Cleanse)
    new glue.CfnTable(this, 'DigitalBankingTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.cleanseDatabase.ref,
      tableInput: {
        name: 'digital_banking',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          columns: [
            { name: 'digital_user_id', type: 'string' },
            { name: 'username', type: 'string' },
            { name: 'email_address', type: 'string' },
            { name: 'full_name', type: 'string' },
            { name: 'phone', type: 'string' },
            { name: 'last_login', type: 'string' },
            { name: 'mobile_app_user', type: 'string' },
            { name: 'online_banking_user', type: 'string' },
            { name: 'bill_pay_enrolled', type: 'string' },
            { name: 'account_alerts', type: 'string' }
          ],
          location: `s3://${props.cleanseBucket.bucketName}/CreditUnionData/DigitalBanking/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
          }
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
          { name: 'hour', type: 'string' }
        ]
      }
    });

    // Loan System Members Table (Cleanse)
    new glue.CfnTable(this, 'LoanSystemMembersTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.cleanseDatabase.ref,
      tableInput: {
        name: 'loan_system_members',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          columns: [
            { name: 'loan_member_id', type: 'string' },
            { name: 'ssn_last_4', type: 'string' },
            { name: 'borrower_name', type: 'string' },
            { name: 'home_address', type: 'string' },
            { name: 'city', type: 'string' },
            { name: 'state', type: 'string' },
            { name: 'postal_code', type: 'string' },
            { name: 'phone_number', type: 'string' },
            { name: 'loan_amount', type: 'string' },
            { name: 'loan_type', type: 'string' },
            { name: 'interest_rate', type: 'string' },
            { name: 'term_months', type: 'string' },
            { name: 'application_date', type: 'string' }
          ],
          location: `s3://${props.cleanseBucket.bucketName}/CreditUnionData/LoanSystem/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
          }
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
          { name: 'hour', type: 'string' }
        ]
      }
    });

    // Member Profile Table (Consume)
    // Post-deployment: Configure AWS Lake Formation for column-level access controls.
    // Priority: HIGH | Risk reduction: Prevents unauthorized access to SSN and PII columns
    // Steps:
    //   1. aws lakeformation register-resource --resource-arn <consume-bucket-arn>
    //   2. aws lakeformation grant-permissions --principal '{"DataLakePrincipalIdentifier":"arn:aws:iam::ACCOUNT:role/analyst-role"}' \
    //        --resource '{"Table":{"DatabaseName":"creditunion_consume","Name":"member_profile","ColumnWildcard":{"ExcludedColumnNames":["ssn","ssn_last_4","ssn_last_4_key"]}}}' \
    //        --permissions SELECT
    //   3. Verify: aws lakeformation get-effective-permissions-for-path --resource-arn <consume-bucket-arn>
    // See the Customer responsibilities section in README.md for details.
    new glue.CfnTable(this, 'MemberProfileTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.consumeDatabase.ref,
      tableInput: {
        name: 'member_profile',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          columns: [
            { name: 'golden_member_id', type: 'string' },
            { name: 'member_number', type: 'int' },
            { name: 'first_name', type: 'string' },
            { name: 'last_name', type: 'string' },
            { name: 'date_of_birth', type: 'date' },
            { name: 'address', type: 'string' },
            { name: 'city', type: 'string' },
            { name: 'state', type: 'string' },
            { name: 'zip', type: 'string' },
            { name: 'phone', type: 'string' },
            { name: 'member_since', type: 'date' },
            { name: 'checking_balance', type: 'decimal(12,2)' },
            { name: 'savings_balance', type: 'decimal(12,2)' },
            { name: 'total_balance', type: 'decimal(13,2)' },
            { name: 'digital_user_id', type: 'string' },
            { name: 'username', type: 'string' },
            { name: 'email', type: 'string' },
            { name: 'last_login', type: 'string' },
            { name: 'mobile_app_user', type: 'string' },
            { name: 'online_banking_user', type: 'string' },
            { name: 'bill_pay_enrolled', type: 'string' },
            { name: 'account_alerts', type: 'string' },
            { name: 'digital_engagement_score', type: 'int' },
            { name: 'ssn_last_4_key', type: 'string' },
            { name: 'full_name_key', type: 'string' },
            { name: 'primary_source', type: 'string' },
            { name: 'match_confidence', type: 'int' },
            { name: 'resolution_method', type: 'string' },
            { name: 'created_date', type: 'timestamp' },
            { name: 'ssn_last_4', type: 'string' },
            { name: 'phone_number', type: 'string' },
            { name: 'total_loans', type: 'int' },
            { name: 'total_loan_amount', type: 'double' },
            { name: 'interest_rate', type: 'double' },
            { name: 'loan_type', type: 'string' },
            { name: 'term_months', type: 'string' },
            { name: 'application_date', type: 'string' },
            { name: 'crm_email', type: 'string' },
            { name: 'last_contact_date', type: 'string' },
            { name: 'preferred_channel', type: 'string' },
            { name: 'marketing_consent', type: 'boolean' },
            { name: 'card_limit_amount', type: 'int' },
            { name: 'card_type', type: 'string' },
            { name: 'product_count', type: 'int' },
            { name: 'risk_category', type: 'string' },
            { name: 'data_quality_score', type: 'int' },
            { name: 'runid', type: 'string' }
          ],
          location: `s3://${props.consumeBucket.bucketName}/CreditUnionData/member_profile/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
          }
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
          { name: 'hour', type: 'string' }
        ]
      }
    });

    // AWS Glue XML crawlers for Credit Cards and CRM
    // Note: AWSGlueServiceRole managed policy is required by AWS Glue crawlers.
    // Approved security exception: see docs/security-exceptions.md Exception 2.
    // Compensated with inline policies scoping Amazon S3 access to collect bucket only.
    const xmlCrawlerRole = new iam.Role(this, 'XMLCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')
      ],
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.collectBucket.bucketArn,
                `${props.collectBucket.bucketArn}/*`
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [props.collectBucket.encryptionKey!.keyArn]
            })
          ]
        })
      }
    });

    // Credit Cards XML Crawler
    const creditCardsCrawlerResource = new glue.CfnCrawler(this, 'CreditCardsXMLCrawler', {
      name: 'creditunion-creditcards-xml-crawler',
      role: xmlCrawlerRole.roleArn,
      databaseName: this.xmlCatalogDatabase.ref,
      targets: {
        s3Targets: [{
          path: `s3://${props.collectBucket.bucketName}/CreditUnionData/CreditCards/`
        }]
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG'
      }
    });

    // CRM XML Crawler
    const crmCrawlerResource = new glue.CfnCrawler(this, 'CRMXMLCrawler', {
      name: 'creditunion-crm-xml-crawler',
      role: xmlCrawlerRole.roleArn,
      databaseName: this.xmlCatalogDatabase.ref,
      targets: {
        s3Targets: [{
          path: `s3://${props.collectBucket.bucketName}/CreditUnionData/CRMSystem/`
        }]
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG'
      }
    });

    // Code signing for crawler trigger Lambda
    const crawlerSigningProfile = new signer.SigningProfile(this, 'CrawlerSigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
      signatureValidity: cdk.Duration.days(365),
    });

    const crawlerCodeSigningConfig = new lambda.CodeSigningConfig(this, 'CrawlerCodeSigningConfig', {
      signingProfiles: [crawlerSigningProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.WARN,
    });

    // AWS Lambda function to trigger crawlers
    this.crawlerTriggerFunction = new lambda.Function(this, 'CrawlerTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      codeSigningConfig: crawlerCodeSigningConfig,
      code: lambda.Code.fromInline(`
import boto3
import json

def handler(event, context):
    glue = boto3.client('glue')
    
    crawlers = ['${creditCardsCrawlerResource.ref}', '${crmCrawlerResource.ref}']
    
    for crawler_name in crawlers:
        try:
            glue.start_crawler(Name=crawler_name)
            print(f'Started crawler: {crawler_name}')
        except Exception as e:
            print(f'Error starting crawler {crawler_name}: {str(e)}')
    
    return {'statusCode': 200, 'body': json.dumps('Crawlers triggered')}
`),
      timeout: cdk.Duration.minutes(5)
    });

    this.crawlerTriggerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['glue:StartCrawler', 'glue:GetCrawler'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:crawler/${creditCardsCrawlerResource.ref}`,
        `arn:aws:glue:${this.region}:${this.account}:crawler/${crmCrawlerResource.ref}`
      ]
    }));

    // Custom resource to trigger crawlers on deployment
    // Note: Crawlers can be manually triggered after deployment
    // aws lambda invoke --function-name [function-name] --region us-west-2 /tmp/response.json

    // Outputs
    new cdk.CfnOutput(this, 'GlueConnectionName', {
      value: this.glueConnection.ref,
      description: 'AWS Glue connection for MySQL database'
    });

    new cdk.CfnOutput(this, 'CleanseDatabaseName', {
      value: this.cleanseDatabase.ref,
      description: 'AWS Glue database for cleansed data'
    });

    new cdk.CfnOutput(this, 'ConsumeDatabaseName', {
      value: this.consumeDatabase.ref,
      description: 'AWS Glue database for analytics-ready data'
    });

    new cdk.CfnOutput(this, 'RdsLambdaFunctionName', {
      value: this.rdsDataLoader.lambda.functionName,
      description: 'Name of the RDS data loader Lambda function'
    });

    new cdk.CfnOutput(this, 'CrawlerLambdaFunctionName', {
      value: this.crawlerTriggerFunction.functionName,
      description: 'Name of the crawler trigger Lambda function'
    });
  }
}
