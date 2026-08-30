import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config, socketCorsOrigin } from './config.js';
import { pool } from './db.js';
import { registerGameSocket } from './socket/registerGameSocket.js';
import { authRouter, configureAuthSocketInvalidation } from './http/authRoutes.js';
import { userRoom } from './services/dayMaps.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use('/auth', authRouter);

app.get('/health', async (_req, res) => {
  try {
    const db = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, service: 'fifoo-game-backend', database: 'ok', time: db.rows[0].now });
  } catch (error) {
    res.status(503).json({ ok: false, service: 'fifoo-game-backend', database: 'unavailable' });
  }
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.sendStatus(204);
  } catch {
    res.sendStatus(503);
  }
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: socketCorsOrigin(),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 2 * 1024 * 1024,
});

configureAuthSocketInvalidation(async (userID) => {
  io.in(userRoom(userID)).disconnectSockets(true);
});

registerGameSocket(io);

server.listen(config.port, () => {
  console.log(`Fifoo game backend listening on :${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  io.close();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
