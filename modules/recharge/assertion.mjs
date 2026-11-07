import { createHmac, timingSafeEqual } from 'node:crypto';

export function signRechargeAssertion(secret, method, path, actor, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ method, path, actor, exp: now + 15_000 })).toString(
    'base64url'
  );
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

export function verifyRechargeAssertion(secret, method, path, assertion, now = Date.now()) {
  if (typeof assertion !== 'string' || assertion.length > 4096) return null;
  const [payload, signature, extra] = assertion.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload || '') ||
      !/^[A-Za-z0-9_-]+$/.test(signature || '')) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || actual.toString('base64url') !== signature ||
      !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const actor = claims.actor;
    if (claims.method !== method || claims.path !== path ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + 30_000 ||
        typeof actor?.id !== 'string' || !actor.id.trim() || actor.id.length > 256 ||
        typeof actor.email !== 'string' || actor.email.length > 320 ||
        typeof actor.admin !== 'boolean' || typeof actor.sensitive !== 'boolean' ||
        actor.sensitive && !actor.admin) return null;
    return Object.freeze({ id: actor.id, email: actor.email, admin: actor.admin, sensitive: actor.sensitive });
  } catch { return null; }
}
