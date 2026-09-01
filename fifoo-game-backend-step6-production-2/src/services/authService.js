import crypto from 'node:crypto';
import { config } from '../config.js';
import { GameError } from '../lib/errors.js';
import { sendPasswordResetEmail } from './emailService.js';
import {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validateEmail,
  validatePasswordPolicy,
  validateUsername,
  verifyPassword,
} from '../lib/authCrypto.js';

export {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validateEmail,
  validatePasswordPolicy,
  validateUsername,
  verifyPassword,
} from '../lib/authCrypto.js';

function cleanText(value, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function randomOpaqueToken(prefix, bytes) {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

function sessionExpiry(now = new Date()) {
  return {
    accessExpiresAt: new Date(now.getTime() + config.authAccessTokenTTLSeconds * 1000),
    refreshExpiresAt: new Date(now.getTime() + config.authRefreshTokenTTLDays * 86_400_000),
  };
}

export function publicUser(row) {
  return {
    userID: row.user_id,
    username: row.username,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    email: row.email,
    joinedAt: row.joined ?? null,
  };
}

export async function issueSession(client, { userID, deviceID }) {
  const accessToken = randomOpaqueToken('fifoo_at_', 32);
  const refreshToken = randomOpaqueToken('fifoo_rt_', 48);
  const { accessExpiresAt, refreshExpiresAt } = sessionExpiry();

  const result = await client.query(
    `INSERT INTO auth_sessions(
       user_id,device_id,access_token_hash,refresh_token_hash,
       access_expires_at,refresh_expires_at,last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
     RETURNING auth_session_id`,
    [
      userID,
      String(deviceID ?? '').trim().slice(0, 200) || 'unknown-device',
      hashOpaqueToken(accessToken),
      hashOpaqueToken(refreshToken),
      accessExpiresAt,
      refreshExpiresAt,
    ],
  );

  return {
    sessionID: result.rows[0].auth_session_id,
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

export async function signup(client, payload) {
  const email = validateEmail(payload.email);
  const username = validateUsername(payload.username);
  const passwordHash = await hashPassword(payload.password);
  const firstName = cleanText(payload.firstName, 100);
  const lastName = cleanText(payload.lastName, 100);

  try {
    const result = await client.query(
      `INSERT INTO users(username,first_name,last_name,email,password,last_active)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING user_id,username,first_name,last_name,email,joined`,
      [username, firstName, lastName, email, passwordHash],
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code === '23505') {
      throw new GameError('conflict', 'An account with that email or username already exists.');
    }
    throw error;
  }
}

export async function authenticatePassword(client, { identifier, password }) {
  const normalizedIdentifier = String(identifier ?? '').trim();
  if (!normalizedIdentifier || typeof password !== 'string') {
    throw new GameError('unauthorized', 'Invalid email/username or password.');
  }

  const result = await client.query(
    `SELECT user_id,username,first_name,last_name,email,password,joined
       FROM users
      WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)
      LIMIT 1`,
    [normalizedIdentifier],
  );

  const row = result.rows[0];
  const valid = row ? await verifyPassword(password, row.password) : false;
  if (!valid) {
    throw new GameError('unauthorized', 'Invalid email/username or password.');
  }

  await client.query('UPDATE users SET last_active=NOW() WHERE user_id=$1', [row.user_id]);
  return row;
}

export async function verifyAccessToken(client, token, { touch = true } = {}) {
  const value = String(token ?? '');
  if (!value.startsWith('fifoo_at_')) {
    throw new GameError('unauthorized', 'Access token is invalid.');
  }

  const result = await client.query(
    `SELECT s.auth_session_id,s.user_id,s.device_id,s.access_expires_at,
            u.username,u.first_name,u.last_name,u.email,u.joined
       FROM auth_sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.access_token_hash=$1
        AND s.revoked_at IS NULL
        AND s.access_expires_at>NOW()
      LIMIT 1`,
    [hashOpaqueToken(value)],
  );

  const row = result.rows[0];
  if (!row) throw new GameError('unauthorized', 'Access token has expired or is invalid.');

  if (touch) {
    await client.query(
      'UPDATE auth_sessions SET last_used_at=NOW(),updated_at=NOW() WHERE auth_session_id=$1',
      [row.auth_session_id],
    );
  }
  return row;
}

export async function rotateRefreshToken(client, { refreshToken, deviceID }) {
  const value = String(refreshToken ?? '');
  if (!value.startsWith('fifoo_rt_')) {
    throw new GameError('unauthorized', 'Refresh token is invalid.');
  }

  const suppliedRefreshHash = hashOpaqueToken(value);
  const result = await client.query(
    `SELECT s.*,u.username,u.first_name,u.last_name,u.email,u.joined
       FROM auth_sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.refresh_token_hash=$1
         OR (s.previous_refresh_token_hash=$1 AND s.previous_refresh_valid_until>NOW())
      FOR UPDATE OF s`,
    [suppliedRefreshHash],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || new Date(row.refresh_expires_at) <= new Date()) {
    throw new GameError('unauthorized', 'Refresh token has expired or is invalid.');
  }
  if (deviceID && row.device_id !== String(deviceID)) {
    throw new GameError('unauthorized', 'Refresh token belongs to another device.');
  }

  const newAccessToken = randomOpaqueToken('fifoo_at_', 32);
  const newRefreshToken = randomOpaqueToken('fifoo_rt_', 48);
  const { accessExpiresAt, refreshExpiresAt } = sessionExpiry();
  await client.query(
    `UPDATE auth_sessions
        SET access_token_hash=$2,
            previous_refresh_token_hash=refresh_token_hash,
            previous_refresh_valid_until=NOW()+INTERVAL '60 seconds',
            refresh_token_hash=$3,
            access_expires_at=$4,
            refresh_expires_at=$5,
            last_used_at=NOW(),
            updated_at=NOW()
      WHERE auth_session_id=$1`,
    [
      row.auth_session_id,
      hashOpaqueToken(newAccessToken),
      hashOpaqueToken(newRefreshToken),
      accessExpiresAt,
      refreshExpiresAt,
    ],
  );

  return {
    user: publicUser(row),
    session: {
      sessionID: row.auth_session_id,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    },
  };
}

export async function revokeByRefreshToken(client, refreshToken) {
  const value = String(refreshToken ?? '');
  if (!value) return;
  await client.query(
    `UPDATE auth_sessions
        SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
      WHERE refresh_token_hash=$1 OR previous_refresh_token_hash=$1`,
    [hashOpaqueToken(value)],
  );
}

export async function revokeByAccessToken(client, accessToken) {
  const value = String(accessToken ?? '');
  if (!value) return;
  await client.query(
    `UPDATE auth_sessions
        SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
      WHERE access_token_hash=$1`,
    [hashOpaqueToken(value)],
  );
}

export async function revokeAllUserSessions(client, userID) {
  await client.query(
    `UPDATE auth_sessions
        SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
      WHERE user_id=$1`,
    [userID],
  );
}

export async function createPasswordReset(client, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const userResult = await client.query(
    'SELECT user_id,email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1',
    [normalized],
  );
  const user = userResult.rows[0];
  if (!user) return null;

  await client.query(
    `UPDATE auth_password_resets
        SET consumed_at=COALESCE(consumed_at,NOW())
      WHERE user_id=$1 AND consumed_at IS NULL`,
    [user.user_id],
  );

  const token = randomOpaqueToken('fifoo_pr_', 40);
  const expiresAt = new Date(Date.now() + config.passwordResetTTLMinutes * 60_000);
  await client.query(
    `INSERT INTO auth_password_resets(user_id,token_hash,expires_at)
     VALUES ($1,$2,$3)`,
    [user.user_id, hashOpaqueToken(token), expiresAt],
  );
  return { userID: user.user_id, email: user.email, token, expiresAt: expiresAt.toISOString() };
}

export async function deliverPasswordReset(reset) {
  return sendPasswordResetEmail(reset);
}

export async function consumePasswordReset(client, { token, newPassword }) {
  const value = String(token ?? '');
  if (!value.startsWith('fifoo_pr_')) {
    throw new GameError('invalid_payload', 'Password reset token is invalid.');
  }
  const passwordHash = await hashPassword(newPassword);
  const result = await client.query(
    `SELECT reset_id,user_id,expires_at,consumed_at
       FROM auth_password_resets
      WHERE token_hash=$1
      FOR UPDATE`,
    [hashOpaqueToken(value)],
  );
  const row = result.rows[0];
  if (!row || row.consumed_at || new Date(row.expires_at) <= new Date()) {
    throw new GameError('invalid_payload', 'Password reset token has expired or is invalid.');
  }

  await client.query('UPDATE users SET password=$2,last_active=NOW() WHERE user_id=$1', [row.user_id, passwordHash]);
  await client.query('UPDATE auth_password_resets SET consumed_at=NOW() WHERE reset_id=$1', [row.reset_id]);
  await revokeAllUserSessions(client, row.user_id);
  return row.user_id;
}
