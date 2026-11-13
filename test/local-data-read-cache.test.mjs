import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../frontend/local-data.js', import.meta.url), 'utf8');
const overviewSource = await readFile(new URL('../frontend/overview-prototype.js', import.meta.url), 'utf8');
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function client(fetch = async () => reply({ success: true })) {
  let locked = 0;
  const window = { fetch, IDLocalAuth: { lock: () => { locked++; } } };
  const actor = { id: 'fixture-actor', role: 'admin', name: '测试操作员' };
  const document = { querySelector: (selector) => ({
    content: selector.includes('id-local-actor') ? encodeURIComponent(JSON.stringify(actor)) : 'required'
  }) };
  runInNewContext(source, { window, document, structuredClone });
  return { api: window.IDLocalData, window, document, locked: () => locked };
}

test('change revisions ignore unchanged snapshots and self writes, then invalidate only related reads', async () => {
  let version = 1;
  const { api } = client(async () => reply({ version, data: {} }));
  const changes = [];
  api.subscribeChanges(scopes => changes.push([...scopes]));
  await api.load('inventory');
  await api.queries.read('inventory', 'list', async () => ({ rows: [] }));
  await api.queries.read('commerce', 'list', async () => ({ rows: [] }));
  api.acceptChangeVersions({ inventory: '1' }, { reconcile: true });
  assert.equal(changes.length, 0);
  api.acceptChangeVersions({ inventory: '2' });
  api.acceptChangeVersions({ inventory: '2' });
  assert.deepEqual(changes, [['inventory']]);
  assert.equal(api.queries.peek('inventory', 'list').stale, true);
  assert.equal(api.queries.peek('commerce', 'list').stale, false);
  assert.equal(api.pendingChangeVersions(['inventory']).inventory, '2');
  version = 2;
  await api.load('inventory');
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['inventory'])), []);
  version = 3;
  await api.save('inventory', 2, {});
  api.acceptChangeVersions({ inventory: '3' });
  assert.equal(changes.length, 1, 'own successful write does not cause another data read');
});

test('a snapshot reconciles missed writes and an old HTTP result cannot hide a newer revision', async () => {
  let version = 1;
  const { api } = client(async () => reply({ version, data: {} }));
  const changes = [];
  api.subscribeChanges(scopes => changes.push([...scopes]));
  await api.load('commerce');
  api.acceptChangeVersions({ commerce: '1' }, { reconcile: true });
  api.acceptChangeVersions({ commerce: '3' }, { reconcile: true });
  version = 2;
  await api.load('commerce');
  assert.equal(api.pendingChangeVersions(['commerce']).commerce, '3');
  version = 3;
  await api.load('commerce');
  api.acceptChangeVersions({ commerce: '3' }, { reconcile: true });
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['commerce'])), []);
  assert(changes.every(scopes => scopes.length === 1 && scopes[0] === 'commerce'));
});

test('metadata revisions are acknowledged without accepting a later unseen change', () => {
  const { api } = client();
  api.acceptChangeVersions({ operators: 'before' });
  api.acceptChangeVersions({ operators: 'after' });
  const captured = api.pendingChangeVersions(['operators']);
  api.acceptChangeVersions({ operators: 'newer' });
  api.acknowledgeChanges(captured);
  assert.equal(api.pendingChangeVersions(['operators']).operators, 'newer');
  api.acknowledgeChanges({ operators: 'newer' });
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['operators'])), []);
  api.acceptChangeVersions({ unknown: '1', inventory: { queryCode: 'never-accepted' } });
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['unknown', 'inventory'])), []);
});

test('a committed external revision does not invalidate the HTTP read that is applying it', async () => {
  const { api } = client(async () => reply({ version: 1, items: [] }));
  await api.queries.read('recharge-codes', 'requests', () => api.rechargeCodeRequests());
  api.acceptChangeVersions({ 'recharge-codes': '1' }, { reconcile: true });
  const changes = [];
  api.subscribeChanges(scopes => changes.push([...scopes]));
  api.acceptChangeVersions({ 'recharge-codes': '1:' + 'a'.repeat(64) });
  const captured = api.pendingChangeVersions(['recharge-codes']);
  await api.queries.read('recharge-codes', 'requests', () => api.rechargeCodeRequests());
  api.acknowledgeChanges(captured);
  assert.equal(api.queries.peek('recharge-codes', 'requests').stale, false);
  assert.equal(changes.length, 1, 'the numeric document response must not re-emit an opaque source revision');
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['recharge-codes'])), []);
  await api.rechargeCodeRequests();
  assert.equal(changes.length, 1, 'a later same-document read must not undo the opaque acknowledgement');
});

