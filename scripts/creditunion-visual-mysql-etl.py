# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.dynamicframe import DynamicFrameCollection
from awsgluedq.transforms import EvaluateDataQuality
from awsglue.dynamicframe import DynamicFrame

# Script generated for node Custom Transform
def MyTransform(glueContext, dfc) -> DynamicFrameCollection:
    from pyspark.sql.functions import lit
    from datetime import datetime

    # Get current date
    today = datetime.now()
    current_year = str(today.year)
    current_month = str(today.month).zfill(2)  # Pad with zero (08 instead of 8)
    current_day = str(today.day).zfill(2)  # Pad with zero (09 instead of 9)
    current_hour = str(today.hour).zfill(2)

    # Get the first DynamicFrame from the collection
    df_key = list(dfc.keys())[0]
    input_df = dfc.select(df_key)

    # Convert to Spark DataFrame and add DYNAMIC partition values
    spark_df = input_df.toDF()
    spark_df = spark_df.withColumn("year", lit(current_year)) \
                       .withColumn("month", lit(current_month)) \
                       .withColumn("day", lit(current_day)) \
                       .withColumn("hour", lit(current_hour))

    # Convert back to DynamicFrame
    from awsglue.dynamicframe import DynamicFrame
    result_df = DynamicFrame.fromDF(spark_df, glueContext, "result")

    return DynamicFrameCollection({df_key: result_df}, glueContext)
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

# Script generated for node CoreBanking_RDS
CoreBanking_RDS_node1754716279403 = glueContext.create_dynamic_frame.from_options(
    connection_type = "mysql",
    connection_options = {
        "useConnectionProperties": "true",
        "dbtable": "core_banking_members",
        "connectionName": "creditunion-mysql-connection",
    },
    transformation_ctx = "CoreBanking_RDS_node1754716279403"
)

# Script generated for node Custom Transform
CustomTransform_node1754776785698 = MyTransform(glueContext, DynamicFrameCollection({"CoreBanking_RDS_node1754716279403": CoreBanking_RDS_node1754716279403}, glueContext))

# Script generated for node Select From Collection
SelectFromCollection_node1754777394760 = SelectFromCollection.apply(dfc=CustomTransform_node1754776785698, key=list(CustomTransform_node1754776785698.keys())[0], transformation_ctx="SelectFromCollection_node1754777394760")

# Script generated for node CoreBanking_Destination
EvaluateDataQuality().process_rows(frame=SelectFromCollection_node1754777394760, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754713359158", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
CoreBanking_Destination_node1754716355517 = glueContext.getSink(path=f"s3://{CLEANSE_BUCKET}/CreditUnionData/core_banking_members/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="CoreBanking_Destination_node1754716355517")
CoreBanking_Destination_node1754716355517.setCatalogInfo(catalogDatabase="creditunion_cleanse",catalogTableName="core_banking_members")
CoreBanking_Destination_node1754716355517.setFormat("glueparquet", compression="snappy")
CoreBanking_Destination_node1754716355517.writeFrame(SelectFromCollection_node1754777394760)
job.commit()
