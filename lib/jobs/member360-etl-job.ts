import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface Member360ETLJobProps {
  glueRole: iam.Role;
  consumeBucket: s3.Bucket;
  cleanseDatabase: glue.CfnDatabase;
  consumeDatabase: glue.CfnDatabase;
  xmlCatalogDatabase: glue.CfnDatabase;
}

export class Member360ETLJob extends Construct {
  public readonly job: glue.CfnJob;

  constructor(scope: Construct, id: string, props: Member360ETLJobProps) {
    super(scope, id);

    this.job = new glue.CfnJob(this, 'Member360ETLJob', {
      name: 'creditunion-member360-etl',
      role: props.glueRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://aws-glue-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/scripts/creditunion-member360-etl.py`
      },
      defaultArguments: {
        '--enable-metrics': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://aws-glue-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/sparkHistoryLogs/`,
        '--enable-job-insights': 'true',
        '--enable-observability-metrics': 'true',
        '--enable-glue-datacatalog': 'true',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--job-language': 'python',
        '--TempDir': `s3://aws-glue-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/temporary/`,
        '--enable-auto-scaling': 'true'
      },
      maxRetries: 0,
      timeout: 60,
      workerType: 'G.1X',
      numberOfWorkers: 10,
      glueVersion: '4.0',
      executionClass: 'STANDARD',
      description: 'Cleanse to Consume for Member 360 view'
    });
  }
}
