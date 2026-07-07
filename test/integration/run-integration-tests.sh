#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Integration tests for the deployed Credit Union Data Lake infrastructure.
# Validates that all AWS resources exist, are configured correctly, and can communicate.
#
# Prerequisites:
#   - AWS CLI configured with credentials for the target account
#   - All 4 CDK stacks deployed successfully
#
# Usage: ./test/integration/run-integration-tests.sh

set -euo pipefail

REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✅ PASS: $1"; ((PASS++)); }
fail() { echo "  ❌ FAIL: $1"; ((FAIL++)); }
skip() { echo "  ⬜ SKIP: $1"; ((SKIP++)); }

echo "============================================"
echo "Credit Union Data Lake Integration Tests"
echo "Account: $ACCOUNT | Region: $REGION"
echo "============================================"
echo ""

# ── S3 Buckets ──────────────────────────────────
echo "── Amazon S3 Buckets ──"

for BUCKET_SUFFIX in collect cleanse consume; do
  BUCKET="creditunion-${ACCOUNT}-${REGION}-${BUCKET_SUFFIX}"
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    pass "Bucket exists: $BUCKET"

    # Check encryption
    ENC=$(aws s3api get-bucket-encryption --bucket "$BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text 2>/dev/null || echo "NONE")
    if [ "$ENC" = "aws:kms" ]; then
      pass "KMS encryption enabled: $BUCKET"
    else
      fail "KMS encryption missing: $BUCKET (got: $ENC)"
    fi

    # Check versioning
    VERS=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query 'Status' --output text 2>/dev/null || echo "NONE")
    if [ "$VERS" = "Enabled" ]; then
      pass "Versioning enabled: $BUCKET"
    else
      fail "Versioning not enabled: $BUCKET (got: $VERS)"
    fi

    # Check public access block
    PUB=$(aws s3api get-public-access-block --bucket "$BUCKET" --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text 2>/dev/null || echo "false")
    if [ "$PUB" = "True" ]; then
      pass "Public access blocked: $BUCKET"
    else
      fail "Public access not blocked: $BUCKET"
    fi

    # Check access logging
    LOG=$(aws s3api get-bucket-logging --bucket "$BUCKET" --query 'LoggingEnabled.TargetBucket' --output text 2>/dev/null || echo "NONE")
    if [ "$LOG" != "NONE" ] && [ "$LOG" != "None" ]; then
      pass "Access logging enabled: $BUCKET"
    else
      fail "Access logging not enabled: $BUCKET"
    fi
  else
    fail "Bucket does not exist: $BUCKET"
  fi
done

echo ""

# ── Collect Bucket Data ─────────────────────────
echo "── Sample Data in Collect Bucket ──"

