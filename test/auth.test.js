import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  resolveSignupUsername,
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
  assert.throws(() => validatePasswordPolicy('12345'), /at least 6 characters/);
  assert.equal(validatePasswordPolicy('123456'), '123456');
});

test('email and username normalization/validation are deterministic', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(validateEmail('Person@Example.COM'), 'person@example.com');
  assert.equal(validateUsername('daudi.sagala'), 'daudi.sagala');
  assert.throws(() => validateUsername('ab'), /3–32/);
});

test('signup can use the account email as its username', () => {
  assert.equal(resolveSignupUsername('', 'Person@Example.COM'), 'person@example.com');
  assert.equal(resolveSignupUsername('PERSON@example.com', 'person@example.com'), 'person@example.com');
  assert.equal(resolveSignupUsername('daudi.sagala', 'person@example.com'), 'daudi.sagala');
  assert.throws(
    () => resolveSignupUsername('other@example.com', 'person@example.com'),
    /must match the account email/,
  );
});

test('opaque token hashes are stable and do not preserve the token', () => {
  const token = 'fifoo_at_secret-example';
  const one = hashOpaqueToken(token);
  const two = hashOpaqueToken(token);
  assert.equal(one, two);
  assert.notEqual(one, token);
  assert.equal(one.length, 64);
});
