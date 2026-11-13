import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createLocalAuth, initializeLocalAdmin, recoverLocalLogin } from '../server/local-auth.mjs';
import { createLoginThrottle, loadLoginSecurity, verifiedAddress } from '../server/login-security.mjs';
import { calculateTotp } from '../modules/tools/totp.mjs';

const domain = 'https://fixture.example.test';
const credentials = { email: 'security-fixture@example.test', name: '隔离测试', password: 'fixture-only-password' };
const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));

async function fixture(t, { turnstile = false } = {}) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'login-security-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountPath = join(directory, 'accounts.json');
  await initializeLocalAdmin(accountPath, credentials);
  const proxyKey = randomBytes(32).toString('hex');
  const publicUrl = new URL(domain);
  const security = loadLoginSecurity({ ID_AUTH_TRUSTED_PROXY_KEY: proxyKey,
    ID_AUTH_MFA_KEY: randomBytes(32).toString('hex'),
    ...(turnstile && { ID_TURNSTILE_SITE_KEY: 'fixture-site', ID_TURNSTILE_SECRET_KEY: 'fixture-only-secret' }) }, publicUrl);
  const events = [];
  let actualTime = Date.UTC(2026, 10, 13, 5);
  let challengeCalls = 0;
  const address = '192.0.2.10';
  const options = { publicUrl, security, now: () => actualTime, onEvent: event => events.push(event),
    turnstileFetch: async (url, options) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(options.body.get('remoteip'), address);
      challengeCalls++;
      const response = options.body.get('response');
      if (response === 'upstream-offline') throw new Error();
      return Response.json({ success: true, action: response === 'wrong-action' ? 'signup' : 'login',
        hostname: response === 'wrong-host' ? 'other.example.test' : publicUrl.hostname });
    } };
  let auth = createLocalAuth(accountPath, options);
  async function call(path, { body, cookie, ip = address, ingress = true, origin = domain, method = body ? 'POST' : 'GET' } = {}) {
    const headers = {};
    let status, data;
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    request.url = '/api/local/auth' + path;
    request.method = method;
    request.headers = { host: publicUrl.host, origin, 'content-type': 'application/json',
      ...(cookie && { cookie }), 'x-id-client-ip': ip,
      ...(ingress && { 'x-id-verified-proxy': proxyKey }), 'x-forwarded-for': address };
    Object.defineProperty(request, 'socket', { value: { remoteAddress: '127.0.0.1' } });
    const response = { setHeader(key, value) { headers[key] = value; }, getHeader(key) { return headers[key]; },
      writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); } };
    await auth.handle(request, response);
    const cookies = [].concat(headers['Set-Cookie'] || []).map(value => value.split(';', 1)[0]);
    return { status, data, headers, cookies, cookie: cookies[0] };
  }
  return { call, now: () => actualTime, advance: delta => actualTime += delta, events, accountPath, security,
    address, challengeCount: () => challengeCalls, restart: () => { auth = createLocalAuth(accountPath, options); } };
}

async function enroll(f) {
  const login = await f.call('/login', { body: credentials });
  assert.equal(login.status, 200);
  const denied = await f.call('/security/network', { cookie: login.cookie, body: { action: 'add', version: 0 } });
  assert.equal(denied.status, 403);
  const step = await f.call('/security/start', { cookie: login.cookie, body: { password: credentials.password } });
  assert.equal(step.status, 200);
  assert.match(step.data.setupKey, /^[A-Z2-7]{32}$/);
  const code = (await calculateTotp(step.data.setupKey, f.now())).code;
  const success = await f.call('/security/confirm', { cookie: login.cookie, body: { enrollment: step.data.enrollment, code } });
  assert.equal(success.status, 200);
  assert.equal(success.data.recoveryCodes.length, 8);
  assert.equal((await f.call('/session', { cookie: login.cookie })).data.actor, null);
  return { ...success, key: step.data.setupKey };
}

test('validated login challenge matches the domain and action and is consumed before password retries', async t => {
  const f = await fixture(t, { turnstile: true });
  assert.equal((await f.call('/login', { body: credentials })).status, 403);
  assert.equal(f.challengeCount(), 0);
  for (const [challenge, status] of [['wrong-host', 403], ['wrong-action', 403], ['upstream-offline', 503]]) {
    assert.equal((await f.call('/login', { body: { ...credentials, challenge } })).status, status);
  }
  const challenge = 'accepted-fixture';
  assert.equal((await f.call('/login', { body: { ...credentials, challenge } })).status, 200);
  assert.equal((await f.call('/login', { body: { ...credentials, challenge } })).status, 403);
  assert.equal(f.challengeCount(), 4);
});

test('account checks, source checks and temporary limits are bounded', () => {
  let now = 0;
  const attempt = createLoginThrottle(() => now);
  for (let n = 0; n < 8; n++) assert.equal(attempt('password', 'same', '192.0.2.' + n), true);
  assert.equal(attempt('password', 'same', '198.51.100.1'), false);
  for (let n = 0; n < 24; n++) assert.equal(attempt('password', 'different-' + n, '198.51.100.1'), true);
  assert.equal(attempt('password', 'another', '198.51.100.1'), false);
  now += 60_000;
  assert.equal(attempt('password', 'same', '198.51.100.1'), true);
});

