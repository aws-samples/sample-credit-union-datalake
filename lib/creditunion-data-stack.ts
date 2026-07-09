// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { RdsDataLoader } from './rds-data-loader';
import { SignedLambdaArtifact } from './signed-lambda-artifact';
import { Construct } from 'constructs';

interface CreditUnionDataStackProps extends cdk.StackProps {
  collectBucket: s3.Bucket;
  cleanseBucket: s3.Bucket;
  consumeBucket: s3.Bucket;
  accessLogsBucket: s3.Bucket;
  glueRoleMysql: iam.Role;
  glueRoleXml: iam.Role;
  glueRoleCsv: iam.Role;
  glueRoleMember360: iam.Role;
  glueSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.Secret;
  databaseSecurityGroup: ec2.SecurityGroup;
  vpc: ec2.Vpc;
  secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
  breakGlassRole: iam.Role;
  dataAnalystRole: iam.Role;
}

export class CreditUnionDataStack extends cdk.Stack {
  public readonly glueConnection: glue.CfnConnection;
  public readonly cleanseDatabase: glue.CfnDatabase;
  public readonly consumeDatabase: glue.CfnDatabase;
  public readonly xmlCatalogDatabase: glue.CfnDatabase;
  public readonly rdsDataLoader: RdsDataLoader;
  public readonly crawlerTriggerFunction: lambda.Function;
  public readonly consumeBucketRegistration: lakeformation.CfnResource;
  public readonly cleanseBucketRegistration: lakeformation.CfnResource;

