# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from awsgluedq.transforms import EvaluateDataQuality
from awsglue import DynamicFrame

def sparkSqlQuery(glueContext, query, mapping, transformation_ctx) -> DynamicFrame:
    for alias, frame in mapping.items():
        frame.toDF().createOrReplaceTempView(alias)
    result = spark.sql(query)
    return DynamicFrame.fromDF(result, glueContext, transformation_ctx)
args = getResolvedOptions(sys.argv, ['JOB_NAME'])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# Resolve bucket names dynamically (no hardcoded account IDs)
import boto3
sts = boto3.client('sts')
ACCOUNT_ID = sts.get_caller_identity()['Account']
REGION = boto3.session.Session().region_name
CLEANSE_BUCKET = f"creditunion-{ACCOUNT_ID}-{REGION}-cleanse"

# Default ruleset used by all target nodes with data quality enabled
DEFAULT_DATA_QUALITY_RULESET = """
    Rules = [
        ColumnCount > 0
    ]
"""

# Script generated for node CreditCards_Source
CreditCards_Source_node1754763803031 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_xml_catalog", table_name="creditcards", transformation_ctx="CreditCards_Source_node1754763803031")

# Script generated for node CRM_Source
CRM_Source_node1754763849815 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_xml_catalog", table_name="crmsystem", transformation_ctx="CRM_Source_node1754763849815")

# Script generated for node Change Schema
ChangeSchema_node1754794112819 = ApplyMapping.apply(frame=CreditCards_Source_node1754763803031, mappings=[("account_holder", "string", "account_holder", "string"), ("billing_address.address_line_1", "string", "billing_address.address_line_1", "string"), ("billing_address.city", "string", "billing_address.city", "string"), ("billing_address.state", "string", "billing_address.state", "string"), ("billing_address.zip", "int", "billing_address.zip", "int"), ("card_details.card_limit", "int", "card_details.card_limit", "int"), ("card_details.card_type", "string", "card_details.card_type", "string"), ("card_details.issue_date", "string", "card_details.issue_date", "string"), ("card_member_id", "string", "card_member_id", "string"), ("contact_phone", "string", "contact_phone", "string"), ("ssn_encrypted", "string", "ssn_encrypted", "string")], transformation_ctx="ChangeSchema_node1754794112819")

# Script generated for node CRM_Flatten_SQL_Transform
SqlQuery1769 = '''
SELECT
    crm_id,
    contact_info.name as contact_name,
    contact_info.phone as contact_phone,
    contact_info.email as contact_email,
    contact_info.address as contact_address,
    interactions.last_contact as last_contact,
    interactions.preferred_channel as preferred_channel,
    interactions.marketing_consent as marketing_consent
FROM myDataSource
'''
CRM_Flatten_SQL_Transform_node1754765706509 = sparkSqlQuery(glueContext, query = SqlQuery1769, mapping = {"myDataSource":CRM_Source_node1754763849815}, transformation_ctx = "CRM_Flatten_SQL_Transform_node1754765706509")

# Script generated for node CreditCards_Flatten_SQL_Transform
SqlQuery1770 = '''
SELECT
    account_holder,
    card_member_id,
    ssn_encrypted,
    contact_phone,
    billing_address.address_line_1 as address_line_1,
    billing_address.city as city,
    billing_address.state as state,
    billing_address.zip as zip,
    card_details.card_limit as card_limit,
    card_details.card_type as card_type,
    card_details.issue_date as issue_date
FROM myDataSource
'''
CreditCards_Flatten_SQL_Transform_node1754765605203 = sparkSqlQuery(glueContext, query = SqlQuery1770, mapping = {"myDataSource":ChangeSchema_node1754794112819}, transformation_ctx = "CreditCards_Flatten_SQL_Transform_node1754765605203")

# Script generated for node CRM_Partition_SQL_Transform
SqlQuery1771 = '''
SELECT *,
  year(current_timestamp()) as year,
  LPAD(month(current_timestamp()), 2, '0') as month,
  LPAD(day(current_timestamp()), 2, '0') as day,
  LPAD(hour(current_timestamp()), 2, '0') as hour
FROM myDataSource
'''
CRM_Partition_SQL_Transform_node1754772496076 = sparkSqlQuery(glueContext, query = SqlQuery1771, mapping = {"myDataSource":CRM_Flatten_SQL_Transform_node1754765706509}, transformation_ctx = "CRM_Partition_SQL_Transform_node1754772496076")

# Script generated for node CreditCards_Partition_SQL_Transform
SqlQuery1772 = '''
SELECT *,
  year(current_timestamp()) as year,
  LPAD(month(current_timestamp()), 2, '0') as month,
  LPAD(day(current_timestamp()), 2, '0') as day,
  LPAD(hour(current_timestamp()), 2, '0') as hour
FROM myDataSource
'''
CreditCards_Partition_SQL_Transform_node1754772383126 = sparkSqlQuery(glueContext, query = SqlQuery1772, mapping = {"myDataSource":CreditCards_Flatten_SQL_Transform_node1754765605203}, transformation_ctx = "CreditCards_Partition_SQL_Transform_node1754772383126")

# Script generated for node CRM_Target
EvaluateDataQuality().process_rows(frame=CRM_Partition_SQL_Transform_node1754772496076, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754763739180", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
CRM_Target_node1754764005574 = glueContext.getSink(path=f"s3://{CLEANSE_BUCKET}/CreditUnionData/CRM/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="CRM_Target_node1754764005574")
CRM_Target_node1754764005574.setCatalogInfo(catalogDatabase="creditunion_xml_catalog",catalogTableName="crm_cleansed")
CRM_Target_node1754764005574.setFormat("glueparquet", compression="snappy")
CRM_Target_node1754764005574.writeFrame(CRM_Partition_SQL_Transform_node1754772496076)
# Script generated for node CreditCards_Target
EvaluateDataQuality().process_rows(frame=CreditCards_Partition_SQL_Transform_node1754772383126, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754763739180", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
CreditCards_Target_node1754763914996 = glueContext.getSink(path=f"s3://{CLEANSE_BUCKET}/CreditUnionData/CreditCards/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="CreditCards_Target_node1754763914996")
CreditCards_Target_node1754763914996.setCatalogInfo(catalogDatabase="creditunion_xml_catalog",catalogTableName="creditcards_cleansed")
CreditCards_Target_node1754763914996.setFormat("glueparquet", compression="snappy")
CreditCards_Target_node1754763914996.writeFrame(CreditCards_Partition_SQL_Transform_node1754772383126)
job.commit()
