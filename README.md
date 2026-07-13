<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Credit Union Data Lake (CUDL)

> **Sample code notice:** This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment. The sample data in `sample-data/` is synthetic and fictitious; do not use this solution with real customer data without first completing the post-deployment security actions listed below.

A complete, deployable Member 360 data lake for credit unions built with the [AWS CDK](https://aws.amazon.com/cdk/). Ingests data from five heterogeneous source systems, performs entity resolution, and produces a unified member profile with 51 attributes — all with a single `cdk deploy --all` command.

> **Sample data disclaimer:** All names, addresses, Social Security Numbers, phone numbers, and email addresses in `sample-data/` are entirely fictitious, generated using the Python Faker library. Any resemblance to real persons is purely coincidental.

## What it deploys

- **Amazon Relational Database Service (Amazon RDS) for MySQL** with ~2,000 sample core banking member records (auto-loaded)
- **Amazon S3 Data Lake** — collect, cleanse, and consume buckets with KMS encryption
- **4 AWS Glue Visual ETL Jobs** — MySQL→Parquet, XML→Parquet, CSV→Parquet, Member 360 aggregation
- **AWS Step Functions** pipeline with parallel/sequential orchestration
- **AWS Glue Data Catalog** — 3 databases, pre-defined table schemas, XML crawlers
- **Full automation** — Lambda functions + CloudFormation custom resources trigger the entire pipeline on deploy

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │            Data Sources                  │
                    │  Amazon RDS for MySQL · CSV Files · XML Files       │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Collect Zone (S3 — KMS Encrypted)       │
                    └──────────────────┬──────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
    ┌─────────▼─────────┐  ┌──────────▼──────────┐  ┌─────────▼─────────┐
    │  MySQL ETL (AWS Glue)  │  │  XML ETL (AWS Glue)     │  │  CSV ETL (AWS Glue)   │
    │  RDS → Parquet     │  │  XML → Parquet      │  │  CSV → Parquet    │
    └─────────┬─────────┘  └──────────┬──────────┘  └─────────┬─────────┘
              └────────────────────────┼────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Cleanse Zone (S3 — Snappy Parquet)      │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Member 360 ETL (AWS Glue)                   │
                    │  Entity Resolution · 5-Source Join        │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Consume Zone (S3 — Analytics-Ready)     │
                    │  member_profile: 51 columns, ~2K rows    │
                    └──────────────────┬──────────────────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         │     Query / BI (optional)  │
                         │  Amazon Athena · QuickSight │
                         └────────────────────────────┘
```

> The consume zone is queryable as-is with Amazon Athena. Amazon QuickSight is an optional downstream BI layer and is **not** deployed by this project.

## Security

This project deploys security controls as a starting point. Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/):

- **AWS is responsible for security *of* the cloud**: protecting the infrastructure that runs AWS services (hardware, software, networking, facilities).
- **Customers are responsible for security *in* the cloud**: configuring and managing the services deployed by this project, including access management, data protection, and ongoing monitoring.

Customers are responsible for configuring and maintaining these controls for their specific requirements.

### Implemented security controls

The following controls are deployed by this project as a baseline. Customers should review, validate, and customize these for their specific security and compliance requirements before production use:

- Customer-managed AWS KMS key with auto-rotation for Amazon S3 bucket and Amazon RDS encryption at rest
- **[M4]** AWS KMS key deletion guard — key-policy denies on `kms:ScheduleKeyDeletion` and `kms:DisableKey` (break-glass admin only) with an Amazon EventBridge rule monitoring those API calls
- Amazon Relational Database Service (Amazon RDS) deployed in isolated subnets with no internet access
- Amazon VPC endpoints for Amazon S3 and AWS Secrets Manager (no public internet traffic)
- Amazon S3 public access blocked, TLS enforced, versioning enabled, server access logging enabled
- **[M3]** Amazon S3 version-deletion and versioning-change deny policies on the collect, cleanse, and consume buckets (break-glass admin only); MFA Delete remains a documented customer action (see below)
- **[M1]** AWS Lake Formation column-level access controls excluding the SSN columns from the default SELECT grant for the data-analyst role: the consume `member_profile` table excludes `ssn_last_4` and `ssn_last_4_key` (the consume golden record stores only tokenized SSN and has no full `ssn` column), the cleanse `core_banking_members` table excludes `ssn`, and the cleanse `loan_system_members` table excludes `ssn_last_4`
- Per-job AWS IAM roles with least-privilege policies for AWS Glue, AWS Lambda, and AWS Step Functions
- Amazon Relational Database Service (Amazon RDS) credentials auto-generated in AWS Secrets Manager, retrieved via Amazon VPC endpoint
- **[M2]** AWS Secrets Manager 30-day automatic rotation of the Amazon RDS database credentials (hosted single-user rotation in the RDS VPC/isolated subnets)
- AWS CloudTrail with log file validation and immutable audit log bucket
- Amazon VPC Flow Logs for network traffic monitoring
- **[M6]** Amazon CloudWatch alarms and metric filters for AWS KMS key-deletion attempts, failed AWS Step Functions executions, and unauthorized API calls, routed to a stack-managed Amazon SNS topic
- **[M7]** AWS Config rules for security-group / network configuration monitoring (rules always deployed; the AWS Config configuration recorder is optional via the `provisionConfigRecorder` flag)
- **[M5]** AWS Lambda code signing via AWS Signer in ENFORCE mode on the three target Lambda functions (RDS data loader, crawler-trigger, crawler-wait)
- AWS Glue job concurrency limits to prevent resource exhaustion

> **Previously customer responsibilities, now deployed:** AWS Lake Formation column-level access (**M1**), AWS Secrets Manager 30-day rotation (**M2**), Amazon CloudWatch alarms (**M6**), and AWS Config security-group/network rules (**M7**) are deployed by this project. See "Implemented security controls" above. The two items below remain customer responsibilities because they cannot be configured through AWS CDK.

### Customer responsibilities (post-deployment)

Customers should complete the following security actions before using this solution with production data. These two controls cannot be configured by AWS CDK and remain the customer's ongoing responsibility:

1. **Configure MFA Delete** on sensitive Amazon S3 buckets (collect, cleanse, consume). This requires root account credentials and cannot be automated via AWS CDK. The deployment already denies object-version deletion and versioning changes on these buckets (M3); MFA Delete is the residual exception documented in the [Security Exceptions register](docs/security-exceptions.md) (Exception 4).

   ```bash
   aws s3api put-bucket-versioning \
     --bucket creditunion-ACCOUNT-REGION-collect \
     --versioning-configuration Status=Enabled,MFADelete=Enabled \
     --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP_CODE"
   ```

2. **Review and customize AWS IAM role permissions** for your specific access requirements. The deployed roles use least-privilege scoping but may need adjustment for your organization's policies.

   ```bash
   aws iam list-attached-role-policies --role-name creditunion-REGION-glue-mysql
   aws iam get-role-policy --role-name creditunion-REGION-glue-mysql --policy-name S3Access
   ```

> **Important:** The sample data in `sample-data/` is entirely synthetic, generated using the Python Faker library. Do not use real customer data without first completing all post-deployment security actions listed above.

## Quick start

### Option 1: AWS CloudShell (easiest)

```bash
git clone https://github.com/aws-samples/sample-credit-union-datalake.git
cd sample-credit-union-datalake
npm install
npm run build
cdk deploy --all --require-approval never
```

### Option 2: Local development

**Prerequisites:** AWS CLI configured, Node.js v18+, AWS CDK v2 (`npm install -g aws-cdk`)

```bash
git clone https://github.com/aws-samples/sample-credit-union-datalake.git
cd sample-credit-union-datalake
npm install
npm run build
cdk bootstrap    # first time only
cdk deploy --all --require-approval never
```

Deployment typically takes 25–35 minutes depending on region and account configuration. Actual times may vary. The pipeline runs automatically — no manual steps after deploy.

## Verify results

```bash
# Check consume bucket for member profiles
aws s3 ls s3://creditunion-$(aws sts get-caller-identity --query Account --output text)-$(aws configure get region)-consume/CreditUnionData/ --recursive

# Check member_profile table schema (51 columns expected)
aws glue get-table --database-name creditunion_consume --name member_profile \
  --query 'Table.StorageDescriptor.Columns[].Name'
```

## After deployment: query the data lake

The pipeline runs automatically on deploy and writes the unified profile to `creditunion_consume.member_profile`. Before you can query it, it helps to understand how access is governed.

### Access model

The consume and cleanse Amazon S3 buckets are **registered with AWS Lake Formation** and protected by a bucket policy that **denies direct `s3:GetObject`** to any principal outside the pipeline's own roles. This is intentional: it prevents people and tools from reading raw member PII straight out of Amazon S3. All analytical access is expected to flow through AWS Lake Formation, which brokers Amazon S3 access on your behalf using the registration role.

As a result, holding AWS Identity and Access Management (AWS IAM) admin rights is **not** enough to query the data. If you run an Amazon Athena query as a principal that has no AWS Lake Formation grant, Athena falls back to your own identity to read Amazon S3 and you receive an explicit-deny 403.

### Grant a query principal access

Grant the identity you query with (an analyst role, an AWS IAM Identity Center permission set, or the deployed `creditunion-data-analyst` role) `SELECT` on the table through AWS Lake Formation:

```bash
aws lakeformation grant-permissions \
  --region <REGION> \
  --principal DataLakePrincipalIdentifier=arn:aws:iam::<ACCOUNT>:role/<YOUR_QUERY_ROLE> \
  --resource '{"Table":{"DatabaseName":"creditunion_consume","Name":"member_profile"}}' \
  --permissions SELECT
```

To exclude the tokenized SSN columns from the grant (the least-privilege analyst view), use a column exclusion instead:

```bash
--resource '{"TableWithColumns":{"DatabaseName":"creditunion_consume","Name":"member_profile","ColumnWildcard":{"ExcludedColumnNames":["ssn_last_4","ssn_last_4_key"]}}}'
```

Your query principal also needs AWS IAM permissions for the query APIs themselves — `athena:StartQueryExecution` / `athena:GetQueryResults`, `glue:GetTable` / `glue:GetPartitions` / `glue:GetDatabase`, `lakeformation:GetDataAccess`, and read/write to your Athena query-results bucket. It does **not** need `s3:GetObject` on the data buckets; AWS Lake Formation vends that access.

### Run a query

Set an Amazon Athena query-results location, then query as your granted principal:

```bash
aws athena start-query-execution \
  --region <REGION> \
  --query-string "SELECT COUNT(*) FROM creditunion_consume.member_profile;" \
  --query-execution-context Database=creditunion_consume \
  --result-configuration OutputLocation=s3://<YOUR_ATHENA_RESULTS_BUCKET>/
```

See [Sample Athena queries](#sample-athena-queries) for analytics examples.

### Note on AWS Lake Formation hybrid mode

The buckets are registered in AWS Lake Formation **hybrid access mode**, which keeps an `IAM_ALLOWED_PRINCIPALS` fallback on the catalog tables. If a granted principal still hits an Amazon S3 explicit-deny, that fallback is causing Athena to use IAM-based access instead of AWS Lake Formation credential vending. For a fully governed, grant-only model, remove the fallback on the table so AWS Lake Formation brokers all access:

```bash
aws lakeformation revoke-permissions \
  --region <REGION> \
  --principal DataLakePrincipalIdentifier=IAM_ALLOWED_PRINCIPALS \
  --resource '{"Table":{"DatabaseName":"creditunion_consume","Name":"member_profile"}}' \
  --permissions ALL
```

Before doing this, make sure every role that reads or writes the table — including the Member 360 ETL job role `creditunion-<region>-glue-member360` — holds an explicit AWS Lake Formation grant, or the next pipeline run will fail with an insufficient-permissions error.

### Visualize in Amazon QuickSight (optional)

Amazon QuickSight is not deployed by this project. To build dashboards, connect Amazon QuickSight to Amazon Athena and grant the QuickSight service role (`aws-quicksight-service-role-v0`) the same AWS Lake Formation `SELECT` on `member_profile`. Also grant that role access to the customer-managed AWS KMS key (`kms:Decrypt`) and to the Athena query-results bucket. Prefer direct query for sensitive data; if you use SPICE, restrict access to the dataset and dashboards, because SPICE caches the underlying rows.

## Project structure

```
├── bin/cdk.ts                              # CDK app entry point
├── lib/
│   ├── creditunion-infrastructure-stack.ts  # VPC, RDS, S3, KMS, IAM
│   ├── creditunion-data-stack.ts            # AWS Glue Catalog, Crawlers, Connections, Lake Formation
│   ├── creditunion-etl-stack.ts             # AWS Glue Jobs, AWS Step Functions
│   ├── creditunion-trigger-stack.ts         # Automation (Custom Resources)
│   ├── visual-etl-simple.ts                 # AWS Glue Job Definitions
│   ├── rds-data-loader.ts                   # RDS Data Loading Construct
│   └── signed-lambda-artifact.ts            # AWS Signer code-signing construct
├── lambda/                                  # Lambda handlers (code-signed)
│   ├── rds-data-loader/index.py             # RDS loader handler
│   ├── crawler-trigger/index.py             # Crawler trigger handler
│   └── crawler-wait/index.py                # Crawler wait handler
├── scripts/
│   ├── creditunion-visual-mysql-etl.py      # MySQL → Parquet
│   ├── creditunion-xml-collect-to-cleanse-visual.py  # XML → Parquet
│   ├── creditunion_CSV_collect_to_cleanse_visual.py  # CSV → Parquet
│   └── creditunion-member-360-visual-etl.py # Member 360 aggregation
├── layers/pymysql/                          # Vendored PyMySQL Lambda layer
├── sample-data/                             # Synthetic data (auto-uploaded to S3)
├── test/                                     # CDK assertion + construct tests (Jest)
├── LICENSE                                  # MIT-0
├── NOTICE                                   # Copyright + synthetic data disclaimer
└── CONTRIBUTING.md                          # Contribution guidelines
```

## CDK stacks

| Stack | Resources | Deploy time |
|---|---|---|
| `CreditUnionInfrastructureStack` | VPC, Amazon RDS for MySQL, S3 buckets, KMS key, IAM roles | ~8–10 min |
| `CreditUnionDataStack` | AWS Glue Data Catalog, crawlers, JDBC connection, Lambda functions | ~3–5 min |
| `CreditUnionETLStack` | 4 AWS Glue Visual ETL jobs, Step Functions state machine | ~2–3 min |
| `CreditUnionTriggerStack` | Custom resources that auto-trigger the pipeline | ~1–2 min + ~10–15 min pipeline |

Deploy individually if needed:

```bash
cdk deploy CreditUnionInfrastructureStack
cdk deploy CreditUnionDataStack
cdk deploy CreditUnionETLStack
cdk deploy CreditUnionTriggerStack
```

## Member 360 output schema

The `member_profile` table in the consume zone has 51 columns:

| Category | Columns |
|---|---|
| Core member data | golden_member_id, member_number, first_name, last_name, date_of_birth, address, city, state, zip, phone, member_since, checking_balance, savings_balance, total_balance |
| Digital banking | digital_user_id, username, email, last_login, mobile_app_user, online_banking_user, bill_pay_enrolled, account_alerts, digital_engagement_score |
| Entity resolution | ssn_last_4_key, full_name_key, primary_source, match_confidence, resolution_method, created_date |
| Loan system | ssn_last_4, phone_number, total_loans, total_loan_amount, interest_rate, loan_type, term_months, application_date |
| CRM | crm_email, last_contact_date, preferred_channel, marketing_consent |
| Credit cards | card_limit_amount, card_type |
| Analytics | product_count, risk_category, data_quality_score, runid |
| Partitions | year, month, day, hour |

## Sample Athena queries

After deployment, query the data directly with Amazon Athena:

```sql
-- Member segmentation by balance tier
SELECT
    CASE
        WHEN total_balance >= 50000 THEN 'High Value ($50K+)'
        WHEN total_balance >= 10000 THEN 'Medium Value ($10K-$50K)'
        ELSE 'Standard (<$10K)'
    END as segment,
    COUNT(*) as members,
    ROUND(AVG(digital_engagement_score), 1) as avg_engagement
FROM creditunion_consume.member_profile
GROUP BY 1 ORDER BY avg_engagement DESC;

-- Risk assessment
SELECT risk_category, COUNT(*) as members,
    ROUND(AVG(total_loan_amount), 2) as avg_loan
FROM creditunion_consume.member_profile
WHERE risk_category IS NOT NULL
GROUP BY 1 ORDER BY members DESC;
```

## Cost estimate

Single deployment + pipeline run (approximate, single region):

| Service | Estimated cost |
|---|---|
| AWS Glue (4 jobs) | ~$2.00 |
| NAT Gateway (1 hr) | ~$1.50 |
| RDS t3.micro (1 hr) | ~$0.50 |
| S3, Lambda, Step Functions, KMS, CloudWatch | ~$0.55 |
| **Total** | **~$4.55** |

With AWS Free Tier: ~$3.50. Run `cdk destroy --all` after testing to stop charges.

## Clean up

```bash
cdk destroy --all --force
```

## Tests

The project ships CDK assertion and construct tests (Jest). Run them with:

```bash
npm install
npm test
```

The suite validates resource counts, encryption, public-access blocks, KMS rotation, Lambda code-signing, and the AWS Lake Formation column/data-location controls across all four stacks.

## Future improvements

The following enhancements would extend the solution toward production use:

- **Make the analyst role query-ready.** Attach the Amazon Athena, AWS Glue Data Catalog, and AWS Lake Formation query permissions (plus Athena results-bucket access) to the deployed `creditunion-data-analyst` role, so analysts can assume it and query without manual setup. See [After deployment: query the data lake](#after-deployment-query-the-data-lake).
- **Adopt full AWS Lake Formation governance.** Register the data-lake locations without the hybrid `IAM_ALLOWED_PRINCIPALS` fallback so all access is grant-based and auditable by default.
- **AWS IAM Identity Center integration.** Map human analysts to the AWS Lake Formation analyst persona through AWS IAM Identity Center so access uses short-lived credentials and aligns with periodic access reviews.
- **Amazon DynamoDB-backed data lineage and ETL metadata.** Add an Amazon DynamoDB table that records pipeline run metadata as each AWS Glue job executes — job run IDs, source-to-target mappings, input/output row counts, AWS Glue Data Quality results, and timestamps. This creates an auditable, queryable lineage trail (for example, "which run produced this `member_profile` partition, from which sources, and did it pass data-quality checks?") that supports regulatory traceability and troubleshooting. This pattern — using Amazon DynamoDB as the store for data lineage and ETL audit metadata — is described in the Rize blog on data lineage. *(Add the exact blog URL here.)*
- **Enforced data-quality gates.** Promote the existing AWS Glue Data Quality evaluation from best-effort to enforced gates that block promotion to the consume zone on failure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE).
