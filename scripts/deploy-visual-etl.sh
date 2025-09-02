#!/bin/bash

# Deploy Visual ETL Jobs using AWS CLI
# This script processes Visual ETL configurations and deploys them with CodeGenConfigurationNodes

set -e

REGION="us-west-2"
CONFIG_DIR="./configs"
ROLE_ARN=""
CONNECTION_NAME=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --region)
            REGION="$2"
            shift 2
            ;;
        --role-arn)
            ROLE_ARN="$2"
            shift 2
            ;;
        --connection-name)
            CONNECTION_NAME="$2"
            shift 2
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

if [ -z "$ROLE_ARN" ] || [ -z "$CONNECTION_NAME" ]; then
    echo "Usage: $0 --role-arn <role-arn> --connection-name <connection-name> [--region <region>]"
    exit 1
fi

echo "Deploying Visual ETL jobs to region: $REGION"

# Process each Visual ETL configuration
for config_file in "$CONFIG_DIR"/*-etl-config.json; do
    if [ -f "$config_file" ]; then
        echo "Processing: $config_file"
        
        # Extract job configuration
        job_name=$(jq -r '.Job.Name' "$config_file")
        
        # Update role and connection references
        temp_file=$(mktemp)
        jq --arg role_arn "$ROLE_ARN" \
           --arg conn_name "$CONNECTION_NAME" \
           '.Job.Role = $role_arn | 
            .Job.Connections.Connections = [$conn_name] |
            .Job.DefaultArguments."--TempDir" = "s3://aws-glue-assets-'$(aws sts get-caller-identity --query Account --output text)'-'$REGION'/temporary/" |
            .Job.DefaultArguments."--spark-event-logs-path" = "s3://aws-glue-assets-'$(aws sts get-caller-identity --query Account --output text)'-'$REGION'/sparkHistoryLogs/" |
            .Job.Command.ScriptLocation = "s3://aws-glue-assets-'$(aws sts get-caller-identity --query Account --output text)'-'$REGION'/scripts/'$job_name'.py"' \
           "$config_file" > "$temp_file"
        
        # Deploy using AWS CLI
        echo "Deploying job: $job_name"
        
        # Extract job parameters
        job_config=$(jq '.Job' "$temp_file")
        
        # Create or update the job
        if aws glue get-job --job-name "$job_name" --region "$REGION" >/dev/null 2>&1; then
            echo "Updating existing job: $job_name"
            echo "$job_config" | aws glue update-job \
                --job-name "$job_name" \
                --job-update file:///dev/stdin \
                --region "$REGION"
        else
            echo "Creating new job: $job_name"
            echo "$job_config" | aws glue create-job \
                --cli-input-json file:///dev/stdin \
                --region "$REGION"
        fi
        
        rm "$temp_file"
        echo "Successfully deployed: $job_name"
    fi
done

echo "Visual ETL deployment completed!"
