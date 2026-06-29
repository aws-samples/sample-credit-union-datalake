<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Exceptions Register

This document records approved security exceptions where AWS service requirements prevent strict least-privilege compliance. Each exception includes justification, compensating controls, and review schedule. Exceptions are listed in priority order by risk level.

## Exception 1 (Priority: Medium Risk): EC2 Describe Wildcard Resource

| Field | Value |
|---|---|
| **Resource** | `creditunion-infrastructure-stack.ts` — AWS Glue per-job IAM roles |
| **Policy statement** | `ec2:DescribeNetworkInterfaces`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups` with `resources: ['*']` |
| **Reason** | AWS EC2 Describe APIs do not support resource-level permissions. Wildcard resource is required per [AWS documentation](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html). |
| **Compensating controls** | (1) `aws:RequestedRegion` condition limits scope to deployment region. (2) `ec2:CreateNetworkInterface` and `ec2:DeleteNetworkInterface` are scoped to specific resource ARNs. (3) AWS CloudTrail audits all EC2 API calls. |
| **Risk** | Low — Describe actions are read-only and do not modify resources. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — verify AWS has not added resource-level support for EC2 Describe APIs |

## Exception 2 (Priority: Medium Risk): AWS Managed Policy — AWSGlueServiceRole

| Field | Value |
|---|---|
| **Resource** | 4 AWS Glue per-job IAM roles + 1 XML crawler role |
| **Policy** | `arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole` |
| **Reason** | Required by AWS Glue service for job execution. Contains broad permissions including `glue:*` and `s3:CreateBucket`. Cannot be replaced with a custom policy without breaking AWS Glue functionality. |
| **Compensating controls** | (1) Per-job IAM roles limit blast radius — each role only accesses specific Amazon S3 buckets. (2) Inline policies scope Amazon S3 access to specific bucket ARNs. (3) AWS KMS access restricted via `kms:ViaService` conditions. (4) AWS CloudTrail audits all AWS Glue API calls. |
| **Risk** | Medium — managed policy grants broader permissions than needed, but compensating controls limit effective access. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — check if AWS has released a more restrictive managed policy for AWS Glue |

## Exception 3 (Priority: Low Risk): AWS Managed Policy — AWSLambdaVPCAccessExecutionRole

| Field | Value |
|---|---|
| **Resource** | RDS data loader AWS Lambda function |
| **Policy** | `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole` |
| **Reason** | Required for AWS Lambda functions deployed in Amazon VPC. Contains EC2 network interface permissions with wildcard resources. |
| **Compensating controls** | (1) AWS Lambda function deployed in private subnet only. (2) Security group restricts outbound to port 3306 (Amazon Relational Database Service (Amazon RDS)) and 443 (AWS Secrets Manager VPC endpoint). (3) AWS Lambda code signing via AWS Signer is enforced (ENFORCE mode) on this function — it is one of the three target Lambdas (RDS loader, crawler-trigger, crawler-wait) for which code signing is enforced; ENFORCE is not applied to all functions in the account. (4) AWS CloudTrail audits all AWS Lambda API calls. |
| **Risk** | Low — function runs in isolated network with restricted egress. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — verify no additional permissions have been added to the managed policy |

## Exception 4 (Priority: Medium Risk): MFA Delete Not Enabled on Amazon S3 Buckets

| Field | Value |
|---|---|
| **Resource** | collect, cleanse, consume Amazon S3 buckets |
| **Reason** | MFA Delete requires root account credentials and cannot be configured via AWS CDK or AWS CloudFormation. |
| **Compensating controls** | (1) Amazon S3 versioning enabled on all buckets. (2) Amazon S3 bucket policies deny unauthorized access. (3) Amazon S3 server access logging enabled. (4) AWS CloudTrail audits all Amazon S3 API calls. (5) AWS CloudTrail audit log bucket has Object Lock enabled for immutability. |
| **Risk** | Medium — without MFA Delete, a compromised admin could delete bucket versions. Versioning and audit logging provide detection capability. |
| **Customer action** | Customers should enable MFA Delete using root credentials: `aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "arn:aws:iam::ACCOUNT:mfa/root-device TOTP"` |
| **Review schedule** | Check if AWS CDK adds MFA Delete support in future releases |
## Exception 5 (Priority: Informational): LICENSE File URL Scheme

| Field | Value |
|---|---|
| **Resource** | `LICENSE` (Apache License 2.0 boilerplate) |
| **Modification** | The two URLs in the license boilerplate (`https://www.apache.org/licenses/` and `https://www.apache.org/licenses/LICENSE-2.0`) were updated from `http://` to `https://`. |
| **Reason** | The canonical Apache 2.0 license text as published by the Apache Software Foundation uses `http://` URLs. Security scanners flag these as "Only HTTPS URLs are allowed." The Apache Software Foundation serves both schemes, and `http://` redirects to `https://`. Updating the scheme does not alter the license terms or legal effect — only the URL transport. |
| **Compensating controls** | (1) URLs resolve to the same canonical Apache 2.0 license document. (2) License text is otherwise unmodified. (3) Project remains fully compliant with Apache 2.0 terms. |
| **Risk** | None — cosmetic change to URL transport scheme only. |
| **Approved by** | Project security review |
| **Review schedule** | None required — permanent modification |

