import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface VisualETLProps {
  roleArn: string;
  connectionName: string;
  region: string;
}

export class VisualETLConstruct extends Construct {
  constructor(scope: Construct, id: string, props: VisualETLProps) {
    super(scope, id);

    // Create a custom resource to deploy Visual ETL jobs
    const deploymentScript = new cdk.CustomResource(this, 'VisualETLDeployment', {
      serviceToken: this.createDeploymentProvider(props).serviceToken,
      properties: {
        roleArn: props.roleArn,
        connectionName: props.connectionName,
        region: props.region,
        // Force update on every deployment
        timestamp: Date.now()
      }
    });
  }

  private createDeploymentProvider(props: VisualETLProps): cr.Provider {
    const onEventHandler = new lambda.Function(this, 'VisualETLHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { execSync } = require('child_process');
        const AWS = require('aws-sdk');
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          const { roleArn, connectionName, region } = event.ResourceProperties;
          
          if (event.RequestType === 'Delete') {
            return { PhysicalResourceId: 'visual-etl-jobs' };
          }
          
          try {
            // Deploy Visual ETL jobs using AWS SDK
            const glue = new AWS.Glue({ region });
            
            // Example: Deploy mysql-etl job
            const jobConfig = {
              Name: 'creditunion-visual-mysql-etl',
              Role: roleArn,
              Command: {
                Name: 'glueetl',
                ScriptLocation: \`s3://aws-glue-assets-\${process.env.AWS_ACCOUNT_ID}-\${region}/scripts/creditunion-visual-mysql-etl.py\`,
                PythonVersion: '3'
              },
              DefaultArguments: {
                '--enable-metrics': 'true',
                '--enable-spark-ui': 'true',
                '--enable-job-insights': 'true',
                '--enable-observability-metrics': 'true',
                '--enable-glue-datacatalog': 'true',
                '--job-bookmark-option': 'job-bookmark-disable',
                '--job-language': 'python',
                '--TempDir': \`s3://aws-glue-assets-\${process.env.AWS_ACCOUNT_ID}-\${region}/temporary/\`,
                '--enable-auto-scaling': 'true'
              },
              Connections: {
                Connections: [connectionName]
              },
              MaxRetries: 0,
              Timeout: 60,
              WorkerType: 'G.1X',
              NumberOfWorkers: 20,
              GlueVersion: '4.0',
              ExecutionClass: 'STANDARD'
            };
            
            try {
              await glue.getJob({ JobName: jobConfig.Name }).promise();
              console.log('Updating existing job:', jobConfig.Name);
              await glue.updateJob({
                JobName: jobConfig.Name,
                JobUpdate: jobConfig
              }).promise();
            } catch (error) {
              if (error.code === 'EntityNotFoundException') {
                console.log('Creating new job:', jobConfig.Name);
                await glue.createJob(jobConfig).promise();
              } else {
                throw error;
              }
            }
            
            return {
              PhysicalResourceId: 'visual-etl-jobs',
              Data: {
                JobName: jobConfig.Name
              }
            };
          } catch (error) {
            console.error('Error deploying Visual ETL jobs:', error);
            throw error;
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
      environment: {
        AWS_ACCOUNT_ID: cdk.Stack.of(this).account
      }
    });

    // Grant permissions to manage Glue jobs
    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:CreateJob',
        'glue:UpdateJob',
        'glue:GetJob',
        'glue:DeleteJob'
      ],
      resources: ['*']
    }));

    return new cr.Provider(this, 'VisualETLProvider', {
      onEventHandler
    });
  }
}
