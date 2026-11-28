import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeRechargeAdapter } from '../modules/recharge/codexdaichong/native-adapter.mjs';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES } from '../modules/recharge/codexdaichong/native-routing.mjs';
import { createManualRoutingClient } from '../modules/recharge/codexdaichong/manual-routing-client.mjs';
import { createManualRouteTickets } from '../modules/recharge/codexdaichong/manual-routing-service.mjs';
import { createLocalBusinessStore, readJson } from '../server/local-business.mjs';
import { manualRechargeWindowId } from '../server/manual-browser-records.mjs';
import { createManualRechargeHandler, manualRechargePrefix } from '../server/manual-recharge-workspace.mjs';

const actor = { id: 'operator-a', role: 'admin', active: true };
const other = { ...actor, id: 'operator-b' };
const email = 'member@example.test';
const origin = 'http://127.0.0.1:4400';

function isolatedStore(t) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  return store;
}

test('connected window and optional note survive a restart of the encrypted business store', async t => {
  const parent = new URL('../.runtime/', import.meta.url);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('window-store-', parent));
  const file = join(directory, 'fixture.sqlite');
  const runId = randomUUID(), notes = '仅用于重启回归的备注';
  let store = createLocalBusinessStore(file);
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const id = store.stageManualBrowser({ email, plan: 'pro100', runId, notes }, actor);
  store.markManualBrowserConnected(id, runId, actor);
  store.close();
  store = null;
  const fileBytes = await readFile(file);
  for (const text of [email, notes]) assert.equal(fileBytes.includes(Buffer.from(text)), false);
  store = createLocalBusinessStore(file);
  const { items } = store.listManualBrowserWindows(new URLSearchParams(), actor);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].email, items[0].plan, items[0].notes], [email, 'pro100', notes]);
});

test('only actual connections publish a window; edits, deletion and repeated callbacks retain the operator boundary', t => {
  const store = isolatedStore(t);
  const list = (owner = actor, query = '') => store.listManualBrowserWindows(new URLSearchParams(query), owner);
  const stage = (notes, owner = actor) => {
    const runId = randomUUID();
    const id = store.stageManualBrowser({ runId, email, plan: 'plus', notes }, owner);
    return { id, runId, connect: () => store.markManualBrowserConnected(id, runId, owner) };
  };
  const a = stage('第一次备注');
  assert.equal(list().total, 0);
  assert.throws(() => store.markManualBrowserConnected(a.id, a.runId, other), { status: 409 });
  a.connect();
  const original = list().items[0];
  a.connect();
  assert.deepEqual(list().items[0], original);
  assert.equal(list(other).total, 0);
  assert.equal(list(actor, 'search=' + encodeURIComponent('备注')).total, 1);
  assert.equal(store.manualBrowserOwnerEmail(a.id, a.runId, other), null);

  const reopening = stage('另一个标签的旧备注');
  store.changeManualBrowserWindow({ id: a.id, revision: original.revision, notes: '最新备注' }, actor);
  reopening.connect();
  assert.equal(list().items[0].notes, '最新备注');
  const older = stage('旧运行'), newer = stage('新运行');
  newer.connect();
  older.connect();
  assert.equal(list().items[0].notes, '新运行');
  assert.throws(() => store.changeManualBrowserWindow({ id: a.id, revision: original.revision, notes: '' }, actor), { status: 409 });
  stage(undefined).connect();
  assert.equal(list().items[0].notes, '新运行');
  stage('').connect();
  assert.equal(list().items[0].notes, '');
  const pending = stage(undefined);
  store.changeManualBrowserWindow(list().items[0], actor, true);
  pending.connect();
  assert.equal(list().total, 0);
  const b = stage(undefined, other);
  assert.notEqual(b.id, a.id);
  b.connect();
  assert.equal(list(other).total, 1);
  assert.equal(list().total, 0);
  assert.throws(() => list({ ...actor, role: 'finance' }), { status: 403 });
});

