import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  automaticProvider, calculateOrder, createOrderSnapshot, snapshotAction
} from '../modules/finance/accounting.mjs';
import { createAutomaticSnapshotHandler } from '../server/finance/quote-route.mjs';
import { createFinanceQuoteService } from '../server/finance/quote-service.mjs';
import { checkFinanceSnapshots } from '../server/finance/snapshot-integrity.mjs';

const initial = Date.parse('2026-11-05T05:00:00Z');
const hour = 3_600_000;
const providerResponse = (at = initial - hour, next = initial + hour, overrides = {}) =>
  Response.json({
    result: 'success', base_code: 'CNY', time_eol_unix: 0,
    time_last_update_unix: at / 1000, time_next_update_unix: next / 1000,
    rates: { CNY: 1, MYR: 0.625, USD: 0.125, PHP: 8, CLP: 125, IDR: 2500 },
    ...overrides
  });
const newOrder = (id, start = '2026-11-05T12:30') => ({
  id, orderNo: id, version: 1, start, product: 'GPT', payment: '银行卡',
  paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
  costBasis: 'standard', costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3' },
  issueFeeSnapshot: { applied: true, amountUsd: '0.5' },
  refunds: [{ amount: '70', currency: 'CNY' }], bankReturns: [{ amount: '200', currency: 'PHP' }]
});
const serviceFor = (fetchQuote, clock = () => initial) =>
  createFinanceQuoteService({ provider: automaticProvider.id, fetchQuote, clock });

test('供应商默认关闭，未知选择报错且零网络调用', async () => {
  let calls = 0;
  const disabled = createFinanceQuoteService({ fetchQuote: async () => { calls++; } });
  await assert.rejects(disabled.snapshotFor(newOrder('one')), /尚未配置/);
  assert.throws(() => createFinanceQuoteService({ provider: 'unapproved' }), /未识别/);
  assert.equal(calls, 0);
});

test('六币种精确倒数、并发合并和缓存时效，刷新后不重算原单', async () => {
  let now = initial;
  let calls = 0;
  const service = serviceFor(async (url, { redirect, signal }) => {
    assert.equal(url, 'https://open.er-api.com/v6/latest/CNY');
    assert.equal(redirect, 'error');
    assert.ok(signal instanceof AbortSignal);
    if (++calls === 1) return providerResponse();
    return providerResponse(now - 15 * 60_000, now + hour, {
      rates: { CNY: 1, MYR: 0.5, USD: 0.125, PHP: 6, CLP: 125, IDR: 2500 }
    });
  }, () => now);
  const order = newOrder('one');
  const [first, concurrent] = await Promise.all([
    service.snapshotFor(order), service.snapshotFor(order)
  ]);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(first.rates, {
    CNY: '1', MYR: '1.60000000', USD: '8.00000000',
    PHP: '0.12500000', CLP: '0.00800000', IDR: '0.00040000'
  });
  assert.equal(first.fetchedAt, '2026-11-05T05:00:00.000Z');
  assert.equal(first.basisAt, '2026-11-05T04:30:00.000Z');
  assert.equal(service.verifySnapshot(first, order), true);
  assert.equal(service.verifySnapshot({ ...first, rates: { ...first.rates, MYR: '2' } }, order), false);
  await service.snapshotFor(order);
  assert.equal(calls, 1);
  order.fxSnapshot = first;
  const old = calculateOrder(order, { clock: now, currency: 'MYR' });
  assert.equal(old.profit, '45.3750');
  now = initial + hour;
  assert.equal(service.verifySnapshot(first, order), false);
  const newer = newOrder('two', '2026-11-05T13:55');
  newer.fxSnapshot = await service.snapshotFor(newer);
  assert.equal(newer.fxSnapshot.rates.PHP, '0.16666667');
  assert.equal(newer.fxSnapshot.rates.MYR, '2.00000000');
  assert.equal(calls, 2);
  await assert.rejects(service.snapshotFor(newOrder('historical')), /尚未生效|已过期/);
  assert.deepEqual(calculateOrder(order, { clock: now, currency: 'MYR' }), old);
});

