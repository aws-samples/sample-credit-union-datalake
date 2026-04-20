// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as signer from 'aws-cdk-lib/aws-signer';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

interface CreditUnionTriggerStackProps extends cdk.StackProps {
  rdsLambdaFunctionName: string;
  crawlerLambdaFunctionName: string;
  stepFunctionArn: string;
}

export class CreditUnionTriggerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CreditUnionTriggerStackProps) {
    super(scope, id, props);

    // Custom resource to trigger Amazon Relational Database Service (Amazon RDS) for MySQL data loading
    const rdsDataLoadTrigger = new cr.AwsCustomResource(this, 'TriggerRdsDataLoad', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: props.rdsLambdaFunctionName
        },
        physicalResourceId: cr.PhysicalResourceId.of('rds-data-load-trigger')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${props.rdsLambdaFunctionName}`]
        })
      ]),
      installLatestAwsSdk: false
    });

    // Custom resource to trigger crawlers (runs in parallel with RDS)
    const crawlerTrigger = new cr.AwsCustomResource(this, 'TriggerCrawlers', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: props.crawlerLambdaFunctionName
        },
        physicalResourceId: cr.PhysicalResourceId.of('crawler-trigger')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${props.crawlerLambdaFunctionName}`]
        })
      ]),
      installLatestAwsSdk: false
    });

    // Wait for AWS Glue crawlers to complete before triggering Step Function
    const crawlerWaitFunction = this.createCrawlerWaitFunction();
    const waitForCrawlers = new cr.AwsCustomResource(this, 'WaitForCrawlers', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: crawlerWaitFunction.functionName
        },
        physicalResourceId: cr.PhysicalResourceId.of('wait-for-crawlers')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [crawlerWaitFunction.functionArn]
        })
      ]),
      installLatestAwsSdk: false
    });
    waitForCrawlers.node.addDependency(crawlerTrigger);

    // Custom resource to trigger AWS Step Functions (after crawlers complete)
    // Input parameters are fixed values — not user-provided — to control execution mode
    const stepFunctionTrigger = new cr.AwsCustomResource(this, 'TriggerStepFunction', {
      onCreate: {
        service: 'StepFunctions',
        action: 'startExecution',
        parameters: {
          stateMachineArn: props.stepFunctionArn,
          name: `automated-execution-${Date.now()}`,
          input: JSON.stringify({
            execution_mode: 'test',
            test_type: 'full'
          })
        },
        physicalResourceId: cr.PhysicalResourceId.of('step-function-trigger')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['states:StartExecution'],
          resources: [props.stepFunctionArn]
        })
      ]),
      installLatestAwsSdk: false
    });
    stepFunctionTrigger.node.addDependency(waitForCrawlers);

    // Outputs
    new cdk.CfnOutput(this, 'RdsDataLoadTriggered', {
      value: 'RDS data loading triggered via Custom Resource',
      description: 'Status of RDS data loading trigger'
    });

    new cdk.CfnOutput(this, 'CrawlersTriggered', {
      value: 'XML crawlers triggered via Custom Resource',
      description: 'Status of crawler trigger'
    });

    new cdk.CfnOutput(this, 'StepFunctionTriggered', {
      value: 'ETL Step Function triggered with test full mode',
      description: 'Status of Step Function trigger'
    });

    // ==========================================================================
    // cdk-nag suppressions — CDK-generated Lambda service roles.
    // The AwsCustomResource construct internally creates Lambda functions whose
    // service roles use AWSLambdaBasicExecutionRole for CloudWatch logging.
    // ==========================================================================
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
      `/${this.stackName}/CrawlerWaitFunction/ServiceRole/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is applied by the CDK AwsCustomResource construct for CloudWatch logging. The construct is managed by AWS CDK and its service role cannot be customized.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      }
    ]);
  }

  private createCrawlerWaitFunction(): lambda.Function {
    const waitSigningProfile = new signer.SigningProfile(this, 'WaitFnSigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
      signatureValidity: cdk.Duration.days(365),
    });

    const waitCodeSigningConfig = new lambda.CodeSigningConfig(this, 'WaitFnCodeSigningConfig', {
      signingProfiles: [waitSigningProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.WARN,
    });

    const waitFunction = new lambda.Function(this, 'CrawlerWaitFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      codeSigningConfig: waitCodeSigningConfig,
      code: lambda.Code.fromInline(`
import boto3
import time
import json

def handler(event, context):
    glue = boto3.client('glue')
    crawlers = ['creditunion-crm-xml-crawler', 'creditunion-creditcards-xml-crawler']
    
    print("Waiting for crawlers to complete...")
    max_wait = 600  # 10 minutes max
    wait_time = 0
    
    while wait_time < max_wait:
        all_complete = True
        
        for crawler_name in crawlers:
            try:
                response = glue.get_crawler(Name=crawler_name)
                state = response['Crawler']['State']
                print(f"Crawler {crawler_name} state: {state}")
                
                if state in ['RUNNING']:
                    all_complete = False
                    break
            except Exception as e:
                print(f"Error checking crawler {crawler_name}: {e}")
                all_complete = False
                break
        
        if all_complete:
            print("All crawlers completed!")
            return {
                'statusCode': 200,
                'body': json.dumps('All crawlers completed')
            }
        
        print("Crawlers still running, waiting 30 seconds...")
        time.sleep(30)
        wait_time += 30
    
    print("Timeout waiting for crawlers, proceeding anyway...")
    return {
        'statusCode': 200,
        'body': json.dumps('Timeout reached, proceeding')
    }
      `),
      timeout: cdk.Duration.minutes(12),
      memorySize: 128
    });

    // Add AWS Glue permissions — scoped to specific crawlers
    waitFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['glue:GetCrawler'],
      resources: [
        `arn:aws:glue:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:crawler/creditunion-crm-xml-crawler`,
        `arn:aws:glue:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:crawler/creditunion-creditcards-xml-crawler`
      ]
    }));

    return waitFunction;
  }
}