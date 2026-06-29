// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Amazon Relational Database Service (Amazon RDS) data loader construct.
// Loads sample CSV data into Amazon RDS for MySQL via AWS Lambda.
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as path from 'path';
import { SignedLambdaArtifact } from './signed-lambda-artifact';
import { Construct } from 'constructs';

export interface RdsDataLoaderProps {
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.Secret;
  collectBucket: s3.Bucket;
  secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
  /**
   * S3 server-access-logs bucket (from the infrastructure stack) used for the
   * signing artifacts bucket so it does not raise an AwsSolutions-S1 finding.
   */
  accessLogsBucket: s3.IBucket;
}

export class RdsDataLoader extends Construct {
  public readonly lambda: lambda.Function;

  constructor(scope: Construct, id: string, props: RdsDataLoaderProps) {
    super(scope, id);

    // AWS Lambda execution role
    // Note: AWSLambdaVPCAccessExecutionRole managed policy is required for VPC-deployed
    // Lambda functions. Approved security exception: see docs/security-exceptions.md Exception 3.
    // Compensated with VPC deployment in private subnet and AWS CloudTrail auditing.
    const lambdaRole = new iam.Role(this, 'RdsLoaderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      ],
      inlinePolicies: {
        RdsAndS3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.databaseSecret.secretArn]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                `${props.collectBucket.bucketArn}/*`,
                props.collectBucket.bucketArn
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt'],
              resources: [props.collectBucket.encryptionKey!.keyArn]
            })
          ]
        })
      }
    });

    // Code signing for AWS Lambda function integrity
    const signingProfile = new signer.SigningProfile(this, 'SigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
      signatureValidity: cdk.Duration.days(365),
    });

    // Versioned, KMS-encrypted artifacts bucket used as the AWS Signer source/destination.
    // Created once and shared by both signing jobs (handler + pymysql layer). Reuses the
    // data-lake customer-managed key and the infrastructure access-logs bucket (avoids
    // AwsSolutions-S1 on the artifacts bucket).
    const artifactsBucket = SignedLambdaArtifact.createArtifactsBucket(
      this,
      'SigningArtifactsBucket',
      props.collectBucket.encryptionKey!,
      {
        serverAccessLogsBucket: props.accessLogsBucket,
        serverAccessLogsPrefix: 'rds-loader-signing/',
      }
    );

    // Code signing under ENFORCE requires every layer on the function to also be
    // signed by an allowed profile. Sign the pymysql layer through the same flow and
    // publish the LayerVersion from the signed object.
    const signedLayer = new SignedLambdaArtifact(this, 'PymysqlLayerArtifact', {
      artifactsBucket,
      signingProfile,
      assetPath: 'layers/pymysql',
    });

    const pymysqlLayer = new lambda.LayerVersion(this, 'PymysqlLayer', {
      code: signedLayer.signedCode,
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      description: 'PyMySQL library for Lambda (AWS Signer signed)'
    });

    // Sign the externalized handler asset (lambda/rds-data-loader/index.py).
    const signedHandler = new SignedLambdaArtifact(this, 'HandlerArtifact', {
      artifactsBucket,
      signingProfile,
      assetPath: path.join(__dirname, '..', 'lambda', 'rds-data-loader'),
    });

    const codeSigningConfig = new lambda.CodeSigningConfig(this, 'CodeSigningConfig', {
      signingProfiles: [signingProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.ENFORCE,
    });

    // Lambda function
    this.lambda = new lambda.Function(this, 'RdsDataLoaderFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.lambda_handler',
      role: lambdaRole,
      codeSigningConfig,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroups: [props.database.connections.securityGroups[0]],
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      layers: [pymysqlLayer],
      environment: {
        SECRET_ARN: props.databaseSecret.secretArn,
        BUCKET_NAME: props.collectBucket.bucketName
      },
      code: signedHandler.signedCode
    });

    // Ensure the signed objects exist before the function is created/updated. The
    // Code.fromBucket tokens already create implicit dependencies on the signing
    // custom resources; these explicit dependencies make the ordering unambiguous.
    this.lambda.node.addDependency(signedHandler);
    this.lambda.node.addDependency(signedLayer);

    // AWS Lambda depends on AWS Secrets Manager VPC endpoint being ready
    this.lambda.node.addDependency(props.secretsManagerEndpoint);
  }
}
