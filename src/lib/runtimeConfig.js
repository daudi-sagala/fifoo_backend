export function validateRuntimeConfig(candidate) {
  if (!['development', 'internal', 'external'].includes(candidate.authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${candidate.authMode}`);
  }

  if (candidate.authMode === 'external' && !candidate.authVerifyURL) {
    throw new Error('AUTH_VERIFY_URL is required when AUTH_MODE=external.');
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
    if (candidate.authMode === 'internal' && !candidate.passwordResetDeliveryURL) {
      throw new Error('PASSWORD_RESET_DELIVERY_URL is required for internal production authentication.');
    }
    if (candidate.corsOrigins.includes('*')) {
      throw new Error('Production requires an explicit CORS_ORIGIN allowlist.');
    }
  }

  return candidate;
}
