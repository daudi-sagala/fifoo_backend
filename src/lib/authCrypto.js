import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { GameError } from './errors.js';

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_ALGORITHM = 'scrypt';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const MAX_PASSWORD_BYTES = 256;

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeUsername(value) {
  return String(value ?? '').trim();
}

export function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new GameError('invalid_payload', 'Enter a valid email address.');
  }
  return normalized;
}

export function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(normalized)) {
    throw new GameError('invalid_payload', 'Username must be 3–32 characters and use letters, numbers, period, underscore, or hyphen.');
  }
  return normalized;
}

export function resolveSignupUsername(value, accountEmail) {
  const email = validateEmail(accountEmail);
  const requested = normalizeUsername(value);

  // Phase 8 does not require a separate player tag. The account email is a
  // valid canonical username, while legacy handle-style usernames remain valid.
  if (!requested) return email;

  if (requested.includes('@')) {
    const usernameEmail = validateEmail(requested);
    if (usernameEmail !== email) {
      throw new GameError(
        'invalid_payload',
        'When an email is used as the username, it must match the account email.',
      );
    }
    return email;
  }

  return validateUsername(requested);
}

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    throw new GameError('invalid_payload', 'Password must be a string.');
  }
  const bytes = Buffer.byteLength(password, 'utf8');
  if (password.length < 6) {
    throw new GameError('invalid_payload', 'Password must contain at least 6 characters.');
  }
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new GameError('invalid_payload', 'Password is too long.');
  }
  return password;
}

export async function hashPassword(password) {
  validatePasswordPolicy(password);
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    PASSWORD_ALGORITHM,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== PASSWORD_ALGORITHM) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = Buffer.from(await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    }));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashOpaqueToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}
