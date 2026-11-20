import crypto from 'node:crypto';
import type { Response } from 'express';

export const SESSION_COOKIE_NAME = 'pitbox_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Generates a salted scrypt hash formatted as `<hexSalt>:<hexHash>`.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifies a plaintext password against a stored `<hexSalt>:<hexHash>` string.
 */
export function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): boolean {
  if (!storedHash || !password) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;

  try {
    const keyBuf = Buffer.from(keyHex, 'hex');
    const derivedBuf = crypto.scryptSync(password, salt, 64);
    if (keyBuf.length !== derivedBuf.length) return false;
    return crypto.timingSafeEqual(keyBuf, derivedBuf);
  } catch {
    return false;
  }
}

/**
 * Derives a stable HMAC secret from SESSION_SECRET or DATABASE_URL so Render restarts don't invalidate logins.
 */
export function getSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    return process.env.SESSION_SECRET.trim();
  }
  const seed = process.env.DATABASE_URL || 'pitbox-local-dev-secret';
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * Signs a session token containing `uid` and expiry (`exp`) using HMAC-SHA256.
 */
export function signSessionToken(userId: string): string {
  const payload = {
    uid: userId,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('hex');
  return `${encodedPayload}.${sig}`;
}

/**
 * Verifies an HMAC-signed session token and checks expiration.
 */
export function verifySessionToken(token: string): { uid: string } | null {
  if (!token) return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;

  const encodedPayload = token.slice(0, dotIdx);
  const sigHex = token.slice(dotIdx + 1);
  if (!encodedPayload || !sigHex) return null;

  try {
    const expectedHex = crypto
      .createHmac('sha256', getSessionSecret())
      .update(encodedPayload)
      .digest('hex');
    const sigBuf = Buffer.from(sigHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const decoded = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    );
    if (
      !decoded ||
      typeof decoded.uid !== 'string' ||
      typeof decoded.exp !== 'number' ||
      decoded.exp <= Date.now()
    ) {
      return null;
    }

    return { uid: decoded.uid };
  } catch {
    return null;
  }
}

/**
 * Parses a Cookie header string into key/value pairs without extra dependencies.
 */
export function parseCookies(
  cookieHeader?: string
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;

  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const rawVal = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawVal);
    } catch {
      out[key] = rawVal;
    }
  }
  return out;
}

/**
 * Attaches the HttpOnly session cookie onto an Express response.
 */
export function setSessionCookie(res: Response, userId: string): void {
  const token = signSessionToken(userId);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Clears the session cookie from the client browser.
 */
export function clearSessionCookie(res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}
