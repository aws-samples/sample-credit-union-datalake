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
| AWS Lambda functions | RDS data loader, crawler trigger | VPC-deployed; code signing enforced on the three target Lambdas where ENFORCE is configured |
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
| I-1 | Member profiles (51 columns, SSNs) exfiltrated from consume bucket | Amazon S3 bucket policy, AWS Key Management Service (AWS KMS) encryption, per-job AWS IAM roles, and AWS Lake Formation column-level controls excluding SSN columns (deployed — M1) |
| I-2 | PII leaked through AWS Lambda error logs | Error messages sanitized — log error type only, not raw exception content |
| I-3 | Database credentials exposed in code | Both username and password resolved dynamically via AWS Secrets Manager |

### Denial of Service

| Threat | Scenario | Mitigation |
|---|---|---|
| D-1 | Excessive AWS Glue job runs exhaust Data Processing Unit (DPU) capacity | MaxConcurrentRuns=1 on all 4 jobs |
| D-2 | Amazon VPC security group misconfiguration blocks pipeline | Amazon VPC Flow Logs for detection, and AWS Config rules for security-group/network monitoring (deployed — M7; recorder optional) |

### Elevation of Privilege

| Threat | Scenario | Mitigation |
|---|---|---|
| E-1 | AWS Glue ETL script injection via shared role | 4 separate per-job AWS IAM roles with scoped Amazon S3 and AWS Key Management Service (AWS KMS) access |
| E-2 | AWS Lambda function code tampered | AWS Signer code signing enforced on the three target Lambdas (RDS loader, crawler-trigger, crawler-wait) where ENFORCE is configured |
| E-3 | Trigger stack Lambda invokes arbitrary functions | Lambda invoke policy scoped to specific function ARN |

## Existing Security Controls

The following controls are implemented in the deployed infrastructure. For detailed configuration, see [docs/security-guidelines.md](security-guidelines.md).

- AWS KMS customer-managed key with auto-rotation
- Per-job AWS IAM roles with `kms:ViaService` conditions
- Amazon S3 deny bucket policies restricting to approved roles
- AWS CloudTrail with log file validation and immutable storage
- Amazon VPC Flow Logs, VPC endpoints for Amazon S3 and AWS Secrets Manager
- AWS Lambda code signing via AWS Signer, enforced (ENFORCE) on the three target Lambdas (RDS loader, crawler-trigger, crawler-wait)
- Amazon RDS in isolated subnet with SSL/TLS enforced, deletion protection enabled
- Amazon S3 server access logging on all data lake buckets
- AWS Glue security configuration enforcing SSE-KMS on CloudWatch logs, Amazon S3 job data, and job bookmarks with the customer-managed key

## Deployed Controls

