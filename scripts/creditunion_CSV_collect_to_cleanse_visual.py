# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
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

# Resolve bucket names from job arguments (set by CDK, no hardcoded account IDs)
import boto3
sts = boto3.client('sts')
ACCOUNT_ID = sts.get_caller_identity()['Account']
REGION = boto3.session.Session().region_name
COLLECT_BUCKET = f"creditunion-{ACCOUNT_ID}-{REGION}-collect"
CLEANSE_BUCKET = f"creditunion-{ACCOUNT_ID}-{REGION}-cleanse"

# Default ruleset used by all target nodes with data quality enabled
DEFAULT_DATA_QUALITY_RULESET = """
    Rules = [
        ColumnCount > 0
    ]
"""

# Script generated for node DigitalBanking_Source
DigitalBanking_Source_node1754766108114 = glueContext.create_dynamic_frame.from_options(format_options={"quoteChar": "\"", "withHeader": True, "separator": ",", "optimizePerformance": False}, connection_type="s3", format="csv", connection_options={"paths": [f"s3://{COLLECT_BUCKET}/CreditUnionData/DigitalBanking/"], "recurse": True}, transformation_ctx="DigitalBanking_Source_node1754766108114")
LoanSystem_Source_node1754766055921 = glueContext.create_dynamic_frame.from_options(format_options={"quoteChar": "\"", "withHeader": True, "separator": ",", "optimizePerformance": False}, connection_type="s3", format="csv", connection_options={"paths": [f"s3://{COLLECT_BUCKET}/CreditUnionData/LoanSystem/"], "recurse": True}, transformation_ctx="LoanSystem_Source_node1754766055921")

# Script generated for node DigitalBanking_Partitions
SqlQuery1667 = '''
SELECT *,
  CAST(year(current_timestamp()) AS STRING) as year,
  LPAD(CAST(month(current_timestamp()) AS STRING), 2, '0') as month,
  LPAD(CAST(day(current_timestamp()) AS STRING), 2, '0') as day,
  LPAD(CAST(hour(current_timestamp()) AS STRING), 2, '0') as hour
FROM myDataSource

'''
DigitalBanking_Partitions_node1754782339019 = sparkSqlQuery(glueContext, query = SqlQuery1667, mapping = {"myDataSource":DigitalBanking_Source_node1754766108114}, transformation_ctx = "DigitalBanking_Partitions_node1754782339019")

# Script generated for node LoanSystem_Partition
SqlQuery1666 = '''
SELECT *,
  CAST(year(current_timestamp()) AS STRING) as year,
  LPAD(CAST(month(current_timestamp()) AS STRING), 2, '0') as month,
  LPAD(CAST(day(current_timestamp()) AS STRING), 2, '0') as day,
  LPAD(CAST(hour(current_timestamp()) AS STRING), 2, '0') as hour
FROM myDataSource

'''
LoanSystem_Partition_node1754782420873 = sparkSqlQuery(glueContext, query = SqlQuery1666, mapping = {"myDataSource":LoanSystem_Source_node1754766055921}, transformation_ctx = "LoanSystem_Partition_node1754782420873")

# Script generated for node DigitalBanking_Cleansed
EvaluateDataQuality().process_rows(frame=DigitalBanking_Partitions_node1754782339019, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754763739180", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
DigitalBanking_Cleansed_node1754766252601 = glueContext.getSink(path=f"s3://{CLEANSE_BUCKET}/CreditUnionData/DigitalBanking/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="DigitalBanking_Cleansed_node1754766252601")
DigitalBanking_Cleansed_node1754766252601.setCatalogInfo(catalogDatabase="creditunion_cleanse",catalogTableName="digital_banking")
DigitalBanking_Cleansed_node1754766252601.setFormat("glueparquet", compression="snappy")
DigitalBanking_Cleansed_node1754766252601.writeFrame(DigitalBanking_Partitions_node1754782339019)
# Script generated for node LoanSystem_Cleansed
EvaluateDataQuality().process_rows(frame=LoanSystem_Partition_node1754782420873, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754763739180", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
LoanSystem_Cleansed_node1754766373651 = glueContext.getSink(path=f"s3://{CLEANSE_BUCKET}/CreditUnionData/LoanSystem/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="LoanSystem_Cleansed_node1754766373651")
LoanSystem_Cleansed_node1754766373651.setCatalogInfo(catalogDatabase="creditunion_cleanse",catalogTableName="loan_system_members")
LoanSystem_Cleansed_node1754766373651.setFormat("glueparquet", compression="snappy")
LoanSystem_Cleansed_node1754766373651.writeFrame(LoanSystem_Partition_node1754782420873)
job.commit()
