<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Key Management Strategy

## Overview

This document describes the encryption key management strategy for the Credit Union Data Lake platform deployed on AWS.

## AWS KMS Key Configuration

| Property | Value |
|---|---|
| Key type | Customer-managed symmetric key |
| Alias | `creditunion-analytics-key` |
| Auto-rotation | Enabled (annual rotation) |
| Deletion protection | Pending deletion window (default 30 days) |
| Region | Single-region (deployment region) |

## Key Usage

The customer-managed AWS KMS key encrypts the following resources:

- **Amazon S3 buckets**: collect, cleanse, consume, and AWS CloudTrail audit log buckets
- **Amazon RDS for MySQL**: storage encryption at rest
- **AWS Glue assets bucket**: ETL script storage (uses AWS-managed KMS key)

## Access Controls

AWS KMS key access is restricted using `kms:ViaService` conditions:

```
Condition:
  StringEquals:
    kms:ViaService:
      - s3.{region}.amazonaws.com
      - glue.{region}.amazonaws.com
```

Only the following AWS IAM roles can use the key:
- `creditunion-{region}-glue-mysql` — Amazon RDS to Amazon S3 ETL
- `creditunion-{region}-glue-xml` — XML to Parquet ETL
- `creditunion-{region}-glue-csv` — CSV to Parquet ETL
- `creditunion-{region}-glue-member360` — Member 360 aggregation ETL
- Amazon RDS service role (for storage encryption)

## Key Lifecycle

| Phase | Procedure |
|---|---|
| Creation | Automated via AWS CDK deployment |
| Rotation | Automatic annual rotation enabled via `enableKeyRotation: true` |
| Access review | Customer responsibility — review AWS IAM policies granting `kms:Decrypt` and `kms:GenerateDataKey` quarterly |
| Revocation | Remove AWS IAM policy statements granting key access, then schedule key deletion |
| Deletion | Use `aws kms schedule-key-deletion --key-id <key-id> --pending-window-in-days 30` |

## Disaster Recovery

- AWS KMS keys are regional. For cross-region DR, create a replica key in the target region and re-encrypt data.
- AWS CloudTrail logs all AWS KMS API calls (`Encrypt`, `Decrypt`, `GenerateDataKey`, `ScheduleKeyDeletion`) for audit purposes.

## Customer Responsibilities

Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/):

- **AWS** manages the underlying key infrastructure, hardware security modules (HSMs), and key material security.
- **Customers** are responsible for the following actions, listed in priority order:

**Priority 1 — Review key access grants:**
```bash
aws kms list-grants --key-id <key-id>
aws kms list-key-policies --key-id <key-id>
```

**Priority 2 — Monitor AWS CloudTrail for unauthorized key usage:**
```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt --max-results 20
```

**Priority 3 — Manage key deletion and rotation schedules.** Verify rotation is active:
```bash
aws kms get-key-rotation-status --key-id <key-id>
```

**Priority 4 — Configure cross-region replication** if required for disaster recovery.
