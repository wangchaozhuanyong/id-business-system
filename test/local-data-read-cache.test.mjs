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
  await api.savedTotpCode('synthetic');
  await api.tenantCardAction({ action: 'reveal', tenantId: 'fixture' });
  await api.orderSync({ mode: 'preview' });
  assert.equal(api.queries.peek('overview', 'fixture').stale, false);
  await api.save('inventory', 0, { mailboxes: [], accounts: [], batches: [] }, { action: 'fixture-save' });
  assert.equal(api.queries.peek('inventory', 'fixture').stale, true);
  assert.equal(api.queries.peek('overview', 'fixture').stale, true);
  assert.equal(api.queries.peek('audit', 'fixture').stale, true);
  assert.equal(api.queries.peek('commerce', 'fixture').stale, false);
  assert.equal(api.queries.peek('tools/mailbox-pool', 'fixture').stale, false);
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
  const { api, window, document } = client();
  const calls = { inventory: 0, commerce: 0, apple: 0 };
  let failCommerce = false;
  const A = {
    $: () => null,
    state: { route: 'overview', drafts: new Map() },
    modules: {
      inventory: {
        refreshOverview: async () => { calls.inventory++; return true; },
        overviewSummary: () => ({ generation: calls.inventory })
      },
      commerce: {
        refreshOverview: async () => { calls.commerce++; return !failCommerce; },
        overviewSummary: () => ({ generation: calls.commerce })
      },
      appleBalance: {
        refreshLocalBalance: async () => { calls.apple++; return true; },
        listRefunds: () => [{ status: 'pending' }]
      }
    },
    canVisit: () => true,
    render() {},
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
    date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    finance: true, apple: true
  };
  await revisit();
  assert.deepEqual(calls, { inventory: 1, commerce: 1, apple: 1 });
  await revisit();
  assert.deepEqual(calls, { inventory: 1, commerce: 1, apple: 1 });
  overview.onClick('overview-refresh');
  await flush();
  assert.deepEqual(calls, { inventory: 2, commerce: 2, apple: 2 });
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
  await revisit();
  assert.deepEqual(calls, { inventory: 5, commerce: 5, apple: 5 });
  failCommerce = false;
  A.canVisit = (route) => route !== 'accounts/apple-balances';
  await revisit();
  assert.deepEqual(calls, { inventory: 6, commerce: 6, apple: 5 });
  await revisit();
  assert.deepEqual(calls, { inventory: 6, commerce: 6, apple: 5 });
  assert.equal(api.queries.peek('overview', { ...key, apple: false }).stale, false);
});
