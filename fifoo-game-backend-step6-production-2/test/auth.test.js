import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validateEmail,
  validatePasswordPolicy,
  validateUsername,
  verifyPassword,
} from '../src/lib/authCrypto.js';

test('password hashes use scrypt and verify without storing the clear password', async () => {
  const password = 'correct horse battery staple';
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$/);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('password policy rejects short passwords', () => {
  assert.throws(() => validatePasswordPolicy('short'), /at least 10 characters/);
  assert.equal(validatePasswordPolicy('long-enough-password'), 'long-enough-password');
});

test('email and username normalization/validation are deterministic', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(validateEmail('Person@Example.COM'), 'person@example.com');
  assert.equal(validateUsername('daudi.sagala'), 'daudi.sagala');
  assert.throws(() => validateUsername('ab'), /3–32/);
});

test('opaque token hashes are stable and do not preserve the token', () => {
  const token = 'fifoo_at_secret-example';
  const one = hashOpaqueToken(token);
  const two = hashOpaqueToken(token);
  assert.equal(one, two);
  assert.notEqual(one, token);
  assert.equal(one.length, 64);
});
