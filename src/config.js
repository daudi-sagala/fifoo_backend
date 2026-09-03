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

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}


function percentListEnv(name, fallback = '10,25,50,100') {
  const values = String(process.env[name] ?? fallback)
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 100);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (!unique.length || unique.at(-1) !== 100) unique.push(100);
  return unique;
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

  // Phase 7 MVP activity-support planner. The rule engine is deliberately
  // deterministic while it collects feedback for later learned prerequisite models.
  activitySupportPlannerEnabled: boolEnv('ACTIVITY_SUPPORT_PLANNER_ENABLED', true),
  activitySupportHorizonHours: Math.max(24, Math.min(intEnv('ACTIVITY_SUPPORT_HORIZON_HOURS', 72), 168)),
  activitySupportSchedulerEnabled: boolEnv('ACTIVITY_SUPPORT_SCHEDULER_ENABLED', nodeEnv === 'production'),
  activitySupportSchedulerIntervalMs: Math.max(300_000, Math.min(intEnv('ACTIVITY_SUPPORT_SCHEDULER_INTERVAL_MS', 900_000), 3_600_000)),
  activitySupportSchedulerStartupDelayMs: Math.max(0, Math.min(intEnv('ACTIVITY_SUPPORT_SCHEDULER_STARTUP_DELAY_MS', 120_000), 600_000)),

  // Adaptive Route Freshness — evaluate the live route frequently, but only
  // publish a new future plan when a material stale-route trigger is present.
  adaptiveRouteFreshnessSchedulerEnabled: boolEnv('ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_ENABLED', nodeEnv === 'production'),
  adaptiveRouteFreshnessSchedulerIntervalMs: Math.max(60_000, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_INTERVAL_MS', 300_000), 3_600_000)),
  adaptiveRouteFreshnessSchedulerStartupDelayMs: Math.max(0, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_STARTUP_DELAY_MS', 90_000), 600_000)),
  adaptiveRouteFreshnessCooldownMs: Math.max(60_000, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_COOLDOWN_MS', 900_000), 7_200_000)),
  adaptiveRouteFreshnessMissedGraceSeconds: Math.max(0, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_MISSED_GRACE_SECONDS', 300), 7_200)),
  adaptiveRouteFreshnessAtRiskWindowSeconds: Math.max(60, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_AT_RISK_WINDOW_SECONDS', 600), 7_200)),
  adaptiveRouteFreshnessMaxShiftSeconds: Math.max(300, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_MAX_SHIFT_SECONDS', 7_200), 21_600)),
  adaptiveRouteFreshnessRebaseBufferSeconds: Math.max(0, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_REBASE_BUFFER_SECONDS', 60), 1_800)),
  adaptiveRouteFreshnessMinimumRemainingSeconds: Math.max(60, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_MIN_REMAINING_SECONDS', 900), 7_200)),
  adaptiveRouteFreshnessMinimumExpectedDayFinish: Math.max(0.10, Math.min(numberEnv('ADAPTIVE_ROUTE_FRESHNESS_MIN_EXPECTED_DAY_FINISH', 0.60), 0.99)),
  adaptiveRouteFreshnessMinimumProjectionCandidateCount: Math.max(1, Math.min(intEnv('ADAPTIVE_ROUTE_FRESHNESS_MIN_PROJECTION_CANDIDATES', 2), 20)),

  // Phase 5 prediction rollout is dual-gated: this process-level mode is the
  // maximum authority the model may receive, while the database deployment
  // record must also be shadow/active. Production defaults to shadow.
  predictionRuntimeMode: (process.env.PREDICTION_RUNTIME_MODE ?? (nodeEnv === 'production' ? 'shadow' : 'legacy')).toLowerCase(),

  // Phase 6 automated model lifecycle. It is safe to run while the process gate
  // remains `shadow`; automatic canary/active changes only become authoritative
  // after the operator raises PREDICTION_RUNTIME_MODE to `active` once.
  predictionModelOpsEnabled: boolEnv('PREDICTION_MODEL_OPS_ENABLED', nodeEnv === 'production'),
  predictionModelOpsIntervalMs: Math.max(3_600_000, Math.min(intEnv('PREDICTION_MODEL_OPS_INTERVAL_MS', 21_600_000), 86_400_000)),
  predictionModelOpsStartupDelayMs: Math.max(0, Math.min(intEnv('PREDICTION_MODEL_OPS_STARTUP_DELAY_MS', 60_000), 600_000)),
  predictionModelOpsTrainingLimit: Math.max(100, Math.min(intEnv('PREDICTION_MODEL_OPS_TRAINING_LIMIT', 20_000), 5_000_000)),
  predictionModelOpsEvaluationLimit: Math.max(100, Math.min(intEnv('PREDICTION_MODEL_OPS_EVALUATION_LIMIT', 10_000), 50_000)),
  predictionModelOpsMinimumTrainingExamples: Math.max(50, intEnv('PREDICTION_MODEL_OPS_MIN_TRAINING_EXAMPLES', 400)),
  predictionModelOpsRetrainMinimumNewLabels: Math.max(10, intEnv('PREDICTION_MODEL_OPS_RETRAIN_MIN_NEW_LABELS', 100)),
  predictionModelOpsRetrainMinimumIntervalHours: Math.max(1, numberEnv('PREDICTION_MODEL_OPS_RETRAIN_MIN_INTERVAL_HOURS', 24)),
  predictionModelOpsRetrainMaximumIntervalHours: Math.max(24, numberEnv('PREDICTION_MODEL_OPS_RETRAIN_MAX_INTERVAL_HOURS', 168)),
  predictionModelOpsTrainingEpochs: Math.max(50, Math.min(intEnv('PREDICTION_MODEL_OPS_TRAINING_EPOCHS', 300), 1500)),
  predictionModelOpsMinimumHealthyChecks: Math.max(1, Math.min(intEnv('PREDICTION_MODEL_OPS_MIN_HEALTHY_CHECKS', 2), 10)),
  predictionModelOpsMinimumIndividualSamples: Math.max(1, intEnv('PREDICTION_MODEL_OPS_MIN_INDIVIDUAL_SAMPLES', 3)),
  predictionModelOpsMinimumShadowLabels: Math.max(20, intEnv('PREDICTION_MODEL_OPS_MIN_SHADOW_LABELS', 100)),
  predictionModelOpsMinimumCanaryLabels: Math.max(10, intEnv('PREDICTION_MODEL_OPS_MIN_CANARY_LABELS', 50)),
  predictionModelOpsMinimumShadowLogLossImprovement: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MIN_SHADOW_LOG_LOSS_IMPROVEMENT', 0.002)),
  predictionModelOpsRolloutSteps: percentListEnv('PREDICTION_MODEL_OPS_ROLLOUT_STEPS'),
  predictionModelOpsAutomaticRollback: boolEnv('PREDICTION_MODEL_OPS_AUTOMATIC_ROLLBACK', true),
  predictionModelOpsOfflineMinTestExamples: Math.max(20, intEnv('PREDICTION_MODEL_OPS_OFFLINE_MIN_TEST_EXAMPLES', 50)),
  predictionModelOpsOfflineMaxLogLoss: numberEnv('PREDICTION_MODEL_OPS_OFFLINE_MAX_LOG_LOSS', 0.75),
  predictionModelOpsOfflineMaxBrier: numberEnv('PREDICTION_MODEL_OPS_OFFLINE_MAX_BRIER', 0.25),
  predictionModelOpsOfflineMaxECE: numberEnv('PREDICTION_MODEL_OPS_OFFLINE_MAX_ECE', 0.15),
  predictionModelOpsOfflineMinAUC: numberEnv('PREDICTION_MODEL_OPS_OFFLINE_MIN_AUC', 0.55),
  predictionModelOpsMaxLogLossRegression: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_LOG_LOSS_REGRESSION', 0.02)),
  predictionModelOpsMaxBrierRegression: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_BRIER_REGRESSION', 0.01)),
  predictionModelOpsMaxECE: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_ECE', 0.18)),
  predictionModelOpsMaxPSI: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_PSI', 0.25)),
  predictionModelOpsMaxPositiveRateDelta: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_POSITIVE_RATE_DELTA', 0.20)),
  predictionModelOpsMinimumCohortLabels: Math.max(5, intEnv('PREDICTION_MODEL_OPS_MIN_COHORT_LABELS', 20)),
  predictionModelOpsMaxCohortLogLossRegression: Math.max(0, numberEnv('PREDICTION_MODEL_OPS_MAX_COHORT_LOG_LOSS_REGRESSION', 0.05)),

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
