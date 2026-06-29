# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Amazon RDS data-loader handler. Externalized from an inline Lambda definition
# (lib/rds-data-loader.ts) so the deployment package can be signed by AWS Signer
# under a code-signing config set to ENFORCE (Requirement R5).
import json
import boto3
from botocore.config import Config
import pymysql
import csv
from io import StringIO
import os

def lambda_handler(event, context):
    try:
        secrets_client = boto3.client('secretsmanager')
        secret_response = secrets_client.get_secret_value(SecretId=os.environ['SECRET_ARN'])
        secret = json.loads(secret_response['SecretString'])
        
        # Configure S3 client to use path-style URLs for VPC endpoint compatibility
        s3_config = Config(
            s3={'addressing_style': 'path'}
        )
        s3_client = boto3.client('s3', config=s3_config)
        
        csv_response = s3_client.get_object(
            Bucket=os.environ['BUCKET_NAME'],
            Key='CreditUnionData/CoreBanking_RDS_LoadOnly/core_banking_members.csv'
        )
        csv_content = csv_response['Body'].read().decode('utf-8')
        
        connection = pymysql.connect(
            host=secret['host'],
            user=secret['username'],
            password=secret['password'],
            database=secret['dbname'],
            port=secret['port'],
            ssl={'ca': '/etc/pki/tls/certs/ca-bundle.crt'}
        )
        
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS core_banking_members")
            cursor.execute("CREATE TABLE core_banking_members (member_number VARCHAR(20) PRIMARY KEY, ssn VARCHAR(11), first_name VARCHAR(50), last_name VARCHAR(50), dob DATE, address VARCHAR(200), city VARCHAR(50), state VARCHAR(2), zip VARCHAR(10), phone VARCHAR(20), join_date DATE, checking_balance DECIMAL(10,2), savings_balance DECIMAL(10,2))")
            
            # Use INSERT IGNORE to skip duplicates — validate fields before insertion
            csv_reader = csv.DictReader(StringIO(csv_content))
            expected_fields = {'member_number','ssn','first_name','last_name','dob','address','city','state','zip','phone','join_date','checking_balance','savings_balance'}
            for row in csv_reader:
                if not expected_fields.issubset(row.keys()):
                    continue  # skip rows with unexpected schema
                values = tuple(str(v)[:200] for v in row.values())  # truncate to prevent overflow
                if len(values) != 13:
                    continue  # skip malformed rows
                cursor.execute("INSERT IGNORE INTO core_banking_members VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", values)
            
            connection.commit()
            cursor.execute("SELECT COUNT(*) FROM core_banking_members")
            count = cursor.fetchone()[0]
        
        connection.close()
        return f'Successfully loaded {count} unique records'
        
    except Exception as e:
        error_type = type(e).__name__
        raise Exception(f'RDS data loading failed: {error_type} - check CloudWatch logs for details')
