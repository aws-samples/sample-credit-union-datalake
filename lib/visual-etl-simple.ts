// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface VisualETLProps {
  mysqlRoleArn: string;
  xmlRoleArn: string;
  csvRoleArn: string;
  member360RoleArn: string;
  connectionName: string;
  bucketName: string;
}

export class VisualETLJobs extends Construct {
  public readonly mysqlVisualJob: glue.CfnJob;
  public readonly xmlVisualJob: glue.CfnJob;
  public readonly csvVisualJob: glue.CfnJob;
  public readonly member360VisualJob: glue.CfnJob;

  constructor(scope: Construct, id: string, props: VisualETLProps) {
    super(scope, id);

    // Deploy AWS Glue scripts to Amazon S3
    const glueAssetsBucket = s3.Bucket.fromBucketName(this, 'GlueAssetsBucket', 
      `aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`);

    new s3deploy.BucketDeployment(this, 'DeployGlueScripts', {
      sources: [s3deploy.Source.asset('./scripts')],
      destinationBucket: glueAssetsBucket,
      destinationKeyPrefix: 'scripts/'
    });

    // MySQL Visual ETL Job
    this.mysqlVisualJob = new glue.CfnJob(this, 'MySQLVisualETL', {
      name: 'creditunion-visual-mysql-etl',
      role: props.mysqlRoleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/scripts/creditunion-visual-mysql-etl.py`,
        pythonVersion: '3'
      },
      defaultArguments: {
        '--enable-metrics': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/sparkHistoryLogs/`,
        '--enable-job-insights': 'true',
        '--enable-observability-metrics': 'true',
        '--enable-glue-datacatalog': 'true',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--job-language': 'python',
        '--TempDir': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/temporary/`,
        '--enable-auto-scaling': 'true'
      },
      connections: {
        connections: [props.connectionName]
      },
      maxRetries: 0,
      timeout: 60,
      workerType: 'G.1X',
      numberOfWorkers: 20,
      glueVersion: '4.0',
      executionClass: 'STANDARD',
      executionProperty: { maxConcurrentRuns: 1 }
    });

    // XML Visual ETL Job
    this.xmlVisualJob = new glue.CfnJob(this, 'XMLVisualETL', {
      name: 'creditunion-xml-collect-to-cleanse-visual',
      role: props.xmlRoleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/scripts/creditunion-xml-collect-to-cleanse-visual.py`,
        pythonVersion: '3'
      },
      defaultArguments: {
        '--enable-metrics': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/sparkHistoryLogs/`,
        '--enable-job-insights': 'true',
        '--enable-observability-metrics': 'true',
        '--enable-glue-datacatalog': 'true',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--job-language': 'python',
        '--TempDir': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/temporary/`,
        '--enable-auto-scaling': 'true'
      },
      maxRetries: 0,
      timeout: 60,
      workerType: 'G.1X',
      numberOfWorkers: 10,
      glueVersion: '4.0',
      executionClass: 'STANDARD',
      executionProperty: { maxConcurrentRuns: 1 }
    });

    // CSV Visual ETL Job
    this.csvVisualJob = new glue.CfnJob(this, 'CSVVisualETL', {
      name: 'creditunion_CSV_collect_to_cleanse_visual',
      role: props.csvRoleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/scripts/creditunion_CSV_collect_to_cleanse_visual.py`,
        pythonVersion: '3'
      },
      defaultArguments: {
        '--enable-metrics': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/sparkHistoryLogs/`,
        '--enable-job-insights': 'true',
        '--enable-observability-metrics': 'true',
        '--enable-glue-datacatalog': 'true',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--job-language': 'python',
        '--TempDir': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/temporary/`,
        '--enable-auto-scaling': 'true'
      },
      maxRetries: 0,
      timeout: 60,
      workerType: 'G.1X',
      numberOfWorkers: 10,
      glueVersion: '4.0',
      executionClass: 'STANDARD',
      executionProperty: { maxConcurrentRuns: 1 }
    });

    // Member 360 Visual ETL Job
    this.member360VisualJob = new glue.CfnJob(this, 'Member360VisualETL', {
      name: 'creditunion-member-360-visual-etl',
      role: props.member360RoleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/scripts/creditunion-member-360-visual-etl.py`,
        pythonVersion: '3'
      },
      defaultArguments: {
        '--enable-metrics': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/sparkHistoryLogs/`,
        '--enable-job-insights': 'true',
        '--enable-observability-metrics': 'true',
        '--enable-glue-datacatalog': 'true',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--job-language': 'python',
        '--TempDir': `s3://aws-glue-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}/temporary/`,
        '--enable-auto-scaling': 'true'
      },
      maxRetries: 0,
      timeout: 60,
      workerType: 'G.1X',
      numberOfWorkers: 10,
      glueVersion: '4.0',
      executionClass: 'STANDARD',
      executionProperty: { maxConcurrentRuns: 1 }
    });
  }
}
