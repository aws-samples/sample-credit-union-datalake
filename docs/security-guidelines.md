<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Guidelines for AWS Services

## Overview

This document provides security configuration guidelines for each AWS service used in the Credit Union Data Lake platform. Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/):

- **AWS is responsible for security *of* the cloud**: protecting the infrastructure that runs all AWS services, including hardware, software, networking, and facilities.
- **Customers are responsible for security *in* the cloud**: configuring and managing the AWS services deployed by this project, including access controls, encryption settings, network configuration, and data protection.

## Implementation Priority

Customers should address post-deployment security actions in the following order:

| Priority | Action | Risk Reduction | Effort |
|---|---|---|---|
| P0 | Configure AWS Lake Formation column-level access controls for SSN fields | Prevents unauthorized PII access (~90% reduction in data exposure risk) | 2–4 hours |
| P1 | Deploy AWS Config rules for security group monitoring | Detects unauthorized network changes (~70% reduction in misconfiguration risk) | 1–2 hours |
| P2 | Configure MFA Delete on sensitive Amazon S3 buckets | Prevents accidental/malicious data deletion (~80% reduction in data loss risk) | 30 minutes (requires root) |
| P3 | Set up Amazon CloudWatch alarms for security events | Reduces mean-time-to-detect for security incidents from days to minutes | 1–2 hours |
| P4 | Review and customize AWS IAM role permissions | Reduces blast radius of compromised credentials | 2–4 hours |
| P5 | Configure AWS Secrets Manager automatic rotation | Limits credential exposure window from indefinite to rotation interval | 1 hour |

## Security Improvement Metrics

The following metrics represent the security posture change from a baseline (no controls) to the deployed state. Post-deployment targets require customer action. Percentages are based on the count of resources with each control enabled relative to the total applicable resources.

| Metric | Before Deployment | After Deployment | Target (Post-Deploy) |
|---|---|---|---|
| S3 buckets with encryption at rest | 0% | 100% | 100% |
| IAM roles with least-privilege scoping | 0% | 100% (per-job roles) | 100% |
| Services with audit logging | 0% | 100% (AWS CloudTrail + Amazon S3 access logs) | 100% |
| PII columns with access controls | 0% | 0% | 100% (via AWS Lake Formation) |
| Secrets with automatic rotation | 0% | 0% | 100% (via AWS Secrets Manager rotation) |
| Security group changes monitored | 0% | 0% (Amazon VPC Flow Logs only) | 100% (via AWS Config rules) |

## Amazon S3

| Control | Status | Details |
|---|---|---|
| Block Public Access | ✅ Enabled | `BlockPublicAccess.BLOCK_ALL` on all buckets |
| Encryption at rest | ✅ Enabled | Customer-managed AWS KMS key with auto-rotation. **BYOK review**: This deployment uses a customer-managed key (BYOK). Customers should review key policies and access grants before production use. See [Key Management Strategy](key-management-strategy.md). |
| TLS enforcement | ✅ Enabled | `enforceSSL: true` on all buckets |
| Versioning | ✅ Enabled | Non-current version expiration after 30 days |
| Server access logging | ✅ Enabled | Dedicated access logs bucket with per-bucket prefixes |
| Bucket policies | ✅ Enabled | Deny statements restricting access to approved AWS IAM roles |
| MFA Delete | ⚠️ Post-deploy | Requires root account credentials; configure via AWS CLI |
| Object Lock | ✅ Enabled | On AWS CloudTrail audit log bucket |

**Customer action**: To configure MFA Delete on sensitive buckets using `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP"`.

## Amazon RDS for MySQL

| Control | Status | Details |
|---|---|---|
| Encryption at rest | ✅ Enabled | AWS KMS customer-managed key |
| Network isolation | ✅ Enabled | Isolated subnet, no internet access |
| SSL/TLS in transit | ✅ Enabled | `useSSL=true&requireSSL=true` on JDBC; `ssl` param on pymysql |
| Credential management | ✅ Enabled | Auto-generated in AWS Secrets Manager, resolved dynamically |
| Backup retention | ✅ Enabled | 7-day retention |
| Security groups | ✅ Scoped | Inbound MySQL (3306) from AWS Glue and AWS Lambda security groups only |

**Customer action**: Review backup retention period for regulatory requirements. Customers should configure automated snapshots to a separate AWS account for DR.

## AWS IAM Access Review Procedures

Customers should perform the following access reviews on a quarterly basis:

