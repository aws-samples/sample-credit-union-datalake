<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Exceptions Register

This document records approved security exceptions where AWS service requirements prevent strict least-privilege compliance. Each exception includes justification, compensating controls, and review schedule.

## Exception 1: EC2 Describe Wildcard Resource

| Field | Value |
|---|---|
| **Resource** | `creditunion-infrastructure-stack.ts` — AWS Glue per-job IAM roles |
| **Policy statement** | `ec2:DescribeNetworkInterfaces`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups` with `resources: ['*']` |
| **Reason** | AWS EC2 Describe APIs do not support resource-level permissions. Wildcard resource is required per [AWS documentation](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html). |
| **Compensating controls** | (1) `aws:RequestedRegion` condition limits scope to deployment region. (2) `ec2:CreateNetworkInterface` and `ec2:DeleteNetworkInterface` are scoped to specific resource ARNs. (3) AWS CloudTrail audits all EC2 API calls. |
| **Risk** | Low — Describe actions are read-only and do not modify resources. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — verify AWS has not added resource-level support for EC2 Describe APIs |

## Exception 2: AWS Managed Policy — AWSGlueServiceRole

| Field | Value |
|---|---|
| **Resource** | 4 AWS Glue per-job IAM roles + 1 XML crawler role |
| **Policy** | `arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole` |
| **Reason** | Required by AWS Glue service for job execution. Contains broad permissions including `glue:*` and `s3:CreateBucket`. Cannot be replaced with a custom policy without breaking AWS Glue functionality. |
| **Compensating controls** | (1) Per-job IAM roles limit blast radius — each role only accesses specific Amazon S3 buckets. (2) Inline policies scope Amazon S3 access to specific bucket ARNs. (3) AWS KMS access restricted via `kms:ViaService` conditions. (4) AWS CloudTrail audits all AWS Glue API calls. |
| **Risk** | Medium — managed policy grants broader permissions than needed, but compensating controls limit effective access. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — check if AWS has released a more restrictive managed policy for AWS Glue |

## Exception 3: AWS Managed Policy — AWSLambdaVPCAccessExecutionRole

| Field | Value |
|---|---|
| **Resource** | RDS data loader AWS Lambda function |
| **Policy** | `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole` |
| **Reason** | Required for AWS Lambda functions deployed in Amazon VPC. Contains EC2 network interface permissions with wildcard resources. |
| **Compensating controls** | (1) AWS Lambda function deployed in private subnet only. (2) Security group restricts outbound to port 3306 (Amazon RDS) and 443 (AWS Secrets Manager VPC endpoint). (3) AWS Lambda code signing via AWS Signer prevents unauthorized code changes. (4) AWS CloudTrail audits all AWS Lambda API calls. |
| **Risk** | Low — function runs in isolated network with restricted egress. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — verify no additional permissions have been added to the managed policy |

## Exception 4: MFA Delete Not Enabled on Amazon S3 Buckets

| Field | Value |
|---|---|
| **Resource** | collect, cleanse, consume Amazon S3 buckets |
| **Reason** | MFA Delete requires root account credentials and cannot be configured via AWS CDK or AWS CloudFormation. |
| **Compensating controls** | (1) Amazon S3 versioning enabled on all buckets. (2) Amazon S3 bucket policies deny unauthorized access. (3) Amazon S3 server access logging enabled. (4) AWS CloudTrail audits all Amazon S3 API calls. (5) AWS CloudTrail audit log bucket has Object Lock enabled for immutability. |
| **Risk** | Medium — without MFA Delete, a compromised admin could delete bucket versions. Versioning and audit logging provide detection capability. |
| **Customer action** | We recommend that customers enable MFA Delete using root credentials: `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP"` |
| **Review schedule** | Check if AWS CDK adds MFA Delete support in future releases |