test('缺币种、过期、未来、限流与超时均不产生快照，冷却期内不重试', async () => {
  const failures = [
    () => providerResponse(initial - 2 * hour, initial),
    () => providerResponse(initial + hour, initial + 2 * hour),
    () => providerResponse(initial - 37 * hour, initial + hour),
    () => providerResponse(initial - hour, initial + hour, { rates: { CNY: 1, MYR: 0.6 } }),
    () => new Response(null, { status: 429 }),
    () => { throw new DOMException('stub timeout', 'TimeoutError'); }
  ];
  for (const fail of failures) {
    let calls = 0;
    const service = serviceFor(async () => { calls++; return fail(); });
    const order = newOrder('pending');
    await assert.rejects(service.snapshotFor(order), /没有完整且有效/);
    await assert.rejects(service.snapshotFor(order), /没有完整且有效/);
    assert.equal(calls, 1);
    assert.equal(calculateOrder(order, { clock: initial }).status, 'pending');
  }
});

async function mount(t, quoteService) {
  let state = { version: 1, data: { orders: [newOrder('one')], logs: [] } };
  const clock = () => initial;
  const store = {
    load: () => structuredClone(state),
    saveBatch([entry], { verifyAutomaticSnapshot } = {}) {
      assert.equal(entry.version, state.version);
      const error = checkFinanceSnapshots(state.data, entry.data, {
        action: entry.action, clock: clock(), verifyAutomaticSnapshot
      });
      if (error) throw Object.assign(new Error(error), { status: 409 });
      state = { version: state.version + 1, data: structuredClone(entry.data) };
      return [store.load()];
    }
  };
  const handle = createAutomaticSnapshotHandler({ store, quoteService, clock });
  const server = createServer((req, res) => {
    void handle(req, res, { id: 'admin-a', name: '隔离操作员' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { orderId: 'one', version: 1 }, requestOrigin = origin) =>
    fetch(origin + '/api/local/finance/auto-snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
      body: JSON.stringify(body)
    });
  return { store, post };
}

test('随机回环 HTTP 仅接受同源编号与版本，冻结事务记审计并拒绝重复和伪造', async (t) => {
  let calls = 0;
  const service = serviceFor(async () => { calls++; return providerResponse(); });
  const { store, post } = await mount(t, service);
  assert.equal((await post(undefined, 'http://example.test')).status, 403);
  assert.equal((await post({ orderId: 'one', version: 1, snapshot: {} })).status, 400);
  assert.equal(calls, 0);
  const response = await post();
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.version, 2);
  assert.equal(saved.data.orders[0].fxSnapshot.kind, 'automatic');
  assert.equal(saved.data.logs[0].actorId, 'admin-a');
  assert.equal(saved.data.logs[0].type, snapshotAction);
  assert.equal((await post()).status, 409);
  assert.equal(calls, 1);
  const prior = { orders: [newOrder('one')], logs: [] };
  assert.match(checkFinanceSnapshots(prior, saved.data, { action: snapshotAction, clock: initial }), /未获服务器确认/);
});

test('自动取价进行期间手工快照可以先提交，自动请求回来时保留手工结果', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const service = serviceFor(async () => {
    started.resolve();
    return release.promise;
  });
  const { store, post } = await mount(t, service);
  const request = post();
  await started.promise;
  const state = store.load();
  const [order] = state.data.orders;
  const manual = createOrderSnapshot({
    source: '隔离账单凭据 A', at: '2026-11-05T12:00', expiresAt: '2026-11-05T15:00',
    rates: { MYR: '1.6', USD: '8', PHP: '0.125' }
  }, order, initial);
  Object.assign(order, { version: 2, fxSnapshot: manual, updatedAt: '', updatedBy: '', updatedById: '' });
  state.data.logs.unshift({ type: snapshotAction, entityId: order.id });
  store.saveBatch([{ ...state, action: snapshotAction }]);
  release.resolve(providerResponse());
  assert.equal((await request).status, 409);
  assert.deepEqual(store.load().data.orders[0].fxSnapshot, manual);
});
