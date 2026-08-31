import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRuntimeConfig } from '../src/lib/runtimeConfig.js';

function baseConfig(overrides = {}) {
  return {
    nodeEnv: 'development',
    publicBaseURL: 'http://localhost:3000',
    trustProxy: false,
    requireHTTPS: false,
    pgSSL: false,
    pgSSLRejectUnauthorized: false,
    authMode: 'development',
    allowDummyAuth: true,
    authVerifyURL: '',
    authExposeResetToken: true,
    passwordResetDeliveryURL: '',
    passwordResetURLBase: 'fifoo://reset-password',
    corsOrigins: ['*'],
    emailProvider: 'console',
    azureCommunicationEmailEndpoint: '',
    azureCommunicationEmailConnectionString: '',
    emailSenderAddress: '',
    applicationInsightsConnectionString: '',
    rateLimitEnabled: true,
    dailyPathSchedulerEnabled: false,
    logLevel: 'debug',
    ...overrides,
  };
}

function productionInternal(overrides = {}) {
  return baseConfig({
    nodeEnv: 'production',
    publicBaseURL: 'https://api.example.com',
    trustProxy: true,
    requireHTTPS: true,
    pgSSL: true,
    pgSSLRejectUnauthorized: true,
    authMode: 'internal',
    allowDummyAuth: false,
    authExposeResetToken: false,
    passwordResetURLBase: 'https://app.example.com/reset-password',
    corsOrigins: ['https://app.example.com'],
    emailProvider: 'azure-communication-services',
    azureCommunicationEmailEndpoint: 'https://example.communication.azure.com',
    emailSenderAddress: 'donotreply@example.com',
    applicationInsightsConnectionString: 'InstrumentationKey=test',
    rateLimitEnabled: true,
    dailyPathSchedulerEnabled: true,
    logLevel: 'info',
    ...overrides,
  });
}

test('development dummy auth remains available for local physical-device testing', () => {
  assert.equal(validateRuntimeConfig(baseConfig()).authMode, 'development');
});

test('production refuses development authentication', () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ nodeEnv: 'production' })),
    /cannot use AUTH_MODE=development/,
  );
});

test('production internal auth accepts the hardened Azure configuration', () => {
  const config = validateRuntimeConfig(productionInternal());
  assert.equal(config.authMode, 'internal');
  assert.equal(config.pgSSLRejectUnauthorized, true);
  assert.equal(config.dailyPathSchedulerEnabled, true);
});

test('production requires PostgreSQL TLS certificate verification', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ pgSSLRejectUnauthorized: false })),
    /PGSSL_REJECT_UNAUTHORIZED must be true/,
  );
});

test('production requires HTTPS public and reset URLs', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ publicBaseURL: 'http://api.example.com' })),
    /PUBLIC_BASE_URL must be an https:\/\/ URL/,
  );
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ passwordResetURLBase: 'fifoo://reset-password' })),
    /PASSWORD_RESET_URL_BASE must be an https:\/\/ URL/,
  );
});

test('production never exposes reset tokens or wildcard CORS', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ authExposeResetToken: true })),
    /AUTH_EXPOSE_RESET_TOKEN must be false/,
  );
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ corsOrigins: ['*'] })),
    /explicit CORS_ORIGIN allowlist/,
  );
});

test('Azure email requires sender plus endpoint or Key Vault supplied connection string', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ emailSenderAddress: '' })),
    /EMAIL_SENDER_ADDRESS is required/,
  );
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ azureCommunicationEmailEndpoint: '', azureCommunicationEmailConnectionString: '' })),
    /AZURE_COMMUNICATION_EMAIL_ENDPOINT or AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING is required/,
  );
  const config = validateRuntimeConfig(productionInternal({
    azureCommunicationEmailEndpoint: '',
    azureCommunicationEmailConnectionString: 'endpoint=https://example.communication.azure.com/;accesskey=redacted',
  }));
  assert.equal(config.emailProvider, 'azure-communication-services');
});

test('production requires observability, rate limiting and daily scheduler', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ applicationInsightsConnectionString: '' })),
    /APPLICATIONINSIGHTS_CONNECTION_STRING is required/,
  );
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ rateLimitEnabled: false })),
    /RATE_LIMIT_ENABLED must be true/,
  );
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ dailyPathSchedulerEnabled: false })),
    /DAILY_PATH_SCHEDULER_ENABLED must be true/,
  );
});

test('production external auth requires verifier URL', () => {
  assert.throws(
    () => validateRuntimeConfig(productionInternal({ authMode: 'external', authVerifyURL: '' })),
    /AUTH_VERIFY_URL is required/,
  );
  const config = validateRuntimeConfig(productionInternal({
    authMode: 'external',
    authVerifyURL: 'https://identity.example.com/verify',
  }));
  assert.equal(config.authMode, 'external');
});
