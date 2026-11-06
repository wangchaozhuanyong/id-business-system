import { createHmac } from 'node:crypto';

export function signRechargeAssertion(secret, method, path, actor, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ method, path, actor, exp: now + 15_000 })).toString(
    'base64url'
  );
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}
