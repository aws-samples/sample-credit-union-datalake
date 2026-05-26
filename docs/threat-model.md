<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Threat Model — Credit Union Data Lake

## Overview

This document provides a STRIDE-based threat analysis for the Credit Union Data Lake platform. It identifies threat actors, attack surfaces, threat scenarios, and mitigations mapped to each identified threat.

## Threat Actors

| Actor | Type | Capability | Motivation |
|---|---|---|---|
| Malicious insider | Internal | Medium–High | Data theft, financial gain |
| External attacker | External | Medium | Credential compromise, data exfiltration |
| Compromised IAM credentials | External | Medium | Lateral movement, privilege escalation |
| Misconfiguration | Operational | N/A | Accidental service disruption |

## Attack Surfaces

| Surface | Components | Exposure |
|---|---|---|
| Amazon Relational Database Service (Amazon RDS) endpoints | MySQL on port 3306 | Isolated subnet, no internet access |
| Amazon S3 buckets | collect, cleanse, consume | Bucket policies restrict to approved AWS IAM roles |
| AWS Lambda functions | RDS data loader, crawler trigger | VPC-deployed, code signing enforced |
| AWS Glue ETL jobs | 4 Visual ETL jobs | Per-job AWS IAM roles, concurrency limited |
| API endpoints | AWS Secrets Manager, Amazon S3 | VPC endpoints only, no public traffic |

## STRIDE Threat Analysis

### Spoofing

| Threat | Scenario | Mitigation |
|---|---|---|
| S-1 | Spoofed data files uploaded to collect bucket | Amazon S3 bucket policy denies writes from unauthorized AWS IAM roles |
| S-2 | AWS Glue catalog table location redirected to attacker-controlled path | AWS IAM restricts catalog writes to CDK deployment roles |

### Tampering

| Threat | Scenario | Mitigation |
|---|---|---|
| T-1 | ETL scripts modified in glue-assets bucket | Bucket versioning enabled, write-restriction policy, AWS CloudTrail auditing |
| T-2 | Amazon S3 data lake objects modified | Versioning on all buckets, deny bucket policies, Amazon S3 access logging |

### Repudiation

| Threat | Scenario | Mitigation |
|---|---|---|
| R-1 | ETL job logs deleted to cover unauthorized access | AWS CloudTrail with file validation, immutable audit log bucket (Object Lock) |
| R-2 | Amazon VPC network changes made without audit trail | Amazon VPC Flow Logs to Amazon CloudWatch (3-month retention) |

### Information Disclosure

| Threat | Scenario | Mitigation |
|---|---|---|
| I-1 | Member profiles (51 columns, SSNs) exfiltrated from consume bucket | Amazon S3 bucket policy, AWS Key Management Service (AWS KMS) encryption, per-job AWS IAM roles. Post-deploy: AWS Lake Formation column-level controls |
| I-2 | PII leaked through AWS Lambda error logs | Error messages sanitized — log error type only, not raw exception content |
| I-3 | Database credentials exposed in code | Both username and password resolved dynamically via AWS Secrets Manager |

### Denial of Service

| Threat | Scenario | Mitigation |
|---|---|---|
| D-1 | Excessive AWS Glue job runs exhaust Data Processing Unit (DPU) capacity | MaxConcurrentRuns=1 on all 4 jobs |
| D-2 | Amazon VPC security group misconfiguration blocks pipeline | Amazon VPC Flow Logs for detection. Post-deploy: AWS Config rules for monitoring |

### Elevation of Privilege

| Threat | Scenario | Mitigation |
|---|---|---|
| E-1 | AWS Glue ETL script injection via shared role | 4 separate per-job AWS IAM roles with scoped Amazon S3 and AWS Key Management Service (AWS KMS) access |
| E-2 | AWS Lambda function code tampered | AWS Signer code signing on all Lambda functions |
| E-3 | Trigger stack Lambda invokes arbitrary functions | Lambda invoke policy scoped to specific function ARN |

## Existing Security Controls

The following controls are implemented in the deployed infrastructure. For detailed configuration, see [docs/security-guidelines.md](security-guidelines.md).

- AWS KMS customer-managed key with auto-rotation
- Per-job AWS IAM roles with `kms:ViaService` conditions
- Amazon S3 deny bucket policies restricting to approved roles
- AWS CloudTrail with log file validation and immutable storage
- Amazon VPC Flow Logs, VPC endpoints for Amazon S3 and AWS Secrets Manager
- AWS Lambda code signing via AWS Signer
- Amazon RDS in isolated subnet with SSL/TLS enforced
- Amazon S3 server access logging on all data lake buckets

## Residual Risks

The following risks require post-deployment customer action, listed in priority order:

| Priority | Risk | Action | Command |
|---|---|---|---|
| P0 | Unmasked SSN columns in consume zone | Configure AWS Lake Formation | `aws lakeformation grant-permissions --principal '{"DataLakePrincipalIdentifier":"<role-arn>"}' --resource '{"Table":{"DatabaseName":"creditunion_consume","Name":"member_profile","ColumnWildcard":{"ExcludedColumnNames":["ssn","ssn_last_4","ssn_last_4_key"]}}}' --permissions SELECT` |
| P1 | Security group changes not actively monitored | Deploy AWS Config rules | `aws configservice put-config-rule --config-rule '{"ConfigRuleName":"sg-open-only-authorized-ports","Source":{"Owner":"AWS","SourceIdentifier":"VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS"}}'` |
| P2 | MFA Delete not enabled on sensitive buckets | Enable via root credentials | `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "<mfa-arn> <totp>"` |
| P3 | AWS Secrets Manager rotation not configured | Enable automatic rotation | `aws secretsmanager rotate-secret --secret-id <SECRET_ARN> --rotation-rules '{"AutomaticallyAfterDays":30}'` |
