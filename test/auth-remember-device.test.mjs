import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, writeFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';
import { openLocalSessionStore } from '../server/local-auth-sessions.mjs';
const day = 86400000, origin = 'https://auth.example.test';
const credentials = { email: 'owner@example.test', name: '测试管理员', password: 'fixture-only-long-password' };
async function fixture(t) {
  const dir = await mkdtemp(new URL('../.runtime/auth-device-', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'accounts.json'), events = [];
  await initializeLocalAdmin(path, credentials);
  let time = Date.UTC(2026, 0, 1);
  const options = { publicUrl: new URL(origin), now: () => time, onEvent: event => events.push(event) };
  let auth = createLocalAuth(path, options);
  async function call(route, { cookie, body, method = body ? 'POST' : 'GET', foreign = false } = {}) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.url = '/api/local/auth' + route; request.method = method;
    request.headers = { host: 'auth.example.test', origin: foreign ? 'https://other.test' : origin,
      'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120.0',
      ...(cookie ? { cookie } : {}) };
    let status, data; const headers = {};
    const response = { setHeader(k, v) { headers[k] = v; }, writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); } };
    await auth.handle(request, response);
    return { status, data, headers, cookie: headers['Set-Cookie']?.split(';', 1)[0] };
  }
  return { dir, path, events, call, advance: value => { time += value; }, at: () => time,
    restart: () => { auth = createLocalAuth(path, options); },
    login: (remember, extra = {}) => call('/login', { body: { ...credentials, ...(remember === undefined ? {} : { remember }), ...extra } }) };
}
test('remembered activity renews 30-day idle expiry, survives restart and stops at 90 days', async t => {
  const f = await fixture(t), login = await f.login(true), cookie = login.cookie;
  assert.equal(login.status, 200);
  assert.match(login.headers['Set-Cookie'], /__Host-id_session=.*HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
  const created = f.at();
  for (const days of [29, 29, 29]) {
    f.advance(days * day); f.restart();
    const result = await f.call('/activity', { cookie, body: {} });
    assert.equal(result.status, 200);
    assert.equal(result.data.expiresAt, Math.min(f.at() + 30 * day, created + 90 * day));
    assert(result.cookie === cookie);
  }
  f.advance(3 * day);
  assert.equal((await f.call('/activity', { cookie, body: {} })).status, 401);
  assert.equal((await f.call('/session', { cookie })).data.reason, 'expired');
});
test('reads and background polling never renew idle expiry, normal login stays eight hours', async t => {
  const f = await fixture(t), remembered = (await f.login(true)).cookie;
  f.advance(29 * day);
  for (let n = 0; n < 3; n++) assert((await f.call('/session', { cookie: remembered })).data.actor);
  assert.equal((await f.call('/devices', { cookie: remembered })).data.items[0].expiresAt, f.at() + day);
  f.advance(day);
  assert.equal((await f.call('/session', { cookie: remembered })).data.actor, null);
  const normal = await f.login();
  assert.match(normal.headers['Set-Cookie'], /Max-Age=28800/);
  f.advance(7 * 3600000);
  const activity = await f.call('/activity', { cookie: normal.cookie, body: {} });
  assert.match(activity.headers['Set-Cookie'], /Max-Age=3600/);
  f.advance(3600000);
  assert.equal((await f.call('/activity', { cookie: normal.cookie, body: {} })).status, 401);
});
test('devices expose only safe metadata; revoking another device preserves this session', async t => {
  const f = await fixture(t), a = (await f.login(true)).cookie, b = (await f.login(true)).cookie;
  const items = (await f.call('/devices', { cookie: a })).data.items;
  assert.equal(items.length, 2); assert(items[0].current);
  assert.deepEqual(Object.keys(items[0]).sort(), ['absoluteExpiresAt', 'createdAt', 'current', 'device', 'expiresAt', 'id', 'lastUsedAt', 'remembered'].sort());
  const result = await f.call('/devices/' + items[1].id, { cookie: a, method: 'DELETE' });
  assert.equal(result.status, 200); assert.equal(result.data.current, false);
  assert.equal((await f.call('/activity', { cookie: b, body: {} })).status, 401);
  assert((await f.call('/session', { cookie: a })).data.actor);
  assert(f.events.some(event => event.action === 'auth_session_revoke'));
  assert.equal((await f.call('/devices/' + items[0].id, { cookie: a, method: 'DELETE', foreign: true })).status, 403);
  const removed = await f.call('/devices/' + items[0].id, { cookie: a, method: 'DELETE' });
  assert.equal(removed.data.current, true); assert.match(removed.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal((await f.call('/activity', { cookie: a, body: {} })).status, 401);
});
test('device IDs never authorize another account; password, role and disable revoke remembered sessions', async t => {
  const f = await fixture(t), owner = (await f.login(true)).cookie;
  const staff = { email: 'employee@example.test', name: '测试员工', role: 'employee', password: 'fixture-employee-password' };
  let employee = (await f.call('/employees', { cookie: owner, body: staff })).data.employee;
  for (const change of [{ password: 'fixture-changed-password' }, { role: 'admin' }, { active: false }]) {
    const session = (await f.call('/login', { body: { ...staff, remember: true } })).cookie;
    assert(session);
    const id = (await f.call('/devices', { cookie: session })).data.items[0].id;
    assert.equal((await f.call('/devices/' + id, { cookie: owner, method: 'DELETE' })).status, 404);
    const changed = await f.call('/employees/' + employee.id, { method: 'PATCH', cookie: owner, body: { version: employee.version, ...change } });
    assert.equal(changed.status, 200); employee = changed.data.employee;
    if (change.password) staff.password = change.password;
    assert.equal((await f.call('/session', { cookie: session })).data.reason, 'revoked');
    assert.equal((await f.call('/activity', { cookie: session, body: {} })).status, 401);
  }
});
test('logout is durable across restart, malformed options and cross-site renewal are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.login('yes')).status, 400);
  const cookie = (await f.login(true)).cookie;
  assert.equal((await f.call('/activity', { cookie, body: {}, foreign: true })).status, 403);
  assert.equal((await f.call('/logout', { cookie, body: {} })).status, 200);
  f.restart();
  assert.equal((await f.call('/activity', { cookie, body: {} })).status, 401);
  assert.equal((await f.call('/devices')).status, 401);
});
test('legacy stored sessions retain their deadline and acquire revocable non-secret device IDs', async t => {
  const f = await fixture(t), login = await f.login(), token = login.cookie.split('=')[1];
  const digest = createHash('sha256').update(token).digest('hex');
  const store = openLocalSessionStore(f.path + '.sessions'), row = store.get(digest);
  store.update(digest, () => ({ employeeId: row.employeeId, version: row.version, expiresAt: row.expiresAt }));
  f.advance(3600000); f.restart();
  const item = (await f.call('/devices', { cookie: login.cookie })).data.items[0];
  assert.equal(item.remembered, false); assert.equal(item.expiresAt, row.expiresAt);
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal((await f.call('/activity', { cookie: login.cookie, body: {} })).data.expiresAt, row.expiresAt);
});
test('session files remain private, reject links and cannot be resurrected by a stale update', async t => {
  const f = await fixture(t), login = await f.login(true), dir = f.path + '.sessions';
  const store = openLocalSessionStore(dir), digest = (await readdir(dir))[0], row = store.get(digest);
  assert.equal((await stat(join(dir, digest))).mode & 0o077, 0);
  store.update(digest, current => ({ ...current, lastUsedAt: current.lastUsedAt + 1 }));
  assert.equal((await stat(join(dir, digest))).mode & 0o077, 0);
  store.delete(digest);
  assert.equal(store.update(digest, () => row), undefined);
  const outside = join(f.dir, 'outside.json');
  await writeFile(outside, JSON.stringify(row), { mode: 0o600 });
  await symlink(outside, join(dir, digest));
  assert.equal(store.get(digest), undefined);
  assert.equal(store.update(digest, () => row), undefined);
  assert.equal((await f.call('/session', { cookie: login.cookie })).data.actor, null);
});

test('temporary account or session-directory outage is an error and never clears the cookie', async t => {
  const f = await fixture(t), cookie = (await f.login(true)).cookie;
  for (const path of [f.path, f.path + '.sessions']) {
    await rename(path, path + '.offline');
    const result = await f.call('/session', { cookie });
    assert.equal(result.status, 500);
    assert.equal(result.headers['Set-Cookie'], undefined);
    await rename(path + '.offline', path);
    assert((await f.call('/session', { cookie })).data.actor);
  }
});
