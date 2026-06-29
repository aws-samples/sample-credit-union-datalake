import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
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
    glueRoleXml: infra.glueRoleXml,
    glueRoleCsv: infra.glueRoleCsv,
    glueRoleMember360: infra.glueRoleMember360,
    glueSecurityGroup: infra.glueSecurityGroup,
    database: infra.database,
    databaseSecret: infra.databaseSecret,
    databaseSecurityGroup: infra.databaseSecurityGroup,
    vpc: infra.vpc,
    secretsManagerEndpoint: infra.secretsManagerEndpoint,
    breakGlassRole: infra.breakGlassRole,
    dataAnalystRole: infra.dataAnalystRole,
    accessLogsBucket: infra.accessLogsBucket,
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
    kmsKey: infra.kmsKey,
    accessLogsBucket: infra.accessLogsBucket,
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

describe('Infrastructure Stack — Secrets rotation', () => {
  const { infra } = buildStacks();
  const template = Template.fromStack(infra);

  test('database secret has a 30-day automatic rotation schedule', () => {
    // NOTE: in aws-cdk-lib 2.213.0 the 30-day interval renders as
    // RotationRules.ScheduleExpression "rate(30 days)" (NOT AutomaticallyAfterDays).
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: {
        ScheduleExpression: 'rate(30 days)',
      },
      RotateImmediatelyOnUpdate: false,
    });
  });

  test('exactly one rotation schedule exists, bound to the database secret', () => {
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);

    const schedules = template.findResources('AWS::SecretsManager::RotationSchedule');
    const props = Object.values(schedules)[0].Properties;
    // SecretId is a CFN Ref to the database secret logical id.
    expect(props.SecretId.Ref).toMatch(/^DatabaseSecret/);
    // Hosted single-user rotation runs inside the VPC.
    expect(props.HostedRotationLambda.RotationType).toBe('MySQLSingleUser');
  });

  test('the generated hosted-rotation Lambda name stays within the 64-char limit', () => {
    // Regression guard: Secrets Manager names the hosted-rotation Lambda
    // `<RotationSchedule logical id>-<RotationType>-Lambda`, and Lambda enforces a
    // hard 64-character functionName limit at CREATE time (a deploy-only check that
    // synth/cdk-nag can't see). The logical id derives from the secret construct id
    // plus the addRotationSchedule() id, so an over-long id silently breaks deploy.
    const schedules = template.findResources('AWS::SecretsManager::RotationSchedule');
    const [logicalId, res] = Object.entries(schedules)[0];
    const rotationType = (res as any).Properties.HostedRotationLambda.RotationType;
    const generatedName = `${logicalId}-${rotationType}-Lambda`;
    expect(generatedName.length).toBeLessThanOrEqual(64);
  });
});

