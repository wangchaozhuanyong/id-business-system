import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP, SocketAddress } from 'node:net';

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const minute = 60_000;
export const verificationLifetime = 5 * minute;
export const browserLifetime = 90 * 24 * 60 * minute;

export function turnstileLoginPage(html, siteKey) {
  if (!siteKey) return html;
  return html.replace('<head>', `<head>\n    <meta name="id-turnstile-site-key" content="${siteKey}" />`)
    .replace("script-src 'self';", "script-src 'self' https://challenges.cloudflare.com;")
    .replace("connect-src 'self'; frame-src 'self';",
      "connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com;");
}

export function loadLoginSecurity(env, publicUrl) {
  const siteKey = env.ID_TURNSTILE_SITE_KEY || '';
  const secret = env.ID_TURNSTILE_SECRET_KEY || '';
  const mfaKey = env.ID_AUTH_MFA_KEY || '';
  const proxyKey = env.ID_AUTH_TRUSTED_PROXY_KEY || '';
  if (Boolean(siteKey) !== Boolean(secret) || (siteKey && (!publicUrl || typeof siteKey !== 'string' ||
      !/^[\w-]{1,128}$/.test(siteKey) || typeof secret !== 'string' || !/^[\w-]{1,512}$/.test(secret))))
    throw new Error('真人验证配置不完整');
  if (mfaKey && !/^[a-f0-9]{64}$/.test(mfaKey)) throw new Error('两步验证配置无效');
  if (proxyKey && !/^[a-f0-9]{64}$/.test(proxyKey)) throw new Error('登录网络配置无效');
  return {
    siteKey, secret, host: publicUrl?.hostname, proxyKey,
    mfaKey: mfaKey ? Buffer.from(mfaKey, 'hex') : null
  };
}

function equalText(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifiedAddress(request, security) {
  const peer = request.socket?.remoteAddress;
  const key = request.headers['x-id-verified-proxy'];
  const address = request.headers['x-id-client-ip'];
  if (!security?.host && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return '127.0.0.1';
  const suppliedKey = typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
  if (!security?.proxyKey || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ||
      !suppliedKey || !equalText(key, security.proxyKey) || typeof address !== 'string' || !isIP(address))
    return null;
  const normalized = isIP(address) === 6 ? new SocketAddress({ address, family: 'ipv6' }).address : address;
  return normalized.startsWith('::ffff:') && isIP(normalized.slice(7)) === 4 ? normalized.slice(7) : normalized;
}

export function readNetwork(value) {
  const match = typeof value === 'string' && /^([a-f\d.:]+)(?:\/(\d{1,3}))?$/i.exec(value.trim());
  if (!match) return null;
  const [, address, mask] = match;
  const family = isIP(address);
  const width = family === 4 ? 32 : 128;
  const prefix = mask === undefined ? width : Number(mask);
  // Whole Internet and overly broad ranges are unsuitable for an office allowlist.
  if (!family || address.toLowerCase().startsWith('::ffff:') || prefix < (family === 4 ? 8 : 16) || prefix > width)
    return null;
  const normalized = family === 6 ? new SocketAddress({ address, family: 'ipv6' }).address : address;
  if (normalized.startsWith('::ffff:')) return null;
  const list = new BlockList();
  list.addSubnet(normalized, prefix, 'ipv' + family);
  return { value: normalized + '/' + prefix, has: ip => Boolean(ip && isIP(ip) === family && list.check(ip, 'ipv' + family)) };
}

export function allowsNetwork(policy, address) {
  return policy?.mode !== 'enforce' || Boolean(address && policy.entries.some(row => readNetwork(row.network)?.has(address)));
}

export async function verifyTurnstile(security, token, address, fetchImpl = fetch) {
  if (!security?.siteKey) return 'passed';
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return 'retry';
  const fields = new URLSearchParams({ secret: security.secret, response: token });
  if (address) fields.set('remoteip', address);
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: fields, signal: AbortSignal.timeout(4000), redirect: 'error'
    });
    if (!response.ok) return 'unavailable';
    const result = await response.json();
    if (result.success === true && result.hostname === security.host && result.action === 'login') return 'passed';
    return result['error-codes']?.some(code => ['internal-error', 'invalid-input-secret', 'missing-input-secret'].includes(code))
      ? 'unavailable' : 'retry';
  } catch {
    return 'unavailable';
  }
}

