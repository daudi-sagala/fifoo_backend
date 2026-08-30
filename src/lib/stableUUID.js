import crypto from 'node:crypto';

/**
 * Deterministic UUID-shaped identifier derived from arbitrary text.
 *
 * This is intentionally used for generated fixtures/day-plan objects so
 * rerunning generation for the same user/date/rule slot performs an upsert
 * instead of producing duplicates.
 */
export function stableUUID(value) {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
