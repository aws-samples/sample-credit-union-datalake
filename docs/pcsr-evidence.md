<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PCSR Evidence Pack — Credit Union Data Lake (CUDL)

This document consolidates security review evidence for the Public Content Security Review (PCSR) of the Credit Union Data Lake repository. It is intended to give the assigned AWS Content Guardian everything needed to verify that high/critical findings are mitigated.

## Content summary

| Field | Value |
|---|---|
| **Repository** | `gitlab.aws.dev/hofsbeno/cu-datalake` |
| **Content type** | Open-source sample code (CDK data lake reference implementation) |
| **Purpose** | Educational demonstration of a credit union Member 360 data lake |
| **License** | Apache 2.0 |
| **Sample data** | 100% synthetic, generated with Python Faker; no real PII |
| **Generative AI** | None (no GenAI inputs or outputs in scope) |
| **Third-party vendors** | None |
| **Target channel** | Public GitHub sample content |

## Architecture (at a glance)

Four CDK stacks deployed to a single AWS account:

1. **InfrastructureStack** — Amazon VPC, Amazon RDS for MySQL, Amazon S3 (collect/cleanse/consume buckets), AWS KMS, AWS IAM roles
2. **DataStack** — AWS Glue Data Catalog, Glue connection, XML crawlers, AWS Lambda loaders
3. **ETLStack** — 4 AWS Glue Visual ETL jobs, AWS Step Functions orchestration
4. **TriggerStack** — Automation via AWS CloudFormation custom resources

See `README.md` for the full architecture diagram and component descriptions.

## Threat model

A full STRIDE threat model was performed using the AI-assisted Threat Modeling MCP Server. Artifacts are stored locally in `security/threat-model/` (not committed to git per AWS guidance on security artifacts):

- `cu-datalake-threat-model.md` / `.json` — initial model
- `cu-datalake-threat-model-v2.md` / `.json` — revised after initial mitigations
- `cu-datalake-threat-model-v3.md` / `.json` — final model with all mitigations verified

### Summary of identified threats and mitigations

| Category | Threat | Mitigation |
|---|---|---|
| **Spoofing** | IAM role assumption by unauthorized principals | Role trust policies scope `Principal` to specific AWS services; AWS CloudTrail audits all `sts:AssumeRole` calls |
| **Tampering** | ETL script modification in `glue-assets` bucket | Bucket has versioning enabled + write-restriction policy limiting writes to CDK deployment roles |
| **Tampering** | Lambda code integrity | AWS Lambda code signing via AWS Signer for all customer-owned Lambda functions |
| **Repudiation** | Lack of audit trail | AWS CloudTrail enabled with file validation; Amazon S3 server access logging on all buckets; Amazon VPC Flow Logs |
| **Information disclosure** | Unencrypted data at rest | All Amazon S3 buckets use AWS KMS customer-managed key; Amazon RDS storage encrypted with same key |
| **Information disclosure** | Data in transit | TLS/SSL enforced on Amazon S3 buckets (`enforceSSL: true`); MySQL connection uses `useSSL=true&requireSSL=true` |
| **Information disclosure** | PII leakage in Lambda error logs | Error messages log type only, never raw exception content |
| **Denial of service** | Resource exhaustion from parallel AWS Glue runs | Concurrency limits set on all Glue jobs via `executionProperty.maxConcurrentRuns` |
| **Elevation of privilege** | Wildcard AWS IAM permissions | Per-job IAM roles with scoped inline policies; wildcards eliminated where possible, documented as exceptions with compensating controls where AWS services require them |
| **Elevation of privilege** | Hardcoded credentials | All credentials resolved dynamically via AWS Secrets Manager references |

## Scanner evidence

### Required: Holmes Content Security Review

Ten iterative scan rounds completed. Scan reports are local at `security/scans/scan-report (0-9).json`.

**Latest round (report 9):**

| Severity | Count | Status |
|---|---|---|
| High | 3 | Documented exceptions (see `docs/security-exceptions.md`) |
| Medium | 15 | 13 fixed, 2 documented |
| Low | 6 | 4 fixed, 2 scanner-confirmed false positives |
| **Remaining after latest fixes** | ~4 | All documented in exception register |

### Recommended: cdk-nag (AWS Solutions rule pack)

Integrated at build time via `AwsSolutionsChecks` aspect in `bin/cdk.ts`.

**Result:** `cdk synth --all` exits 0 with zero findings after code-level improvements (AWS Glue security configuration, Amazon RDS deletion protection, AWS X-Ray tracing on Step Functions) and documented suppressions for AWS service-required permissions.

### Recommended: CDK assertion tests

`test/cdk.test.ts` validates 11 invariants across all 4 stacks (resource counts, encryption settings, public access blocks, KMS rotation).