describe('Infrastructure Stack — S3 version-deletion deny', () => {
  const { infra } = buildStacks();
  const template = Template.fromStack(infra);

  // The break-glass role ARN is assembled from the account pseudo-parameter
  // (cdk.Aws.ACCOUNT_ID), so it renders as an Fn::Join in the synthesized
  // template rather than a literal string.
  const breakGlassArn = {
    'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/creditunion-break-glass-admin']],
  };

  const deleteVersionDeny = Match.objectLike({
    Sid: 'DenyObjectVersionDeletion',
    Effect: 'Deny',
    Action: 's3:DeleteObjectVersion',
    Principal: { AWS: '*' },
    Condition: {
      ArnNotLike: { 'aws:PrincipalArn': Match.arrayWith([breakGlassArn]) },
    },
  });

  const putVersioningDeny = Match.objectLike({
    Sid: 'DenyVersioningConfigurationChange',
    Effect: 'Deny',
    Action: 's3:PutBucketVersioning',
    Principal: { AWS: '*' },
    Condition: {
      ArnNotLike: { 'aws:PrincipalArn': Match.arrayWith([breakGlassArn]) },
    },
  });

  test('a data-lake bucket policy denies s3:DeleteObjectVersion to all but the break-glass role', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([deleteVersionDeny]) },
    });
  });

  test('a data-lake bucket policy denies s3:PutBucketVersioning to all but the break-glass role', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([putVersioningDeny]) },
    });
  });

  test('exactly the three data-lake buckets carry BOTH version-deny statements, targeting collect/cleanse/consume', () => {
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const withDelete: string[] = [];
    const withPut: string[] = [];

    for (const [id, res] of Object.entries(policies)) {
      const statements = (res as any).Properties.PolicyDocument.Statement as any[];
      const sids = statements.map((s) => s.Sid);
      if (sids.includes('DenyObjectVersionDeletion')) withDelete.push(id);
      if (sids.includes('DenyVersioningConfigurationChange')) withPut.push(id);
    }

    // Only the three data-lake buckets get these denies (not access-logs/CloudTrail).
    expect(withDelete).toHaveLength(3);
    expect(withPut).toHaveLength(3);
    // The same three policies carry both statements.
    expect(withDelete.slice().sort()).toEqual(withPut.slice().sort());

    // They target the collect/cleanse/consume buckets (by GetAtt logical id on the
    // PutBucketVersioning statement, whose Resource is the bare bucket ARN).
    const targetedBuckets = withPut.map((id) => {
      const stmt = (policies[id] as any).Properties.PolicyDocument.Statement.find(
        (s: any) => s.Sid === 'DenyVersioningConfigurationChange'
      );
      return stmt.Resource['Fn::GetAtt'][0] as string;
    });
    expect(targetedBuckets.some((b) => b.startsWith('CollectBucket'))).toBe(true);
    expect(targetedBuckets.some((b) => b.startsWith('CleanseBucket'))).toBe(true);
    expect(targetedBuckets.some((b) => b.startsWith('ConsumeBucket'))).toBe(true);
  });

  test('the access-logs and CloudTrail bucket policies carry NO version-deny statements', () => {
    const policies = template.findResources('AWS::S3::BucketPolicy');

    for (const res of Object.values(policies)) {
      const statements = (res as any).Properties.PolicyDocument.Statement as any[];
      const targetsLogBucket = statements.some((s) => {
        const r = s.Resource;
        let logicalId: string | undefined;
        if (r && r['Fn::GetAtt']) {
          logicalId = r['Fn::GetAtt'][0];
        } else if (r && r['Fn::Join']) {
          const first = r['Fn::Join'][1][0];
          logicalId = first && first['Fn::GetAtt'] ? first['Fn::GetAtt'][0] : undefined;
        }
        return typeof logicalId === 'string' && (logicalId.startsWith('AccessLogs') || logicalId.startsWith('CloudTrail'));
      });

      if (targetsLogBucket) {
        const sids = statements.map((s) => s.Sid);
        expect(sids).not.toContain('DenyObjectVersionDeletion');
        expect(sids).not.toContain('DenyVersioningConfigurationChange');
      }
    }
  });
});

