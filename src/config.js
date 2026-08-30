import 'dotenv/config';
import { validateRuntimeConfig } from './lib/runtimeConfig.js';

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
  databaseURL: required('DATABASE_URL'),
  pgSSL: boolEnv('PGSSL', false),
  corsOrigins: origins.length ? origins : ['*'],
  authMode: process.env.AUTH_MODE ?? 'development',
  allowDummyAuth: boolEnv('ALLOW_DUMMY_AUTH', false),
  dummyAuthToken: process.env.DUMMY_AUTH_TOKEN ?? 'DUMMY_AUTH_TOKEN',
  dummyUserID: process.env.DUMMY_USER_ID ?? '',
  authVerifyURL: process.env.AUTH_VERIFY_URL ?? '',
  authVerifyTimeoutMs: Math.max(1000, Math.min(intEnv('AUTH_VERIFY_TIMEOUT_MS', 5000), 30_000)),
  authAccessTokenTTLSeconds: Math.max(300, Math.min(intEnv('AUTH_ACCESS_TOKEN_TTL_SECONDS', 900), 86_400)),
  authRefreshTokenTTLDays: Math.max(1, Math.min(intEnv('AUTH_REFRESH_TOKEN_TTL_DAYS', 30), 365)),
  passwordResetTTLMinutes: Math.max(5, Math.min(intEnv('PASSWORD_RESET_TTL_MINUTES', 30), 1440)),
  passwordResetDeliveryURL: process.env.PASSWORD_RESET_DELIVERY_URL ?? '',
  passwordResetDeliverySecret: process.env.PASSWORD_RESET_DELIVERY_SECRET ?? '',
  passwordResetDeepLinkBase: process.env.PASSWORD_RESET_DEEP_LINK_BASE ?? 'fifoo://reset-password',
  authExposeResetToken: boolEnv('AUTH_EXPOSE_RESET_TOKEN', nodeEnv !== 'production'),
  socketAuthTimeoutMs: Math.max(1000, Math.min(intEnv('SOCKET_AUTH_TIMEOUT_MS', 10_000), 60_000)),
  persistApplicationActions: boolEnv('PERSIST_APPLICATION_ACTIONS', false),
  logApplicationActions: boolEnv('LOG_APPLICATION_ACTIONS', nodeEnv !== 'production'),
  maxSearchResults: Math.max(1, Math.min(intEnv('MAX_SEARCH_RESULTS', 50), 200)),
  maxLiveHistory: Math.max(1, Math.min(intEnv('MAX_LIVE_HISTORY', 100), 500)),
  maxMutationPayloadBytes: Math.max(16_384, Math.min(intEnv('MAX_MUTATION_PAYLOAD_BYTES', 1_048_576), 1_900_000)),
  defaultTimeZone: process.env.DEFAULT_TIME_ZONE ?? 'America/New_York',
}));

export function socketCorsOrigin() {
  if (config.corsOrigins.includes('*')) return '*';
  return config.corsOrigins;
}
