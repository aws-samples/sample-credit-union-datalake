# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Crawler-wait handler. Externalized from an inline Lambda definition
# (lib/creditunion-trigger-stack.ts) so the deployment package can be signed by
# AWS Signer under a code-signing config set to ENFORCE.
#
# The crawler names are static (no token interpolation needed), so the handler
# body is moved here verbatim.
import boto3
import time
import json

def handler(event, context):
    glue = boto3.client('glue')
    crawlers = ['creditunion-crm-xml-crawler', 'creditunion-creditcards-xml-crawler']

    print("Waiting for crawlers to complete...")
    max_wait = 600  # 10 minutes max
    wait_time = 0

    while wait_time < max_wait:
        all_complete = True

        for crawler_name in crawlers:
            try:
                response = glue.get_crawler(Name=crawler_name)
                state = response['Crawler']['State']
                print(f"Crawler {crawler_name} state: {state}")

                if state in ['RUNNING']:
                    all_complete = False
                    break
            except Exception as e:
                print(f"Error checking crawler {crawler_name}: {e}")
                all_complete = False
                break

        if all_complete:
            print("All crawlers completed!")
            return {
                'statusCode': 200,
                'body': json.dumps('All crawlers completed')
            }

        print("Crawlers still running, waiting 30 seconds...")
        time.sleep(30)
        wait_time += 30

    print("Timeout waiting for crawlers, proceeding anyway...")
    return {
        'statusCode': 200,
        'body': json.dumps('Timeout reached, proceeding')
    }
