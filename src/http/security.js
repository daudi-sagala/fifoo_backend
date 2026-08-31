import crypto from 'node:crypto';
import { config } from '../config.js';

function requestID(value) {
  const candidate = String(value ?? '').trim();
  if (/^[A-Za-z0-9._:-]{8,128}$/.test(candidate)) return candidate;
  return crypto.randomUUID();
}

export function requestContext(req, res, next) {
  req.requestID = requestID(req.headers['x-request-id']);
  res.setHeader('x-request-id', req.requestID);
  next();
}

export function securityHeaders(req, res, next) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function requireHTTPS(req, res, next) {
  if (!config.requireHTTPS) return next();
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwarded === 'https') return next();
  return res.status(400).json({
    success: false,
    errorCode: 'https_required',
    message: 'HTTPS is required.',
    requestID: req.requestID ?? null,
  });
}

export function noStore(_req, res, next) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  next();
}
