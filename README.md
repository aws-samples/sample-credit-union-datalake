<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

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
                         │                           │
                    Amazon Athena            Amazon QuickSight
```

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

> **Previously customer responsibilities, now deployed:** AWS Lake Formation column-level access (formerly P0, now **M1**), AWS Secrets Manager 30-day rotation (formerly P5, now **M2**), Amazon CloudWatch alarms (formerly P3, now **M6**), and AWS Config security-group/network rules (formerly P1, now **M7**) are deployed by this project. See "Implemented security controls" above. The two items below remain customer responsibilities because they cannot be configured through AWS CDK.

### Customer responsibilities (post-deployment)

Customers should complete the following security actions before using this solution with production data. These two controls cannot be configured by AWS CDK and remain the customer's ongoing responsibility:

1. **[P2] Configure MFA Delete** on sensitive Amazon S3 buckets (collect, cleanse, consume). This requires root account credentials and cannot be automated via AWS CDK. The deployment already denies object-version deletion and versioning changes on these buckets (M3); MFA Delete is the residual exception documented under model assumption A007.

   ```bash
   aws s3api put-bucket-versioning \
     --bucket creditunion-ACCOUNT-REGION-collect \
     --versioning-configuration Status=Enabled,MFADelete=Enabled \
     --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP_CODE"
   ```

2. **[P4] Review and customize AWS IAM role permissions** for your specific access requirements. The deployed roles use least-privilege scoping but may need adjustment for your organization's policies.

   ```bash
   aws iam list-attached-role-policies --role-name creditunion-REGION-glue-mysql
   aws iam get-role-policy --role-name creditunion-REGION-glue-mysql --policy-name S3Access
   ```

> **Important:** The sample data in `sample-data/` is entirely synthetic, generated using the Python Faker library. Do not use real customer data without first completing all post-deployment security actions listed above.

## Quick start

Replace `YOUR_ORG` in the clone commands below with your Git hosting organization or user.

### Option 1: AWS CloudShell (easiest)

```bash
git clone https://github.com/YOUR_ORG/credit-union-data-lake.git
cd credit-union-data-lake
npm install
npm run build
cdk deploy --all --require-approval never
```

### Option 2: Local development

**Prerequisites:** AWS CLI configured, Node.js v18+, AWS CDK v2 (`npm install -g aws-cdk`)

```bash
git clone https://github.com/YOUR_ORG/credit-union-data-lake.git
cd credit-union-data-lake
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

## Project structure

```
├── bin/cdk.ts                              # CDK app entry point
├── lib/
│   ├── creditunion-infrastructure-stack.ts  # VPC, RDS, S3, KMS, IAM
│   ├── creditunion-data-stack.ts            # AWS Glue Catalog, Crawlers, Connections
│   ├── creditunion-etl-stack.ts             # AWS Glue Jobs, AWS Step Functions
│   ├── creditunion-trigger-stack.ts         # Automation (Custom Resources)
│   ├── visual-etl-simple.ts                 # AWS Glue Job Definitions
│   └── rds-data-loader.ts                   # RDS Data Loading Construct
├── scripts/
│   ├── creditunion-visual-mysql-etl.py      # MySQL → Parquet
│   ├── creditunion-xml-collect-to-cleanse-visual.py  # XML → Parquet
│   ├── creditunion_CSV_collect_to_cleanse_visual.py  # CSV → Parquet
│   └── creditunion-member-360-visual-etl.py # Member 360 aggregation
├── sample-data/                             # Synthetic data (auto-uploaded to S3)
├── test/cdk.test.ts                         # CDK synthesis tests
├── LICENSE                                  # Apache 2.0
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

Single deployment + pipeline run (us-west-2):

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