test('application routes bind measurement to launch, return only display fields and fail closed for same-country IP drift', async t => {
  const store = isolatedStore(t);
  // Only the external pool, network observations and OS desktop are fixtures.
  // The application, private HTTP bridge, country/ranking rules and record storage run together.
  const observed = new Map();
  let policyVersion = 1;
  const pool = [1, 2].map(id => ({ id, is_active: 1, label_country_code: 'PH',
    proxy_url: (id === 2 ? 'socks5://' : 'http://') + 'session-{session}:' +
      randomUUID() + '@proxy.invalid:' + (8100 + id) }));
  const selector = createNativeRechargeRouting({
    store: {
      async runQuery(sql, values) {
        if (sql.includes('FROM id_recharge_route_config'))
          return [{ version: policyVersion, plans_json: DEFAULT_PLAN_ROUTES, audit_json: [] }];
        if (sql.includes('JOIN app_config') || sql.includes('FROM id_recharge_proxy_checks')) return [];
        if (sql.includes('FROM proxy_assets p LEFT JOIN'))
          return sql.includes('WHERE p.id = ?') ? pool.filter(row => row.id === values[0]) : pool;
        throw new Error('Unexpected fixture query');
      },
    },
    substituteSession: raw => raw.replace('{session}', randomUUID()),
    async probe(proxyUrl) {
      const fast = new URL(proxyUrl).port === '8102';
      const observation = { countryCode: 'PH', ip: fast ? '8.8.8.8' : '1.1.1.1', latencyMs: fast ? 32 : 180 };
      observed.set(proxyUrl, observation);
      return observation;
    },
  });
  const secret = randomBytes(32).toString('hex');
  const adapter = createNativeRechargeAdapter({ nativeUrl: 'http://127.0.0.1:1', secret,
    getNativeAdminToken: () => assert.fail('Manual work must not launch automatic recharge'),
    manualRoutes: createManualRouteTickets(selector) });
  const server = createServer(adapter.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const routes = createManualRoutingClient({ upstreamUrl: 'http://127.0.0.1:' + server.address().port, secret });
  let active = null, drift = false, stops = 0;
  const retiredEmails = [];
  const remote = {
    rechargeReady: async () => true,
    async prepareRecharge(req, spec) {
      const winner = observed.get(spec.proxyUrl);
      assert.equal(winner?.latencyMs, 32, 'desktop got the exact measured session with the lowest latency');
      assert.equal(new URL(spec.proxyUrl).protocol, 'socks5h:');
      assert.equal(spec.expectedIp, winner.ip);
      const id = manualRechargeWindowId(actor.id, spec.email);
      active = { runId: spec.runId, id, viewerUrl: '/manual-workspaces/' + id + '/?run=' + spec.runId };
      return { ...active, country: 'PH', exitIp: drift ? '1.0.0.1' : winner.ip };
    },
    rechargeOccupancy: async () => active,
    async releaseLegacyRecharge(req, { email }) { retiredEmails.push(email); },
    async releaseRecharge(req, { id, runId }) {
      assert.deepEqual([id, runId], [active.id, active.runId]);
      active = null; stops++;
    },
  };
  const handle = createManualRechargeHandler({ store, routes, remote, publicOrigin: origin, readJson });
  async function call(action, method, body, owner = actor, from = origin) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url: manualRechargePrefix + action, method, headers: { 'content-type': 'application/json', origin: from }
    });
    const result = {};
    await handle(req, { writeHead(status) { result.status = status; }, end(data) { result.data = JSON.parse(data); } }, owner, action);
    return result;
  }
  const selection = { email, plan: 'plus', proxyId: 'auto' };
  assert.equal((await call('release-legacy', 'POST', {email, id: 'untrusted'})).status, 400);
  assert.equal((await call('release-legacy', 'POST', {email}, {...actor, role: 'finance'})).status, 403);
  assert.equal((await call('release-legacy', 'POST', {email: ' ' + email.toUpperCase() + ' '})).status, 200);
  assert.deepEqual(retiredEmails, [email]);
  assert.equal((await call('probe', 'POST', selection, other, 'https://elsewhere.invalid')).status, 403);
  assert.equal((await call('probe', 'POST', { ...selection, sessionJson: '{}' })).status, 400);
  const measured = await call('probe', 'POST', selection);
  assert.equal(measured.status, 200, measured.data.error);
  assert.equal(measured.data.ip, '8.8.8.8');
  assert.equal(measured.data.protocol, 'socks5');
  assert.equal(observed.size, 2);
  const { ticket } = measured.data;
  const request = { email, plan: 'plus', ticket, notes: '核对窗口' };
  assert.equal((await call('launch', 'POST', request, other)).status, 409);
  const opened = await call('launch', 'POST', request);
  assert.equal(opened.status, 200);
  assert.ok(!JSON.stringify(opened.data).includes('proxy.invalid'));
  assert.equal((await call('launch', 'POST', request)).status, 409);
  assert.equal((await call('windows', 'GET')).data.total, 0);
  assert.equal((await call('occupancy', 'GET')).data.active.email, email);
  store.markManualBrowserConnected(active.id, active.runId, actor);
  const routeBinding = store.manualBrowserRouteBinding(active.id, active.runId, actor);
  assert.deepEqual(await routes.validate(actor, { routeBinding }), { ok: true });
  assert.throws(() => store.manualBrowserRouteBinding(active.id, active.runId, other), { status: 409 });
  assert.doesNotMatch(JSON.stringify(routeBinding), /proxy\.invalid|session-|proxyUrl/);
  const row = (await call('windows', 'GET')).data.items[0];
  assert.ok(!Object.hasOwn(row, 'routeBinding'));
  assert.equal(row.notes, request.notes);
  assert.equal((await call('window', 'PATCH', { id: row.id, revision: row.revision, notes: '' })).status, 200);
  assert.equal((await call('release', 'POST', { id: row.id, runId: active.runId })).status, 200);
  assert.equal((await call('occupancy', 'GET')).data.active, null);
  policyVersion++;
  await assert.rejects(routes.validate(actor, { routeBinding }), { status: 409 });
  drift = true;
  const second = (await call('probe', 'POST', { ...selection, email: 'next@example.test' })).data;
  assert.equal((await call('launch', 'POST', { ...request, email: 'next@example.test', ticket: second.ticket })).status, 409);
  assert.equal(active, null);
  assert.equal(stops, 2);
  assert.equal((await call('windows', 'GET')).data.total, 1);
  drift = false;
  const nextAccount = { ...selection, email: 'next@example.test' };
  const nextProbe = (await call('probe', 'POST', nextAccount)).data;
  assert.equal((await call('launch', 'POST', { ...request, email: nextAccount.email, ticket: nextProbe.ticket })).status, 200);
  store.markManualBrowserConnected(active.id, active.runId, actor);
  assert.deepEqual(new Set((await call('windows', 'GET')).data.items.map(row => row.email)), new Set([email, nextAccount.email]));
});
