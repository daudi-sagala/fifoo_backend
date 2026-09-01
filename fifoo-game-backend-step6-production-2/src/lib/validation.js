import { GameError } from './errors.js';

export function isUUID(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function assertObject(value, name = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GameError('invalid_payload', `${name} must be an object.`);
  }
  return value;
}

export function assertString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new GameError('invalid_payload', `${name} must be a string.`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new GameError('invalid_payload', `${name} cannot be empty.`);
  }
  return value;
}

export function assertUUID(value, name) {
  const candidate = rawUUID(value);
  if (!candidate || !isUUID(candidate)) {
    throw new GameError('invalid_payload', `${name} must be a UUID.`);
  }
  return candidate;
}

export function optionalUUID(value) {
  if (value == null || value === '') return null;
  const candidate = rawUUID(value);
  return candidate && isUUID(candidate) ? candidate : null;
}

export function rawUUID(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.rawValue === 'string') {
    return value.rawValue;
  }
  return null;
}

export function assertMapDate(value, name = 'mapDate') {
  assertString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new GameError('invalid_payload', `${name} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new GameError('invalid_payload', `${name} must be a real calendar date.`);
  }
  return value;
}

export function assertTimeZone(value, name = 'timeZoneIdentifier') {
  const candidate = assertString(value, name).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
  } catch {
    throw new GameError('invalid_payload', `${name} must be a valid IANA time zone.`);
  }
  return candidate;
}

export function parseEnvelope(value) {
  const envelope = assertObject(value, 'envelope');
  const context = assertObject(envelope.context, 'context');
  const requestID = assertUUID(context.requestID, 'context.requestID');
  const mapDate = assertMapDate(context.mapDate, 'context.mapDate');
  const timeZoneIdentifier = assertTimeZone(context.timeZoneIdentifier, 'context.timeZoneIdentifier');
  const deviceID = assertString(context.deviceID, 'context.deviceID');
  const clientRevision = Number(context.clientRevision ?? 0);
  if (!Number.isFinite(clientRevision) || clientRevision < 0) {
    throw new GameError('invalid_payload', 'context.clientRevision must be a non-negative number.');
  }
  return {
    context: {
      ...context,
      requestID,
      mapDate,
      timeZoneIdentifier,
      deviceID,
      clientRevision: Math.trunc(clientRevision),
    },
    payload: envelope.payload ?? {},
  };
}

export function parseClockSeconds(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const h12 = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (h12) {
    let hour = Number(h12[1]);
    const minute = Number(h12[2]);
    const second = Number(h12[3] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59 || second > 59) return null;
    if (hour === 12) hour = 0;
    if (h12[4].toUpperCase() === 'PM') hour += 12;
    return hour * 3600 + minute * 60 + second;
  }

  const h24 = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    const second = Number(h24[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    return hour * 3600 + minute * 60 + second;
  }

  return null;
}

export function boundedText(value, max, fallback = '') {
  if (value == null) return fallback;
  return String(value).trim().slice(0, max);
}

export function assertMatchingRevision(clientRevision, serverRevision) {
  const clientValue = Math.trunc(Number(clientRevision));
  const serverValue = Math.trunc(Number(serverRevision));
  if (!Number.isFinite(clientValue) || !Number.isFinite(serverValue)) {
    throw new GameError('server_error', 'Revision state is invalid.');
  }
  if (clientValue !== serverValue) {
    throw new GameError(
      'conflict',
      'Day Map changed on another client. Refreshing authoritative state before retry.',
      { serverRevision: serverValue },
    );
  }
  return serverValue;
}

export function assertJSONByteSize(value, maxBytes, name = 'payload') {
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    throw new GameError('invalid_payload', `${name} must be JSON serializable.`);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new GameError('invalid_payload', `${name} exceeds the maximum allowed size.`);
  }
  return bytes;
}

