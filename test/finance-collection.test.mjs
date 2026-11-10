// Pure fixture tests: no website, SQLite database or external provider is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createFinanceCollection } from '../server/finance/collection-service.mjs';
import { collectionDomain, defaults, validateSettings, quoteId, cleanupPlan, hour, day } from '../server/finance/collection-policy.mjs';
import { createFinanceCollectionHandler } from '../server/finance/collection-route.mjs';
import { createFinanceQuoteService } from '../server/finance/quote-service.mjs';
import { automaticProvider, calculateOrder } from '../modules/finance/accounting.mjs';

const initial = Date.parse('2026-11-07T09:00:00Z');
const actor = { id: 'fixture-admin', name: '合成管理员', role: 'admin' };
function providerResponse(now, overrides = {}) {
  return Response.json({ result: 'success', base_code: 'CNY', time_eol_unix: 0,
    time_last_update_unix: (now - hour) / 1000, time_next_update_unix: (now + 23 * hour) / 1000,
    rates: { CNY: 1, MYR: 0.625, USD: 0.125, PHP: 8, CLP: 125, IDR: 2500, EGP: 6.25 }, ...overrides });
}
const order = () => ({ id: 'fixture-order', start: '2026-11-07T16:30', product: 'GPT', payment: '银行卡',
  paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY', refunds: [], bankReturns: [],
  costBasis: 'standard', costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3' },
  issueFeeSnapshot: { applied: true, amountUsd: '0.5' } });
function fixture({ provider = automaticProvider.id, fetcher } = {}) {
  let now = initial, document = { version: 0, data: null }, calls = 0;
  const audits = [], timers = [], commerce = { version: 0, data: { orders: [] } };
  const store = {
    featureDocument(domain) { assert.equal(domain, collectionDomain); return structuredClone(document); },
    saveFeatureDocument(domain, version, data, audit) {
      assert.equal(domain, collectionDomain);
      if (version !== document.version || (audit.commerceVersion !== undefined && audit.commerceVersion !== commerce.version))
        throw Object.assign(new Error('版本冲突'), { status: 409 });
      document = { version: version + 1, data: structuredClone(data) }; audits.push(audit);
      return structuredClone(document);
    },
    load(domain) { assert.equal(domain, 'commerce'); return structuredClone(commerce); }
  };
  const options = { store, provider, clock: () => now, fetchQuote: async (...args) => {
    calls++; return fetcher ? fetcher(now, ...args) : providerResponse(now);
  }, setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cleared = true; } };
  const collection = createFinanceCollection(options);
  return { collection, options, store, audits, timers, commerce, calls: () => calls,
    advance: amount => { now += amount; }, replace: data => { document = { version: document.version + 1, data: structuredClone(data) }; } };
}
const input = settings => { const { version, ...values } = settings; return values; };

test('设置严格校验支持币种、来源、频率及保留范围，配置版本与运行版本独立', async () => {
  for (const change of [{ currencies: [] }, { currencies: ['USD', 'USD'] }, { currencies: ['EUR'] }, { intervalMinutes: 1 },
    { quoteRetentionDays: 0 }, { runRetentionDays: 366 }, { retryAttempts: 4 }, { provider: 'untrusted' }, { extra: true }])
    assert.throws(() => validateSettings({ ...input(defaults()), ...change }));
  const f = fixture();
  await f.collection.collect('manual', actor);
  const before = f.collection.read().data.settings;
  assert.equal(before.version, 1);
  f.collection.saveSettings(1, { ...input(before), intervalMinutes: 360 }, actor);
  assert.equal(f.collection.read().data.settings.version, 2);
  const change = f.collection.view({ tab: 'settings-history' }).rows[0];
  assert.equal(change.before.intervalMinutes, 1440);
  assert.equal(change.after.intervalMinutes, 360);
  assert.equal(change.actorId, actor.id);
  assert.throws(() => f.collection.saveSettings(1, input(before), actor), /已更新/);
  assert.equal(f.calls(), 1);
});

test('来源默认关闭，管理员配置后生效；暂停自动采集仍可查看及手动采集', async () => {
  const f = fixture({ provider: 'disabled' });
  const quoteService = createFinanceQuoteService({ collection: f.collection });
  assert.equal(quoteService.enabled, false);
  await assert.rejects(f.collection.collect(), /启用/);
  f.collection.saveSettings(1, { ...input(defaults()), provider: automaticProvider.id, enabled: false }, actor);
  assert.equal(quoteService.enabled, true);
  await assert.rejects(f.collection.collect('automatic'), /暂停/);
  await f.collection.collect('manual', actor);
  assert.equal(f.calls(), 1);
  assert.equal(f.collection.view().validCount, 6);
  assert.equal(f.collection.view({ currency: 'EGP' }).rows[0].rate, '0.16000000');
  assert.equal(f.collection.view().nextExpiryAt, new Date(initial + 23 * hour).toISOString());
});

