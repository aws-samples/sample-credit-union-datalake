# Security Guidelines for AWS Services

## Overview

This document provides security configuration guidelines for each AWS service used in the Credit Union Data Lake platform. Under the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/), AWS manages infrastructure security while customers manage configuration and access.

## Amazon S3

| Control | Status | Details |
|---|---|---|
| Block Public Access | ✅ Enabled | `BlockPublicAccess.BLOCK_ALL` on all buckets |
| Encryption at rest | ✅ Enabled | Customer-managed AWS KMS key with auto-rotation |
| TLS enforcement | ✅ Enabled | `enforceSSL: true` on all buckets |
| Versioning | ✅ Enabled | Non-current version expiration after 30 days |
| Server access logging | ✅ Enabled | Dedicated access logs bucket with per-bucket prefixes |
| Bucket policies | ✅ Enabled | Deny statements restricting access to approved AWS IAM roles |
| MFA Delete | ⚠️ Post-deploy | Requires root account credentials; configure via AWS CLI |
| Object Lock | ✅ Enabled | On AWS CloudTrail audit log bucket |

**Customer action**: Enable MFA Delete on sensitive buckets using `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP"`.

## Amazon RDS for MySQL

| Control | Status | Details |
|---|---|---|
| Encryption at rest | ✅ Enabled | AWS KMS customer-managed key |
| Network isolation | ✅ Enabled | Isolated subnet, no internet access |
| SSL/TLS in transit | ✅ Enabled | `useSSL=true&requireSSL=true` on JDBC; `ssl` param on pymysql |
| Credential management | ✅ Enabled | Auto-generated in AWS Secrets Manager, resolved dynamically |
| Backup retention | ✅ Enabled | 7-day retention |
| Security groups | ✅ Scoped | Inbound MySQL (3306) from AWS Glue and AWS Lambda security groups only |

**Customer action**: Review backup retention period for regulatory requirements. Consider enabling automated snapshots to a separate AWS account for DR.

## AWS Glue

| Control | Status | Details |
|---|---|---|
| Per-job IAM roles | ✅ Enabled | 4 separate roles scoped to specific Amazon S3 paths |
| KMS via-service conditions | ✅ Enabled | AWS KMS access restricted to Amazon S3 and AWS Glue services |
| Job concurrency limits | ✅ Enabled | `MaxConcurrentRuns: 1` on all jobs |
| JDBC SSL | ✅ Enabled | SSL parameters in connection URL |
| Script integrity | ✅ Enabled | Glue assets bucket has versioning + write-restriction policy |

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

**Customer action**: Consider changing `untrustedArtifactOnDeployment` from `WARN` to `ENFORCE` for production environments.
