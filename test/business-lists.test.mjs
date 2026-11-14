import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { businessListQuery, readInventoryPage, readOrdersPage } from '../server/business-lists.mjs';
import { employeeCommerce, financeCommerce, retailAccess } from '../server/access-roles.mjs';
import { handleLocalBusiness } from '../server/local-business.mjs';

const at = Date.parse('2026-11-14T02:00:00Z');
const order = (id, fields = {}) => ({
  id: 'order-' + id, orderNo: '测试-' + id, product: 'Claude Pro', plan: 'Pro', customerId: 'customer',
  email: 'order' + id + '@example.test', start: '2026-11-01 12:00', expiry: '2026-12-01 12:00',
  payment: '银行卡', saleCurrency: 'CNY', saleAmount: '200', paidCurrency: 'CNY', paidAmount: '80',
  businessType: '首次开通', costBasis: 'actual', actualCostAmount: '80', actualCostCurrency: 'CNY',
  source: '管理员手工', version: 1, refunds: [], ...fields
});
const customer = { id: 'customer', name: '隔离样本客户' };
const document = orders => ({ orders, customers: [customer], tenants: [], operating: [], rentBatches: [], logs: [] });
const orderQuery = (filters = {}) => ({ product: 'Claude', tab: 'all', page: 1, pageSize: 20, ...filters });
const inventoryQuery = (filters = {}) => ({ type: 'google', tab: 'all', page: 1, pageSize: 20, ...filters });

test('order pages bound a ten thousand row document and preserve time ordering, counts and filtered pages', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => order(index + 1, {
    createdAt: '2026-11-01 11:00', notes: '合成备注'.repeat(200)
  }));
  rows[0] = { ...rows[0], cancelled: true, refunds: [{ amount: '10', at: '2026-11-02 23:00' }] };
  rows[1] = { ...rows[1], customerId: '', plan: 'Max 5x', refunds: [{ amount: '50', at: '2026-11-12 23:00' }] };
  const options = { snapshot: { version: 27, data: document(rows) }, at };
  const first = readOrdersPage(orderQuery(), options);
  assert.deepEqual(first.counts, { all: 9999, pending: 1, refunded: 2, cancelled: 1 });
  assert.equal(first.rows.length, 20);
  assert.equal(first.rows[0].id, 'order-10000');
  assert.equal(first.rows.at(-1).id, 'order-9981');
  assert.equal(first.rows[0].list.customer, customer.name);
  assert.equal(first.rows[0].list.expiry, '有效');
  assert(!JSON.stringify(first).includes('order-9979'));
  const last = readOrdersPage(orderQuery({ page: 9999, pageSize: 50 }), options);
  assert.equal(last.page, 200);
  assert.equal(last.rows.length, 49);
  assert.equal(last.rows.at(-1).id, 'order-2');
  const refunds = readOrdersPage(orderQuery({ tab: 'refunded' }), options);
  assert.deepEqual(refunds.rows.map(row => row.id), ['order-2', 'order-1']);
  const filter = readOrdersPage(orderQuery({ tab: 'pending', plan: 'Max 5x', query: '待补充客户' }), options);
  assert.deepEqual(filter.rows.map(row => row.id), ['order-2']);
  assert.deepEqual(readOrdersPage(orderQuery({ query: 'no results' }), options).rows, []);
});

test('order list preserves scoped search, accounting and current owner without returning correction bodies', () => {
  const rows = [
    order(1, { ownerId: 'employee-a', proCardNumber: '4000000000123456', proCardSerial: 'synthetic-card-sequence',
      paidConfirmed: true, receiptConfirmed: true, notes: 'synthetic-private-note',
      corrections: [{ previous: { notes: 'synthetic-correction-secret' } }] }),
    order(2, { ownerId: 'employee-b', notes: 'synthetic-other-record' })
  ];
  const snapshot = { version: 2, data: document(rows) };
  const owners = [{ id: 'employee-a', name: '新归属名称' }];
  const admin = readOrdersPage(orderQuery({ query: '新归属名称', operation: '使用中' }), { snapshot, owners, at, managers: true });
  assert.equal(admin.total, 1);
  assert.equal(admin.rows[0].list.gain, '120.0000');
  assert(!JSON.stringify(admin).includes('synthetic-correction-secret'));
  const finance = financeCommerce(snapshot);
  const account = readOrdersPage(orderQuery({ query: '4000000000123456' }), { snapshot: finance, at });
  assert.equal(account.total, 0);
  const financePage = readOrdersPage(orderQuery(), { snapshot: finance, at });
  assert.equal(financePage.rows.find(row => row.id === 'order-1').list.gain, admin.rows[0].list.gain);
  assert(!JSON.stringify(financePage).includes('synthetic-card-sequence'));
  const employee = employeeCommerce(snapshot, { id: 'employee-a' });
  const employeePage = readOrdersPage(orderQuery(), { snapshot: employee, at });
  assert.deepEqual(employeePage.rows.map(row => row.id), ['order-1']);
  assert(!JSON.stringify(employeePage).includes('synthetic-other-record'));
  assert(!JSON.stringify(employeePage).includes('synthetic-private-note'));
});