test('a later external revision still supersedes an in-flight document read', async () => {
  let resolve;
  const { api } = client(() => new Promise(done => { resolve = done; }));
  api.acceptChangeVersions({ 'card-types': '2:' + 'a'.repeat(64) }, { reconcile: true });
  const captured = api.pendingChangeVersions(['card-types']);
  const reading = api.queries.read('card-types', 'list', () => api.cardTypes());
  const rejected = assert.rejects(reading, { code: 'READ_SUPERSEDED' });
  await flush();
  api.acceptChangeVersions({ 'card-types': '2:' + 'b'.repeat(64) });
  resolve(reply({ version: 2, items: [] }));
  await rejected;
  api.acknowledgeChanges(captured);
  assert.equal(api.pendingChangeVersions(['card-types'])['card-types'], '2:' + 'b'.repeat(64));
});

test('a restarted source can return to a numeric revision without invalidating its recovery read', async () => {
  const { api } = client(async () => reply({ version: 2, items: [] }));
  api.acceptChangeVersions({ 'recharge-codes': '2:' + 'a'.repeat(64) }, { reconcile: true });
  api.acknowledgeChanges(api.pendingChangeVersions(['recharge-codes']));
  api.acceptChangeVersions({ 'recharge-codes': '2' }, { reconcile: true });
  await api.queries.read('recharge-codes', 'requests', () => api.rechargeCodeRequests());
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['recharge-codes'])), []);
  assert.equal(api.queries.peek('recharge-codes', 'requests').stale, false);
});

test('subscription changes invalidate subscription views and are acknowledged once', async () => {
  const { api } = client();
  const changes = [];
  api.subscribeChanges(scopes => changes.push([...scopes]));
  await api.queries.read('subscription-management', 'list', async () => ({ items: [] }));
  api.acceptChangeVersions({ 'subscription-management': '1' }, { reconcile: true });
  api.acceptChangeVersions({ 'subscription-management': '2' });
  assert.deepEqual(changes, [['subscription-management']]);
  assert.equal(api.queries.peek('subscription-management', 'list').stale, true);
  api.acknowledgeChanges(api.pendingChangeVersions(['subscription-management']));
  api.acceptChangeVersions({ 'subscription-management': '2' }, { reconcile: true });
  assert.equal(changes.length, 1);
});

test('a lost save response reuses the exact operation identifier and payload', async () => {
  const calls = [];
  const { api, window } = client(async (_url, options) => {
    calls.push(structuredClone(options));
    if (calls.length === 1) throw new TypeError('synthetic response lost');
    return reply({ version: 2, data: {} });
  });
  window.crypto = { randomUUID: () => 'operation-synthetic-0001' };
  await api.save('commerce', 1, {}, { action: '修改资料' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].headers['X-ID-Operation'], 'operation-synthetic-0001');
});

test('clearing a rejected query cache keeps stream ordering; identity shutdown clears all tracking', async () => {
  const { api } = client(async () => reply({ version: 1, data: {} }));
  const changes = [];
  await api.load('inventory');
  api.subscribeChanges(scopes => changes.push([...scopes]));
  api.acceptChangeVersions({ inventory: '1' });
  api.queries.clear();
  api.acceptChangeVersions({ inventory: '2' });
  assert.deepEqual(changes, [['inventory']]);
  api.clearChangeTracking();
  assert.deepEqual(Object.keys(api.pendingChangeVersions(['inventory'])), []);
});

test('shared reads normalize parameters, combine requests and isolate returned snapshots', async () => {
  const { api: { queries } } = client();
  const gate = Promise.withResolvers();
  let loads = 0;
  const load = () => { loads++; return gate.promise; };
  const first = queries.read('inventory', { page: 1, filters: { state: 'active', type: 'gpt' } }, load);
  const second = queries.read('inventory', { filters: { type: 'gpt', state: 'active' }, page: 1 }, load);
  await flush();
  assert.equal(loads, 1);
  assert.equal(queries.peek('inventory', { page: 1, filters: { type: 'gpt', state: 'active' } }).pending, true);
  gate.resolve({ rows: [{ id: 'a' }] });
  const [a, b] = await Promise.all([first, second]);
  a.rows[0].id = 'changed';
  assert.equal(b.rows[0].id, 'a');
  const snapshot = queries.peek('inventory', { page: 1, filters: { state: 'active', type: 'gpt' } });
  assert.equal(snapshot.data.rows[0].id, 'a');
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.stale, false);
  snapshot.data.rows.length = 0;
  assert.equal((await queries.read('inventory', { filters: { state: 'active', type: 'gpt' }, page: 1 }, load)).rows.length, 1);
  assert.equal(loads, 1);
});