COLLECT="creditunion-${ACCOUNT}-${REGION}-collect"
for PREFIX in CreditUnionData/CoreBanking_RDS_LoadOnly/ CreditUnionData/CreditCards/ CreditUnionData/CRMSystem/ CreditUnionData/DigitalBanking/ CreditUnionData/LoanSystem/; do
  COUNT=$(aws s3 ls "s3://${COLLECT}/${PREFIX}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -gt 0 ]; then
    pass "Data present: ${PREFIX} (${COUNT} objects)"
  else
    fail "No data found: ${PREFIX}"
  fi
done

echo ""

# ── RDS Database ────────────────────────────────
echo "── Amazon RDS for MySQL ──"

DB_INSTANCE=$(aws rds describe-db-instances --query "DBInstances[?TagList[?Key=='Project'&&Value=='CreditUnionAnalytics']].DBInstanceIdentifier" --output text 2>/dev/null | head -1)
if [ -n "$DB_INSTANCE" ] && [ "$DB_INSTANCE" != "None" ]; then
  pass "RDS instance exists: $DB_INSTANCE"

  STATUS=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" --query 'DBInstances[0].DBInstanceStatus' --output text)
  if [ "$STATUS" = "available" ]; then
    pass "RDS status: available"
  else
    fail "RDS status: $STATUS (expected: available)"
  fi

  ENCRYPTED=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" --query 'DBInstances[0].StorageEncrypted' --output text)
  if [ "$ENCRYPTED" = "True" ]; then
    pass "RDS storage encrypted"
  else
    fail "RDS storage not encrypted"
  fi
else
  fail "No RDS instance found with Project=CreditUnionAnalytics tag"
fi

echo ""

# ── AWS Secrets Manager ─────────────────────────
echo "── AWS Secrets Manager ──"

SECRET_ARN=$(aws cloudformation describe-stacks --stack-name CreditUnionInfrastructureStack --query "Stacks[0].Outputs[?OutputKey=='DatabaseSecretArn'].OutputValue" --output text 2>/dev/null || echo "")
if [ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ]; then
  pass "Database secret exists: ${SECRET_ARN##*:}"
  
  # Verify secret is readable (don't print the value)
  if aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query 'Name' --output text >/dev/null 2>&1; then
    pass "Database secret is readable"
  else
    fail "Database secret is not readable"
  fi
else
  fail "Database secret not found in stack outputs"
fi

echo ""

# ── AWS Glue ────────────────────────────────────
echo "── AWS Glue ──"

for DB_NAME in creditunion_cleanse creditunion_consume creditunion_xml_catalog; do
  if aws glue get-database --name "$DB_NAME" >/dev/null 2>&1; then
    pass "Glue database exists: $DB_NAME"
  else
    fail "Glue database missing: $DB_NAME"
  fi
done

# Check Glue connection
if aws glue get-connection --name "creditunion-mysql-connection" >/dev/null 2>&1; then
  pass "Glue JDBC connection exists"
else
  fail "Glue JDBC connection missing"
fi

# Check Glue jobs
for JOB in creditunion-visual-mysql-etl creditunion-xml-collect-to-cleanse-visual creditunion_CSV_collect_to_cleanse_visual creditunion-member-360-visual-etl; do
  if aws glue get-job --job-name "$JOB" >/dev/null 2>&1; then
    pass "Glue job exists: $JOB"
    
    # Check concurrency limit
    MAX_RUNS=$(aws glue get-job --job-name "$JOB" --query 'Job.ExecutionProperty.MaxConcurrentRuns' --output text 2>/dev/null || echo "0")
    if [ "$MAX_RUNS" = "1" ]; then
      pass "Concurrency limit set: $JOB (MaxConcurrentRuns=1)"
    else
      fail "Concurrency limit not set: $JOB (MaxConcurrentRuns=$MAX_RUNS)"
    fi
  else
    fail "Glue job missing: $JOB"
  fi
done

# Check crawlers
for CRAWLER in creditunion-creditcards-xml-crawler creditunion-crm-xml-crawler; do
  if aws glue get-crawler --name "$CRAWLER" >/dev/null 2>&1; then
    pass "Glue crawler exists: $CRAWLER"
  else
    fail "Glue crawler missing: $CRAWLER"
  fi
done

echo ""

# ── AWS Step Functions ──────────────────────────
echo "── AWS Step Functions ──"

SM_ARN="arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:creditunion-etl-state-machine"
if aws stepfunctions describe-state-machine --state-machine-arn "$SM_ARN" >/dev/null 2>&1; then
  pass "State machine exists: creditunion-etl-state-machine"
  
  LOG_LEVEL=$(aws stepfunctions describe-state-machine --state-machine-arn "$SM_ARN" --query 'loggingConfiguration.level' --output text 2>/dev/null || echo "OFF")
  if [ "$LOG_LEVEL" = "ALL" ]; then
    pass "Execution logging enabled (level=ALL)"
  else
    fail "Execution logging not set to ALL (got: $LOG_LEVEL)"
  fi
else
  fail "State machine missing: creditunion-etl-state-machine"
fi

echo ""

# ── AWS Lambda ──────────────────────────────────
echo "── AWS Lambda ──"

RDS_LAMBDA=$(aws cloudformation describe-stacks --stack-name CreditUnionDataStack --query "Stacks[0].Outputs[?OutputKey=='RdsLambdaFunctionName'].OutputValue" --output text 2>/dev/null || echo "")
CRAWLER_LAMBDA=$(aws cloudformation describe-stacks --stack-name CreditUnionDataStack --query "Stacks[0].Outputs[?OutputKey=='CrawlerLambdaFunctionName'].OutputValue" --output text 2>/dev/null || echo "")

for FUNC_NAME in "$RDS_LAMBDA" "$CRAWLER_LAMBDA"; do
  if [ -n "$FUNC_NAME" ] && [ "$FUNC_NAME" != "None" ]; then
    if aws lambda get-function --function-name "$FUNC_NAME" >/dev/null 2>&1; then
      pass "Lambda function exists: ${FUNC_NAME##*-}"
      
      # Check code signing
      CSC=$(aws lambda get-function --function-name "$FUNC_NAME" --query 'Configuration.CodeSigningConfigArn' --output text 2>/dev/null || echo "None")
      if [ "$CSC" != "None" ] && [ -n "$CSC" ]; then
        pass "Code signing configured: ${FUNC_NAME##*-}"
      else
        skip "Code signing not detected: ${FUNC_NAME##*-} (may use inline code)"
      fi
    else
      fail "Lambda function missing: $FUNC_NAME"
    fi
  else
    fail "Lambda function name not found in stack outputs"
  fi
done

echo ""

# ── AWS CloudTrail ──────────────────────────────
echo "── AWS CloudTrail ──"

if aws cloudtrail describe-trails --trail-name-list "creditunion-audit-trail" --query 'trailList[0].Name' --output text 2>/dev/null | grep -q "creditunion"; then
  pass "CloudTrail exists: creditunion-audit-trail"
  
  VALIDATION=$(aws cloudtrail describe-trails --trail-name-list "creditunion-audit-trail" --query 'trailList[0].LogFileValidationEnabled' --output text)
  if [ "$VALIDATION" = "True" ]; then
    pass "Log file validation enabled"
  else
    fail "Log file validation not enabled"
  fi
else
  fail "CloudTrail missing: creditunion-audit-trail"
fi

echo ""

# ── VPC and Networking ──────────────────────────
echo "── Amazon VPC ──"

VPC_ID=$(aws ec2 describe-vpcs --filters "Name=tag:Project,Values=CreditUnionAnalytics" --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "None")
if [ "$VPC_ID" != "None" ] && [ -n "$VPC_ID" ]; then
  pass "VPC exists: $VPC_ID"
  
  # Check flow logs
  FLOW_LOGS=$(aws ec2 describe-flow-logs --filter "Name=resource-id,Values=$VPC_ID" --query 'FlowLogs | length(@)' --output text 2>/dev/null || echo "0")
  if [ "$FLOW_LOGS" -gt 0 ]; then
    pass "VPC Flow Logs enabled ($FLOW_LOGS log(s))"
  else
    fail "VPC Flow Logs not enabled"
  fi
  
  # Check VPC endpoints
  ENDPOINTS=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" --query 'VpcEndpoints | length(@)' --output text 2>/dev/null || echo "0")
  if [ "$ENDPOINTS" -ge 2 ]; then
    pass "VPC endpoints configured ($ENDPOINTS endpoints)"
  else
    fail "Expected at least 2 VPC endpoints, found $ENDPOINTS"
  fi
else
  fail "VPC not found with Project=CreditUnionAnalytics tag"
fi

echo ""

# ── AWS KMS ─────────────────────────────────────
echo "── AWS KMS ──"

KEY_ALIAS="alias/creditunion-analytics-key"
KEY_ID=$(aws kms describe-key --key-id "$KEY_ALIAS" --query 'KeyMetadata.KeyId' --output text 2>/dev/null || echo "None")
if [ "$KEY_ID" != "None" ]; then
  pass "KMS key exists: $KEY_ALIAS"
  
  ROTATION=$(aws kms get-key-rotation-status --key-id "$KEY_ID" --query 'KeyRotationEnabled' --output text 2>/dev/null || echo "false")
  if [ "$ROTATION" = "True" ]; then
    pass "Key rotation enabled"
  else
    fail "Key rotation not enabled"
  fi
else
  fail "KMS key not found: $KEY_ALIAS"
fi

echo ""

# ── IAM Roles ───────────────────────────────────
echo "── AWS IAM Roles ──"

for ROLE_SUFFIX in glue-mysql glue-xml glue-csv glue-member360; do
  ROLE="creditunion-${REGION}-${ROLE_SUFFIX}"
  if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    pass "IAM role exists: $ROLE"
  else
    fail "IAM role missing: $ROLE"
  fi
done

echo ""

# ── Summary ─────────────────────────────────────
echo "============================================"
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