export function createLoginThrottle(now) {
  const events = [];
  return (kind, account, source) => {
    const at = now();
    while (events.length && events[0].at <= at - minute) events.shift();
    if ((!source && events.filter(row => row.kind === kind && !row.source).length >= 80) ||
        events.length >= 4096 ||
        events.filter(row => row.kind === kind && row.account === account).length >= 8 ||
        (source && (events.filter(row => row.kind === kind && row.source === source).length >= 24 ||
          events.filter(row => row.kind === kind && row.source === source && row.account === account).length >= 6)))
      return false;
    events.push({ at, kind, account, source });
    return true;
  };
}

export function createSourceLimit({ maximum, windowMs, clock = Date.now }) {
  const counts = new Map();
  let pruneAt = 0;
  return key => {
    const now = clock();
    if (now >= pruneAt || counts.size >= 2048) {
      for (const [source, count] of counts) if (count.until <= now) counts.delete(source);
      pruneAt = now + windowMs;
    }
    const slot = counts.get(key);
    if (slot?.until > now) {
      if (slot.count >= maximum) return false;
      slot.count++;
    } else {
      if (!slot && counts.size >= 2048) return false;
      counts.set(key, { count: 1, until: now + windowMs });
    }
    return true;
  };
}

function encodeSeed(seed) {
  let value = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of seed) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += base32[(value >> bits) & 31];
    }
  }
  return encoded;
}

export function authenticatorCode(seed, counter) {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', seed).update(step).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function matchingStep(seed, code, at, lastStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(at / 30_000);
  return [step, step - 1, step + 1].find(counter =>
    counter >= 0 && counter > lastStep && equalText(authenticatorCode(seed, counter), code)) ?? null;
}

function encryptSeed(key, seed, employeeId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(employeeId));
  return Buffer.concat([iv, cipher.update(seed), cipher.final(), cipher.getAuthTag()]).toString('hex');
}

function decryptSeed(key, value, employeeId) {
  const bytes = Buffer.from(value, 'hex');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(employeeId));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
}

export function newAuthenticator(email) {
  const seed = randomBytes(20);
  const setupKey = encodeSeed(seed);
  const label = encodeURIComponent('ID 业务管理系统:' + email);
  const params = new URLSearchParams({ secret: setupKey, issuer: 'ID 业务管理系统', algorithm: 'SHA1', digits: '6', period: '30' });
  return { seed, setupKey, uri: 'otpauth://totp/' + label + '?' + params };
}

const recoveryDigest = (key, employeeId, code) => createHmac('sha256', key)
  .update('recovery\0' + employeeId + '\0' + code).digest('hex');

export function bindAuthenticator(key, employee, seed, code, at) {
  const lastStep = matchingStep(seed, code, at);
  if (lastStep === null) return null;
  const codes = Array.from({ length: 8 }, () => randomBytes(12).toString('hex').match(/.{6}/g).join('-').toUpperCase());
  employee.mfa = {
    seed: encryptSeed(key, seed, employee.id), lastStep,
    recovery: codes.map(value => recoveryDigest(key, employee.id, value.replaceAll('-', '')))
  };
  return codes;
}

export function useAuthenticator(key, employee, code, at, { recovery = false } = {}) {
  if (!key || !employee.mfa || typeof code !== 'string' || code.length > 32) return null;
  const seed = decryptSeed(key, employee.mfa.seed, employee.id);
  const lastStep = matchingStep(seed, code, at, employee.mfa.lastStep);
  if (lastStep !== null) {
    employee.mfa.lastStep = lastStep;
    return 'authenticator';
  }
  const candidate = code.replaceAll('-', '').toUpperCase();
  if (!recovery || !/^[0-9A-F]{24}$/.test(candidate)) return null;
  const digest = recoveryDigest(key, employee.id, candidate);
  const index = employee.mfa.recovery.findIndex(value => equalText(value, digest));
  if (index < 0) return null;
  employee.mfa.recovery.splice(index, 1);
  return 'recovery';
}
