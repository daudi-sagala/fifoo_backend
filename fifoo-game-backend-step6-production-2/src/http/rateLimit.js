import crypto from 'node:crypto';

const buckets = new Map();
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32);
}

export function clientIP(req) {
  return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 128);
}

export function createRateLimiter({
  name,
  limit,
  windowMs,
  keyGenerator = clientIP,
  skip = () => false,
}) {
  return (req, res, next) => {
    if (skip(req)) return next();
    const now = Date.now();
    sweep(now);
    const rawKey = keyGenerator(req);
    const key = `${name}:${hashKey(rawKey)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('ratelimit-limit', String(limit));
    res.setHeader('ratelimit-remaining', String(remaining));
    res.setHeader('ratelimit-reset', String(retryAfterSeconds));

    if (bucket.count > limit) {
      res.setHeader('retry-after', String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        errorCode: 'rate_limited',
        message: 'Too many requests. Try again later.',
        requestID: req.requestID ?? null,
      });
    }
    return next();
  };
}

export function compositeAuthKey(req) {
  const identifier = String(
    req.body?.identifier ?? req.body?.email ?? req.body?.username ?? '',
  ).trim().toLowerCase();
  return `${clientIP(req)}:${identifier}`;
}

export function makeSocketConnectionLimiter({ limit, windowMs }) {
  return createTokenWindow({ name: 'socket-connect', limit, windowMs });
}

export function createTokenWindow({ name, limit, windowMs }) {
  return {
    consume(subject) {
      const now = Date.now();
      sweep(now);
      const key = `${name}:${hashKey(subject)}`;
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return {
        allowed: bucket.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    },
  };
}