test('one-time login needs the second factor, recovery codes are consumed, and sensitive writes require fresh verification', async t => {
  const f = await fixture(t);
  const enrolled = await enroll(f);
  const raw = await readFile(f.accountPath, 'utf8');
  assert(!raw.includes(enrolled.key));
  for (const code of enrolled.data.recoveryCodes) assert(!raw.includes(code));
  const first = await f.call('/login', { body: credentials });
  assert.equal(first.status, 202);
  assert.equal(first.cookie, undefined);
  const consumedCode = (await calculateTotp(enrolled.key, f.now())).code;
  assert.equal((await f.call('/login/verify', { body: { verification: first.data.verification, code: consumedCode } })).status, 400);
  const recovery = enrolled.data.recoveryCodes[0];
  const signedIn = await f.call('/login/verify', { body: { verification: first.data.verification, code: recovery } });
  assert.equal(signedIn.status, 200);
  assert(signedIn.cookie);
  assert.equal((await f.call('/security', { cookie: signedIn.cookie })).data.recentlyVerified, false);
  const second = await f.call('/login', { body: credentials });
  assert.equal((await f.call('/login/verify', { body: { verification: second.data.verification, code: recovery } })).status, 400);
  f.advance(31_000);
  const nextCode = (await calculateTotp(enrolled.key, f.now())).code;
  const verified = await f.call('/security/verify', { cookie: signedIn.cookie, body: { code: nextCode } });
  assert.equal(verified.status, 200);
  assert.equal((await f.call('/security', { cookie: signedIn.cookie })).data.recentlyVerified, true);
  f.advance(301_000);
  assert.equal((await f.call('/security', { cookie: signedIn.cookie })).data.recentlyVerified, false);
  assert(f.events.some(event => event.action === 'auth_mfa_bind'));
  assert(f.events.some(event => event.action === 'auth_recovery_used'));
  assert(!JSON.stringify(f.events).includes(recovery));
});

test('approved browsers and verified networks constrain existing sessions and recover independently', async t => {
  const f = await fixture(t);
  const enrolled = await enroll(f);
  const approved = await f.call('/security/device', { cookie: enrolled.cookie, body: { action: 'add-current' } });
  assert.equal(approved.status, 200);
  assert.match(approved.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Max-Age=7776000; Secure/);
  const firstBrowser = enrolled.cookie + '; ' + approved.cookie;
  assert.equal((await f.call('/security/device', { cookie: firstBrowser, body: { action: 'set-lock', enabled: true } })).status, 200);
  assert.equal((await f.call('/session', { cookie: enrolled.cookie })).data.reason, 'device');
  f.advance(31_000);
  const login = await f.call('/login', { body: credentials });
  const code = (await calculateTotp(enrolled.key, f.now())).code;
  const pending = await f.call('/login/verify', { body: { verification: login.data.verification, code } });
  assert.equal(pending.status, 202);
  assert.equal(pending.data.pendingDevice, true);
  assert(pending.cookie.startsWith('__Host-id_approved_browser='));
  const { items } = (await f.call('/security/device-requests', { cookie: firstBrowser })).data;
  assert.equal(items.length, 1);
  assert.equal((await f.call('/security/device', { cookie: firstBrowser,
    body: { action: 'approve', id: items[0].id } })).status, 200);
  assert.equal((await f.call('/security/network', { cookie: firstBrowser,
    body: { action: 'mode', mode: 'enforce', version: 0 } })).status, 409);
  assert.equal((await f.call('/security/network', { cookie: firstBrowser,
    body: { action: 'add', name: '办公室', network: '192.0.2.0/24', version: 0 } })).status, 200);
  assert.equal((await f.call('/security/network', { cookie: firstBrowser,
    body: { action: 'mode', mode: 'enforce', version: 1 } })).status, 200);
  assert.equal((await f.call('/session', { cookie: firstBrowser, ip: '198.51.100.2' })).data.reason, 'network');
  assert.equal((await f.call('/session', { cookie: firstBrowser, ingress: false })).data.reason, 'network');
  f.restart();
  assert((await f.call('/session', { cookie: firstBrowser })).data.actor);
  recoverLocalLogin(f.accountPath, { action: 'network', confirmation: 'RECOVER-LOGIN', now: f.now() });
  const result = await f.call('/security/network', { cookie: firstBrowser, ip: '198.51.100.2' });
  assert.equal(result.data.policy.mode, 'observe');
  assert.equal(result.data.lastRecovery.action, 'network');
  assert.equal((await f.call('/security', { cookie: firstBrowser })).data.deviceLock, true);
  assert.equal(verifiedAddress({ headers: { 'cf-connecting-ip': f.address }, socket: { remoteAddress: '127.0.0.1' } }, f.security), null);
});