  constructor(scope: Construct, id: string, props: CreditUnionDataStackProps) {
    super(scope, id, props);

    // Amazon Relational Database Service (Amazon RDS) data loader - runs after all networking is established
    this.rdsDataLoader = new RdsDataLoader(this, 'RdsDataLoader', {
      vpc: props.vpc,
      database: props.database,
      databaseSecret: props.databaseSecret,
      collectBucket: props.collectBucket,
      secretsManagerEndpoint: props.secretsManagerEndpoint,
      accessLogsBucket: props.accessLogsBucket
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

    // ==========================================================================
    // AWS Lake Formation — location registration
    // Implements column-level access controls as deployed CDK resources. Column
    // grants follow below.
    //
    // The data lake ADMINISTRATOR designation (CfnDataLakeSettings) lives in the
    // Infrastructure_Stack, which deploys first. PutDataLakeSettings is eventually
    // consistent; designating the admin in the same CloudFormation operation as
    // these registrations/grants races propagation and fails with AccessDenied.
    // Because the Infrastructure_Stack fully completes before this stack's
    // changeset runs (Data depends on Infra via props), the admin is already
    // propagated here, so no intra-stack dependency on the settings is needed.
    // ==========================================================================

    // CfnResource — register the consume and cleanse bucket locations in hybrid
    // access mode using an EXPLICIT registration role (NOT the Lake Formation
    // service-linked role). The SLR path cannot deregister the *last* S3 location
    // without manually deleting the SLR, which wedges `cdk destroy` in DELETE_FAILED
    // (violating the clean-teardown invariant). An explicit role
    // deregisters cleanly. The role is assumed by Lake Formation to read/write the
    // registered data-lake buckets on behalf of LF-governed queries.
    const lfRegistrationRole = new iam.Role(this, 'LakeFormationRegistrationRole', {
      roleName: `creditunion-${cdk.Aws.REGION}-lf-registration`,
      assumedBy: new iam.ServicePrincipal('lakeformation.amazonaws.com'),
      description: 'Role Lake Formation assumes to access registered CUDL data-lake S3 locations'
    });
    props.consumeBucket.grantReadWrite(lfRegistrationRole);
    props.cleanseBucket.grantReadWrite(lfRegistrationRole);

    this.consumeBucketRegistration = new lakeformation.CfnResource(this, 'ConsumeBucketLFRegistration', {
      resourceArn: props.consumeBucket.bucketArn,
      useServiceLinkedRole: false,
      roleArn: lfRegistrationRole.roleArn,
      hybridAccessEnabled: true
    });
    this.consumeBucketRegistration.node.addDependency(lfRegistrationRole);

    this.cleanseBucketRegistration = new lakeformation.CfnResource(this, 'CleanseBucketLFRegistration', {
      resourceArn: props.cleanseBucket.bucketArn,
      useServiceLinkedRole: false,
      roleArn: lfRegistrationRole.roleArn,
      hybridAccessEnabled: true
    });
    this.cleanseBucketRegistration.node.addDependency(lfRegistrationRole);

    // The registration role's read/write access to the (KMS-encrypted) data-lake
    // buckets is granted via bucket.grantReadWrite, which emits the object-level
    // S3 wildcards and the corresponding KMS wildcards LF needs to broker access.
    NagSuppressions.addResourceSuppressions(lfRegistrationRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Lake Formation data-location registration role: object-level read/write on the consume and cleanse data-lake buckets (and the corresponding KMS data-key actions) is required for Lake Formation to broker access to LF-governed locations. Wildcards are scoped to those specific bucket ARNs and the data-lake CMK. See docs/security-exceptions.md.'
      }
    ], true);



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
    const coreBankingMembersTable = new glue.CfnTable(this, 'CoreBankingMembersTable', {
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
    const loanSystemMembersTable = new glue.CfnTable(this, 'LoanSystemMembersTable', {
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
    // Column-level access control for the SSN/PII columns on this table is now
    // deployed in code via the AWS Lake Formation CfnPrincipalPermissions grants
    // below (analyst SELECT with ssn/ssn_last_4/ssn_last_4_key excluded), rather
    // than as a post-deployment customer CLI step.
    const memberProfileTable = new glue.CfnTable(this, 'MemberProfileTable', {
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

    // ==========================================================================
    // AWS Lake Formation — column-level permission grants. These
    // CfnPrincipalPermissions are ordered after the data lake
    // settings and the bucket-location registrations (settings → registration →
    // grants) and depend on the Glue tables they reference so the catalog
    // objects exist before the grants are applied. On destroy, CloudFormation
    // removes the grants before deregistering the locations.
    // ==========================================================================

    // Analyst SELECT with the SSN-bearing columns excluded on
    // creditunion_consume.member_profile. The consume-zone golden record stores
    // only TOKENIZED SSN — the columns `ssn_last_4` and `ssn_last_4_key` — and has
    // no full `ssn` column. Lake Formation validates ExcludedColumnNames against
    // the actual table schema and rejects the grant ("Resource does not exist") if
    // any named column is absent, so the exclusion set MUST match real columns.
    // (The earlier ['ssn','ssn_last_4','ssn_last_4_key'] set included a non-existent
    // 'ssn' column and failed to deploy.)
    const analystMemberProfileGrant = new lakeformation.CfnPrincipalPermissions(this, 'AnalystMemberProfileGrant', {
      principal: { dataLakePrincipalIdentifier: props.dataAnalystRole.roleArn },
      resource: {
        tableWithColumns: {
          catalogId: this.account,
          databaseName: 'creditunion_consume',
          name: 'member_profile',
          columnWildcard: { excludedColumnNames: ['ssn_last_4', 'ssn_last_4_key'] }
        }
      },
      permissions: ['SELECT'],
      permissionsWithGrantOption: []
    });
    analystMemberProfileGrant.node.addDependency(this.consumeBucketRegistration);
    analystMemberProfileGrant.node.addDependency(memberProfileTable);

    // Analyst SELECT with 'ssn' excluded on creditunion_cleanse.core_banking_members.
    const analystCoreBankingGrant = new lakeformation.CfnPrincipalPermissions(this, 'AnalystCoreBankingMembersGrant', {
      principal: { dataLakePrincipalIdentifier: props.dataAnalystRole.roleArn },
      resource: {
        tableWithColumns: {
          catalogId: this.account,
          databaseName: 'creditunion_cleanse',
          name: 'core_banking_members',
          columnWildcard: { excludedColumnNames: ['ssn'] }
        }
      },
      permissions: ['SELECT'],
      permissionsWithGrantOption: []
    });
    analystCoreBankingGrant.node.addDependency(this.cleanseBucketRegistration);
    analystCoreBankingGrant.node.addDependency(coreBankingMembersTable);

    // Analyst SELECT with 'ssn_last_4' excluded on creditunion_cleanse.loan_system_members.
    const analystLoanSystemGrant = new lakeformation.CfnPrincipalPermissions(this, 'AnalystLoanSystemMembersGrant', {
      principal: { dataLakePrincipalIdentifier: props.dataAnalystRole.roleArn },
      resource: {
        tableWithColumns: {
          catalogId: this.account,
          databaseName: 'creditunion_cleanse',
          name: 'loan_system_members',
          columnWildcard: { excludedColumnNames: ['ssn_last_4'] }
        }
      },
      permissions: ['SELECT'],
      permissionsWithGrantOption: []
    });
    analystLoanSystemGrant.node.addDependency(this.cleanseBucketRegistration);
    analystLoanSystemGrant.node.addDependency(loanSystemMembersTable);

    // Full SELECT (all columns) for the ETL_Writer_Role (per-job Glue role that writes
    // data-lake objects) and the Break_Glass_Role, so pipeline processing and emergency
    // access retain all columns including the SSN columns. A `table` resource
    // (no column wildcard) grants access to every column.
    const fullAccessTables: Array<{ id: string; databaseName: string; name: string; table: glue.CfnTable; registration: lakeformation.CfnResource }> = [
      { id: 'MemberProfile', databaseName: 'creditunion_consume', name: 'member_profile', table: memberProfileTable, registration: this.consumeBucketRegistration },
      { id: 'CoreBankingMembers', databaseName: 'creditunion_cleanse', name: 'core_banking_members', table: coreBankingMembersTable, registration: this.cleanseBucketRegistration },
      { id: 'LoanSystemMembers', databaseName: 'creditunion_cleanse', name: 'loan_system_members', table: loanSystemMembersTable, registration: this.cleanseBucketRegistration }
    ];

    const fullAccessPrincipals: Array<{ id: string; arn: string }> = [
      { id: 'EtlWriter', arn: props.glueRoleMysql.roleArn },
      { id: 'BreakGlass', arn: props.breakGlassRole.roleArn }
    ];

    for (const principal of fullAccessPrincipals) {
      for (const target of fullAccessTables) {
        const grant = new lakeformation.CfnPrincipalPermissions(this, `${principal.id}${target.id}FullSelectGrant`, {
          principal: { dataLakePrincipalIdentifier: principal.arn },
          resource: {
            table: {
              catalogId: this.account,
              databaseName: target.databaseName,
              name: target.name
            }
          },
          permissions: ['SELECT'],
          permissionsWithGrantOption: []
        });
        grant.node.addDependency(target.registration);
        grant.node.addDependency(target.table);
      }
    }

    // ==========================================================================
    // AWS Lake Formation — DATA_LOCATION_ACCESS for the ETL writer roles.
    //
    // Registering the cleanse and consume buckets with Lake Formation means LF
    // brokers ALL access to those locations. DATA_LOCATION_ACCESS is the one LF
    // permission the default IAMAllowedPrincipals fallback never covers, so any
    // per-job Glue role that WRITES data to a registered location (a Glue Studio
    // getSink(path="s3://<bucket>/...", connection_type="s3").writeFrame, incl.
    // enableUpdateCatalog catalog writes) must hold it explicitly. Without it the
    // job fails with "Insufficient Lake Formation permission(s) on s3://...".
    //
    // Table READS continue to resolve through IAMAllowedPrincipals (the per-job
    // roles carry IAM S3/KMS access), and the analyst column controls are
    // unaffected: the data-analyst role has NO IAM data access and relies solely
    // on its column-excluded SELECT grant, so this does not widen analyst access.
    //
    // Data flow (see per-job role comments in the Infrastructure_Stack):
    //   - mysql / xml / csv jobs write to the CLEANSE location
    //   - member360 job writes to the CONSUME location
    // ==========================================================================
    const dataLocationGrants: Array<{ id: string; roleArn: string; bucketArn: string; registration: lakeformation.CfnResource }> = [
      { id: 'MysqlCleanseLocation', roleArn: props.glueRoleMysql.roleArn, bucketArn: props.cleanseBucket.bucketArn, registration: this.cleanseBucketRegistration },
      { id: 'XmlCleanseLocation', roleArn: props.glueRoleXml.roleArn, bucketArn: props.cleanseBucket.bucketArn, registration: this.cleanseBucketRegistration },
      { id: 'CsvCleanseLocation', roleArn: props.glueRoleCsv.roleArn, bucketArn: props.cleanseBucket.bucketArn, registration: this.cleanseBucketRegistration },
      { id: 'Member360ConsumeLocation', roleArn: props.glueRoleMember360.roleArn, bucketArn: props.consumeBucket.bucketArn, registration: this.consumeBucketRegistration }
    ];

    for (const grant of dataLocationGrants) {
      const locationGrant = new lakeformation.CfnPrincipalPermissions(this, `${grant.id}Grant`, {
        principal: { dataLakePrincipalIdentifier: grant.roleArn },
        resource: {
          dataLocation: {
            catalogId: this.account,
            resourceArn: grant.bucketArn
          }
        },
        permissions: ['DATA_LOCATION_ACCESS'],
        permissionsWithGrantOption: []
      });
      locationGrant.node.addDependency(grant.registration);
    }

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
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.ENFORCE,
    });

    // Versioned, KMS-encrypted artifacts bucket used as the AWS Signer source/destination
    // for the crawler-trigger handler. Reuses the data-lake customer-managed key and the
    // infrastructure access-logs bucket (avoids AwsSolutions-S1 on the artifacts bucket).
    const crawlerArtifactsBucket = SignedLambdaArtifact.createArtifactsBucket(
      this,
      'CrawlerSigningArtifactsBucket',
      props.collectBucket.encryptionKey!,
      {
        serverAccessLogsBucket: props.accessLogsBucket,
        serverAccessLogsPrefix: 'crawler-trigger-signing/',
      }
    );

    // Sign the externalized handler asset (lambda/crawler-trigger/index.py).
    const signedCrawlerHandler = new SignedLambdaArtifact(this, 'CrawlerHandlerArtifact', {
      artifactsBucket: crawlerArtifactsBucket,
      signingProfile: crawlerSigningProfile,
      assetPath: path.join(__dirname, '..', 'lambda', 'crawler-trigger'),
    });

    // AWS Lambda function to trigger crawlers. The crawler names were previously
    // token-interpolated into the inline source; they are now passed as environment
    // variables so the signed asset file (lambda/crawler-trigger/index.py) is static.
    this.crawlerTriggerFunction = new lambda.Function(this, 'CrawlerTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      codeSigningConfig: crawlerCodeSigningConfig,
      code: signedCrawlerHandler.signedCode,
      environment: {
        CREDIT_CARDS_CRAWLER: creditCardsCrawlerResource.ref,
        CRM_CRAWLER: crmCrawlerResource.ref
      },
      timeout: cdk.Duration.minutes(5)
    });

    // Ensure the signed object exists before the function is created/updated.
    this.crawlerTriggerFunction.node.addDependency(signedCrawlerHandler);

    this.crawlerTriggerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['glue:StartCrawler', 'glue:GetCrawler'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:crawler/${creditCardsCrawlerResource.ref}`,
        `arn:aws:glue:${this.region}:${this.account}:crawler/${crmCrawlerResource.ref}`
      ]
    }));

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

    // ==========================================================================
    // cdk-nag suppressions — documented security exceptions
    // See docs/security-exceptions.md for full justification of each item.
    // ==========================================================================

    // XML crawler role — uses AWSGlueServiceRole (Exception 2)
    NagSuppressions.addResourceSuppressions(xmlCrawlerRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSGlueServiceRole managed policy is required by AWS Glue crawlers. Exception 2 in docs/security-exceptions.md. Compensated with inline policies scoping S3 access to collect bucket only.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSGlueServiceRole']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Object-level read access within the scoped collect bucket is required for crawler operation.',
        appliesTo: [{ regex: '/^Resource::.*CollectBucket.*Arn.*\\/\\*$/g' }]
      }
    ], true);

    // RDS data loader Lambda — uses AWSLambdaVPCAccessExecutionRole (Exception 3)
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/RdsDataLoader/RdsLoaderRole/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaVPCAccessExecutionRole required for Lambda functions deployed in a VPC. Exception 3 in docs/security-exceptions.md. Compensated with private subnet, security group restrictions, and code signing.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Object-level access to collect bucket is required for uploading loaded data.',
        appliesTo: [{ regex: '/^Resource::.*CollectBucket.*Arn.*\\/\\*$/g' }]
      }
    ]);

    // Crawler trigger Lambda — CDK default role
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/CrawlerTriggerFunction/ServiceRole/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard execution role for Lambda CloudWatch logging. Equivalent custom policy would only duplicate these permissions.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      }
    ]);

    // Crawler warnings — GL1 (CloudWatch encryption) not applicable at CfnCrawler level;
    // encryption is enforced via the Glue security configuration attached to Glue jobs.
    NagSuppressions.addResourceSuppressions(creditCardsCrawlerResource, [
      {
        id: 'AwsSolutions-GL1',
        reason: 'Glue crawlers inherit encryption via the account-level Glue security configuration (creditunion-glue-security-config) created in the infrastructure stack. CloudWatch logs for crawler output are encrypted via KMS.'
      }
    ]);
    NagSuppressions.addResourceSuppressions(crmCrawlerResource, [
      {
        id: 'AwsSolutions-GL1',
        reason: 'Glue crawlers inherit encryption via the account-level Glue security configuration (creditunion-glue-security-config) created in the infrastructure stack. CloudWatch logs for crawler output are encrypted via KMS.'
      }
    ]);
  }
}