The following mitigations are implemented in deployed CDK infrastructure (verified by `cdk synth` emitting each mitigation's required resource). Each control is listed with its mitigation identifier, the threat(s) it addresses, and its severity.

| Mitigation | Deployed control | Threat(s) | Severity | Stack |
|---|---|---|---|---|
| M1 | AWS Lake Formation column-level access excluding SSN columns from the consume zone | T1 | Critical | Data stack |
| M2 | AWS Secrets Manager 30-day automatic rotation of the database credential | T2 | High | Infrastructure stack |
| M3 | Amazon S3 version-deletion deny + versioning-change deny on the three data-lake buckets | T3 (A007) | High | Infrastructure stack |
| M4 | AWS KMS deletion guard (key-policy denies on `kms:ScheduleKeyDeletion`/`kms:DisableKey`) + EventBridge monitoring | T6 | Critical | Infrastructure stack |
| M5 | AWS Lambda code signing in ENFORCE mode on the three target Lambdas (RDS loader, crawler-trigger, crawler-wait) | T8 | High | Data / Trigger stacks |
| M6 | Amazon CloudWatch alarms + metric filters (detective controls supporting M2/M4) | T2, T6 (supporting) | High | Infrastructure stack |
| M7 | AWS Config rules for network/security-group monitoring (always emitted; recorder optional) | T7-class (network) | Medium | Infrastructure stack |

> **M1 note:** Lake Formation column-level access is enforced on the consume `member_profile` table (SSN-bearing columns `ssn_last_4`, `ssn_last_4_key` excluded for the data-analyst role) and the cleanse `core_banking_members` (`ssn`) and `loan_system_members` (`ssn_last_4`) tables. The consume and cleanse S3 locations are registered with Lake Formation via a dedicated, explicitly-scoped registration role (`creditunion-<region>-lf-registration`, assumed by `lakeformation.amazonaws.com`) rather than the Lake Formation service-linked role, so `cdk destroy` deregisters the locations cleanly (see [docs/security-exceptions.md](security-exceptions.md), Exception 8). Because registering a location makes Lake Formation broker all access to it, the four per-job Glue ETL roles each hold an explicit `DATA_LOCATION_ACCESS` grant on the location they write to (mysql/xml/csv → cleanse, member360 → consume); this is the only LF permission the default `IAMAllowedPrincipals` fallback does not cover. It does **not** widen analyst access — the data-analyst role has no IAM data access and is still constrained to its column-excluded SELECT grant — and the ETL roles already held equivalent IAM write access to those buckets.

> **M3 note:** Amazon S3 deletion/tampering protection is deployed in code (version-deletion deny + versioning-change deny). MFA Delete remains the single documented residual exception under model assumption **A007** because it cannot be configured via AWS CDK/CloudFormation (see [docs/security-exceptions.md](security-exceptions.md), Exception 4).

> **M7 note:** The AWS Config rules are always deployed. The AWS Config configuration recorder is optional and gated behind the `provisionConfigRecorder` CDK context flag (default `false`); when not provisioned, it is the documented optional exception (see [docs/security-exceptions.md](security-exceptions.md), Exception 6).

## Traceability (R10)

### M1–M7 traceability table

This structured mapping provides one row per mitigation, with explicit columns for the working mitigation identifier, the reconciled working threat identifier, the severity, the remediation type, and the status.

| Mitigation | Working threat id | Severity | Remediation type | Status |
|---|---|---|---|---|
| M1 — Lake Formation column-level SSN exclusion | T1 | Critical | Deployed CDK (Data_Stack) | Resolved |
| M2 — Secrets Manager 30-day rotation | T2 | High | Deployed CDK (Infrastructure_Stack) | Resolved |
| M3 — S3 deletion protection (+ MFA Delete A007) | T3 | High | Deployed CDK; MFA Delete residual (A007) | Resolved (MFA Delete = Customer Responsibility) |
| M4 — KMS deletion guard + monitoring | T6 | Critical | Deployed CDK (Infrastructure_Stack) | Resolved |
| M5 — Lambda code signing ENFORCE | T8 | High | Deployed CDK (3 functions + layer) | Resolved |
| M6 — Detective CloudWatch alarms | T2, T6 (supporting) | High | Deployed CDK (Infrastructure_Stack) | Resolved |
| M7 — AWS Config network rules | T7-class (network) | Medium | Deployed CDK (rules); recorder optional/undeployed | Resolved (recorder = Customer Responsibility when not provisioned) |

Every Critical/High mitigation above is deployed CDK infrastructure; no Critical/High threat is left without a deployed remediation, so there are no open residual-risk rows beyond the documented MFA-Delete (A007) and the optional AWS Config recorder.

### Reconciliation crosswalk to the Guardian v3 export

Maps each working identifier used in this spec to the Guardian's exported v3 Threat Model JSON (`.threatmodel/cu-datalake-threat-model-v3.json`), recording the export numeric id and UUID. The T4 collision is explicit: in the working numbering `T4` denotes the already-resolved supply-chain threat, whereas the v3 export's `numericId 4` denotes the Lake Formation / PII threat (which the working numbering calls `T1`).

| Working id | Meaning | v3 export numericId | v3 export UUID | v3 status |
|---|---|---|---|---|
| M5 / T8 — code signing | crawler-trigger + wait Lambda signing | mitigation 1 / threat 1 | mit `5fcdda71-6008-4221-b58d-0f1fa5add93e` / thr `c0b5af02-8723-4211-a5ff-9ec94fe8d249` | Resolved |
| M1 / T1 — Lake Formation PII | column-level controls on member_profile | mitigation 5 / **threat 4** | mit `31433cc9-4fbf-4876-b92f-ef5ef4b12445` / thr `c7eaf55b-8b2e-4972-886a-341fbdfe5634` | threatIdentified (now remediated by this spec) |
| M7 / network | Config SG/VPC rules | mitigation 4 / threat 7 | mit `9e637e6d-432a-4a37-b0ce-5614f4e446a0` / thr `fcf0b6a3-e9b0-4321-8d24-3772cc00d156` | mitigationInProgress (now deployed) |
| **T4 (working) — supply chain** | already-resolved supply-chain threat (≠ export threat 4) | n/a (no 1:1 export row; do **not** confuse with export `numericId 4`) | — | Resolved (working mapping) |
| M2 — secrets rotation | RDS credential rotation | no direct v3 export row | — | Resolved (this spec) |
| M4 — KMS deletion guard | key deletion/disable guard + monitor | no direct v3 export row | — | Resolved (this spec) |
| M6 — detective alarms | CloudWatch alarms | no direct v3 export row | — | Resolved (this spec) |

Already-resolved working mitigations M8–M13 and the working supply-chain threat T4 are marked Resolved with an evidence reference (the corresponding mitigationResolved/threatResolved entries in the v3 export — e.g., export mitigations numericId 2, 3, 6, 7, 8 and threats numericId 1, 2, 3, 5, 6, 8). Fields are never left blank; where no 1:1 export row exists the cell is explicitly marked "no direct v3 export row".

## Residual Risks

After the controls above were deployed, the following residual items remain. They require customer action only because AWS CDK/CloudFormation cannot configure them, and are listed in priority order:

| Priority | Risk | Action | Command |
|---|---|---|---|
| P0 | MFA Delete not enabled on sensitive buckets (A007) — version-deletion and versioning-change deny policies are deployed (M3), but MFA Delete itself requires root credentials | Enable via root credentials | `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "<mfa-arn> <totp>"` |
| P1 | AWS Config configuration recorder not provisioned (optional) — the AWS Config rules (M7) are deployed, but the recorder is gated behind the `provisionConfigRecorder` flag (default `false`) | Deploy the recorder by setting the flag, or enable a recorder out of band | `cdk deploy -c provisionConfigRecorder=true` |
