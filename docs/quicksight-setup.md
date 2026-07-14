<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Visualizing the data lake with Amazon QuickSight

Amazon QuickSight is **not** deployed by this project. This guide describes how to connect QuickSight (Enterprise edition) to the `creditunion_consume.member_profile` table through Amazon Athena, when the consume zone is governed by AWS Lake Formation.

> Replace `<ACCOUNT>` and `<REGION>` with your values. Examples use `us-east-1`.

## Why this needs care

The consume data is protected two ways:

1. The S3 bucket policy **denies direct `s3:GetObject`** to anyone outside the pipeline roles, so nothing reads the raw Parquet directly.
2. The `member_profile` table is governed by **AWS Lake Formation**. All reads go through Lake Formation credential vending (via the registration role), not through the caller's own S3 access.

Because of this, granting IAM permissions alone is not enough. The critical, easy-to-miss detail is at the end: **Lake Formation evaluates the QuickSight *user/group* identity, not the QuickSight IAM service role.**

## Prerequisites

- QuickSight **Enterprise edition** in the same Region as the data lake.
- You can already query `creditunion_consume.member_profile` in the Athena console as an authorized principal. Verify this first — if Athena itself does not work, fix that before touching QuickSight.

## Step 1 — Enable QuickSight access to Athena and S3

In QuickSight: **Manage QuickSight → Security & permissions → QuickSight access to AWS services → Manage**:

- Enable **Amazon Athena**.
- Under **Amazon S3**, select your **Athena query-results bucket** with write access (for example `aws-athena-query-results-<ACCOUNT>-<REGION>`).
- You do **not** need to select the consume data bucket — Lake Formation vends that access.

## Step 2 — Give the QuickSight service role the Lake Formation data-access IAM action

The service role (path `/service-role/`) needs `lakeformation:GetDataAccess` plus Glue catalog reads. `AWSQuicksightAthenaAccess` alone may not include `GetDataAccess`, so add an inline policy:

```bash
aws iam put-role-policy \
  --role-name aws-quicksight-service-role-v0 \
  --policy-name QuickSightLakeFormationAccess \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["lakeformation:GetDataAccess","glue:GetTable","glue:GetTables","glue:GetDatabase","glue:GetDatabases","glue:GetPartition","glue:GetPartitions"],"Resource":"*"}]}'
```

## Step 3 — Grant Lake Formation permissions to the QuickSight USER/GROUP (the key step)

Lake Formation evaluates the QuickSight author identity at query time, so the grant must target the QuickSight **user (or group) ARN**, not the IAM service role.

Find the QuickSight user ARN:

```bash
aws quicksight list-users \
  --aws-account-id <ACCOUNT> \
  --namespace default \
  --region <REGION> \
  --query 'UserList[].{Name:UserName,Arn:Arn,Role:Role}' \
  --output table
```

Grant database `DESCRIBE` and table `SELECT`/`DESCRIBE` to that QuickSight user ARN:

```bash
aws lakeformation grant-permissions \
  --region <REGION> \
  --principal DataLakePrincipalIdentifier=arn:aws:quicksight:<REGION>:<ACCOUNT>:user/default/<QUICKSIGHT_USER> \
  --resource '{"Database":{"Name":"creditunion_consume"}}' \
  --permissions DESCRIBE

aws lakeformation grant-permissions \
  --region <REGION> \
  --principal DataLakePrincipalIdentifier=arn:aws:quicksight:<REGION>:<ACCOUNT>:user/default/<QUICKSIGHT_USER> \
  --resource '{"Table":{"DatabaseName":"creditunion_consume","Name":"member_profile"}}' \
  --permissions SELECT DESCRIBE
```

To hide the tokenized SSN columns from QuickSight, grant table `DESCRIBE` (for resolution) plus a column-excluded `SELECT` instead of a plain table `SELECT`:

```bash
--resource '{"TableWithColumns":{"DatabaseName":"creditunion_consume","Name":"member_profile","ColumnWildcard":{"ExcludedColumnNames":["ssn_last_4","ssn_last_4_key"]}}}' --permissions SELECT
```

Note: Lake Formation will not let you hold both a plain-table `SELECT` and a column-excluded `SELECT` for the same principal on the same table — pick one shape.

## Step 4 — Create the dataset

In QuickSight: **Datasets → New dataset → Athena** → create a data source → choose database `creditunion_consume` → table `member_profile`. Prefer **Directly query your data** for sensitive data (SPICE caches the rows). Then build your analysis.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `TABLE_NOT_FOUND` for `member_profile` | Lake Formation hides tables the principal can't access; the **QuickSight user** identity has no LF grant | Step 3 — grant the QuickSight user/group ARN, not just the service role |
| "No tables found" in the picker for `creditunion_consume` | Missing database-level `DESCRIBE`, or QuickSight cached the catalog | Grant DB `DESCRIBE` to the QuickSight user; recreate the data source to refresh the cache |
| `s3:GetObject ... explicit deny` | Query used the caller's IAM identity instead of Lake Formation vending | Ensure `lakeformation:GetDataAccess` is on the service role (Step 2) and the LF grant is on the QuickSight user (Step 3) |
| Table visible but query returns nothing / KMS error | Service role can't decrypt via the vending path | Confirm the Lake Formation registration role has KMS access (it does by default in this project) |

### Confirming the vend

After a successful query, you can confirm QuickSight used Lake Formation credential vending:

```bash
aws cloudtrail lookup-events --region <REGION> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetDataAccess \
  --max-results 15
```

You should see `GetDataAccess` calls originating from the QuickSight query (source `quicksight.amazonaws.com`). If only non-QuickSight principals appear, the QuickSight user grant from Step 3 is missing.