test('精确报价、相同批次去重与采集任务留痕，普通重复点击不重复取价', async () => {
  const f = fixture({ fetcher: () => providerResponse(initial) });
  await Promise.all([f.collection.collect('manual', actor), f.collection.collect('manual', actor)]);
  let d = f.collection.read().data;
  assert.equal(f.calls(), 1); assert.equal(d.runs.length, 1); assert.equal(d.quotes.length, 1);
  assert.equal(d.quotes[0].rates.IDR, '0.00040000');
  assert.equal(d.runs[0].status, 'updated');
  await assert.rejects(f.collection.collect('manual', actor), /一小时/);
  f.advance(hour);
  await f.collection.collect('manual', actor);
  d = f.collection.read().data;
  assert.equal(d.quotes.length, 1); assert.equal(d.runs.length, 2);
  assert.equal(d.runs[0].status, 'unchanged');
  assert.equal(d.runs[0].updatedCount, 0);
  assert(d.quotes[0].lastSeenAt > d.quotes[0].fetchedAt);
});

test('只采集选中币种；无关币种缺失不阻止本单冻结，必要币种缺失明确待核算', async () => {
  const f = fixture({ fetcher: now => providerResponse(now, { rates: { CNY: 1, MYR: 0.625, USD: 0.125, PHP: 8 } }) });
  f.collection.saveSettings(1, { ...input(defaults(automaticProvider.id)), currencies: ['USD', 'MYR', 'PHP'] }, actor);
  const snapshot = await f.collection.snapshotFor(order());
  assert(!('IDR' in snapshot.rates)); assert.equal(snapshot.rates.USD, '8.00000000');
  assert.equal(f.collection.verifySnapshot(snapshot, order()), true);
  assert.equal(calculateOrder({ ...order(), fxSnapshot: snapshot }).status, 'ready');
  assert.equal(f.collection.read().data.runs[0].status, 'updated');
  assert.equal(f.collection.verifySnapshot({ ...snapshot, rates: { ...snapshot.rates, USD: '2' } }, order()), false);
  const another = { ...order(), paidCurrency: 'CLP' };
  await assert.rejects(f.collection.snapshotFor(another), /未包含.*CLP/);
});

test('失败保留原报价，错误脱敏，部分结果独立标记，不拼接不同时点的订单报价', async () => {
  let failure = false;
  const f = fixture({ fetcher: now => {
    if (failure) throw new Error('synthetic-secret-must-not-appear');
    return providerResponse(now, { rates: { CNY: 1, MYR: 0.625, USD: 0.125 } });
  } });
  await f.collection.collect();
  assert.equal(f.collection.read().data.runs[0].status, 'partial');
  assert.equal(f.collection.read().data.quotes.length, 1);
  failure = true; f.advance(60_000);
  await f.collection.collect();
  const data = f.collection.read().data;
  assert.equal(data.runs[0].status, 'failed'); assert.equal(data.quotes.length, 1);
  assert(!JSON.stringify(data).includes('synthetic-secret'));
  assert.equal(data.state.failures, 2);
  assert.equal(Date.parse(data.state.retryAt) - (initial + 60_000), 5 * 60_000);
});

test('来源限流持久冷却至少20分钟，重试为零时不会在冷却结束自动反复请求', async () => {
  const f = fixture({ fetcher: () => new Response('', { status: 429 }) });
  f.collection.saveSettings(1, { ...input(defaults(automaticProvider.id)), retryAttempts: 0 }, actor);
  await f.collection.collect();
  const d = f.collection.read().data;
  assert.equal(Date.parse(d.state.cooldownUntil), initial + 20 * 60_000);
  assert.equal(d.state.retryAt, null);
  await assert.rejects(f.collection.collect(), /冷却/);
  const restarted = createFinanceCollection(f.options);
  await assert.rejects(restarted.collect(), /冷却/);
  assert.equal(f.calls(), 1);
  restarted.start();
  assert.equal(f.timers.at(-1).delay, day);
  restarted.close();
});

