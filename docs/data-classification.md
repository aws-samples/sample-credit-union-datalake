<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Data Classification and Handling Procedures

## Overview

This document defines the data classification levels and handling procedures for the Credit Union Data Lake platform.

## Classification Levels

| Level | Description | Examples in this project |
|---|---|---|
| **Restricted** | Highly sensitive PII requiring strict access controls | SSN, SSN last 4 digits, date of birth |
| **Confidential** | Sensitive financial and personal data | Account balances, loan amounts, credit card limits, member addresses, phone numbers |
| **Internal** | Operational data not intended for public access | Member numbers, digital engagement scores, ETL run IDs |
| **Public** | Non-sensitive reference data | Data quality scores, risk categories, resolution methods |

## Data Flow by Classification

### Collect Zone (Amazon S3)
- **Contains**: Raw data from all 5 source systems (Amazon RDS for MySQL, CSV, XML)
- **Classification**: Restricted + Confidential
- **Controls**: AWS KMS encryption at rest, TLS in transit, Amazon S3 bucket policy restricting access to approved AWS IAM roles

### Cleanse Zone (Amazon S3)
- **Contains**: Transformed Parquet data with partition columns
- **Classification**: Restricted + Confidential
- **Controls**: AWS KMS encryption at rest, TLS in transit, per-job AWS Glue IAM roles with scoped Amazon S3 access

### Consume Zone (Amazon S3)
- **Contains**: Unified member profiles (51 columns)
- **Classification**: Restricted (SSN columns) + Confidential (financial data)
- **Controls**: AWS KMS encryption at rest, TLS in transit, Amazon S3 bucket policy. Post-deployment: AWS Lake Formation column-level access controls recommended.

### Amazon RDS for MySQL
- **Contains**: Core banking member records (~2,000 rows)
- **Classification**: Restricted
- **Controls**: AWS KMS storage encryption, isolated subnet (no internet), SSL/TLS connections enforced, credentials in AWS Secrets Manager

## Handling Procedures

### Restricted Data (SSN, DOB)

| Procedure | Implementation |
|---|---|
| Encryption at rest | AWS KMS customer-managed key on all Amazon S3 buckets and Amazon RDS |
| Encryption in transit | TLS enforced on Amazon S3 (enforceSSL), SSL on Amazon RDS JDBC and pymysql connections |
| Access control | Per-job AWS IAM roles; Amazon S3 bucket policies deny unauthorized principals |
| Masking | Post-deployment: configure AWS Lake Formation to exclude SSN columns from analyst queries |
| Audit | AWS CloudTrail logs all Amazon S3 and Amazon RDS API calls; Amazon S3 server access logging enabled |
| Retention | Amazon S3 lifecycle rules expire non-current versions after 30 days |

### Confidential Data (Financial, Contact)

| Procedure | Implementation |
|---|---|
| Encryption at rest | AWS KMS customer-managed key |
| Encryption in transit | TLS enforced |
| Access control | Amazon S3 bucket policies + AWS IAM role scoping |
| Audit | AWS CloudTrail + Amazon S3 access logs |

### Internal Data (Operational)

| Procedure | Implementation |
|---|---|
| Encryption at rest | AWS KMS customer-managed key (inherited from bucket-level encryption) |
| Access control | Standard AWS IAM role access |

## Customer Responsibilities

Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/), AWS is responsible for security *of* the cloud infrastructure, while customers are responsible for security *in* the cloud, including data classification and protection. Customers should:

- Define data retention policies appropriate for regulatory requirements (GLBA, state privacy laws)
- Configure AWS Lake Formation column-level permissions for Restricted data before granting analyst access
- Review data classification assignments when adding new data sources
- Implement data masking or tokenization for SSN fields in the consume zone