## Exception 6 (Priority: Low Risk): AWS Config Configuration Recorder Role

> Applies only when the platform is deployed with the `provisionConfigRecorder` CDK context flag set to `true`. The recorder, delivery channel, and this role are gated behind that flag (default `false`), so the default deployment never creates them.

| Field | Value |
|---|---|
| **Resource** | `creditunion-infrastructure-stack.ts` — AWS Config configuration recorder service role (`ConfigRole`, gated behind `provisionConfigRecorder`) |
| **Scoped suppression** | `NagSuppressions.addResourceSuppressions(configRole, [...], true)` inside the `if (provisionConfigRecorder)` block, so it only applies when the role exists. |
| **Rule: `AwsSolutions-IAM4`** | `appliesTo` pinned to `Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWS_ConfigRole`. The AWS managed `AWS_ConfigRole` policy is required by AWS Config to read configuration items across supported resource types and cannot be replaced by a custom policy without breaking AWS Config. |
| **Rule: `AwsSolutions-IAM5`** | Object-level write (`s3:PutObject*`, `s3:Abort*`) plus the corresponding AWS KMS wildcards (`kms:GenerateDataKey*`, `kms:ReEncrypt*`) on the dedicated, KMS-encrypted Config delivery bucket, required for AWS Config to deliver configuration snapshots/history. Wildcards are scoped to the Config bucket object path and the data-lake customer-managed key only. |
| **Compensating controls** | (1) Role assumable only by `config.amazonaws.com`. (2) Delivery bucket is KMS-encrypted, versioned, blocks public access, and enforces SSL. (3) Recorder is gated behind a default-false flag, so the role is not created in the default deployment. (4) AWS CloudTrail audits all AWS Config API calls. |
| **Risk** | Low — service role scoped to a single AWS service with a dedicated delivery bucket. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — check if AWS releases a more restrictive managed policy for AWS Config |

## Exception 7 (Priority: Low Risk): Deploy-Time Lambda Code-Signing Provider (SignedLambdaArtifact)

| Field | Value |
|---|---|
| **Resource** | `signed-lambda-artifact.ts` — `SignedLambdaArtifact` construct. Reused across the Data stack (`RdsDataLoader/PymysqlLayerArtifact`, `RdsDataLoader/HandlerArtifact`, `CrawlerHandlerArtifact`) and the Trigger stack (`WaitHandlerArtifact`). |
| **Scoped suppression** | `NagSuppressions.addResourceSuppressions(this, [...], true)` is applied inside the construct itself, so it travels with every reuse and is independent of the consuming stack's name (test-portability). It covers the construct's own child nodes only: the `SigningOnEvent` function role/policy and the `SigningProvider/framework-onEvent` function role/policy. |
| **Rule: `AwsSolutions-IAM4`** | `appliesTo` pinned to `Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`. Applied by CDK to the signing onEvent function and the custom-resource provider framework function for CloudWatch logging. These are CDK-internal signing tooling. |
| **Rule: `AwsSolutions-IAM5`** | Reason-only. The onEvent policy contains: (1) `grantRead`/`grantReadWrite` wildcards on the staged-asset and versioned artifacts buckets (`s3:GetObject*`, `s3:GetBucket*`, `s3:List*`, `s3:Abort*`, `s3:DeleteObject*`, `s3:PutObject*`) and the corresponding KMS wildcards (`kms:GenerateDataKey*`, `kms:ReEncrypt*`) — object-level grants scoped to specific bucket/key ARNs emitted by the CDK grant helpers; and (2) `signer:StartSigningJob` / `signer:DescribeSigningJob` on `Resource::*` because AWS Signer does not support resource-level permissions for these actions. The provider framework function policy contains a `lambda:InvokeFunction` wildcard (`<SigningOnEvent>.Arn:*`) auto-generated by the `cr.Provider` construct. |
| **Rule: `AwsSolutions-L1`** | Reason-only. The custom-resource provider framework Lambda runtime is managed by the AWS CDK `cr.Provider` construct and updates with CDK library upgrades; it cannot be customized. |
| **Compensating controls** | (1) The signing tooling runs only at deploy time and is not part of the runtime data path. (2) The artifacts bucket is KMS-encrypted, versioned, blocks public access, and enforces SSL. (3) AWS Signer signing jobs are scoped to the supplied signing profile. (4) AWS CloudTrail audits all AWS Signer, Amazon S3, and AWS Lambda API calls. |
| **Risk** | Low — deploy-time-only tooling; wildcards are AWS-imposed (Signer, CDK-managed provider) or scoped object-level grants. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — verify AWS Signer has not added resource-level permission support and re-check CDK provider-framework defaults |

