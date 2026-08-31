#!/usr/bin/env bash
set -euo pipefail

required=(AZURE_RESOURCE_GROUP AZURE_LOCATION AZURE_WEBAPP_NAME PUBLIC_BASE_URL CORS_ORIGIN PASSWORD_RESET_URL_BASE EMAIL_SENDER_ADDRESS DATABASE_URL ACS_EMAIL_CONNECTION_STRING)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
done

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --output none

DEPLOYMENT_NAME="fifoo-step6-production"

az deployment group create \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file "$(dirname "$0")/../infra/azure/main.bicep" \
  --parameters \
    appName="$AZURE_WEBAPP_NAME" \
    location="$AZURE_LOCATION" \
    publicBaseUrl="$PUBLIC_BASE_URL" \
    corsOrigin="$CORS_ORIGIN" \
    passwordResetUrlBase="$PASSWORD_RESET_URL_BASE" \
    emailSenderAddress="$EMAIL_SENDER_ADDRESS" \
    emailReplyToAddress="${EMAIL_REPLY_TO_ADDRESS:-}" \
    databaseUrl="$DATABASE_URL" \
    azureCommunicationEmailConnectionString="$ACS_EMAIL_CONNECTION_STRING"

echo
az deployment group show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$DEPLOYMENT_NAME" \
  --query properties.outputs \
  --output jsonc 2>/dev/null || true

echo "Infrastructure deployment submitted. Configure custom-domain DNS/TLS and GitHub OIDC before the first code deployment."
