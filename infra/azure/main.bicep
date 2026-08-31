targetScope = 'resourceGroup'

@description('Globally unique App Service name.')
param appName string

@description('Azure region for App Service, Key Vault, Log Analytics and Application Insights.')
param location string = resourceGroup().location

@description('Public HTTPS API base URL, normally https://api.fifoo.ai.')
param publicBaseUrl string

@description('Browser CORS allowlist, comma separated. Native mobile apps do not require an Origin value.')
param corsOrigin string

@description('Public HTTPS password reset page or Universal Link.')
param passwordResetUrlBase string

@description('Verified Azure Communication Services MailFrom address.')
param emailSenderAddress string

@description('Reply-to/support address.')
param emailReplyToAddress string = ''

@description('Azure Communication Services connection string. Stored only as a Key Vault secret by this deployment.')
@secure()
param azureCommunicationEmailConnectionString string

@description('Production PostgreSQL application connection string. Stored only as a Key Vault secret by this deployment.')
@secure()
param databaseUrl string

@description('App Service plan SKU. B1 is sufficient for the initial single-instance Fifoo production deployment.')
param appServiceSku string = 'B1'

@description('App Service plan worker count. Keep at 1 until the Socket.IO Redis adapter is enabled.')
@minValue(1)
@maxValue(1)
param workerCount int = 1

var safePrefix = toLower(replace(replace(appName, '-', ''), '_', ''))
var kvName = take('${safePrefix}${uniqueString(resourceGroup().id)}', 24)
var logName = '${appName}-logs'
var insightsName = '${appName}-insights'
var planName = '${appName}-plan'
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource databaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'fifoo-database-url'
  properties: {
    value: databaseUrl
  }
}

resource acsSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'fifoo-acs-email-connection-string'
  properties: {
    value: azureCommunicationEmailConnectionString
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: appServiceSku
    capacity: workerCount
  }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
      http20Enabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      healthCheckPath: '/ready'
      appCommandLine: 'npm start'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
        { name: 'TRUST_PROXY', value: 'true' }
        { name: 'REQUIRE_HTTPS', value: 'true' }
        { name: 'CORS_ORIGIN', value: corsOrigin }
        { name: 'AUTH_MODE', value: 'internal' }
        { name: 'ALLOW_DUMMY_AUTH', value: 'false' }
        { name: 'AUTH_EXPOSE_RESET_TOKEN', value: 'false' }
        { name: 'PASSWORD_RESET_URL_BASE', value: passwordResetUrlBase }
        { name: 'EMAIL_PROVIDER', value: 'azure-communication-services' }
        { name: 'EMAIL_SENDER_ADDRESS', value: emailSenderAddress }
        { name: 'EMAIL_REPLY_TO_ADDRESS', value: emailReplyToAddress }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${databaseSecret.name})' }
        { name: 'AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${acsSecret.name})' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'PGSSL', value: 'true' }
        { name: 'PGSSL_REJECT_UNAUTHORIZED', value: 'true' }
        { name: 'RATE_LIMIT_ENABLED', value: 'true' }
        { name: 'RUN_MIGRATIONS_ON_START', value: 'true' }
        { name: 'DAILY_PATH_SCHEDULER_ENABLED', value: 'true' }
        { name: 'DAILY_PATH_SCHEDULER_INTERVAL_MS', value: '300000' }
        { name: 'DAILY_PATH_SCHEDULER_STARTUP_DELAY_MS', value: '15000' }
        { name: 'LOG_LEVEL', value: 'info' }
        { name: 'LOG_APPLICATION_ACTIONS', value: 'false' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD', value: 'true' }
      ]
    }
  }
}

resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, app.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output appServiceName string = app.name
output defaultHostname string = app.properties.defaultHostName
output keyVaultName string = vault.name
output applicationInsightsName string = insights.name
output applicationInsightsConnectionString string = insights.properties.ConnectionString
output appManagedIdentityPrincipalId string = app.identity.principalId
