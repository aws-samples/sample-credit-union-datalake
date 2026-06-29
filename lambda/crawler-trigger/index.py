# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Crawler-trigger handler. Externalized from an inline Lambda definition
# (lib/creditunion-data-stack.ts) so the deployment package can be signed by
# AWS Signer under a code-signing config set to ENFORCE (Requirement R5).
#
# The crawler names were previously token-interpolated into the inline source;
# they are now passed in as environment variables (CREDIT_CARDS_CRAWLER,
# CRM_CRAWLER) so this asset file is static and signable.
import boto3
import json
import os

def handler(event, context):
    glue = boto3.client('glue')

    crawlers = [os.environ['CREDIT_CARDS_CRAWLER'], os.environ['CRM_CRAWLER']]

    for crawler_name in crawlers:
        try:
            glue.start_crawler(Name=crawler_name)
            print(f'Started crawler: {crawler_name}')
        except Exception as e:
            print(f'Error starting crawler {crawler_name}: {str(e)}')

    return {'statusCode': 200, 'body': json.dumps('Crawlers triggered')}
