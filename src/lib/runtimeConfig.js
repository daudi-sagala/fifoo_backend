function isHTTPS(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateRuntimeConfig(candidate) {
  if (!['development', 'internal', 'external'].includes(candidate.authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${candidate.authMode}`);
  }

  if (candidate.authMode === 'external' && !candidate.authVerifyURL) {
    throw new Error('AUTH_VERIFY_URL is required when AUTH_MODE=external.');
  }

  if (!['console', 'webhook', 'azure-communication-services'].includes(candidate.emailProvider ?? 'console')) {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${candidate.emailProvider}`);
  }

  if (!['debug', 'info', 'warn', 'error'].includes(candidate.logLevel ?? 'info')) {
    throw new Error(`Unsupported LOG_LEVEL: ${candidate.logLevel}`);
  }

  if (!['legacy', 'shadow', 'active'].includes(candidate.predictionRuntimeMode ?? 'legacy')) {
    throw new Error(`Unsupported PREDICTION_RUNTIME_MODE: ${candidate.predictionRuntimeMode}`);
  }

  if (candidate.emailProvider === 'webhook' && !candidate.passwordResetDeliveryURL) {
    throw new Error('PASSWORD_RESET_DELIVERY_URL is required when EMAIL_PROVIDER=webhook.');
  }

  if (candidate.emailProvider === 'azure-communication-services') {
    if (!candidate.emailSenderAddress) {
      throw new Error('EMAIL_SENDER_ADDRESS is required for Azure Communication Services email.');
    }
    if (!candidate.azureCommunicationEmailEndpoint && !candidate.azureCommunicationEmailConnectionString) {
      throw new Error('AZURE_COMMUNICATION_EMAIL_ENDPOINT or AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING is required.');
    }
  }

  if (candidate.nodeEnv === 'production') {
    if (candidate.authMode === 'development') {
      throw new Error('Production cannot use AUTH_MODE=development.');
    }
    if (candidate.allowDummyAuth) {
      throw new Error('ALLOW_DUMMY_AUTH must be false in production.');
    }
    if (candidate.authExposeResetToken) {
      throw new Error('AUTH_EXPOSE_RESET_TOKEN must be false in production.');
    }
    if (candidate.corsOrigins.includes('*')) {
      throw new Error('Production requires an explicit CORS_ORIGIN allowlist.');
    }
    if (!candidate.pgSSL) {
      throw new Error('PGSSL must be true in production.');
    }
    if (!candidate.pgSSLRejectUnauthorized) {
      throw new Error('PGSSL_REJECT_UNAUTHORIZED must be true in production.');
    }
    if (!candidate.requireHTTPS) {
      throw new Error('REQUIRE_HTTPS must be true in production.');
    }
    if (!candidate.trustProxy) {
      throw new Error('TRUST_PROXY must be true in production behind App Service/reverse proxy.');
    }
    if (!candidate.publicBaseURL || !isHTTPS(candidate.publicBaseURL)) {
      throw new Error('PUBLIC_BASE_URL must be an https:// URL in production.');
    }
    if (!candidate.passwordResetURLBase || !isHTTPS(candidate.passwordResetURLBase)) {
      throw new Error('PASSWORD_RESET_URL_BASE must be an https:// URL in production.');
    }
    if (candidate.authMode === 'internal' && candidate.emailProvider === 'console') {
      throw new Error('Production internal authentication requires a real EMAIL_PROVIDER.');
    }
    if (!candidate.applicationInsightsConnectionString) {
      throw new Error('APPLICATIONINSIGHTS_CONNECTION_STRING is required in production.');
    }
    if (!candidate.rateLimitEnabled) {
      throw new Error('RATE_LIMIT_ENABLED must be true in production.');
    }
    if (!candidate.dailyPathSchedulerEnabled) {
      throw new Error('DAILY_PATH_SCHEDULER_ENABLED must be true in production.');
    }
  }

  return candidate;
}
