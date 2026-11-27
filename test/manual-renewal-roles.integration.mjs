import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

test('authenticated host serves finance and admins only their own renewal records, workspaces and addresses', { timeout: 30_000 }, async t => {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(new URL('renewal-role-qa-', runtime));
  const authPath = join(dir, 'staff.json'), canonical = new URL('https://renewal-role.example.test');
  const fixture = role => ({ name: '隔离测试 ' + role, email: role + '@example.test', password: randomUUID() });
  const superAdmin = fixture('super');
  const restricted = ['employee', 'supervisor', 'registrar'];
  const initialDirectory = process.cwd();
  const initialEnvironment = process.env;
  let server;
  t.after(async () => {
    try {
      if (server) {
        const closed = new Promise(done => server.close(done));
        server.closeAllConnections();
        await closed;
      }
    } finally {
      process.chdir(initialDirectory);
      process.env = initialEnvironment;
      await rm(dir, { recursive: true, force: true });
    }
  });
  // startPreview resolves private login settings from the environment and site observations from cwd.
  process.chdir(dir);
  process.env = { HOME: dir, TMPDIR: dir, TZ: 'UTC' };
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('External requests are disabled in this fixture'); });
  const { initializeLocalAdmin } = await import('../server/local-auth.mjs');
  const { startPreview } = await import('../server/preview.mjs');
  await initializeLocalAdmin(authPath, superAdmin);
  const preview = await startPreview(0, {
    authPath, databasePath: ':memory:', publicOrigin: canonical.origin, manualWorkspaceSocket: join(dir, 'unstarted.sock'),
    storefrontAdmissionDirectory: null, monitoringProbeSecret: null, monitoringWorkerReceiptsDirectory: null,
    monitoringBackupReceiptsDirectory: null, rechargePartnerEnabled: false, rechargeOrderSync: false
  });
  server = preview.server;
  const loopback = new URL(preview.url);
  assert.equal(loopback.hostname, '127.0.0.1');
  const call = (path, cookie, method = 'GET', body) => new Promise((resolve, reject) => {
    const target = new URL(path, loopback);
    assert.equal(target.origin, loopback.origin);
    const req = httpRequest(target, { method, agent: false, signal: AbortSignal.timeout(5000),
      headers: { Host: canonical.host, ...(cookie && { Cookie: cookie }), ...(method !== 'GET' && { Origin: canonical.origin }),
        ...(body && { 'Content-Type': 'application/json' }) } }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';', 1)[0],
          text, json: () => JSON.parse(text) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject).end(body && JSON.stringify(body));
  });
  async function login(account) {
    const r = await call('/api/local/auth/login', null, 'POST', { email: account.email, password: account.password });
    assert.equal(r.status, 200); assert.ok(r.cookie);
    return r.cookie;
  }
  const root = await login(superAdmin);
  const sessions = { super: root };
  let secondFinance;
  for (const role of ['admin', 'finance', ...restricted]) {
    const account = fixture(role);
    const result = await call('/api/local/auth/employees', root, 'POST', { ...account, role });
    assert.equal(result.status, 201);
    sessions[role] = await login(account);
    if (role === 'finance') secondFinance = await login(account);
  }
  assert.ok(sessions.finance !== secondFinance);
  const address = '/api/local/bitbrowser-addresses', base = '/api/local/native-browser-workbench';
  const list = base + '?action=renewals', save = base + '?action=renewal-record';
  const form = { email: 'subscription@example.test', status: 'pending_renewal', currentPlan: '', renewalNotes: '' };
  const marker = /<body\s[^>]*\bdata-manual-remote-workspaces(?:\s|>|=)/i;
  assert.equal(marker.test((await call('/')).text), false);
  for (const [role, cookie] of Object.entries(sessions)) {
    const allowed = ['super', 'admin', 'finance'].includes(role);
    const home = await call('/', cookie);
    assert.equal(home.status, 200);
    assert.equal(marker.test(home.text), allowed);
    const versions = JSON.parse(decodeURIComponent(home.text.match(/<meta name="id-data-versions" content="([^"]+)"/)[1]));
    assert.equal(Object.hasOwn(versions, 'manual-renewal-records'), allowed);
    assert.equal(Object.hasOwn(versions, 'bitbrowser-addresses'), allowed);
    assert.equal((await call(list, cookie)).status, allowed ? 200 : 403);
    assert.equal((await call(address, cookie)).status, allowed ? 200 : 403);
  }
  for (const role of ['finance', ...restricted]) {
    const cookie = sessions[role];
    for (const [path, method] of [[base, 'GET'], [base + '?action=preferences', 'GET'],
      [base + '?action=renewals&action=preferences', 'GET'], [base + '?action=preferences&action=renewals', 'GET'],
      [base + '?action=update-json', 'POST'], [base + '?action=launch', 'POST'],
      ['/api/local/bitbrowser-connections', 'GET'], ['/api/local/bitbrowser-proxies', 'GET'],
      ['/api/local/bitbrowser-login-windows', 'POST'], ['/integrations/bitbrowser/local-login', 'GET'],
      ['/integrations/native-workbench/prototype', 'GET'], [address + ':another-operator', 'GET']]) {
      assert.equal((await call(path, cookie, method, method === 'POST' ? {} : undefined)).status, 403, method + ' ' + path);
    }
  }
  for (const role of restricted) {
    assert.equal((await call(save, sessions[role], 'POST', form)).status, 403, role + ' may not register a renewal');
    assert.equal((await call(address, sessions[role], 'PUT', { count: 1 })).status, 403, role + ' may not manage addresses');
  }
  assert.equal((await call(address, sessions.finance, 'POST', { count: 1 })).status, 403);
  assert.equal((await call(address, sessions.finance, 'PUT', { count: 1, ownerId: 'other' })).status, 400);
  const ads = await call(address, sessions.finance, 'PUT', { count: 1 });
  assert.equal(ads.status, 200);
  const addr = ads.json().items[0];
  assert.equal((await call(address, secondFinance)).json().total, 1);
  assert.equal((await call(address, sessions.admin)).json().total, 0);
  assert.equal((await call(address, sessions.admin, 'PUT', { id: addr.id, expectedStatus: 'unused', status: 'used' })).status, 404);
  assert.equal((await call(address, secondFinance, 'PUT', { id: addr.id, expectedStatus: 'unused', status: 'used' })).status, 200);
  const created = await call(save, sessions.finance, 'POST', form);
  assert.equal(created.status, 200);
  const { record } = created.json();
  const edit = { id: record.id, expectedRevision: record.revision, status: 'active', currentPlan: 'plus', renewalNotes: '已人工确认' };
  assert.equal((await call(save, sessions.admin, 'POST', edit)).status, 404);
  assert.equal((await call(save, secondFinance, 'POST', edit)).status, 200);
  const listed = (await call(list, sessions.finance)).json();
  assert.equal(listed.summary.statuses.active, 1);
  assert.deepEqual(listed.summary.plans, [{ name: 'plus', count: 1 }]);
  assert.equal((await call(list, sessions.admin)).json().total, 0);
  const workspace = '/manual-workspaces/' + record.id + '/';
  for (const cookie of [sessions.finance, secondFinance]) assert.equal((await call(workspace, cookie)).status, 200);
  assert.equal((await call(workspace, sessions.admin)).status, 404);
  for (const role of restricted) {
    assert.equal((await call(workspace, sessions[role])).status, 403, role + ' may not view a workspace');
    assert.equal((await call(workspace + 'open', sessions[role], 'POST')).status, 403, role + ' may not open a workspace');
  }
  assert.equal((await call(workspace)).status, 401);
  const adminRecord = (await call(save, sessions.admin, 'POST', form)).json().record;
  assert.equal((await call('/manual-workspaces/' + adminRecord.id + '/', sessions.admin)).status, 200);
  assert.equal((await call('/manual-workspaces/' + adminRecord.id + '/', sessions.finance)).status, 404);
  assert.equal(network.mock.callCount(), 0, 'all fixture traffic used the loopback host');
});
