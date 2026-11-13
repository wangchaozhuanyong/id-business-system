import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createOrderExpenseHandler, orderExpenseDomain } from '../server/finance/expense-receipts.mjs';

test('a competing order correction invalidates an expense calculated from the old cost', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtime, 'expense-concurrency-'));
  const database = join(directory, 'fixture.sqlite');
  const first = createLocalBusinessStore(database), second = createLocalBusinessStore(database);
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const original = { id: 'synthetic-order', orderNo: 'SYN-EXPENSE', version: 1, product: 'GPT', plan: 'Plus',
    source: '历史入库', customerId: 'synthetic-customer', payment: '银行卡', paidConfirmed: true,
    paidAmount: '20', paidCurrency: 'USD', saleAmount: '150', saleCurrency: 'CNY', receiptConfirmed: true,
    costBasis: 'actual', actualCostAmount: '100', actualCostCurrency: 'CNY', refunds: [], bankReturns: [], corrections: [] };
  first.saveBatch([{ domain: 'commerce', version: 0, data: { orders: [original],
    customers: [{ id: 'synthetic-customer' }], tenants: [], rentBatches: [], operating: [], logs: [] } }]);
  let armed = true;
  const raced = new Proxy(first, { get(target, key) {
    if (key !== 'load') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    return domain => {
      const snapshot = target.load(domain);
      if (armed && domain === 'commerce') {
        armed = false;
        const current = second.load('commerce'), row = current.data.orders[0], previous = structuredClone(row);
        for (const field of ['corrections', 'refunds', 'bankReturns']) delete previous[field];
        row.actualCostAmount = '50'; row.version++;
        row.corrections.push({ id: 'synthetic-cost-correction', reason: '核对实际成本', previous, versionAfter: row.version });
        second.saveBatch([{ domain: 'commerce', ...current, action: '更正订单' }]);
      }
      return snapshot;
    };
  } });
  const handler = createOrderExpenseHandler({ store: raced, publicOrigin: 'http://audit.invalid',
    clock: () => Date.parse('2026-11-05T00:00:00Z') });
  const command = { action: 'record', version: 0, entry: { category: 'fx-fee', chargedOn: '2026-11-01',
    source: 'Synthetic bank', reference: 'SYN-RECEIPT', amount: '80', currency: 'CNY',
    orderNo: 'SYN-EXPENSE', accountingMode: 'included' } };
  const request = Readable.from([Buffer.from(JSON.stringify(command))]);
  request.method = 'POST'; request.headers = { host: 'audit.invalid', origin: 'http://audit.invalid', 'content-type': 'application/json' };
  let status, response;
  await handler(request, { writeHead(code) { status = code; }, end(value) { response = JSON.parse(value); } },
    { id: 'synthetic-admin', role: 'super', name: 'Synthetic administrator' });
  assert.equal(status, 409, JSON.stringify(response));
  assert.deepEqual(first.featureDocument(orderExpenseDomain), { version: 0, data: null });
  assert.equal(first.load('commerce').data.orders[0].actualCostAmount, '50');
});

test('an expense already included in cost also blocks a conflicting later order correction', t => {
  const store = createLocalBusinessStore(':memory:'); t.after(() => store.close());
  const order = { id: 'synthetic-order', version: 1, product: 'GPT', payment: '银行卡',
    paidAmount: '20', paidCurrency: 'USD', paidConfirmed: true, saleAmount: '150', saleCurrency: 'CNY',
    costBasis: 'actual', actualCostAmount: '100', actualCostCurrency: 'CNY', refunds: [], corrections: [] };
  store.saveBatch([{ domain: 'commerce', version: 0, data: { orders: [order], customers: [], tenants: [],
    operating: [], rentBatches: [], logs: [] } }]);
  store.saveFeatureDocument(orderExpenseDomain, 0, { items: [{ id: 'synthetic-expense', orderId: order.id,
    category: 'fx-fee', accountingMode: 'included', amount: '80', currency: 'CNY', chargedOn: '2026-11-01' }] });
  const snapshot = store.load('commerce');
  const correction = amount => {
    const next = structuredClone(snapshot), row = next.data.orders[0], previous = structuredClone(row);
    delete previous.corrections; delete previous.refunds;
    row.actualCostAmount = amount; row.version++;
    row.corrections.push({ id: 'synthetic-correction', previous, reason: '核对成本凭据', versionAfter: row.version });
    return { domain: 'commerce', ...next, action: '更正订单' };
  };
  assert.throws(() => store.saveBatch([correction('50')]), { status: 409 });
  assert.deepEqual(store.load('commerce'), snapshot);
  store.saveBatch([correction('200')]);
  assert.equal(store.load('commerce').data.orders[0].actualCostAmount, '200');
  assert.equal(store.featureDocument(orderExpenseDomain).data.items[0].amount, '80');
});
