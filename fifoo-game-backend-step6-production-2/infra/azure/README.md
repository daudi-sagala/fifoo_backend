# Azure production infrastructure

`main.bicep` creates the App Service-side production resources and accepts the two required deployment secrets (`DATABASE_URL` and Azure Communication Services email connection string) as secure parameters. It stores those values in Key Vault and gives the App Service managed identity read access through the Key Vault Secrets User RBAC role.

The template intentionally uses one App Service worker until the Socket.IO Redis adapter is added. See `docs/BACKEND_INTEGRATION_STEP6_PRODUCTION_DEPLOYMENT.md` before changing worker count.

PostgreSQL Flexible Server and Email Communication Services/domain verification are provisioned separately because their production region, networking, backup redundancy, database sizing and DNS choices should not be silently guessed by this app template.
