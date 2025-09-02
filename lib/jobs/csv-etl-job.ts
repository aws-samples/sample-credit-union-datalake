import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface CSVETLJobProps {
  glueRole: iam.Role;
  collectBucket: s3.Bucket;
  cleanseBucket: s3.Bucket;
  cleanseDatabase: glue.CfnDatabase;
}

export class CSVETLJob extends Construct {
  public readonly job: glue.CfnJob;

  constructor(scope: Construct, id: string, props: CSVETLJobProps) {
    super(scope, id);

    this.job = new glue.CfnJob(this, 'CSVETLJob', {
      name: 'creditunion-csv-etl',
      role: props.glueRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://aws-glue-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/scripts/creditunion-csv-etl.py`
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
      description: 'Collect to Cleanse for CSV document types'
    });
  }
}
