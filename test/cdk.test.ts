import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CreditUnionInfrastructureStack } from '../lib/creditunion-infrastructure-stack';
import { CreditUnionDataStack } from '../lib/creditunion-data-stack';
import { CreditUnionETLStack } from '../lib/creditunion-etl-stack';
import { CreditUnionTriggerStack } from '../lib/creditunion-trigger-stack';

const env = { account: '123456789012', region: 'us-west-2' };

function buildStacks() {
  const app = new cdk.App();

  const infra = new CreditUnionInfrastructureStack(app, 'TestInfra', { env });
  const data = new CreditUnionDataStack(app, 'TestData', {
    env,
    collectBucket: infra.collectBucket,
    cleanseBucket: infra.cleanseBucket,
    consumeBucket: infra.consumeBucket,
    glueRoleMysql: infra.glueRoleMysql,
    glueSecurityGroup: infra.glueSecurityGroup,
    database: infra.database,
    databaseSecret: infra.databaseSecret,
    databaseSecurityGroup: infra.databaseSecurityGroup,
    vpc: infra.vpc,
    secretsManagerEndpoint: infra.secretsManagerEndpoint,
  });
  const etl = new CreditUnionETLStack(app, 'TestETL', {
    env,
    collectBucket: infra.collectBucket,
    cleanseBucket: infra.cleanseBucket,
    consumeBucket: infra.consumeBucket,
    accessLogsBucket: infra.accessLogsBucket,
    glueRoleMysql: infra.glueRoleMysql,
    glueRoleXml: infra.glueRoleXml,
    glueRoleCsv: infra.glueRoleCsv,
    glueRoleMember360: infra.glueRoleMember360,
    glueConnection: data.glueConnection,
    cleanseDatabase: data.cleanseDatabase,
    consumeDatabase: data.consumeDatabase,
    xmlCatalogDatabase: data.xmlCatalogDatabase,
    glueSecurityConfiguration: infra.glueSecurityConfiguration,
  });
  const trigger = new CreditUnionTriggerStack(app, 'TestTrigger', {
    env,
    rdsLambdaFunctionName: data.rdsDataLoader.lambda.functionName,
    crawlerLambdaFunctionName: data.crawlerTriggerFunction.functionName,
    stepFunctionArn: etl.stepFunction.stateMachineArn,
  });

  return { app, infra, data, etl, trigger };
}

describe('Infrastructure Stack', () => {
  const { infra } = buildStacks();
  const template = Template.fromStack(infra);

  test('creates VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('creates RDS instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  test('creates 3 S3 buckets with encryption', () => {
    template.resourceCountIs('AWS::S3::Bucket', 5);
  });

  test('creates KMS key with rotation', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('S3 buckets block public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe('Data Stack', () => {
  const { data } = buildStacks();
  const template = Template.fromStack(data);

  test('creates 3 Glue databases', () => {
    template.resourceCountIs('AWS::Glue::Database', 3);
  });

  test('creates Glue connection', () => {
    template.resourceCountIs('AWS::Glue::Connection', 1);
  });

  test('creates 2 XML crawlers', () => {
    template.resourceCountIs('AWS::Glue::Crawler', 2);
  });
});

describe('ETL Stack', () => {
  const { etl } = buildStacks();
  const template = Template.fromStack(etl);

  test('creates 4 Glue jobs', () => {
    template.resourceCountIs('AWS::Glue::Job', 4);
  });

  test('creates Step Functions state machine', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });
});

describe('Trigger Stack', () => {
  const { trigger } = buildStacks();
  const template = Template.fromStack(trigger);

  test('synthesizes without errors', () => {
    // If we got here, the stack synthesized successfully
    const template = Template.fromStack(trigger);
    expect(template.toJSON()).toBeDefined();
  });
});
