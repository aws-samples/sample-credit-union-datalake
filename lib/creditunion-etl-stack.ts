// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { VisualETLJobs } from './visual-etl-simple';

interface CreditUnionETLStackProps extends cdk.StackProps {
  collectBucket: s3.Bucket;
  cleanseBucket: s3.Bucket;
  consumeBucket: s3.Bucket;
  accessLogsBucket: s3.Bucket;
  glueRoleMysql: iam.Role;
  glueRoleXml: iam.Role;
  glueRoleCsv: iam.Role;
  glueRoleMember360: iam.Role;
  glueConnection: glue.CfnConnection;
  glueSecurityConfiguration: glue.CfnSecurityConfiguration;
  cleanseDatabase: glue.CfnDatabase;
  consumeDatabase: glue.CfnDatabase;
  xmlCatalogDatabase: glue.CfnDatabase;
}

export class CreditUnionETLStack extends cdk.Stack {
  public readonly stepFunction: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: CreditUnionETLStackProps) {
    super(scope, id, props);

    // Create AWS Glue assets bucket for ETL scripts
    const glueAssetsBucket = new s3.Bucket(this, 'GlueAssetsBucket', {
      bucketName: `creditunion-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: s3.BucketEncryption.KMS,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 'glue-assets/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // Restrict glue-assets bucket writes to CDK deployment roles only
    glueAssetsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyUnauthorizedScriptWrites',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [`${glueAssetsBucket.bucketArn}/*`],
      conditions: {
        'ArnNotLike': {
          'aws:PrincipalArn': [
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`,
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/CreditUnion*`,
          ]
        },
        'StringNotEquals': {
          'aws:PrincipalServiceName': ['cloudformation.amazonaws.com']
        }
      }
    }));

    // AWS Glue Visual ETL jobs
    const visualETL = new VisualETLJobs(this, 'VisualETL', {
      mysqlRoleArn: props.glueRoleMysql.roleArn,
      xmlRoleArn: props.glueRoleXml.roleArn,
      csvRoleArn: props.glueRoleCsv.roleArn,
      member360RoleArn: props.glueRoleMember360.roleArn,
      connectionName: props.glueConnection.ref,
      bucketName: props.cleanseBucket.bucketName,
      securityConfigurationName: props.glueSecurityConfiguration.ref
    });

    // AWS Step Functions state machine Role
    const stepFunctionRole = new iam.Role(this, 'StepFunctionRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies: {
        GlueJobExecution: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'glue:StartJobRun',
                'glue:GetJobRun',
                'glue:GetJobRuns',
                'glue:BatchStopJobRun'
              ],
              resources: [
                `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/creditunion-visual-mysql-etl`,
                `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/creditunion-xml-collect-to-cleanse-visual`,
                `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/creditunion_CSV_collect_to_cleanse_visual`,
                `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/creditunion-member-360-visual-etl`
              ]
            })
          ]
        }),
        LogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogDelivery',
                'logs:GetLogDelivery',
                'logs:UpdateLogDelivery',
                'logs:DeleteLogDelivery',
                'logs:ListLogDeliveries',
                'logs:PutResourcePolicy',
                'logs:DescribeResourcePolicies',
                'logs:DescribeLogGroups'
              ],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/vendedlogs/states/creditunion-etl-state-machine-Logs:*`
              ]
            })
          ]
        })
      }
    });

    // AWS Step Functions state machine Definition
    const definition = new stepfunctions.Choice(this, 'CheckExecutionMode')
      .when(
        stepfunctions.Condition.stringEquals('$.execution_mode', 'test'),
        new stepfunctions.Choice(this, 'TestModeChoice')
          .when(
            stepfunctions.Condition.stringEquals('$.test_type', 'individual'),
            new stepfunctions.Parallel(this, 'TestParallelProcessing')
              .branch(
                new tasks.GlueStartJobRun(this, 'TestMySQLProcessing', {
                  glueJobName: 'creditunion-visual-mysql-etl',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
                  arguments: stepfunctions.TaskInput.fromObject({
                    '--execution_id': 'automated-test-mysql',
                    '--p_year': '2025',
                    '--p_month': '08',
                    '--p_day': '28',
                    '--p_hour': '22'
                  })
                })
              )
              .branch(
                new tasks.GlueStartJobRun(this, 'TestXMLProcessing', {
                  glueJobName: 'creditunion-xml-collect-to-cleanse-visual',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
                  arguments: stepfunctions.TaskInput.fromObject({
                    '--execution_id': 'automated-test-xml'
                  })
                })
              )
              .branch(
                new tasks.GlueStartJobRun(this, 'TestCSVProcessing', {
                  glueJobName: 'creditunion_CSV_collect_to_cleanse_visual',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
                  arguments: stepfunctions.TaskInput.fromObject({
                    '--execution_id': 'automated-test-csv'
                  })
                })
              )
              .next(
                new tasks.GlueStartJobRun(this, 'TestMember360Processing', {
                  glueJobName: 'creditunion-member-360-visual-etl',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
                  arguments: stepfunctions.TaskInput.fromObject({
                    '--execution_id': 'automated-test-member360'
                  })
                })
              )
          )
          .otherwise(
            new stepfunctions.Parallel(this, 'ProductionParallelProcessing')
              .branch(
                new tasks.GlueStartJobRun(this, 'ProcessMySQLData', {
                  glueJobName: 'creditunion-visual-mysql-etl',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
                })
              )
              .branch(
                new tasks.GlueStartJobRun(this, 'ProcessXMLData', {
                  glueJobName: 'creditunion-xml-collect-to-cleanse-visual',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
                })
              )
              .branch(
                new tasks.GlueStartJobRun(this, 'ProcessCSVData', {
                  glueJobName: 'creditunion_CSV_collect_to_cleanse_visual',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
                })
              )
              .next(
                new tasks.GlueStartJobRun(this, 'ProcessMember360Data', {
                  glueJobName: 'creditunion-member-360-visual-etl',
                  integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
                })
              )
          )
      )
      .otherwise(
        new stepfunctions.Parallel(this, 'DefaultParallelProcessing')
          .branch(
            new tasks.GlueStartJobRun(this, 'DefaultMySQLProcessing', {
              glueJobName: 'creditunion-visual-mysql-etl',
              integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
            })
          )
          .branch(
            new tasks.GlueStartJobRun(this, 'DefaultXMLProcessing', {
              glueJobName: 'creditunion-xml-collect-to-cleanse-visual',
              integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
            })
          )
          .branch(
            new tasks.GlueStartJobRun(this, 'DefaultCSVProcessing', {
              glueJobName: 'creditunion_CSV_collect_to_cleanse_visual',
              integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
            })
          )
          .next(
            new tasks.GlueStartJobRun(this, 'DefaultMember360Processing', {
              glueJobName: 'creditunion-member-360-visual-etl',
              integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB
            })
          )
      );

    // Create AWS Step Functions state machine
    this.stepFunction = new stepfunctions.StateMachine(this, 'CreditUnionETLStateMachine', {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      role: stepFunctionRole,
      stateMachineName: 'creditunion-etl-state-machine',
      // Enable AWS X-Ray tracing for visibility into state machine executions.
      // Addresses cdk-nag AwsSolutions-SF2.
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StepFunctionLogGroup', {
          logGroupName: '/aws/vendedlogs/states/creditunion-etl-state-machine-Logs',
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY
        }),
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true
      }
    });

    // Outputs
    new cdk.CfnOutput(this, 'StepFunctionArn', {
      value: this.stepFunction.stateMachineArn,
      description: 'Credit Union ETL Step Function ARN'
    });

    // ==========================================================================
    // cdk-nag suppressions — documented security exceptions
    // See docs/security-exceptions.md for full justification of each item.
    // ==========================================================================

    // StepFunctionRole — log delivery wildcards required by Step Functions log delivery service
    NagSuppressions.addResourceSuppressions(stepFunctionRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Log stream wildcard within the scoped log group is required by Step Functions to write vended logs. Log group ARN is scoped to this specific state machine.',
        appliesTo: [
          'Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/vendedlogs/states/creditunion-etl-state-machine-Logs:*'
        ]
      }
    ], true);

    // StepFunction DefaultPolicy — CDK auto-adds wildcard logs:* for X-Ray tracing integration
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/StepFunctionRole/DefaultPolicy/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Log delivery permissions are auto-generated by CDK for Step Functions vended logging. Resources are scoped to the account and log group for this state machine.',
        appliesTo: ['Resource::*']
      }
    ]);

    // CDK-generated BucketDeployment Lambda (internal CDK construct, identical to infrastructure stack)
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource`,
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is applied by the CDK BucketDeployment construct. The construct is managed by AWS CDK.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions are defined by the CDK BucketDeployment construct to support uploading Glue scripts to the CDK assets and Glue assets buckets. The construct is managed by AWS CDK and its DefaultPolicy cannot be customized. Suppression is account/region-agnostic because the resolved bucket ARNs include the account ID and region.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Lambda runtime is managed by the AWS CDK BucketDeployment construct and updates with CDK library upgrades.'
      }
    ]);

    // Glue jobs — the security configuration is attached but cdk-nag cannot resolve
    // the cross-stack Fn::ImportValue token at synth time, so it falsely flags GL1/GL3.
    // The security configuration IS applied (see template.json SecurityConfiguration property).
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/VisualETL/MySQLVisualETL`,
      `/${this.stackName}/VisualETL/XMLVisualETL`,
      `/${this.stackName}/VisualETL/CSVVisualETL`,
      `/${this.stackName}/VisualETL/Member360VisualETL`
    ], [
      {
        id: 'AwsSolutions-GL1',
        reason: 'Glue security configuration (creditunion-glue-security-config) is attached with CloudWatch SSE-KMS encryption. False positive: cdk-nag cannot resolve the cross-stack Fn::ImportValue token for the security config reference.'
      },
      {
        id: 'AwsSolutions-GL3',
        reason: 'Glue security configuration (creditunion-glue-security-config) is attached with CSE-KMS job bookmark encryption. False positive: cdk-nag cannot resolve the cross-stack Fn::ImportValue token for the security config reference.'
      }
    ]);
  }
}