test('inventory filtering includes registration labels, health and legacy status with bounded detail', () => {
  const mailboxes = [
    { id: 'registered', type: 'google', email: 'registered@example.test', inventoryState: 'used', notes: '已实际使用',
      usageLinks: [{ kind: 'registration', accountId: 'gpt-account', product: 'GPT' }], inventoryHistory: [{ detail: '历史正文' }] },
    { id: 'ready', type: 'google', email: 'ready@example.test', country: '马来西亚' },
    { id: 'dead', type: 'google', email: 'dead@example.test', health: 'dead' },
    { id: 'microsoft', type: 'microsoft', email: 'ms@example.test', auxiliary: 'ready@example.test',
      mailboxUsage: 'available', microsoftSecurity: { recoveryAccess: 'inventory', recoveryMailboxId: 'ready' } }
  ];
  const snapshot = { version: 8, data: { mailboxes, accounts: [
    { id: 'gpt-account', type: 'gpt', email: 'registered@example.test' },
    { id: 'claude-old', type: 'claude', registered: '2026-11-01 10:00', status: '冻结', health: 'normal',
      source: '历史入库', importId: 'batch', claudeHistory: { phase: 'aging' }, inventoryHistory: [{ action: 'Claude 历史入库' }] },
    { id: 'claude-new', type: 'claude', registered: '2026-11-13 16:00' }
  ], tableSettings: [['claude', { countries: ['马来西亚'], hours: 72 }]] } };
  const used = readInventoryPage(inventoryQuery({ tab: 'used', query: 'ChatGPT' }), snapshot, {}, at);
  assert.deepEqual(used.rows.map(row => row.id), ['registered']);
  assert.equal(used.rows[0].list.platformLabel, 'ChatGPT');
  assert.equal(used.stockTotal, 3);
  assert.equal(used.counts.dead, 1);
  assert(!JSON.stringify(used).includes('历史正文'));
  const ms = readInventoryPage(inventoryQuery({ type: 'microsoft', query: 'ready@example.test', usage: 'available' }), snapshot, {}, at);
  assert.equal(ms.rows[0].list.recoveryLinked, true);
  const claude = readInventoryPage(inventoryQuery({ type: 'claude', tab: 'available' }), snapshot, {}, at);
  assert.equal(claude.total, 2);
  assert.equal(claude.available, 1);
  assert.equal(claude.rows.find(row => row.id === 'claude-old').list.operationalStatus, '正常');
});

test('page endpoints enforce role, origin, bounded filters and read-only methods', async () => {
  const origin = 'https://synthetic.invalid';
  const admin = { id: 'admin', role: 'admin' };
  const store = { businessList: (domain, query, actor) => ({ domain, query, role: actor.role }) };
  async function call(domain, actor, payload, { method = 'POST', source = origin } = {}) {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(request, { method, headers: { origin: source, 'content-type': 'application/json' } });
    const headers = {};
    let status, body;
    await handleLocalBusiness(request, { setHeader(key, value) { headers[key] = value; },
      writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } },
    '/api/local/' + domain, store, actor, { publicOrigin: origin });
    return { status, body, headers };
  }
  for (const role of ['finance', 'employee']) {
    const actor = { id: role, role };
    assert.equal(retailAccess(actor, '/api/local/commerce/page', 'POST'), true);
    assert.equal(retailAccess(actor, '/api/local/commerce/page', 'PUT'), false);
    assert.equal((await call('inventory/page', actor, inventoryQuery())).status, 403);
    const response = await call('commerce/page', actor, orderQuery());
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
  }
  assert.equal((await call('commerce/page', { role: 'registrar' }, orderQuery())).status, 403);
  assert.equal((await call('inventory/page', admin, inventoryQuery(), { method: 'GET' })).status, 405);
  assert.equal((await call('inventory/page', admin, inventoryQuery(), { source: 'https://other.invalid' })).status, 403);
  assert.equal((await call('inventory/page', admin, inventoryQuery({ pageSize: 51 }))).status, 400);
  assert.equal((await call('commerce/page', admin, orderQuery({ query: 'x'.repeat(501) }))).status, 400);
  assert.equal(businessListQuery('commerce/page', orderQuery({ ownerId: 'other-role' })), undefined);
});
