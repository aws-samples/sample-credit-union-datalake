<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Credit Union Data Lake (CUDL)

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
                    Amazon Athena            Amazon Quick Suite
```

## Security

This project deploys security controls as a starting point. Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/):

- **AWS is responsible for security *of* the cloud**: protecting the infrastructure that runs AWS services (hardware, software, networking, facilities).
- **Customers are responsible for security *in* the cloud**: configuring and managing the services deployed by this project, including access management, data protection, and ongoing monitoring.

Customers are responsible for configuring and maintaining these controls for their specific requirements.

### Implemented security controls

The following controls are deployed by this project. Customers should review and customize these for their environment:

- Customer-managed AWS KMS key with auto-rotation for Amazon S3 bucket and Amazon RDS encryption at rest
- Amazon RDS deployed in isolated subnets with no internet access
- Amazon VPC endpoints for Amazon S3 and AWS Secrets Manager (no public internet traffic)
- Amazon S3 public access blocked, TLS enforced, versioning enabled, server access logging enabled
- Per-job AWS IAM roles with least-privilege policies for AWS Glue, AWS Lambda, and AWS Step Functions
- Amazon RDS credentials auto-generated in AWS Secrets Manager, retrieved via Amazon VPC endpoint
- AWS CloudTrail with log file validation and immutable audit log bucket
- Amazon VPC Flow Logs for network traffic monitoring
- AWS Lambda code signing via AWS Signer for function integrity
- AWS Glue job concurrency limits to prevent resource exhaustion

### Customer responsibilities (post-deployment)

We recommend that customers complete the following security actions before using this solution with production data. These controls are not automatically configured by the deployment and are the customer's ongoing responsibility:

1. **[P0] Configure [AWS Lake Formation](https://aws.amazon.com/lake-formation/)** column-level access controls to restrict access to sensitive fields (SSN, account balances) in the `member_profile` table. Without this, all authenticated users can query unmasked PII.
2. **[P1] Deploy [AWS Config](https://aws.amazon.com/config/) rules** for security group change detection (`ec2-security-group-attached-to-eni-periodic`, `vpc-sg-open-only-to-authorized-ports`). Without this, security group changes are logged but not actively monitored.
3. **[P2] Configure MFA Delete** on sensitive Amazon S3 buckets (collect, cleanse, consume). This requires root account credentials and cannot be automated via AWS CDK.
4. **[P4] Review and customize AWS IAM role permissions** for your specific access requirements. The deployed roles use least-privilege scoping but may need adjustment for your organization's policies.
5. **[P3] Configure Amazon CloudWatch alarms** for security-relevant metrics (failed AWS Step Functions executions, AWS KMS key deletion attempts, unauthorized API calls).
6. **[P5] Configure AWS Secrets Manager automatic rotation** for the Amazon RDS database credentials.

> **Important:** The sample data in `sample-data/` is entirely synthetic, generated using the Python Faker library. Do not use real customer data without first completing all post-deployment security actions listed above.

## Quick start

### Option 1: AWS CloudShell (easiest)

```bash
git clone https://github.com/<your-org>/credit-union-data-lake.git
cd credit-union-data-lake
npm install
npm run build
cdk deploy --all --require-approval never
```

### Option 2: Local development

**Prerequisites:** AWS CLI configured, Node.js v18+, AWS CDK v2 (`npm install -g aws-cdk`)

```bash
git clone https://github.com/<your-org>/credit-union-data-lake.git
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