## Exception 8 (Priority: Low Risk): Lake Formation Data-Location Registration Role

| Field | Value |
|---|---|
| **Resource** | `creditunion-data-stack.ts` — `LakeFormationRegistrationRole` (`creditunion-<region>-lf-registration`), assumed by `lakeformation.amazonaws.com`, registering the consume and cleanse data-lake S3 locations. |
| **Reason** | Lake Formation must assume a role to broker access to registered S3 locations for LF-governed queries. An **explicit** registration role is used instead of the Lake Formation service-linked role (`AWSServiceRoleForLakeFormationDataAccess`): the SLR path cannot deregister the *last* registered S3 location without a manual SLR deletion, which wedges `cdk destroy` in `DELETE_FAILED` and breaks the clean-teardown invariant. An explicit role deregisters cleanly. |
| **Scoped suppression** | `NagSuppressions.addResourceSuppressions(lfRegistrationRole, [...], true)`. |
| **Rule: `AwsSolutions-IAM5`** | Reason-only. `bucket.grantReadWrite(...)` on the consume and cleanse buckets emits object-level S3 wildcards (`s3:GetObject*`, `s3:GetBucket*`, `s3:List*`, `s3:Abort*`, `s3:DeleteObject*`, `s3:PutObject*`) and the corresponding KMS data-key wildcards (`kms:GenerateDataKey*`, `kms:ReEncrypt*`) that Lake Formation needs to broker access to LF-governed locations. Wildcards are scoped to the two specific bucket ARNs and the data-lake customer-managed key only. |
| **Compensating controls** | (1) Role assumable only by `lakeformation.amazonaws.com`. (2) Read/write scoped to the consume and cleanse buckets and the data-lake CMK — no access to the collect, access-logs, or CloudTrail buckets. (3) The buckets are KMS-encrypted, versioned, block public access, and enforce SSL. (4) AWS CloudTrail audits all Lake Formation, Amazon S3, and AWS KMS API calls. |
| **Risk** | Low — single-service registration role scoped to the two governed data-lake buckets; replaces the SLR purely to preserve hands-off teardown. |
| **Approved by** | Project security review |
| **Review schedule** | Quarterly — re-check whether Lake Formation supports clean SLR last-location deregistration via CloudFormation |

## Exception 9 (Priority: Low Risk): Crawler-Wait Custom Resource Lambda Invoke

| Field | Value |
|---|---|
| **Resource** | `creditunion-trigger-stack.ts` — `WaitForCrawlers` `AwsCustomResource` and the shared custom-resource provider role; invoke of the `CrawlerWaitFunction`. |
| **Reason** | The `WaitForCrawlers` custom resource invokes the crawler-wait Lambda. The grant covers the unqualified function ARN and its version/alias-qualified form (`<CrawlerWaitFunction.Arn>:*`). The AWS SDK v3 Lambda `invoke` path can authorize against the qualified ARN, so granting only the unqualified name leaves the invocation unauthorized (`AccessDenied` on `lambda:InvokeFunction`). |
| **Scoped suppression** | `NagSuppressions.addResourceSuppressionsByPath(...)` with `appliesTo` regex `/^Resource::<CrawlerWaitFunction.*\.Arn>:\*$/g` on the provider `ServiceRole/DefaultPolicy` and the `WaitForCrawlers/CustomResourcePolicy`. |
| **Rule: `AwsSolutions-IAM5`** | Reason-only for the `:*` qualifier. `lambda:InvokeFunction` is scoped to a single function's ARN; the wildcard applies only to versions/aliases of that one function. |
| **Compensating controls** | (1) The grant is for exactly one function (the crawler-wait Lambda), not a wildcard across functions. (2) The custom resource runs only at deploy time. (3) AWS CloudTrail audits all AWS Lambda API calls. |
| **Risk** | Low — invoke scoped to versions/aliases of a single deploy-time function. |
| **Approved by** | Project security review |
| **Review schedule** | None required — standard scoped invoke grant |

## Note on cross-stack resource references (Exceptions 2 and 3)

The `XMLCrawlerRole` (Exception 2) and `RdsDataLoader/RdsLoaderRole` (Exception 3) `AwsSolutions-IAM5` suppressions scope their object-level collect-bucket access via a regular-expression `appliesTo` (`/^Resource::.*CollectBucket.*Arn.*\/\*$/g`). The collect bucket is created in the infrastructure stack and consumed cross-stack, so its ARN resolves to a CloudFormation export-import token (`<ProducerStack>:ExportsOutputFnGetAttCollectBucket...Arn.../*`) rather than the same-stack `<CollectBucket....Arn>/*` form. The regex matches both forms so the scoped suppression applies regardless of stack naming (canonical deployment and test harness alike). No additional access is granted — the wildcard remains scoped to object paths within the collect bucket only.
