<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Assessment

## Scan Summary

This project has undergone multiple rounds of automated security scanning using the Holmes Content Security Review baseline. Findings have been categorized by severity and addressed through code changes or documented compensating controls.

## Findings and Remediation

### Critical / High Severity — Addressed

| Finding | Severity | Remediation | Verified |
|---|---|---|---|
| Hardcoded database username in AWS Glue connection | High | Resolved: both username and password now resolved via AWS Secrets Manager dynamic references | Code review |
| Shared AWS Glue IAM role across all ETL jobs | High | Resolved: split into 4 per-job roles with scoped Amazon S3 and AWS KMS access | CDK synth test |
| AWS KMS wildcard fallback (`keyArn \|\| '*'`) | High | Resolved: replaced with non-null assertion (`encryptionKey!.keyArn`) | CDK synth test |
| Amazon CloudWatch Logs wildcard resource | High | Resolved: scoped to `arn:aws:logs:{region}:{account}:*` | CDK synth test |
| EC2 VPC wildcard resource | High | Resolved: Describe actions keep `*` with region condition; Create/Delete scoped to specific ARNs | CDK synth test |
| CSV data inserted without validation | High | Resolved: added schema validation, field count check, value truncation | Code review |
| PII leakage in AWS Lambda error logs | High | Resolved: error messages log type only, not raw exception content | Code review |
| Trigger stack wildcard Lambda invoke | High | Resolved: scoped to specific function ARN | CDK synth test |
| ETL script tampering risk | High | Resolved: glue-assets bucket has versioning + write-restriction policy | CDK synth test |
| Missing audit logging | High | Resolved: AWS CloudTrail with file validation, Amazon VPC Flow Logs, Amazon S3 access logging | CDK synth test |

### Compensating Controls

| Finding | Severity | Compensating Control |
|---|---|---|
| EC2 Describe actions require `resource: '*'` | Medium | AWS requires wildcard for EC2 Describe APIs. Compensated with `aws:RequestedRegion` condition limiting scope to deployment region. AWS CloudTrail audits all EC2 API calls. |
| `AWSGlueServiceRole` managed policy is broad | Medium | Required by AWS Glue service. Compensated with per-job roles limiting Amazon S3 access to specific bucket ARNs and AWS KMS access via `kms:ViaService` conditions. |
| MFA Delete not enabled on Amazon S3 buckets | Medium | Requires root account credentials, cannot be automated via AWS CDK. Documented as post-deployment customer action in README and security-guidelines. |
| Missing `__CODE_SCAN_RESULTS__` artifact | Medium | This project uses external scanning tools (Holmes CSR). Scan results are maintained in the project's security review system, not as an in-repo artifact. |

### Attestation

Security controls implemented in this project have been verified through:

1. **Automated CDK synthesis tests** — 11 tests validate all 4 stacks synthesize correctly with expected resource counts and configurations
   ```bash
   npx jest --verbose
   ```
2. **Multiple rounds of automated security scanning** — Holmes Content Security Review baseline with iterative remediation
3. **STRIDE threat model** — documented in [docs/threat-model.md](threat-model.md) with mitigations mapped to each threat
4. **Code review** — all security changes reviewed for correctness before deployment

To verify deployed controls, run the integration test suite:
```bash
./test/integration/run-integration-tests.sh
```