test('refresh failures preserve data and invalidation fences responses from earlier generations', async () => {
  const { api: { queries } } = client();
  const key = ['gpt', 1];
  await queries.read('inventory', key, async () => ({ version: 1 }));
  await assert.rejects(queries.read('inventory', key, async () => { throw new Error('synthetic failure'); }, { refresh: true }), /synthetic failure/);
  assert.equal(queries.peek('inventory', key).data.version, 1);
  assert.equal(queries.peek('inventory', key).stale, true);
  const oldGate = Promise.withResolvers();
  const old = queries.read('inventory', key, () => oldGate.promise);
  const rejected = assert.rejects(old, (error) => error.name === 'AbortError' && error.code === 'READ_SUPERSEDED');
  queries.invalidate('inventory');
  await queries.read('inventory', key, async () => ({ version: 3 }));
  oldGate.resolve({ version: 2 });
  await rejected;
  assert.equal(queries.peek('inventory', key).data.version, 3);
  assert.equal(queries.peek('inventory', key).stale, false);
});

test('clearing identity data prevents late reads and already queued cache hits from resurfacing', async () => {
  const { api: { queries } } = client();
  await queries.read('inventory', 'rows', async () => ({ actor: 'old' }));
  const cached = queries.read('inventory', 'rows', async () => assert.fail('clean data must not load'));
  const cachedRejected = assert.rejects(cached, { name: 'AbortError', code: 'READ_SUPERSEDED' });
  const gate = Promise.withResolvers();
  const pending = queries.read('commerce', 'rows', () => gate.promise);
  const pendingRejected = assert.rejects(pending, { name: 'AbortError', code: 'READ_SUPERSEDED' });
  queries.clear();
  await queries.read('commerce', 'rows', async () => ({ actor: 'new' }));
  gate.resolve({ actor: 'old' });
  await Promise.all([cachedRejected, pendingRejected]);
  assert.equal(queries.peek('inventory', 'rows'), undefined);
  assert.equal(queries.peek('commerce', 'rows').data.actor, 'new');
});

test('only known writes invalidate related snapshots; query POSTs and explicit reload semantics stay unchanged', async () => {
  const requests = [];
  const { api } = client(async (url, options) => {
    requests.push({ url, options });
    return reply({ items: [], success: true });
  });
  for (const scope of ['overview', 'inventory', 'commerce', 'tools/mailbox-pool', 'tools/website-analytics', 'audit'])
    await api.queries.read(scope, 'fixture', async () => ({ rows: [] }));
  await api.websiteVisits({ page: 1 });
  await api.queryManagedMailbox('MBX-synthetic', 10);
  await api.managedMailboxCodePage(['synthetic'], 0);
  await api.savedTotpCodePage(['synthetic'], 0);
  await api.tenantCardAction({ action: 'reveal', tenantId: 'fixture' });
  await api.orderSync({ mode: 'preview' });
  assert.equal(api.queries.peek('overview', 'fixture').stale, false);
  await api.save('inventory', 0, { mailboxes: [], accounts: [], batches: [] }, { action: 'fixture-save' });
  assert.equal(api.queries.peek('inventory', 'fixture').stale, true);
  assert.equal(api.queries.peek('overview', 'fixture').stale, true);
  assert.equal(api.queries.peek('audit', 'fixture').stale, true);
  assert.equal(api.queries.peek('commerce', 'fixture').stale, false);
  assert.equal(api.queries.peek('tools/mailbox-pool', 'fixture').stale, true, 'Claude 库存改变后刷新待授权邮箱投影');
  assert.equal(api.queries.peek('tools/website-analytics', 'fixture').stale, false);
  await api.saveManagedMailboxPool({ action: 'settings' });
  assert.equal(api.queries.peek('tools/mailbox-pool', 'fixture').stale, true);
  await api.load('inventory');
  await api.load('inventory');
  const reloads = requests.filter(({ url, options }) => url === '/api/local/inventory' && options.cache === 'no-store');
  assert.equal(reloads.length, 2);
});

test('authentication rejection clears cached data without retrying a protected request', async () => {
  let requests = 0;
  const { api, locked } = client(async () => { requests++; return reply({ error: '会话失效' }, 401); });
  await api.queries.read('inventory', 'fixture', async () => ({ rows: [] }));
  await assert.rejects(api.load('inventory'), { status: 401 });
  assert.equal(locked(), 1);
  assert.equal(requests, 1);
  assert.equal(api.queries.peek('inventory', 'fixture'), undefined);
});

