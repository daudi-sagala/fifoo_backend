import express from 'express';
import { withClient, withTransaction } from '../db.js';
import { GameError, asGameError } from '../lib/errors.js';
import {
  authenticatePassword,
  consumePasswordReset,
  createPasswordReset,
  deliverPasswordReset,
  issueSession,
  publicUser,
  revokeAllUserSessions,
  revokeByAccessToken,
  revokeByRefreshToken,
  rotateRefreshToken,
  signup,
  verifyAccessToken,
} from '../services/authService.js';
import { config } from '../config.js';

export const authRouter = express.Router();

let disconnectUserSockets = async () => {};

export function configureAuthSocketInvalidation(handler) {
  disconnectUserSockets = typeof handler === 'function' ? handler : async () => {};
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function statusFor(error) {
  switch (error.code) {
    case 'invalid_payload': return 400;
    case 'unauthorized': return 401;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'conflict': return 409;
    default: return 500;
  }
}

function authResponse(userRow, session) {
  return { user: publicUser(userRow), ...session };
}

async function requireHTTPUser(req) {
  const token = bearerToken(req);
  if (!token) throw new GameError('unauthorized', 'Authorization token is required.');
  return withClient((client) => verifyAccessToken(client, token));
}

authRouter.post('/signup', asyncRoute(async (req, res) => {
  const deviceID = String(req.body?.deviceID ?? '').trim();
  if (!deviceID) throw new GameError('invalid_payload', 'deviceID is required.');

  const result = await withTransaction(async (client) => {
    const user = await signup(client, req.body ?? {});
    const session = await issueSession(client, { userID: user.user_id, deviceID });
    return authResponse(user, session);
  });
  res.status(201).json(result);
}));

authRouter.post('/login', asyncRoute(async (req, res) => {
  const deviceID = String(req.body?.deviceID ?? '').trim();
  if (!deviceID) throw new GameError('invalid_payload', 'deviceID is required.');

  const result = await withTransaction(async (client) => {
    const user = await authenticatePassword(client, req.body ?? {});
    const session = await issueSession(client, { userID: user.user_id, deviceID });
    return authResponse(user, session);
  });
  res.json(result);
}));

authRouter.post('/refresh', asyncRoute(async (req, res) => {
  const result = await withTransaction((client) => rotateRefreshToken(client, {
    refreshToken: req.body?.refreshToken,
    deviceID: req.body?.deviceID,
  }));
  res.json({ user: result.user, ...result.session });
}));

authRouter.get('/me', asyncRoute(async (req, res) => {
  const row = await requireHTTPUser(req);
  res.json({ user: publicUser(row) });
}));

authRouter.post('/logout', asyncRoute(async (req, res) => {
  await withClient(async (client) => {
    if (req.body?.refreshToken) await revokeByRefreshToken(client, req.body.refreshToken);
    const accessToken = bearerToken(req);
    if (accessToken) await revokeByAccessToken(client, accessToken);
  });
  res.json({ success: true });
}));

authRouter.post('/logout-all', asyncRoute(async (req, res) => {
  const row = await requireHTTPUser(req);
  await withClient((client) => revokeAllUserSessions(client, row.user_id));
  await disconnectUserSockets(row.user_id);
  res.json({ success: true });
}));

authRouter.post('/password/forgot', asyncRoute(async (req, res) => {
  const reset = await withClient((client) => createPasswordReset(client, req.body?.email));
  if (reset) await deliverPasswordReset(reset);
  const response = {
    success: true,
    message: 'If that email belongs to an account, password reset instructions have been issued.',
  };
  if (reset && config.authExposeResetToken && config.nodeEnv !== 'production') {
    response.developmentResetToken = reset.token;
  }
  res.json(response);
}));

authRouter.post('/password/reset', asyncRoute(async (req, res) => {
  const userID = await withTransaction((client) => consumePasswordReset(client, {
    token: req.body?.token,
    newPassword: req.body?.newPassword,
  }));
  await disconnectUserSockets(userID);
  res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
}));

authRouter.use((error, _req, res, _next) => {
  const authError = asGameError(error);
  res.status(statusFor(authError)).json({
    success: false,
    errorCode: authError.code,
    message: authError.message,
  });
});
