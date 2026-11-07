// Database and HTTP verification runs in the isolated CI environment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

const inventory = { mailboxes: [], accounts: [], batches: [], returnRecords: [], importRecords: [],
  registrationRecords: [], tableSettings: [], undo: [] };
const commerce = { customers: [], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] };

test('commit listeners run after commit, failed batches do not publish, and revisions are owner/role scoped', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const admin = { id: 'fixture-admin-a', role: 'admin' }, other = { id: 'fixture-admin-b', role: 'admin' };
  let notices = 0;
  store.subscribeChanges(() => { notices++; assert.equal(store.load('inventory').version, 1); });
  store.subscribeChanges(() => { throw new Error('synthetic subscriber failure'); });
  store.saveBatch([{ domain: 'inventory', version: 0, data: inventory }]);
  assert.equal(notices, 1);
  assert.equal(store.changeVersions(admin).inventory, '1');
  assert.throws(() => store.saveBatch([
    { domain: 'commerce', version: 0, data: commerce },
    { domain: 'inventory', version: 0, data: inventory }
  ]), /已/);
  assert.equal(notices, 1);
  assert.equal(store.load('commerce').version, 0);
  store.saveToolbox({ version: 0, data: { shortcuts: [], phrases: [] } }, admin);
  assert.equal(store.changeVersions(admin).toolbox, '1');
  assert.equal(store.changeVersions(other).toolbox, '0');
  const employee = store.changeVersions({ id: admin.id, role: 'employee' });
  assert.equal(employee.toolbox, '1');
  for (const scope of ['settings', 'appleBalance', 'audit', 'tenant-cards', 'apple-relay']) assert(!(scope in employee));
  assert(!JSON.stringify(employee).includes(admin.id));
});

test('authenticated clients receive the same committed revision; signed-out and cross-origin streams are rejected', { timeout: 20_000 }, async t => {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('change-sync-http-', runtime));
  const authPath = join(directory, 'accounts.json');
  const email = 'change-sync@example.test', password = 'FixtureEventPassword2468!';
  await initializeLocalAdmin(authPath, { email, name: '合成管理员', password });
  const host = await startPreview(0, { databasePath: ':memory:', authPath });
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = new URL(host.url).origin;
  const endpoint = origin + '/api/local/change-events';
  assert.equal((await fetch(endpoint)).status, 401);
  const login = await fetch(origin + '/api/local/auth/login', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(endpoint, { headers: { cookie, origin: 'https://unrelated.invalid' } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie, origin } })).status, 405);
  const open = async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(endpoint, { headers: { cookie, origin }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').startsWith('text/event-stream'));
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        assert(!chunk.done);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      assert(!frame.includes(password) && !frame.includes(email));
      return JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5));
    };
    const initial = await next();
    assert.equal(initial.versions.commerce, '0');
    return next;
  };
  const [first, second] = await Promise.all([open(), open()]);
  const result = await fetch(origin + '/api/local/commerce', {
    method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 0, data: commerce })
  });
  assert.equal(result.status, 200);
  const notifications = await Promise.all([first(), second()]);
  for (const event of notifications) {
    assert.equal(event.versions.commerce, '1');
    assert(!('inventory' in event.versions));
  }
});
