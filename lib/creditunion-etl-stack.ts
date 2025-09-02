import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { VisualETLJobs } from './visual-etl-simple';

interface CreditUnionETLStackProps extends cdk.StackProps {
  collectBucket: s3.Bucket;
  cleanseBucket: s3.Bucket;
  consumeBucket: s3.Bucket;
  glueRole: iam.Role;
  glueConnection: glue.CfnConnection;
  cleanseDatabase: glue.CfnDatabase;
  consumeDatabase: glue.CfnDatabase;
  xmlCatalogDatabase: glue.CfnDatabase;
}

export class CreditUnionETLStack extends cdk.Stack {
  public readonly stepFunction: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: CreditUnionETLStackProps) {
    super(scope, id, props);

    // Create Glue assets bucket for ETL scripts
    const glueAssetsBucket = new s3.Bucket(this, 'GlueAssetsBucket', {
      bucketName: `aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // Visual ETL Jobs
    const visualETL = new VisualETLJobs(this, 'VisualETL', {
      roleArn: props.glueRole.roleArn,
      connectionName: props.glueConnection.ref,
      bucketName: props.cleanseBucket.bucketName
    });

    // Step Functions State Machine Role
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
              resources: ['*']
            })
          ]
        })
      }
    });

    // Step Functions State Machine Definition
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

    // Create Step Functions State Machine
    this.stepFunction = new stepfunctions.StateMachine(this, 'CreditUnionETLStateMachine', {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      role: stepFunctionRole,
      stateMachineName: 'creditunion-etl-state-machine',
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
  }
}
