import { validateRuntimeConfig } from './lib/runtimeConfig.js';

// Node 22+ provides native .env loading. Ignore a missing local file because
// production injects environment variables through Azure Container Apps.
try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const origins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

export const config = Object.freeze(validateRuntimeConfig({
  nodeEnv,
  port: intEnv('PORT', 3000),
  publicBaseURL: process.env.PUBLIC_BASE_URL ?? '',
  trustProxy: boolEnv('TRUST_PROXY', nodeEnv === 'production'),
  requireHTTPS: boolEnv('REQUIRE_HTTPS', nodeEnv === 'production'),

  databaseURL: required('DATABASE_URL'),
  pgSSL: boolEnv('PGSSL', nodeEnv === 'production'),
  pgSSLRejectUnauthorized: boolEnv('PGSSL_REJECT_UNAUTHORIZED', nodeEnv === 'production'),
  pgSSLCA: process.env.PGSSL_CA ?? '',
  pgPoolMax: Math.max(2, Math.min(intEnv('PG_POOL_MAX', 20), 100)),
  pgIdleTimeoutMs: Math.max(1_000, Math.min(intEnv('PG_IDLE_TIMEOUT_MS', 30_000), 300_000)),
  pgConnectionTimeoutMs: Math.max(1_000, Math.min(intEnv('PG_CONNECTION_TIMEOUT_MS', 10_000), 60_000)),
  pgStatementTimeoutMs: Math.max(1_000, Math.min(intEnv('PG_STATEMENT_TIMEOUT_MS', 30_000), 300_000)),
  pgIdleTransactionTimeoutMs: Math.max(1_000, Math.min(intEnv('PG_IDLE_TRANSACTION_TIMEOUT_MS', 30_000), 300_000)),

  corsOrigins: origins.length ? origins : ['*'],
  authMode: process.env.AUTH_MODE ?? 'development',
  allowDummyAuth: boolEnv('ALLOW_DUMMY_AUTH', false),
  dummyAuthToken: process.env.DUMMY_AUTH_TOKEN ?? 'DUMMY_AUTH_TOKEN',
  dummyUserID: process.env.DUMMY_USER_ID ?? '',
  authVerifyURL: process.env.AUTH_VERIFY_URL ?? '',
  authVerifyTimeoutMs: Math.max(1000, Math.min(intEnv('AUTH_VERIFY_TIMEOUT_MS', 5000), 30_000)),
  outboundHTTPTimeoutMs: Math.max(1000, Math.min(intEnv('OUTBOUND_HTTP_TIMEOUT_MS', 10_000), 60_000)),
  authAccessTokenTTLSeconds: Math.max(300, Math.min(intEnv('AUTH_ACCESS_TOKEN_TTL_SECONDS', 900), 86_400)),
  authRefreshTokenTTLDays: Math.max(1, Math.min(intEnv('AUTH_REFRESH_TOKEN_TTL_DAYS', 30), 365)),
  passwordResetTTLMinutes: Math.max(5, Math.min(intEnv('PASSWORD_RESET_TTL_MINUTES', 30), 1440)),
  passwordResetDeliveryURL: process.env.PASSWORD_RESET_DELIVERY_URL ?? '',
  passwordResetDeliverySecret: process.env.PASSWORD_RESET_DELIVERY_SECRET ?? '',
  passwordResetURLBase: process.env.PASSWORD_RESET_URL_BASE
    ?? process.env.PASSWORD_RESET_DEEP_LINK_BASE
    ?? 'fifoo://reset-password',
  authExposeResetToken: boolEnv('AUTH_EXPOSE_RESET_TOKEN', nodeEnv !== 'production'),
  socketAuthTimeoutMs: Math.max(1000, Math.min(intEnv('SOCKET_AUTH_TIMEOUT_MS', 10_000), 60_000)),

  emailProvider: process.env.EMAIL_PROVIDER ?? (nodeEnv === 'production' ? 'azure-communication-services' : 'console'),
  azureCommunicationEmailEndpoint: process.env.AZURE_COMMUNICATION_EMAIL_ENDPOINT ?? '',
  azureCommunicationEmailConnectionString: process.env.AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING ?? '',
  emailSenderAddress: process.env.EMAIL_SENDER_ADDRESS ?? '',
  emailReplyToAddress: process.env.EMAIL_REPLY_TO_ADDRESS ?? '',

  applicationInsightsConnectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? '',
  logLevel: (process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug')).toLowerCase(),

  rateLimitEnabled: boolEnv('RATE_LIMIT_ENABLED', true),
  generalRateLimitPerMinute: Math.max(30, Math.min(intEnv('GENERAL_RATE_LIMIT_PER_MINUTE', 300), 10_000)),
  authLoginRateLimitPer15Minutes: Math.max(3, Math.min(intEnv('AUTH_LOGIN_RATE_LIMIT_PER_15_MINUTES', 20), 500)),
  authSignupRateLimitPerHour: Math.max(1, Math.min(intEnv('AUTH_SIGNUP_RATE_LIMIT_PER_HOUR', 10), 200)),
  authPasswordResetRateLimitPerHour: Math.max(1, Math.min(intEnv('AUTH_PASSWORD_RESET_RATE_LIMIT_PER_HOUR', 6), 100)),
  socketConnectionRateLimitPerMinute: Math.max(5, Math.min(intEnv('SOCKET_CONNECTION_RATE_LIMIT_PER_MINUTE', 60), 1000)),
  socketMutationRateLimitPerMinute: Math.max(20, Math.min(intEnv('SOCKET_MUTATION_RATE_LIMIT_PER_MINUTE', 240), 5000)),

  runMigrationsOnStart: boolEnv('RUN_MIGRATIONS_ON_START', nodeEnv === 'production'),
  dailyPathSchedulerEnabled: boolEnv('DAILY_PATH_SCHEDULER_ENABLED', nodeEnv === 'production'),
  dailyPathSchedulerIntervalMs: Math.max(60_000, Math.min(intEnv('DAILY_PATH_SCHEDULER_INTERVAL_MS', 300_000), 3_600_000)),
  dailyPathSchedulerStartupDelayMs: Math.max(0, Math.min(intEnv('DAILY_PATH_SCHEDULER_STARTUP_DELAY_MS', 15_000), 300_000)),

  // Phase 5 prediction rollout is dual-gated: this process-level mode is the
  // maximum authority the model may receive, while the database deployment
  // record must also be shadow/active. Production defaults to shadow.
  predictionRuntimeMode: (process.env.PREDICTION_RUNTIME_MODE ?? (nodeEnv === 'production' ? 'shadow' : 'legacy')).toLowerCase(),

  persistApplicationActions: boolEnv('PERSIST_APPLICATION_ACTIONS', false),
  logApplicationActions: boolEnv('LOG_APPLICATION_ACTIONS', nodeEnv !== 'production'),

  maxSearchResults: Math.max(1, Math.min(intEnv('MAX_SEARCH_RESULTS', 50), 200)),
  maxLiveHistory: Math.max(1, Math.min(intEnv('MAX_LIVE_HISTORY', 100), 500)),
  maxMutationPayloadBytes: Math.max(16_384, Math.min(intEnv('MAX_MUTATION_PAYLOAD_BYTES', 1_048_576), 1_900_000)),
  maxHTTPPayloadBytes: Math.max(16_384, Math.min(intEnv('MAX_HTTP_PAYLOAD_BYTES', 1_048_576), 2_000_000)),

  defaultTimeZone: process.env.DEFAULT_TIME_ZONE ?? 'America/New_York',
}));

export function socketCorsOrigin() {
  if (config.corsOrigins.includes('*')) return '*';
  return config.corsOrigins;
}
