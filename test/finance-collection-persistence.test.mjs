// Run only in the approved remote isolated CI environment, not on the user's Mac.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';
import { collectionDomain, defaults } from '../server/finance/collection-policy.mjs';

test('采集文档持久写入、乐观版本及订单引用事务保护，员工不收到采集版本', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const actor = { id: 'fixture-finance-admin', name: '合成管理员', role: 'admin' };
  const document = { settings: defaults(), quotes: [], runs: [], settingChanges: [], state: {} };
  const saved = store.saveFeatureDocument(collectionDomain, 0, document, { action: '修改汇率采集设置', actor });
  assert.equal(saved.version, 1);
  assert.deepEqual(store.featureDocument(collectionDomain).data, document);
  assert.equal(store.changeVersions(actor)['finance-rates'], '1');
  assert(!('finance-rates' in store.changeVersions({ ...actor, role: 'employee' })));
  assert.throws(() => store.saveFeatureDocument(collectionDomain, 0, document), /已更新/);
  assert.throws(() => store.saveFeatureDocument(collectionDomain, 1, document, { commerceVersion: 100 }), /订单报价引用/);
  assert.equal(store.featureDocument(collectionDomain).version, 1);
  assert.equal(store.audit().filter(row => row.domain === collectionDomain).length, 1);
});

test('实际HTTP管理入口鉴权、配置回读与持久采集记录，行情请求使用隔离替身', { timeout: 20_000 }, async t => {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('fx-collection-http-', runtime));
  const authPath = join(directory, 'accounts.json');
  const email = 'finance-collection@example.test', password = 'FixtureFxCollectionCredential2468!';
  await initializeLocalAdmin(authPath, { email, name: '合成管理员', password });
  let calls = 0;
  const host = await startPreview(0, { databasePath: ':memory:', authPath, financeFetch: async () => {
    calls++;
    return Response.json({ date: new Date().toISOString().slice(0, 10),
      cny: { cny: 1, myr: 0.625, usd: 0.125, php: 8, clp: 125, idr: 2500 } });
  } });
  t.after(async () => {
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = new URL(host.url).origin, endpoint = origin + '/api/local/finance/collection';
  assert.equal((await fetch(endpoint)).status, 401);
  const login = await fetch(origin + '/api/local/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { cookie, origin, 'content-type': 'application/json' };
  const read = () => fetch(endpoint, { headers }).then(response => response.json());
  assert.equal((await fetch(endpoint, { headers: { cookie, origin: 'https://unrelated.invalid' } })).status, 403);
  assert.equal(calls, 0);
  const current = await read(), { version, ...settings } = current.settings;
  const save = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'settings', version,
    settings: { ...settings, provider: 'exchange-rate-api-open', enabled: false, currencies: ['USD', 'MYR', 'PHP'] } }) });
  assert.equal(save.status, 200);
  const run = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'collect' }) });
  assert.equal(run.status, 200);
  assert.equal(calls, 1);
  const loaded = await read();
  assert.equal(loaded.validCount, 3);
  assert.equal(loaded.settings.enabled, false);
  assert.equal(loaded.settings.version, 2);
  assert.equal(loaded.latest.status, 'updated');
  assert.equal((await fetch(endpoint + '?tab=runs', { headers }).then(response => response.json())).total, 1);
});