test('持久任务所有权阻止第二实例并发，采集中修改配置不被旧响应覆盖', async () => {
  let release;
  const f = fixture({ fetcher: now => new Promise(resolve => { release = () => resolve(providerResponse(now)); }) });
  const first = f.collection.collect('manual', actor);
  const second = createFinanceCollection(f.options);
  await assert.rejects(second.collect(), /已有采集/);
  f.collection.saveSettings(1, { ...input(defaults(automaticProvider.id)), enabled: false, currencies: ['MYR'] }, actor);
  release(); await first;
  assert.equal(f.calls(), 1);
  assert.equal(f.collection.read().data.settings.enabled, false);
  assert.deepEqual(f.collection.read().data.settings.currencies, ['MYR']);
  assert.equal(f.collection.read().data.runs[0].currencies.length, 6);
  second.close();
});

test('重启恢复计划与中断任务；配置更新不会触发毫秒级失败循环', async () => {
  const f = fixture();
  await f.collection.collect();
  const restarted = createFinanceCollection(f.options);
  restarted.start();
  assert.equal(f.timers.at(-1).delay, 23 * hour);
  restarted.saveSettings(1, { ...input(defaults(automaticProvider.id)), schedule: 'interval', intervalMinutes: 60 }, actor);
  assert.equal(f.timers.at(-1).delay, hour);
  const state = restarted.read().data;
  state.state.active = { id: 'interrupted', expiresAt: new Date(initial - 1).toISOString() };
  state.runs.unshift({ id: 'interrupted', status: 'running', startedAt: new Date(initial - 60_000).toISOString() });
  f.replace(state); f.advance(day);
  await restarted.collect('automatic');
  assert.equal(restarted.read().data.runs.find(run => run.id === 'interrupted').status, 'failed');
  assert.equal(restarted.read().data.state.active, null);
  restarted.close();
});

test('历史补核算使用订单时点的持久报价，过期后重启仍可核对；不能用今天报价补过去', async () => {
  const f = fixture();
  const original = await f.collection.snapshotFor(order());
  f.advance(3 * day);
  const restarted = createFinanceCollection(f.options);
  const historical = await restarted.snapshotFor(order());
  assert.deepEqual(historical, original); assert.equal(f.calls(), 1);
  assert.equal(restarted.verifySnapshot(historical, order()), true);
  assert.equal(restarted.view().validCount, 0);
  await assert.rejects(restarted.snapshotFor({ ...order(), start: '2026-10-01T12:00' }), /覆盖订阅时点/);
  assert.equal(calculateOrder({ ...order(), fxSnapshot: original }, { clock: initial + 3 * day }).status, 'ready');
});

test('保留期只产生待清理预览；引用报价、旧快照凭据与运行中任务不被删除，迟到预览拒绝', () => {
  const f = fixture();
  const d = f.collection.read().data;
  const makeQuote = rate => {
    const q = { provider: automaticProvider.id, source: automaticProvider.source, at: new Date(initial - 500 * day).toISOString(),
      expiresAt: new Date(initial - 499 * day).toISOString(), fetchedAt: new Date(initial - 500 * day + hour).toISOString(), rates: { CNY: '1', USD: rate } };
    return { id: quoteId(q), ...q };
  };
  d.quotes = [makeQuote('7'), makeQuote('8')];
  d.runs = [{ id: 'old-run', status: 'failed', startedAt: new Date(initial - 100 * day).toISOString() },
    { id: 'running', status: 'running', startedAt: new Date(initial - 100 * day).toISOString() }];
  f.commerce.data.orders.push({ fxSnapshot: { quoteId: d.quotes[0].id } });
  f.replace(d);
  const preview = f.collection.planCleanup();
  assert.equal(preview.quoteCount, 1); assert.equal(preview.runCount, 1);
  assert.equal(f.collection.read().data.quotes.length, 2);
  f.commerce.data.orders.push({ fxSnapshot: { quoteId: d.quotes[1].id } });
  assert.throws(() => f.collection.cleanup(preview, actor), /范围已变化/);
  f.commerce.data.orders.pop();
  f.collection.cleanup(preview, actor);
  assert.equal(f.collection.read().data.quotes.length, 1);
  assert.equal(f.collection.read().data.runs[0].status, 'running');
  assert.equal(f.audits.at(-1).commerceVersion, f.commerce.version);
  const legacy = { fxSnapshot: { source: d.quotes[0].source, at: d.quotes[0].at } };
  assert.equal(cleanupPlan(d, [legacy], initial).quotes.length, 0);
  f.advance(6 * 60_000);
  assert.throws(() => f.collection.cleanup(f.collection.planCleanup() && preview, actor), /过期/);
});

