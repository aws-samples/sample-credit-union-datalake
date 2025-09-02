import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from awsgluedq.transforms import EvaluateDataQuality
from awsglue.dynamicframe import DynamicFrame
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

# Default ruleset used by all target nodes with data quality enabled
DEFAULT_DATA_QUALITY_RULESET = """
    Rules = [
        ColumnCount > 0
    ]
"""

# Script generated for node DigitalBanking
DigitalBanking_node1754779442123 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_cleanse", table_name="digital_banking", transformation_ctx="DigitalBanking_node1754779442123")

# Script generated for node LoanSystem
LoanSystem_node1754779442776 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_cleanse", table_name="loan_system_members", transformation_ctx="LoanSystem_node1754779442776")

# Script generated for node CreditCards
CreditCards_node1754848800707 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_xml_catalog", table_name="creditcards_cleansed", transformation_ctx="CreditCards_node1754848800707")

# Script generated for node CoreBanking
CoreBanking_node1754779434111 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_cleanse", table_name="core_banking_members", transformation_ctx="CoreBanking_node1754779434111")

# Script generated for node CRM
CRM_node1754779443320 = glueContext.create_dynamic_frame.from_catalog(database="creditunion_xml_catalog", table_name="crm_cleansed", transformation_ctx="CRM_node1754779443320")

# Script generated for node transform_2_loan_aggregation
SqlQuery31 = '''
SELECT DISTINCT
    ssn_last_4,
    UPPER(TRIM(borrower_name)) as full_name_key,
    phone_number,
    1 as total_loans,  -- Hard-code to 1 since it's always 1 loan per person
    CAST(REGEXP_REPLACE(loan_amount, '[^0-9.]', '') as DOUBLE) as total_loan_amount,  -- Remove SUM
    CAST(interest_rate as DOUBLE) as interest_rate,  -- Remove AVG

    -- Additional Loan Details
    loan_type,
    term_months,
    application_date

FROM LoanSystem
-- Remove GROUP BY since we're not aggregating anymore
'''
transform_2_loan_aggregation_node1754846939747 = sparkSqlQuery(glueContext, query = SqlQuery31, mapping = {"LoanSystem":LoanSystem_node1754779442776}, transformation_ctx = "transform_2_loan_aggregation_node1754846939747")

# Script generated for node transform_1_core_digital
SqlQuery32 = '''
SELECT DISTINCT
    -- Core Banking Fields
    CONCAT('CU_', CoreBanking.ssn) as golden_member_id,
    CoreBanking.member_number,
    UPPER(TRIM(CoreBanking.first_name)) as first_name,
    UPPER(TRIM(CoreBanking.last_name)) as last_name,
    CoreBanking.dob as date_of_birth,
    CoreBanking.address,
    CoreBanking.city,
    CoreBanking.state,
    CoreBanking.zip,
    CoreBanking.phone,
    CoreBanking.join_date as member_since,
    CoreBanking.checking_balance,
    CoreBanking.savings_balance,
    (CoreBanking.checking_balance + CoreBanking.savings_balance) as total_balance,

    -- Digital Banking Fields
    DigitalBanking.digital_user_id,
    DigitalBanking.username,
    DigitalBanking.email_address as email,
    DigitalBanking.last_login,
    DigitalBanking.mobile_app_user,
    DigitalBanking.online_banking_user,
    DigitalBanking.bill_pay_enrolled,
    DigitalBanking.account_alerts,

    -- Digital Engagement Score
    COALESCE(CAST(DigitalBanking.mobile_app_user AS INT), 0) +
    COALESCE(CAST(DigitalBanking.online_banking_user AS INT), 0) +
    COALESCE(CAST(DigitalBanking.bill_pay_enrolled AS INT), 0) +
    COALESCE(CAST(DigitalBanking.account_alerts AS INT), 0) as digital_engagement_score,

    -- Join Keys
    RIGHT(CoreBanking.ssn, 4) as ssn_last_4_key,
    UPPER(TRIM(CoreBanking.first_name || ' ' || CoreBanking.last_name)) as full_name_key,

    -- Metadata
    'CORE_BANKING' as primary_source,
    CASE WHEN DigitalBanking.digital_user_id IS NOT NULL THEN 95 ELSE 100 END as match_confidence,
    'SSN_EXACT' as resolution_method,
    current_timestamp() as created_date

FROM CoreBanking
LEFT JOIN DigitalBanking
    ON CoreBanking.phone = DigitalBanking.phone
    OR UPPER(TRIM(CoreBanking.first_name || ' ' || CoreBanking.last_name)) = UPPER(TRIM(DigitalBanking.full_name))
'''
transform_1_core_digital_node1754779940152 = sparkSqlQuery(glueContext, query = SqlQuery32, mapping = {"CoreBanking":CoreBanking_node1754779434111, "DigitalBanking":DigitalBanking_node1754779442123}, transformation_ctx = "transform_1_core_digital_node1754779940152")

# Script generated for node join_member_loans
transform_1_core_digital_node1754779940152DF = transform_1_core_digital_node1754779940152.toDF()
transform_2_loan_aggregation_node1754846939747DF = transform_2_loan_aggregation_node1754846939747.toDF()
join_member_loans_node1754847038817 = DynamicFrame.fromDF(transform_1_core_digital_node1754779940152DF.join(transform_2_loan_aggregation_node1754846939747DF, (transform_1_core_digital_node1754779940152DF['ssn_last_4_key'] == transform_2_loan_aggregation_node1754846939747DF['ssn_last_4']) & (transform_1_core_digital_node1754779940152DF['full_name_key'] == transform_2_loan_aggregation_node1754846939747DF['full_name_key']), "left"), glueContext, "join_member_loans_node1754847038817")