test('permission rejection removes old protected snapshots instead of treating them as refresh fallback', async () => {
  const { api: { queries } } = client();
  await queries.read('inventory', 'fixture', async () => ({ rows: ['protected'] }));
  await assert.rejects(queries.read('inventory', 'fixture', async () => {
    throw Object.assign(new Error('权限已变化'), { status: 403 });
  }, { refresh: true }), { status: 403 });
  assert.equal(queries.peek('inventory', 'fixture'), undefined);
});

test('overview reuses a clean visit, refreshes explicitly and preserves failed sections after writes', async () => {
  const { api, window, document } = client(async resource => resource === '/api/local/recharge-codes?view=pending-summary'
    ? reply({ version: 1, pending: 0 }) : reply({ success: true }));
  const calls = { inventory: 0, commerce: 0, apple: 0 };
  const feedback = [];
  let failCommerce = false;
  let heldInventory;
  const A = {
    $: () => null,
    state: { route: 'overview', actor: api.actor(), drafts: new Map() },
    modules: {
      inventory: {
        refreshOverview: async () => { calls.inventory++; await heldInventory; return true; },
        overviewSummary: () => ({ generation: calls.inventory })
      },
      commerce: {
        refreshOverview: async () => { calls.commerce++; return !failCommerce; },
        overviewSummary: () => {
          const data = { generation: calls.commerce };
          return { commerce: data, profit: { today: data, week: data, month: data } };
        },
        overviewCustomerSummary: () => ({ generation: calls.commerce })
      },
      appleBalance: {
        refreshLocalBalance: async () => { calls.apple++; return true; },
        listRefunds: () => [{ status: 'pending' }]
      }
    },
    canVisit: () => true,
    render() {},
    async withActionFeedback(node, operation, messages) {
      const result = await operation();
      feedback.push({ result, messages });
      return result;
    },
    esc: String
  };
  window.IDDesignAPI = A;
  window.IDDesignModules = [];
  runInNewContext(overviewSource, { window, document, structuredClone, queueMicrotask, Intl });
  const overview = window.IDDesignModules[0];
  const revisit = async () => {
    A.state.route = 'elsewhere';
    A.state.route = 'overview';
    overview.afterRender({ routeChanged: true });
    await flush();
  };
  const key = {
    actor: 'fixture-actor', role: 'admin', finance: true, apple: true, rechargeRequests: true, dateBasis: 'created', currency: 'CNY'
  };
  await revisit();
  assert.deepEqual(calls, { inventory: 1, commerce: 1, apple: 1 });
  await revisit();
  assert.deepEqual(calls, { inventory: 1, commerce: 1, apple: 1 });
  overview.onClick('overview-refresh');
  await flush();
  assert.deepEqual(calls, { inventory: 2, commerce: 2, apple: 2 });
  assert.equal(feedback[0].result, true, '完整刷新才允许成功反馈');
  await api.save('inventory', 0, {});
  await revisit();
  assert.deepEqual(calls, { inventory: 3, commerce: 3, apple: 3 });
  failCommerce = true;
  overview.onClick('overview-refresh');
  await flush();
  const snapshot = api.queries.peek('overview', key);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.data.inventory.data.generation, 4);
  assert.equal(snapshot.data.commerce.data.generation, 3);
  assert.equal(snapshot.data.commerce.phase, 'error');
  assert.equal(feedback[1].result, false, '部分失败不能报告全部更新成功');
  assert.match(feedback[1].messages.failure, /部分数据/);
  await revisit();
  assert.deepEqual(calls, { inventory: 5, commerce: 5, apple: 5 });
  failCommerce = false;
  A.canVisit = (route) => route !== 'accounts/apple-balances';
  await revisit();
  assert.deepEqual(calls, { inventory: 6, commerce: 6, apple: 5 });
  await revisit();
  assert.deepEqual(calls, { inventory: 6, commerce: 6, apple: 5 });
  assert.equal(api.queries.peek('overview', { ...key, apple: false }).stale, false);

  const hold = Promise.withResolvers();
  heldInventory = hold.promise;
  const refreshing = A.modules.overview.refresh({ refresh: true });
  await flush();
  api.queries.invalidate('overview');
  heldInventory = undefined;
  hold.resolve();
  assert.equal(await refreshing, true);
  assert.deepEqual(calls, { inventory: 8, commerce: 8, apple: 5 });
  assert.equal(api.queries.peek('overview', { ...key, apple: false }).data.commerce.data.generation, 8);
});
