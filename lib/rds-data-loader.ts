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
import { Construct } from 'constructs';

export interface RdsDataLoaderProps {
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.Secret;
  collectBucket: s3.Bucket;
  secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
}

export class RdsDataLoader extends Construct {
  public readonly lambda: lambda.Function;

  constructor(scope: Construct, id: string, props: RdsDataLoaderProps) {
    super(scope, id);

    // Create pymysql AWS Lambda layer
    const pymysqlLayer = new lambda.LayerVersion(this, 'PymysqlLayer', {
      code: lambda.Code.fromAsset('layers/pymysql'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      description: 'PyMySQL library for Lambda'
    });

    // AWS Lambda execution role
    // Note: AWSLambdaVPCAccessExecutionRole managed policy is required for VPC-deployed
    // Lambda functions. Contains EC2 wildcard permissions for network interface management.
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

    const codeSigningConfig = new lambda.CodeSigningConfig(this, 'CodeSigningConfig', {
      signingProfiles: [signingProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.WARN,
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
      code: lambda.Code.fromInline(`
import json
import boto3
from botocore.config import Config
import pymysql
import csv
from io import StringIO
import os

def lambda_handler(event, context):
    try:
        secrets_client = boto3.client('secretsmanager')
        secret_response = secrets_client.get_secret_value(SecretId=os.environ['SECRET_ARN'])
        secret = json.loads(secret_response['SecretString'])
        
        # Configure S3 client to use path-style URLs for VPC endpoint compatibility
        s3_config = Config(
            s3={'addressing_style': 'path'}
        )
        s3_client = boto3.client('s3', config=s3_config)
        
        csv_response = s3_client.get_object(
            Bucket=os.environ['BUCKET_NAME'],
            Key='CreditUnionData/CoreBanking_RDS_LoadOnly/core_banking_members.csv'
        )
        csv_content = csv_response['Body'].read().decode('utf-8')
        
        connection = pymysql.connect(
            host=secret['host'],
            user=secret['username'],
            password=secret['password'],
            database=secret['dbname'],
            port=secret['port'],
            ssl={'ca': '/etc/pki/tls/certs/ca-bundle.crt'}
        )
        
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS core_banking_members")
            cursor.execute("CREATE TABLE core_banking_members (member_number VARCHAR(20) PRIMARY KEY, ssn VARCHAR(11), first_name VARCHAR(50), last_name VARCHAR(50), dob DATE, address VARCHAR(200), city VARCHAR(50), state VARCHAR(2), zip VARCHAR(10), phone VARCHAR(20), join_date DATE, checking_balance DECIMAL(10,2), savings_balance DECIMAL(10,2))")
            
            # Use INSERT IGNORE to skip duplicates — validate fields before insertion
            csv_reader = csv.DictReader(StringIO(csv_content))
            expected_fields = {'member_number','ssn','first_name','last_name','dob','address','city','state','zip','phone','join_date','checking_balance','savings_balance'}
            for row in csv_reader:
                if not expected_fields.issubset(row.keys()):
                    continue  # skip rows with unexpected schema
                values = tuple(str(v)[:200] for v in row.values())  # truncate to prevent overflow
                if len(values) != 13:
                    continue  # skip malformed rows
                cursor.execute("INSERT IGNORE INTO core_banking_members VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", values)
            
            connection.commit()
            cursor.execute("SELECT COUNT(*) FROM core_banking_members")
            count = cursor.fetchone()[0]
        
        connection.close()
        return f'Successfully loaded {count} unique records'
        
    except Exception as e:
        error_type = type(e).__name__
        raise Exception(f'RDS data loading failed: {error_type} - check CloudWatch logs for details')
      `)
    });

    // AWS Lambda depends on AWS Secrets Manager VPC endpoint being ready
    this.lambda.node.addDependency(props.secretsManagerEndpoint);

    // Note: Lambda can be manually triggered after deployment
    // aws lambda invoke --function-name [function-name] --region us-west-2 /tmp/response.json
  }
}
