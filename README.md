# Credit Union Data Lake (CUDL)

A complete, deployable Member 360 data lake for credit unions built with the [AWS CDK](https://aws.amazon.com/cdk/). Ingests data from five heterogeneous source systems, performs entity resolution, and produces a unified member profile with 51 attributes — all with a single `cdk deploy --all` command.

> **Sample data disclaimer:** All names, addresses, Social Security Numbers, phone numbers, and email addresses in `sample-data/` are entirely fictitious, generated using the Python Faker library. Any resemblance to real persons is purely coincidental.

## What it deploys

- **Amazon RDS MySQL** with ~2,000 sample core banking member records (auto-loaded)
- **Amazon S3 Data Lake** — collect, cleanse, and consume buckets with KMS encryption
- **4 AWS Glue Visual ETL Jobs** — MySQL→Parquet, XML→Parquet, CSV→Parquet, Member 360 aggregation
- **AWS Step Functions** pipeline with parallel/sequential orchestration
- **AWS Glue Data Catalog** — 3 databases, pre-defined table schemas, XML crawlers
- **Full automation** — Lambda functions + CloudFormation custom resources trigger the entire pipeline on deploy

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │            Data Sources                  │
                    │  RDS MySQL · CSV Files · XML Files       │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Collect Zone (S3 — KMS Encrypted)       │
                    └──────────────────┬──────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
    ┌─────────▼─────────┐  ┌──────────▼──────────┐  ┌─────────▼─────────┐
    │  MySQL ETL (Glue)  │  │  XML ETL (Glue)     │  │  CSV ETL (Glue)   │
    │  RDS → Parquet     │  │  XML → Parquet      │  │  CSV → Parquet    │
    └─────────┬─────────┘  └──────────┬──────────┘  └─────────┬─────────┘
              └────────────────────────┼────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Cleanse Zone (S3 — Snappy Parquet)      │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │  Member 360 ETL (Glue)                   │
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

- KMS encryption (customer-managed key with auto-rotation) on all S3 buckets and RDS
- RDS in isolated subnets with no internet access
- VPC endpoints for S3 and Secrets Manager (no public internet traffic)
- S3 public access blocked, SSL enforced, versioning enabled
- Least-privilege IAM roles per service (Glue, Lambda, Step Functions)
- RDS credentials auto-generated in Secrets Manager, retrieved via VPC endpoint

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

Deployment takes ~25–35 minutes. The pipeline runs automatically — no manual steps after deploy.

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
│   ├── creditunion-data-stack.ts            # Glue Catalog, Crawlers, Connections
│   ├── creditunion-etl-stack.ts             # Glue Jobs, Step Functions
│   ├── creditunion-trigger-stack.ts         # Automation (Custom Resources)
│   ├── visual-etl-simple.ts                 # Glue Job Definitions
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
| `CreditUnionInfrastructureStack` | VPC, RDS MySQL, S3 buckets, KMS key, IAM roles | ~8–10 min |
| `CreditUnionDataStack` | Glue Data Catalog, crawlers, JDBC connection, Lambda functions | ~3–5 min |
| `CreditUnionETLStack` | 4 Glue Visual ETL jobs, Step Functions state machine | ~2–3 min |
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
