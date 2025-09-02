import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

export class VisualETLJobs extends Construct {
    constructor(scope: Construct, id: string, props: {
        roleArn: string;
        connectionName: string;
        bucketName: string;
    }) {
        super(scope, id);

        const account = cdk.Stack.of(this).account;
        const region = cdk.Stack.of(this).region;

        // creditunion-visual-mysql-etl
        new glue.CfnJob(this, 'MysqlEtl', {
            name: 'creditunion-visual-mysql-etl',
            role: props.roleArn,
            command: {
                name: 'glueetl',
                scriptLocation: `s3://aws-glue-assets-${account}-${region}/scripts/creditunion-visual-mysql-etl.py`,
                pythonVersion: '3'
            },
            defaultArguments: {
          "--enable-metrics": "true",
          "--enable-spark-ui": "true",
          "--spark-event-logs-path": `s3://aws-glue-assets-${account}-${region}/sparkHistoryLogs/`,
          "--enable-job-insights": "true",
          "--enable-observability-metrics": "true",
          "--enable-glue-datacatalog": "true",
          "--job-bookmark-option": "job-bookmark-disable",
          "--job-language": "python",
          "--TempDir": `s3://aws-glue-assets-${account}-${region}/temporary/`,
          "--enable-auto-scaling": "true"
},
            connections: {
                connections: ['creditunion-mysql-connection']
            },
            maxRetries: 0,
            timeout: 60,
            workerType: 'G.1X',
            numberOfWorkers: 20,
            glueVersion: '4.0',
            executionClass: 'STANDARD'
        });
    }
}