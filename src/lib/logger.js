import { config } from '../config.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function sanitize(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (value == null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: config.nodeEnv === 'production' ? undefined : value.stack,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return value;

  const redacted = /token|password|secret|authorization|cookie|databaseurl|connectionstring/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redacted.test(key) ? '[redacted]' : sanitize(item, depth + 1),
  ]));
}

function write(level, message, fields = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: 'fifoo-game-backend',
    message,
    ...sanitize(fields),
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = Object.freeze({
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
});
