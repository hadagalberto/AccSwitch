/**
 * Best-effort account identification.
 *
 * Every provider we support stores at least one JWT somewhere inside its
 * credential JSON. Rather than hardcoding a path per provider, we walk the
 * object, decode anything that looks like a JWT, and pull the first usable
 * identity claim out of it. Nothing here is ever persisted except the label.
 */

const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

const IDENTITY_CLAIMS = [
  'email',
  'preferred_username',
  'https://api.openai.com/auth',
  'name',
  'username',
  'sub',
];

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function claimFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of IDENTITY_CLAIMS) {
    const value = payload[key];
    if (typeof value === 'string' && value.includes('@')) return value;
  }
  for (const key of IDENTITY_CLAIMS) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const nested = claimFrom(value);
      if (nested) return nested;
    }
  }
  return null;
}

/** Walks any JSON value looking for an email-ish identity. */
export function guessAccount(value, depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === 'string') {
    if (value.includes('@') && !value.includes(' ') && value.includes('.')) return value;
    if (JWT_RE.test(value)) return claimFrom(decodeJwtPayload(value));
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = guessAccount(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof value === 'object') {
    // Prefer explicitly named fields before falling back to a blind walk.
    for (const key of ['active', 'email', 'account', 'accountEmail', 'user']) {
      if (key in value) {
        const hit = guessAccount(value[key], depth + 1);
        if (hit) return hit;
      }
    }
    for (const item of Object.values(value)) {
      const hit = guessAccount(item, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}

/** Extra hints worth showing in listings (plan tier, auth mode). */
export function guessPlan(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return null;
  for (const key of ['subscriptionType', 'auth_mode', 'plan', 'planType', 'chatgpt_plan_type']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const item of Object.values(value)) {
    const hit = guessPlan(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}
