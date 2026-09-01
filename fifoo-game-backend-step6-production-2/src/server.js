import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config, socketCorsOrigin } from './config.js';
import { pool } from './db.js';
import { registerGameSocket } from './socket/registerGameSocket.js';
import { authRouter, configureAuthSocketInvalidation } from './http/authRoutes.js';
import { userRoom } from './services/dayMaps.js';
import { logger } from './lib/logger.js';
import { requestContext, requireHTTPS, securityHeaders } from './http/security.js';
import { createRateLimiter, makeSocketConnectionLimiter } from './http/rateLimit.js';
import { startDailyPathScheduler, stopDailyPathScheduler } from './services/dailyPathScheduler.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy ? 1 : false);

const allowedOrigins = new Set(config.corsOrigins);
app.use(requestContext);
app.use(securityHeaders);
app.use(requireHTTPS);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true); // native iOS/Android clients do not send browser Origin.
    if (allowedOrigins.has('*') || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
}));

const generalRateLimit = createRateLimiter({
  name: 'http-general',
  limit: config.generalRateLimitPerMinute,
  windowMs: 60_000,
  skip: (req) => !config.rateLimitEnabled || req.path === '/health' || req.path === '/ready' || req.path === '/live',
});
app.use(generalRateLimit);
app.use(express.json({ limit: config.maxHTTPPayloadBytes }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('http request', {
      requestID: req.requestID,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
    });
  });
  next();
});

app.use('/auth', authRouter);

app.get('/live', (_req, res) => {
  res.status(200).json({ ok: true, service: 'fifoo-game-backend' });
});

app.get('/health', async (_req, res) => {
  try {
    const db = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, service: 'fifoo-game-backend', database: 'ok', time: db.rows[0].now });
  } catch (error) {
    logger.error('health database check failed', { error });
    res.status(503).json({ ok: false, service: 'fifoo-game-backend', database: 'unavailable' });
  }
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.sendStatus(204);
  } catch (error) {
    logger.warn('readiness check failed', { error });
    res.sendStatus(503);
  }
});

app.use((_req, res) => {
  res.status(404).json({ success: false, errorCode: 'not_found', message: 'Not found.' });
});

app.use((error, req, res, _next) => {
  logger.error('unhandled http error', { requestID: req.requestID, error });
  if (res.headersSent) return;
  res.status(500).json({
    success: false,
    errorCode: 'server_error',
    message: 'The server could not complete the request.',
    requestID: req.requestID ?? null,
  });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: socketCorsOrigin(),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: Math.min(config.maxMutationPayloadBytes * 2, 2_000_000),
  perMessageDeflate: false,
});

const socketConnectionLimiter = makeSocketConnectionLimiter({
  limit: config.socketConnectionRateLimitPerMinute,
  windowMs: 60_000,
});

io.use((socket, next) => {
  if (!config.rateLimitEnabled) return next();
  const forwarded = String(socket.handshake.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const address = forwarded || socket.handshake.address || 'unknown';
  const result = socketConnectionLimiter.consume(address);
  if (result.allowed) return next();
  const error = new Error('Too many socket connection attempts.');
  error.data = { errorCode: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
  return next(error);
});

configureAuthSocketInvalidation(async (userID) => {
  io.in(userRoom(userID)).disconnectSockets(true);
});

registerGameSocket(io);

server.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    authMode: config.authMode,
    schedulerEnabled: config.dailyPathSchedulerEnabled,
  });
  startDailyPathScheduler();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server shutdown started', { signal });
  stopDailyPathScheduler();
  io.close();
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      logger.info('server shutdown complete', { signal });
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason }));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error });
  shutdown('uncaughtException');
});