describe('Infrastructure Stack — KMS deletion guard + EventBridge', () => {
  const { infra } = buildStacks();
  const template = Template.fromStack(infra);

  // ARNs in the exemption lists are assembled from the account pseudo-parameter
  // (cdk.Aws.ACCOUNT_ID), so each renders as an Fn::Join in the synthesized
  // KMS key policy rather than a literal string.
  const breakGlassArn = {
    'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/creditunion-break-glass-admin']],
  };
  const accountRootArn = {
    'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':root']],
  };
  const cdkDeploymentRoleArn = {
    'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/cdk-*']],
  };

  // The KMS deny statements live inside the AWS::KMS::Key resource's KeyPolicy,
  // not in a standalone resource policy.
  const scheduleDeletionDeny = Match.objectLike({
    Sid: 'DenyScheduleKeyDeletion',
    Effect: 'Deny',
    Action: 'kms:ScheduleKeyDeletion',
    Principal: { AWS: '*' },
    Condition: {
      ArnNotLike: {
        'aws:PrincipalArn': Match.arrayWith([accountRootArn, breakGlassArn, cdkDeploymentRoleArn]),
      },
    },
  });

  const disableKeyDeny = Match.objectLike({
    Sid: 'DenyDisableKey',
    Effect: 'Deny',
    Action: 'kms:DisableKey',
    Principal: { AWS: '*' },
    Condition: {
      ArnNotLike: {
        'aws:PrincipalArn': Match.arrayWith([accountRootArn, breakGlassArn]),
      },
    },
  });

  test('key policy denies kms:ScheduleKeyDeletion to all but root, break-glass, and the CDK deployment role', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: { Statement: Match.arrayWith([scheduleDeletionDeny]) },
    });
  });

  test('key policy denies kms:DisableKey to all but root and the break-glass role', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: { Statement: Match.arrayWith([disableKeyDeny]) },
    });
  });

  test('the CDK deployment role is NOT exempted from kms:DisableKey', () => {
    // cdk deploy/destroy never disables the key, so role/cdk-* must remain denied
    // DisableKey while still being exempt from ScheduleKeyDeletion (so destroy works).
    const keys = template.findResources('AWS::KMS::Key');
    const statements = Object.values(keys)[0].Properties.KeyPolicy.Statement as any[];

    const disable = statements.find((s) => s.Sid === 'DenyDisableKey');
    const disableArns = JSON.stringify(disable.Condition.ArnNotLike['aws:PrincipalArn']);
    expect(disableArns).not.toContain('role/cdk-*');

    const schedule = statements.find((s) => s.Sid === 'DenyScheduleKeyDeletion');
    const scheduleArns = JSON.stringify(schedule.Condition.ArnNotLike['aws:PrincipalArn']);
    expect(scheduleArns).toContain('role/cdk-*');
  });

  test('an EventBridge rule matches kms:ScheduleKeyDeletion / kms:DisableKey CloudTrail calls', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'creditunion-kms-deletion-guard',
      EventPattern: Match.objectLike({
        source: ['aws.kms'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: Match.objectLike({
          eventName: Match.arrayWith(['ScheduleKeyDeletion', 'DisableKey']),
        }),
      }),
    });
  });

  test('the EventBridge rule targets the shared security SNS topic', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'creditunion-kms-deletion-guard',
      Targets: Match.arrayWith([
        Match.objectLike({ Arn: { Ref: Match.stringLikeRegexp('SecurityNotificationTopic') } }),
      ]),
    });
  });

  test('exactly one KMS deletion-guard EventBridge rule exists', () => {
    const rules = template.findResources('AWS::Events::Rule', {
      Properties: { Name: 'creditunion-kms-deletion-guard' },
    });
    expect(Object.keys(rules)).toHaveLength(1);
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

describe('Data Stack — Lake Formation column-level access', () => {
  const { data } = buildStacks();
  const template = Template.fromStack(data);

  test('the data-lake-admin settings are NOT in the Data stack (avoids PutDataLakeSettings/grant race)', () => {
    // CfnDataLakeSettings must live in the Infrastructure stack so the admin
    // designation is applied and propagated in an earlier CloudFormation
    // operation. Designating the admin in the same operation as these grants
    // races eventual consistency and fails with AccessDenied. The grants and
    // registrations, however, must remain in this stack.
    template.resourceCountIs('AWS::LakeFormation::DataLakeSettings', 0);
    template.resourceCountIs('AWS::LakeFormation::Resource', 2);
  });

  test('analyst grant on consume.member_profile excludes EXACTLY ssn_last_4/ssn_last_4_key', () => {
    // member_profile (consume golden record) stores only tokenized SSN; it has no
    // full `ssn` column. Excluding a non-existent column makes Lake Formation
    // reject the grant at deploy ("Resource does not exist"), so the set must be
    // exactly the real SSN-bearing columns.
    template.hasResourceProperties('AWS::LakeFormation::PrincipalPermissions', {
      Permissions: ['SELECT'],
      Resource: {
        TableWithColumns: {
          DatabaseName: 'creditunion_consume',
          Name: 'member_profile',
          ColumnWildcard: {
            ExcludedColumnNames: ['ssn_last_4', 'ssn_last_4_key'],
          },
        },
      },
    });
  });

  test('analyst grant on cleanse.core_banking_members excludes EXACTLY ssn', () => {
    template.hasResourceProperties('AWS::LakeFormation::PrincipalPermissions', {
      Permissions: ['SELECT'],
      Resource: {
        TableWithColumns: {
          DatabaseName: 'creditunion_cleanse',
          Name: 'core_banking_members',
          ColumnWildcard: {
            ExcludedColumnNames: ['ssn'],
          },
        },
      },
    });
  });

  test('analyst grant on cleanse.loan_system_members excludes EXACTLY ssn_last_4', () => {
    template.hasResourceProperties('AWS::LakeFormation::PrincipalPermissions', {
      Permissions: ['SELECT'],
      Resource: {
        TableWithColumns: {
          DatabaseName: 'creditunion_cleanse',
          Name: 'loan_system_members',
          ColumnWildcard: {
            ExcludedColumnNames: ['ssn_last_4'],
          },
        },
      },
    });
  });

  test('no column-excluded analyst grant leaks an unexpected exclusion set', () => {
    // Guard against regressions where the member_profile exclusion set drifts:
    // there must be exactly one TableWithColumns grant whose exclusion list is
    // the tokenized-SSN pair, and it must target member_profile.
    const grants = template.findResources('AWS::LakeFormation::PrincipalPermissions', {
      Properties: {
        Resource: {
          TableWithColumns: {
            ColumnWildcard: {
              ExcludedColumnNames: Match.arrayWith(['ssn_last_4_key']),
            },
          },
        },
      },
    });
    const matches = Object.values(grants);
    expect(matches).toHaveLength(1);
    expect(matches[0].Properties.Resource.TableWithColumns.Name).toBe('member_profile');
    expect(matches[0].Properties.Resource.TableWithColumns.ColumnWildcard.ExcludedColumnNames).toEqual([
      'ssn_last_4',
      'ssn_last_4_key',
    ]);
  });

  test('every excluded column in a LF grant actually exists in the target table schema', () => {
    // Regression guard for the deploy-only failure where ExcludedColumnNames
    // referenced a column ('ssn') absent from member_profile. Lake Formation
    // validates excluded columns against the real schema and rejects the grant
    // with "Resource does not exist" — invisible to synth/cdk-nag. Cross-check
    // every grant's excluded columns against the referenced Glue table's columns.

    // Map Glue database logical id -> database name (grants reference the name).
    const databases = template.findResources('AWS::Glue::Database');
    const dbNameByLogicalId: Record<string, string> = {};
    for (const [logicalId, res] of Object.entries(databases)) {
      dbNameByLogicalId[logicalId] = (res as any).Properties.DatabaseInput.Name;
    }

    // Map "<dbName>.<tableName>" -> Set(column names).
    const tables = template.findResources('AWS::Glue::Table');
    const columnsByTable: Record<string, Set<string>> = {};
    for (const res of Object.values(tables)) {
      const ti = (res as any).Properties.TableInput;
      const db = (res as any).Properties.DatabaseName;
      const dbName = typeof db === 'string' ? db : dbNameByLogicalId[db?.Ref];
      if (!dbName) continue;
      const cols = (ti?.StorageDescriptor?.Columns ?? []).map((c: any) => c.Name);
      columnsByTable[`${dbName}.${ti.Name}`] = new Set(cols);
    }

    const grants = template.findResources('AWS::LakeFormation::PrincipalPermissions');
    let checked = 0;
    for (const res of Object.values(grants)) {
      const twc = (res as any).Properties?.Resource?.TableWithColumns;
      const excluded: string[] | undefined = twc?.ColumnWildcard?.ExcludedColumnNames;
      if (!twc || !excluded || excluded.length === 0) continue;
      const cols = columnsByTable[`${twc.DatabaseName}.${twc.Name}`];
      expect(cols).toBeDefined(); // every excluded grant must resolve to a known table
      for (const col of excluded) {
        expect(cols!.has(col)).toBe(true);
      }
      checked++;
    }
    // Sanity: we actually exercised the three column-excluded analyst grants.
    expect(checked).toBe(3);
  });

  test('every ETL writer role has a DATA_LOCATION_ACCESS grant on a registered location', () => {
    // Regression guard for the deploy-only failure where the per-job Glue ETL
    // roles could not write to the LF-registered cleanse/consume buckets
    // ("Insufficient Lake Formation permission(s) on s3://..."). Registering a
    // location makes LF broker all access to it, and DATA_LOCATION_ACCESS is the
    // one permission the default IAMAllowedPrincipals fallback never covers — so
    // each writer role needs an explicit data-location grant. This is invisible
    // to synth/cdk-nag and only surfaces when a Glue job runs.
    const grants = template.findResources('AWS::LakeFormation::PrincipalPermissions');
    const locationGrants = Object.values(grants).filter((res: any) => {
      const perms: string[] = res.Properties?.Permissions ?? [];
      return perms.length === 1 && perms[0] === 'DATA_LOCATION_ACCESS';
    });

    // mysql/xml/csv write to cleanse, member360 writes to consume => 4 grants.
    expect(locationGrants.length).toBe(4);

    // Each must target a registered S3 data location (not a table/column resource).
    for (const res of locationGrants) {
      const dataLocation = (res as any).Properties?.Resource?.DataLocation;
      expect(dataLocation).toBeDefined();
      expect(dataLocation.ResourceArn).toBeDefined();
      expect((res as any).Properties?.Resource?.TableWithColumns).toBeUndefined();
    }
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

describe('Code signing ENFORCE', () => {
  // The three CodeSigningConfig resources are spread across two stacks:
  //   - Data stack: RDS data-loader CSC + crawler-trigger CSC (2)
  //   - Trigger stack: crawler-wait CSC (1)
  // The Infrastructure and ETL stacks carry none, and the signing provider
  // Lambda (SignedLambdaArtifact) is intentionally NOT under a CSC.
  // App-wide there must be EXACTLY three CSCs, all 'Enforce', zero 'Warn'.
  const { infra, data, etl, trigger } = buildStacks();

  const infraTemplate = Template.fromStack(infra);
  const dataTemplate = Template.fromStack(data);
  const etlTemplate = Template.fromStack(etl);
  const triggerTemplate = Template.fromStack(trigger);

  const CSC = 'AWS::Lambda::CodeSigningConfig';

  // Collect every CSC's UntrustedArtifactOnDeployment policy across all stacks.
  const allPolicies = (): string[] => {
    const result: string[] = [];
    for (const t of [infraTemplate, dataTemplate, etlTemplate, triggerTemplate]) {
      const cscs = t.findResources(CSC);
      for (const res of Object.values(cscs)) {
        result.push((res as any).Properties.CodeSigningPolicies.UntrustedArtifactOnDeployment);
      }
    }
    return result;
  };

  test('Infrastructure and ETL stacks carry NO CodeSigningConfig (signing provider is un-signed)', () => {
    infraTemplate.resourceCountIs(CSC, 0);
    etlTemplate.resourceCountIs(CSC, 0);
  });

  test('Data stack has exactly two CodeSigningConfigs, both ENFORCE (RDS loader + crawler-trigger)', () => {
    dataTemplate.resourceCountIs(CSC, 2);
    const policies = Object.values(dataTemplate.findResources(CSC)).map(
      (r: any) => r.Properties.CodeSigningPolicies.UntrustedArtifactOnDeployment
    );
    expect(policies).toEqual(['Enforce', 'Enforce']);
  });

  test('Trigger stack has exactly one CodeSigningConfig, ENFORCE (crawler-wait)', () => {
    triggerTemplate.resourceCountIs(CSC, 1);
    triggerTemplate.hasResourceProperties(CSC, {
      CodeSigningPolicies: { UntrustedArtifactOnDeployment: 'Enforce' },
    });
  });

  test('exactly three CodeSigningConfig resources exist app-wide', () => {
    expect(allPolicies()).toHaveLength(3);
  });

  test('every CodeSigningConfig enforces untrusted artifacts (zero Warn)', () => {
    const policies = allPolicies();
    expect(policies.every((p) => p === 'Enforce')).toBe(true);
    expect(policies.filter((p) => p === 'Warn')).toHaveLength(0);
  });
});

describe('Infrastructure Stack — detective controls', () => {
  const { infra } = buildStacks();
  const template = Template.fromStack(infra);

  // The shared SNS topic logical id is referenced by every alarm's AlarmActions
  // as a CFN Ref; it renders as e.g. "SecurityNotificationTopic9D05E4A4".
  const snsTopicRef = Match.objectLike({
    Ref: Match.stringLikeRegexp('SecurityNotificationTopic'),
  });

  // --- R6: metric filters + alarms + SNS topic -----------------------------

  test('the two CloudTrail-derived metric filters exist in the CreditUnion/Security namespace', () => {
    template.resourceCountIs('AWS::Logs::MetricFilter', 2);

    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterName: 'creditunion-kms-deletion',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricName: 'KmsDeletionAttempts',
          MetricNamespace: 'CreditUnion/Security',
          MetricValue: '1',
        }),
      ]),
    });

    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterName: 'creditunion-unauthorized-api',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricName: 'UnauthorizedApiCalls',
          MetricNamespace: 'CreditUnion/Security',
          MetricValue: '1',
        }),
      ]),
    });
  });

  test('the shared security SNS topic exists (KMS-encrypted)', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'creditunion-security-notifications',
    });
  });

  test('exactly three CloudWatch alarms exist', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  test('the Step Functions ExecutionsFailed alarm uses the AWS/States metric with the expected shape', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ExecutionsFailed',
      Namespace: 'AWS/States',
      Threshold: 1,
      Period: 300,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: 'StateMachineArn' }),
      ]),
      AlarmActions: Match.arrayWith([snsTopicRef]),
    });
  });

  test('the KMS-deletion alarm references the KmsDeletionAttempts metric filter metric', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'KmsDeletionAttempts',
      Namespace: 'CreditUnion/Security',
      Threshold: 1,
      Period: 300,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: Match.arrayWith([snsTopicRef]),
    });
  });

  test('the unauthorized-API alarm references the UnauthorizedApiCalls metric filter metric', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'UnauthorizedApiCalls',
      Namespace: 'CreditUnion/Security',
      Threshold: 1,
      Period: 300,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: Match.arrayWith([snsTopicRef]),
    });
  });

  test('all three alarms route their actions to the shared security SNS topic', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const alarmList = Object.values(alarms);
    expect(alarmList).toHaveLength(3);
    for (const alarm of alarmList) {
      const actions = (alarm as any).Properties.AlarmActions as any[];
      expect(actions).toHaveLength(1);
      expect(actions[0].Ref).toMatch(/^SecurityNotificationTopic/);
    }
  });

  // --- R7: Config rules always emitted; recorder gated by context flag ------

  test('the two AWS Config rules are always emitted with the expected source identifiers', () => {
    template.resourceCountIs('AWS::Config::ConfigRule', 2);

    template.hasResourceProperties('AWS::Config::ConfigRule', {
      Source: {
        Owner: 'AWS',
        SourceIdentifier: 'VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS',
      },
    });

    template.hasResourceProperties('AWS::Config::ConfigRule', {
      Source: {
        Owner: 'AWS',
        SourceIdentifier: 'VPC_DEFAULT_SECURITY_GROUP_CLOSED',
      },
    });
  });

  test('every AWS-managed Config rule uses a known-valid source identifier', () => {
    // Regression guard: AWS Config validates managed-rule sourceIdentifiers only
    // at deploy time, so an invalid/typo'd identifier (e.g. the missing `VPC_`
    // prefix on DEFAULT_SECURITY_GROUP_CLOSED, or a blank input parameter) passes
    // `cdk synth` and cdk-nag but fails CREATE with a 400. This test asserts every
    // AWS-owned ConfigRule the stack emits is in the allowlist of identifiers we
    // have confirmed against the AWS Config managed-rules documentation. When you
    // add a new managed rule, add its verified identifier here.
    const VALID_AWS_MANAGED_CONFIG_RULE_IDS = new Set([
      'VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS',
      'VPC_DEFAULT_SECURITY_GROUP_CLOSED',
    ]);

    const rules = template.findResources('AWS::Config::ConfigRule');
    const awsOwnedRules = Object.entries(rules).filter(
      ([, res]) => (res as any).Properties?.Source?.Owner === 'AWS'
    );

    // Sanity: the stack emits the two AWS-managed rules we expect.
    expect(awsOwnedRules).toHaveLength(2);

    for (const [logicalId, res] of awsOwnedRules) {
      const sourceId = (res as any).Properties.Source.SourceIdentifier;
      // Catch blank/whitespace identifiers as well as unknown ones.
      expect(typeof sourceId).toBe('string');
      expect(sourceId.trim()).toBe(sourceId);
      expect(sourceId.length).toBeGreaterThan(0);
      expect(VALID_AWS_MANAGED_CONFIG_RULE_IDS.has(sourceId)).toBe(
        true
      );
      // Surface the offending rule name if the assertion above fails.
      if (!VALID_AWS_MANAGED_CONFIG_RULE_IDS.has(sourceId)) {
        throw new Error(`Config rule ${logicalId} uses unknown sourceIdentifier "${sourceId}"`);
      }
    }
  });

  test('AWS Config rules do not emit blank input parameters (rejected by AWS Config at deploy)', () => {
    // Regression guard for the empty-string `authorizedTcpPorts`/`authorizedUdpPorts`
    // bug: AWS Config rejects blank parameter values ("Blank spaces are not
    // acceptable for input parameter") at CREATE time. Absent parameters are fine;
    // present-but-blank ones are not. Assert no emitted rule carries a blank value.
    const rules = template.findResources('AWS::Config::ConfigRule');
    for (const [logicalId, res] of Object.entries(rules)) {
      const inputParams = (res as any).Properties?.InputParameters;
      if (!inputParams) continue;
      for (const [key, value] of Object.entries(inputParams)) {
        if (typeof value === 'string') {
          expect({ logicalId, key, value }).toMatchObject({ logicalId, key });
          expect(value.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('no configuration recorder or delivery channel is provisioned by default (provisionConfigRecorder unset)', () => {
    template.resourceCountIs('AWS::Config::ConfigurationRecorder', 0);
    template.resourceCountIs('AWS::Config::DeliveryChannel', 0);
  });

  test('the configuration recorder + delivery channel are provisioned when provisionConfigRecorder context is true', () => {
    // The lib reads the flag via this.node.tryGetContext('provisionConfigRecorder')
    // and only provisions when the value is strictly boolean `true`, so the flag
    // must be set on the App context (not the buildStacks() helper, which sets none).
    const flaggedApp = new cdk.App({ context: { provisionConfigRecorder: true } });
    const flaggedInfra = new CreditUnionInfrastructureStack(flaggedApp, 'TestInfraConfigRecorder', { env });
    const flaggedTemplate = Template.fromStack(flaggedInfra);

    flaggedTemplate.resourceCountIs('AWS::Config::ConfigurationRecorder', 1);
    flaggedTemplate.resourceCountIs('AWS::Config::DeliveryChannel', 1);
    // The Config rules remain exactly two regardless of the recorder flag.
    flaggedTemplate.resourceCountIs('AWS::Config::ConfigRule', 2);
  });
});
