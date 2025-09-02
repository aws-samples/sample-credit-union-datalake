import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface XMLETLJobProps {
  glueRole: iam.Role;
  cleanseBucket: s3.Bucket;
  xmlCatalogDatabase: glue.CfnDatabase;
}

export class XMLETLJob extends Construct {
  public readonly job: glue.CfnJob;

  constructor(scope: Construct, id: string, props: XMLETLJobProps) {
    super(scope, id);

    this.job = new glue.CfnJob(this, 'XMLETLJob', {
      name: 'creditunion-xml-etl',
      role: props.glueRole.roleArn,
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://aws-glue-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/scripts/creditunion-xml-etl.py`
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
      description: 'Collect to Cleanse for XML document types'
    });
  }
}