# Script generated for node transform_4_add_crm
SqlQuery33 = '''
WITH ranked_crm AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY UPPER(TRIM(contact_name))
            ORDER BY
                CASE WHEN last_contact IS NOT NULL THEN last_contact END DESC,
                year DESC, month DESC, day DESC, hour DESC,
                crm_id DESC
        ) as rn
    FROM CRM
)
SELECT
    join_member_loans.*,
    -- CRM Fields (most recent record)
    ranked_crm.contact_email as crm_email,
    ranked_crm.last_contact as last_contact_date,
    ranked_crm.preferred_channel,
    ranked_crm.marketing_consent

FROM join_member_loans
LEFT JOIN ranked_crm
    ON join_member_loans.phone = ranked_crm.contact_phone
    OR join_member_loans.full_name_key = UPPER(TRIM(ranked_crm.contact_name))
WHERE ranked_crm.rn = 1 OR ranked_crm.rn IS NULL
'''
transform_4_add_crm_node1754847800228 = sparkSqlQuery(glueContext, query = SqlQuery33, mapping = {"join_member_loans":join_member_loans_node1754847038817, "CRM":CRM_node1754779443320}, transformation_ctx = "transform_4_add_crm_node1754847800228")

# Script generated for node transform_5_add_cards
SqlQuery34 = '''
SELECT DISTINCT
    transform_4_add_crm.*,

    -- Credit Card Fields
    CreditCards.card_limit as card_limit_amount,
    CreditCards.card_type,

    -- Final Calculations
    1 + -- Core banking (always present)
    CASE WHEN transform_4_add_crm.digital_user_id IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN transform_4_add_crm.total_loans > 0 THEN 1 ELSE 0 END +
    CASE WHEN CreditCards.card_limit IS NOT NULL THEN 1 ELSE 0 END as product_count,

    -- Risk Category
    CASE
        WHEN transform_4_add_crm.total_loan_amount = 0 OR transform_4_add_crm.total_balance = 0 THEN 'LOW'
        WHEN (transform_4_add_crm.total_loan_amount / transform_4_add_crm.total_balance) < 2.0 THEN 'LOW'
        WHEN (transform_4_add_crm.total_loan_amount / transform_4_add_crm.total_balance) BETWEEN 2.0 AND 5.0 THEN 'MEDIUM'
        ELSE 'HIGH'
    END as risk_category,

    -- Data Quality Score
    transform_4_add_crm.match_confidence as data_quality_score,

    -- Dynamic Partitions (Padded strings for consistency)
    CAST(YEAR(current_date()) AS STRING) as year,
    LPAD(CAST(MONTH(current_date()) AS STRING), 2, '0') as month,
    LPAD(CAST(DAY(current_date()) AS STRING), 2, '0') as day,
    LPAD(CAST(HOUR(current_timestamp()) AS STRING), 2, '0') as hour

FROM transform_4_add_crm
LEFT JOIN CreditCards
    ON CONCAT(LEFT(transform_4_add_crm.first_name, 1), ' ', transform_4_add_crm.last_name) = UPPER(TRIM(CreditCards.account_holder))
'''
transform_5_add_cards_node1754848422441 = sparkSqlQuery(glueContext, query = SqlQuery34, mapping = {"transform_4_add_crm":transform_4_add_crm_node1754847800228, "CreditCards":CreditCards_node1754848800707}, transformation_ctx = "transform_5_add_cards_node1754848422441")

# Script generated for node Add Current Timestamp
AddCurrentTimestamp_node1756230876786 = sparkSqlQuery(glueContext, query = "SELECT *, date_format(current_timestamp(), 'yyyy-MM-dd-HH-mm') as RunID FROM myDataSource", mapping = {"myDataSource":transform_5_add_cards_node1754848422441}, transformation_ctx = "AddCurrentTimestamp_node1756230876786")

# Script generated for node Member_Profile_Output
EvaluateDataQuality().process_rows(frame=AddCurrentTimestamp_node1756230876786, ruleset=DEFAULT_DATA_QUALITY_RULESET, publishing_options={"dataQualityEvaluationContext": "EvaluateDataQuality_node1754779415822", "enableDataQualityResultsPublishing": True}, additional_options={"dataQualityResultsPublishing.strategy": "BEST_EFFORT", "observations.scope": "ALL"})
Member_Profile_Output_node1754780166976 = glueContext.getSink(path="s3://creditunion-546549546983-us-west-2-consume/CreditUnionData/member_profile/", connection_type="s3", updateBehavior="UPDATE_IN_DATABASE", partitionKeys=["year", "month", "day", "hour"], enableUpdateCatalog=True, transformation_ctx="Member_Profile_Output_node1754780166976")
Member_Profile_Output_node1754780166976.setCatalogInfo(catalogDatabase="creditunion_consume",catalogTableName="member_profile")
Member_Profile_Output_node1754780166976.setFormat("glueparquet", compression="snappy")
Member_Profile_Output_node1754780166976.writeFrame(AddCurrentTimestamp_node1756230876786)
job.commit()