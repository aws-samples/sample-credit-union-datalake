#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CreditUnionInfrastructureStack } from '../lib/creditunion-infrastructure-stack';
import { CreditUnionDataStack } from '../lib/creditunion-data-stack';
import { CreditUnionETLStack } from '../lib/creditunion-etl-stack';
import { CreditUnionTriggerStack } from '../lib/creditunion-trigger-stack';

const app = new cdk.App();

// Infrastructure Stack (S3, RDS, KMS, IAM, VPC)
const infrastructureStack = new CreditUnionInfrastructureStack(app, 'CreditUnionInfrastructureStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Credit Union Analytics Platform - Infrastructure (S3, RDS, KMS, IAM, VPC)'
});

// Data Stack (AWS Glue Databases, Tables, Connections, Crawlers)
const dataStack = new CreditUnionDataStack(app, 'CreditUnionDataStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Credit Union Analytics Platform - Data Catalog (AWS Glue Databases, Tables, Connections)',
  collectBucket: infrastructureStack.collectBucket,
  cleanseBucket: infrastructureStack.cleanseBucket,
  consumeBucket: infrastructureStack.consumeBucket,
  glueRoleMysql: infrastructureStack.glueRoleMysql,
  glueSecurityGroup: infrastructureStack.glueSecurityGroup,
  database: infrastructureStack.database,
  databaseSecret: infrastructureStack.databaseSecret,
  databaseSecurityGroup: infrastructureStack.databaseSecurityGroup,
  vpc: infrastructureStack.vpc,
  secretsManagerEndpoint: infrastructureStack.secretsManagerEndpoint
});

// ETL Stack (AWS Glue Jobs, Step Functions)
const etlStack = new CreditUnionETLStack(app, 'CreditUnionETLStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Credit Union Analytics Platform - ETL Jobs (AWS Glue Visual ETL, AWS Step Functions)',
  collectBucket: infrastructureStack.collectBucket,
  cleanseBucket: infrastructureStack.cleanseBucket,
  consumeBucket: infrastructureStack.consumeBucket,
  accessLogsBucket: infrastructureStack.accessLogsBucket,
  glueRoleMysql: infrastructureStack.glueRoleMysql,
  glueRoleXml: infrastructureStack.glueRoleXml,
  glueRoleCsv: infrastructureStack.glueRoleCsv,
  glueRoleMember360: infrastructureStack.glueRoleMember360,
  glueConnection: dataStack.glueConnection,
  cleanseDatabase: dataStack.cleanseDatabase,
  consumeDatabase: dataStack.consumeDatabase,
  xmlCatalogDatabase: dataStack.xmlCatalogDatabase
});

// Trigger Stack (Optional - Custom Resources to auto-trigger Lambda functions)
const triggerStack = new CreditUnionTriggerStack(app, 'CreditUnionTriggerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Credit Union Analytics Platform - Full Automation (RDS → Crawlers → ETL)',
  rdsLambdaFunctionName: dataStack.rdsDataLoader.lambda.functionName,
  crawlerLambdaFunctionName: dataStack.crawlerTriggerFunction.functionName,
  stepFunctionArn: etlStack.stepFunction.stateMachineArn
});

// Add dependencies
dataStack.addDependency(infrastructureStack);
etlStack.addDependency(dataStack);
triggerStack.addDependency(etlStack);

// Add tags to all resources
cdk.Tags.of(app).add('Project', 'CreditUnionAnalytics');
cdk.Tags.of(app).add('Environment', 'Development');
cdk.Tags.of(app).add('Owner', 'CreditUnionAnalytics');
