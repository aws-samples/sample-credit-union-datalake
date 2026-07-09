// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { SignedLambdaArtifact } from './signed-lambda-artifact';
import { Construct } from 'constructs';

interface CreditUnionTriggerStackProps extends cdk.StackProps {
  rdsLambdaFunctionName: string;
  crawlerLambdaFunctionName: string;
  stepFunctionArn: string;
  /**
   * Customer-managed KMS key (from the infrastructure stack) used to encrypt the
   * signing artifacts bucket for the crawler-wait Lambda.
   */
  kmsKey: kms.IKey;
  /**
   * S3 server-access-logs bucket (from the infrastructure stack) used for the
   * signing artifacts bucket so it does not raise an AwsSolutions-S1 finding.
   */
  accessLogsBucket: s3.IBucket;
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
    const crawlerWaitFunction = this.createCrawlerWaitFunction(props);
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
          // Grant invoke on both the unqualified function ARN and the version/alias
          // qualified form (`:*`). The AWS SDK v3 Lambda `invoke` path can be
          // authorized against the qualified ARN, so granting only the unqualified
          // name leaves the shared custom-resource provider role unauthorized
          // (AccessDenied on lambda:InvokeFunction). functionArn is the canonical
          // attribute and creates the correct dependency on the function.
          resources: [
            crawlerWaitFunction.functionArn,
            `${crawlerWaitFunction.functionArn}:*`
          ]
        })
      ]),
      installLatestAwsSdk: false
    });
    // Ensure the wait function (and its role/policy) exists before the invoke runs.
    waitForCrawlers.node.addDependency(crawlerTrigger);
    waitForCrawlers.node.addDependency(crawlerWaitFunction);
    // Belt-and-suspenders: also grant invoke via the function's own grant helper so
    // the permission and resource dependency are established the canonical way.
    crawlerWaitFunction.grantInvoke(waitForCrawlers);

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

    // The WaitForCrawlers custom resource must invoke the crawler-wait Lambda. The
    // grant covers the unqualified function ARN and its version/alias-qualified form
    // (`<CrawlerWaitFunction.Arn>:*`), which is the canonical lambda:InvokeFunction
    // grant. The wildcard is scoped to versions/aliases of that single function only.
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/WaitForCrawlers/CustomResourcePolicy/Resource`
    ], [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'lambda:InvokeFunction is scoped to the crawler-wait function ARN and its version/alias-qualified form (:*); the AWS SDK v3 Lambda invoke path can authorize against the qualified ARN, so both are granted. The wildcard applies only to versions/aliases of that single function.',
        appliesTo: [{ regex: '/^Resource::<CrawlerWaitFunction.*\\.Arn>:\\*$/g' }]
      }
    ], true);
  }

  private createCrawlerWaitFunction(props: CreditUnionTriggerStackProps): lambda.Function {
    const waitSigningProfile = new signer.SigningProfile(this, 'WaitFnSigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
      signatureValidity: cdk.Duration.days(365),
    });

    const waitCodeSigningConfig = new lambda.CodeSigningConfig(this, 'WaitFnCodeSigningConfig', {
      signingProfiles: [waitSigningProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.ENFORCE,
    });

    // Versioned, KMS-encrypted artifacts bucket used as the AWS Signer source/destination
    // for the crawler-wait handler. Reuses the data-lake customer-managed key and the
    // infrastructure access-logs bucket (avoids AwsSolutions-S1 on the artifacts bucket).
    const waitArtifactsBucket = SignedLambdaArtifact.createArtifactsBucket(
      this,
      'WaitSigningArtifactsBucket',
      props.kmsKey,
      {
        serverAccessLogsBucket: props.accessLogsBucket,
        serverAccessLogsPrefix: 'crawler-wait-signing/',
      }
    );

    // Sign the externalized handler asset (lambda/crawler-wait/index.py).
    const signedWaitHandler = new SignedLambdaArtifact(this, 'WaitHandlerArtifact', {
      artifactsBucket: waitArtifactsBucket,
      signingProfile: waitSigningProfile,
      assetPath: path.join(__dirname, '..', 'lambda', 'crawler-wait'),
    });

    const waitFunction = new lambda.Function(this, 'CrawlerWaitFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      codeSigningConfig: waitCodeSigningConfig,
      code: signedWaitHandler.signedCode,
      timeout: cdk.Duration.minutes(12),
      memorySize: 128
    });

    // Ensure the signed object exists before the function is created/updated.
    waitFunction.node.addDependency(signedWaitHandler);

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