test('查询分页、日期与结果筛选、状态汇总保留成功无变化的执行证据', async () => {
  const f = fixture({ fetcher: () => providerResponse(initial) });
  for (let i = 0; i < 10; i++) { if (i) f.advance(hour); await f.collection.collect('manual', actor); }
  const view = f.collection.view({ tab: 'runs', status: 'unchanged', page: 2, pageSize: 8 });
  assert.equal(view.total, 9); assert.equal(view.rows.length, 1); assert.equal(view.page, 2);
  assert.equal(view.metrics[0].successPercent, '100.0');
  assert.equal(f.collection.view({ tab: 'runs', query: actor.name }).total, 10);
  assert.equal(f.collection.view({ tab: 'runs', from: '2026-11-08', to: '2026-11-08' }).total, 3, '日期筛选按北京时间计算');
  assert.equal(f.collection.view({ tab: 'runs', from: '2026-11-09', to: '2026-11-09' }).total, 0);
});

test('管理接口拒绝员工、跨站、非法参数和未经预览确认的清理，不启动HTTP服务', async () => {
  const f = fixture();
  const handle = createFinanceCollectionHandler({ collection: f.collection, publicOrigin: 'https://fixture.invalid' });
  const call = async ({ actor: user = actor, method = 'GET', body, headers = {}, query = '' } = {}) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(request, { method, url: '/api/local/finance/collection' + query, headers: { host: 'fixture.invalid', ...headers } });
    let status, result;
    await handle(request, { writeHead: value => { status = value; }, end: value => { result = JSON.parse(value); } }, user);
    return { status, result };
  };
  assert.equal((await call({ actor: null })).status, 401);
  assert.equal((await call({ actor: { ...actor, role: 'employee' } })).status, 403);
  assert.equal((await call({ headers: { origin: 'https://other.invalid' } })).status, 403);
  for (const query of ['?page=-1', '?from=2026-02-31', '?tab=untrusted', '?page=1&page=2', '?currency=CNY'])
    assert.equal((await call({ query })).status, 400);
  const egypt = await call({ query: '?currency=EGP' });
  assert.equal(egypt.status, 200);
  assert.deepEqual(egypt.result.rows.map(row => row.currency), ['EGP']);
  const defaults = await call();
  assert.equal(defaults.status, 200);
  assert.equal(defaults.result.pageSize, 8);
  for (const pageSize of [8, 10, 16, 20, 32, 50]) {
    const response = await call({ query: `?pageSize=${pageSize}` });
    assert.equal(response.status, 200);
    assert.equal(response.result.pageSize, pageSize);
  }
  assert.equal((await call({ query: '?pageSize=11' })).status, 400);
  const headers = { origin: 'https://fixture.invalid', 'content-type': 'application/json' };
  assert.equal((await call({ method: 'POST', body: { action: 'collect' } })).status, 403);
  assert.equal((await call({ method: 'POST', headers, body: { action: 'cleanup', confirm: false } })).status, 400);
  assert.equal(f.calls(), 0);
});

test('后台定时器无需浏览器即可执行首轮采集，关闭后不再读取或写入', async () => {
  const f = fixture();
  f.collection.start();
  assert.equal(f.calls(), 0);
  const first = f.timers.at(-1);
  first.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  assert.equal(f.collection.read().data.runs[0].mode, 'automatic');
  assert.equal(f.collection.read().data.runs[0].status, 'updated');
  assert.equal(f.timers.at(-1).delay, 23 * hour);
  f.collection.close();
  const version = f.collection.read().version;
  first.fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.collection.read().version, version);
  assert.equal(f.calls(), 1);
});

test('暂停状态重启也会恢复遗留任务状态，但不产生新的行情请求', async () => {
  const f = fixture();
  const d = f.collection.read().data;
  d.settings.enabled = false;
  d.state.active = { id: 'paused-interrupted', expiresAt: new Date(initial + 30_000).toISOString() };
  d.runs.push({ id: 'paused-interrupted', status: 'running', startedAt: new Date(initial).toISOString() });
  f.replace(d); f.collection.start();
  assert.equal(f.timers.at(-1).delay, 30_000);
  f.advance(31_000); f.timers.at(-1).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.collection.read().data.runs[0].status, 'failed');
  assert.equal(f.calls(), 0);
  f.collection.close();
});

test('普通失败最多三次后台重试，耗尽后等待下一轮计划，不形成请求循环', async () => {
  const f = fixture({ fetcher: () => { throw new Error('fixture network failure'); } });
  f.collection.start();
  f.timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve));
  for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
    assert.equal(f.timers.at(-1).delay, delay);
    f.advance(delay); f.timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(f.calls(), 4);
  assert.equal(f.collection.read().data.state.failures, 4);
  assert.equal(f.collection.read().data.state.retryAt, null);
  assert.equal(f.timers.at(-1).delay, day);
  f.collection.close();
});