**Result:** 11/11 passing on every build.

## High-severity findings remediation

Per Appendix B of the PCSR guide:

### Finding H-1: EC2 Describe wildcard in Glue VPC policy

| Field | Value |
|---|---|
| **Description** | AWS Glue per-job IAM roles require `ec2:DescribeNetworkInterfaces / DescribeVpcs / DescribeSubnets / DescribeSecurityGroups` with `resources: '*'` |
| **Severity** | High (scanner) |
| **Risk** | In theory, broad read visibility on EC2 metadata. In practice, EC2 Describe APIs cannot be scoped to specific resource ARNs per [AWS documentation](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html). |
| **Fix** | Not possible to remove — scoped to deployment region via `aws:RequestedRegion` condition. All calls audited via CloudTrail. |
| **Evidence** | `docs/security-exceptions.md` Exception 1; `lib/creditunion-infrastructure-stack.ts` line ~295 |

### Finding H-2: AWSGlueServiceRole managed policy on 5 roles

| Field | Value |
|---|---|
| **Description** | Five AWS Glue per-job roles attach the AWS-managed `AWSGlueServiceRole` policy, which contains `glue:*` and `s3:CreateBucket` |
| **Severity** | High (scanner) |
| **Risk** | Broader permissions than strictly necessary |
| **Fix** | AWS Glue service requires this managed policy for job execution. Compensated with per-job roles, inline policies scoping Amazon S3 access to specific bucket ARNs, and `kms:ViaService` conditions on AWS KMS access. All Glue API calls audited via AWS CloudTrail. |
| **Evidence** | `docs/security-exceptions.md` Exception 2; per-job roles in `lib/creditunion-infrastructure-stack.ts` |

### Finding H-3: AWSLambdaVPCAccessExecutionRole on RDS data loader

| Field | Value |
|---|---|
| **Description** | RDS data loader AWS Lambda function attaches AWS-managed `AWSLambdaVPCAccessExecutionRole`, which contains EC2 network interface wildcards |
| **Severity** | Medium (scanner) / flagged High in earlier round |
| **Risk** | EC2 network interface permissions wider than specific Lambda needs |
| **Fix** | Required for Lambda functions in an Amazon VPC. Compensated with private subnet deployment, security group restricting egress to MySQL (3306) and AWS Secrets Manager (443) endpoints only, and AWS Lambda code signing. |
| **Evidence** | `docs/security-exceptions.md` Exception 3; `lib/rds-data-loader.ts` |

## Exit criteria status

| Requirement | Status |
|---|---|
| All high/critical findings verified as mitigated/resolved | ✅ All documented in `docs/security-exceptions.md` with compensating controls |
| `aws-itsec-appsec` POSIX group added to review | ⏳ Expected to auto-add via RIVER workflow |
| Evidence from required scanners attached to SIM ticket | ⏳ This document + `security/scans/scan-report (9).json` + threat model exports |

## Legal and licensing

| Check | Status |
|---|---|
| Apache 2.0 license present (`LICENSE`) | ✅ |
| Copyright notice present (`NOTICE`) | ✅ |
| License headers on all source files | ✅ TypeScript, Python, Markdown |
| Sample-code disclaimer in README | ✅ Added per Q12 in PCSR guide |
| Third-party generative AI (Appendix D) | ❌ Not applicable — no GenAI in scope |
| High-risk use cases requiring BLL review | ❌ Not applicable — synthetic data only, educational purpose |

## Customer post-deployment responsibilities

The following are documented as customer responsibilities and are not automated by the deployment:

| Priority | Action |
|---|---|
| P0 | Configure AWS Lake Formation column-level access controls for PII columns |
| P1 | Deploy AWS Config rules for security group change detection |
| P2 | Configure MFA Delete on sensitive Amazon S3 buckets |
| P3 | Configure Amazon CloudWatch alarms for security-relevant metrics |
| P4 | Review and customize AWS IAM role permissions for organizational policies |
| P5 | Configure AWS Secrets Manager automatic rotation for Amazon RDS credentials |

Full details in `README.md` under "Customer responsibilities (post-deployment)".

## Supporting documents

| Document | Location |
|---|---|
| Threat model | `security/threat-model/` (local only) |
| Security exceptions register | `docs/security-exceptions.md` |
| Security assessment | `docs/security-assessment.md` |
| Security guidelines | `docs/security-guidelines.md` |
| Data classification | `docs/data-classification.md` |
| Key management strategy | `docs/key-management-strategy.md` |
| Threat model summary | `docs/threat-model.md` |
| Scan reports (10 rounds) | `security/scans/scan-report (0-9).json` (local only) |