1. **Review AWS Glue role permissions**: `aws iam list-attached-role-policies --role-name creditunion-{region}-glue-mysql` for each of the 4 per-job roles. Verify no additional policies have been attached.
2. **Review Amazon S3 bucket policies**: `aws s3api get-bucket-policy --bucket creditunion-{account}-{region}-collect` for each bucket. Verify principal patterns match expected roles.
3. **Review AWS KMS key grants**: `aws kms list-grants --key-id <key-id>`. Revoke any grants not associated with deployed services.
4. **Review AWS Secrets Manager access**: `aws secretsmanager get-resource-policy --secret-id <secret-arn>`. Verify only the AWS Lambda RDS loader and AWS Glue MySQL role have access.
5. **Audit AWS CloudTrail**: Review `iam:AttachRolePolicy`, `iam:PutRolePolicy`, and `kms:CreateGrant` events for unauthorized changes.

## AWS Glue

| Control | Status | Details |
|---|---|---|
| Per-job IAM roles | ✅ Enabled | 4 separate roles scoped to specific Amazon S3 paths |
| KMS via-service conditions | ✅ Enabled | AWS KMS access restricted to Amazon S3 and AWS Glue services |
| Job concurrency limits | ✅ Enabled | `MaxConcurrentRuns: 1` on all jobs |
| JDBC SSL | ✅ Enabled | SSL parameters in connection URL |
| Script integrity | ✅ Enabled | AWS Glue assets bucket has versioning + write-restriction policy |

**Customer action**: Review AWS Glue job scripts periodically for unauthorized modifications. Monitor AWS CloudTrail for `glue:UpdateJob` API calls.

## AWS Lambda

| Control | Status | Details |
|---|---|---|
| Code signing | ✅ Enabled | AWS Signer profiles with 365-day validity on all Lambda functions |
| VPC deployment | ✅ Enabled | RDS data loader runs in private subnet |
| Least-privilege IAM | ✅ Enabled | Scoped to specific AWS Secrets Manager ARN, Amazon S3 paths, and AWS KMS key |
| Error sanitization | ✅ Enabled | Error messages log type only, not raw exception content |

**Customer action**: Rotate AWS Signer signing profiles before expiration. Monitor AWS CloudTrail for `lambda:UpdateFunctionCode` API calls.

## AWS Step Functions

| Control | Status | Details |
|---|---|---|
| Execution logging | ✅ Enabled | `LogLevel.ALL` with execution data to Amazon CloudWatch |
| Scoped IAM role | ✅ Enabled | Limited to specific AWS Glue job ARNs |
| Amazon CloudWatch Logs | ✅ Enabled | 1-month retention |

**Customer action**: Configure Amazon CloudWatch alarms for failed executions. Review execution history for anomalous patterns.

## AWS CloudTrail

| Control | Status | Details |
|---|---|---|
| Log file validation | ✅ Enabled | Digest files for tamper detection |
| Amazon CloudWatch delivery | ✅ Enabled | 3-month retention |
| Immutable storage | ✅ Enabled | Object Lock on audit log bucket |
| Encryption | ✅ Enabled | AWS KMS customer-managed key |

**Customer action**: Configure Amazon CloudWatch metric filters and alarms for security-relevant API calls (e.g., `DeleteTrail`, `StopLogging`, `DisableKey`).

## Amazon VPC

| Control | Status | Details |
|---|---|---|
| Flow Logs | ✅ Enabled | All traffic logged to Amazon CloudWatch (3-month retention) |
| VPC endpoints | ✅ Enabled | Amazon S3 (gateway) and AWS Secrets Manager (interface) |
| Subnet isolation | ✅ Enabled | 3-tier: public, private with NAT, isolated for Amazon RDS |
| Security groups | ✅ Scoped | Explicit port rules (3306, 443, TCP self-referencing for AWS Glue) |

**Customer action**: Deploy AWS Config rules for security group change detection. See README.md Customer responsibilities section.

## AWS KMS

| Control | Status | Details |
|---|---|---|
| Key rotation | ✅ Enabled | Annual automatic rotation |
| Via-service conditions | ✅ Enabled | Restricts key usage to Amazon S3 and AWS Glue services |
| Audit logging | ✅ Enabled | AWS CloudTrail captures all AWS KMS API calls |

**Customer action**: See [Key Management Strategy](key-management-strategy.md) for lifecycle procedures and access review schedule.

## AWS Secrets Manager

| Control | Status | Details |
|---|---|---|
| Auto-generated credentials | ✅ Enabled | Username and password generated at deploy time |
| VPC endpoint access | ✅ Enabled | No public internet traffic for credential retrieval |
| Scoped IAM access | ✅ Enabled | Only AWS Glue MySQL role and AWS Lambda RDS loader can read the secret |

**Customer action**: Enable automatic secret rotation via AWS Secrets Manager rotation Lambda. Review secret access in AWS CloudTrail quarterly.

## AWS Signer

| Control | Status | Details |
|---|---|---|
| Signing profiles | ✅ Enabled | SHA384 ECDSA platform, 365-day validity |
| Code signing configs | ✅ Enabled | WARN policy on untrusted artifacts |

**Customer action**: Customers can change `untrustedArtifactOnDeployment` from `WARN` to `ENFORCE` for production environments.
