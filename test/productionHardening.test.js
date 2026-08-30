import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRuntimeConfig } from '../src/lib/runtimeConfig.js';

function baseConfig(overrides = {}) {
  return {
    nodeEnv: 'development',
    authMode: 'development',
    allowDummyAuth: true,
    authVerifyURL: '',
    authExposeResetToken: true,
    passwordResetDeliveryURL: '',
    corsOrigins: ['*'],
    ...overrides,
  };
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

test('production internal auth requires reset delivery and explicit CORS', () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      nodeEnv: 'production',
      authMode: 'internal',
      allowDummyAuth: false,
      authExposeResetToken: false,
      corsOrigins: ['https://app.example'],
    })),
    /PASSWORD_RESET_DELIVERY_URL is required/,
  );

  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      nodeEnv: 'production',
      authMode: 'internal',
      allowDummyAuth: false,
      authExposeResetToken: false,
      passwordResetDeliveryURL: 'https://mailer.example/reset',
      corsOrigins: ['*'],
    })),
    /explicit CORS_ORIGIN allowlist/,
  );

  const config = validateRuntimeConfig(baseConfig({
    nodeEnv: 'production',
    authMode: 'internal',
    allowDummyAuth: false,
    authExposeResetToken: false,
    passwordResetDeliveryURL: 'https://mailer.example/reset',
    corsOrigins: ['https://app.example'],
  }));
  assert.equal(config.authMode, 'internal');
});

test('production never exposes reset tokens', () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      nodeEnv: 'production',
      authMode: 'internal',
      allowDummyAuth: false,
      authExposeResetToken: true,
      passwordResetDeliveryURL: 'https://mailer.example/reset',
      corsOrigins: ['https://app.example'],
    })),
    /AUTH_EXPOSE_RESET_TOKEN must be false/,
  );
});

test('production external auth requires an explicit CORS allowlist', () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      nodeEnv: 'production',
      authMode: 'external',
      allowDummyAuth: false,
      authExposeResetToken: false,
      authVerifyURL: 'https://auth.example/verify',
      corsOrigins: ['*'],
    })),
    /explicit CORS_ORIGIN allowlist/,
  );

  const config = validateRuntimeConfig(baseConfig({
    nodeEnv: 'production',
    authMode: 'external',
    allowDummyAuth: false,
    authExposeResetToken: false,
    authVerifyURL: 'https://auth.example/verify',
    corsOrigins: ['https://app.example'],
  }));
  assert.equal(config.authMode, 'external');
});

test('external auth fails fast when AUTH_VERIFY_URL is missing', () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ authMode: 'external', allowDummyAuth: false })),
    /AUTH_VERIFY_URL is required/,
  );
});
