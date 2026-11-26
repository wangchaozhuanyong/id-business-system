import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { businessListQuery, ordersPageDomain, readOrdersPage } from '../server/business-lists.mjs';
import { customerQuery } from '../server/customer-query.mjs';
import { buildEmployeeStatistics } from '../server/employee-statistics.mjs';
import { createRuntimeSnapshot, restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { createLocalBusinessStore, readRechargeDebugCleanupDocuments } from '../server/local-business.mjs';
import { buildRechargeOrder, createRechargeOrderSync } from '../server/recharge-order-sync.mjs';
import { planRechargeDebugCleanup, readRechargeDebugEvidence } from '../server/recharge-debug-cleanup.mjs';
import { renewalSidebar } from '../server/renewal-sidebar.mjs';
import { subscriptionForOrder } from '../server/subscription-management.mjs';
import { usedRechargeCode } from './recharge-order-fixtures.mjs';

const now = Date.parse('2026-11-25T10:00:00.000Z');
const actor = { id: 'admin-fixture', role: 'super', name: '测试管理员' };
const customer = { id: 'customer-fixture', name: '真实单合成客户' };
const cleanupCli = fileURLToPath(new URL('../server/recharge-debug-cleanup-cli.mjs', import.meta.url));
const order = (id, orderNo, patch = {}) => ({
  ...buildRechargeOrder({ jobKey: id, rechargeCode: '[checkout-debug]', plan: 'Plus',
    start: '2026-11-25T09:00', expiry: '2026-11-26T09:00', completedAt: '2026-11-25T01:00:00Z' }, {}, now),
  id: 'order-' + id, orderNo: 'OD-LOCAL-' + orderNo, ...patch
});

test('调试历史只读盘点、隔离恢复与实际删除；保留资金、关联和旧单号', async t => {
  const base = fileURLToPath(new URL('../backups/', import.meta.url));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, '.recharge-debug-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data');
  const database = join(dataDir, 'local-business.sqlite');
  const store = createLocalBusinessStore(database);
  t.after(() => store.close());
  const debug = order('debug', '0062');
  const paid = order('debug-with-payment', '0061', {
    paidConfirmed: true, paidAmount: '99', paidCurrency: 'PHP',
    financialEvidence: [{ kind: 'payment', amount: '99', currency: 'PHP' }]
  });
  const linked = order('debug-with-link', '0060');
  const unknown = order('unknown', '0059', { rechargeCode: '' });
  const real = order('real', '0058', {
    rechargeCode: 'fixture-real-code', email: 'real@example.test',
    paidConfirmed: true, paidAmount: '123', paidCurrency: 'PHP', customerId: customer.id,
    previousOrderId: linked.id
  });
  store.saveBatch([{ domain: 'commerce', version: 0, data: {
    customers: [customer], tenants: [], operating: [], rentBatches: [], orders: [debug, paid, linked, unknown, real],
    logs: [{ id: 'debug-only-log', entityId: debug.id }]
  } }]);
  const forViews = documents => ({ ...documents, inventory: documents.inventory || { data: null } });
  const since = now - 24 * 3600_000;
  store.saveFeatureDocument('order-sync', 0, { since, scanOffset: 100,
    rows: [{ jobKey: debug.taskId, orderNo: debug.orderNo, needs: ['待核对'] }] });
  const client = { async get(path) {
    const jobKey = path.split('/').at(-1);
    if (jobKey === real.taskId) return { task: { jobKey, cdk: real.rechargeCode, status: 'success' } };
    if (jobKey === unknown.taskId) return { task: { jobKey, status: 'success', cdk: '' } };
    return { task: { jobKey, cdk: '[checkout-debug]', status: 'success', progress: 100 } };
  } };
  const before = readRechargeDebugCleanupDocuments(database);
  const remindersBefore = renewalSidebar(store, now);
  const verified = await readRechargeDebugEvidence(before, client);
  const plan = planRechargeDebugCleanup(before, verified);
  assert.deepEqual(plan.eligible, [{ orderNo: debug.orderNo, jobKey: debug.taskId }]);
  assert.deepEqual(plan.review.map(row => [row.orderNo, row.reason]), [
    [paid.orderNo, '存在付款、实收、成本、退款或回款记录'],
    [linked.orderNo, '存在业务关联或人工处理记录'],
    [unknown.orderNo, '原任务未证实为调试'],
    [real.orderNo, '原任务未证实为调试']
  ]);
  const requests = [];
  const native = createServer(async (request, response) => {
    requests.push([request.method, request.url]);
    const value = await client.get(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  }).listen(0, '127.0.0.1');
  t.after(() => native.close());
  await once(native, 'listening');
  const cli = async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cleanupCli,
      '--data-dir', dataDir, '--codexdaichong-url', 'http://127.0.0.1:' + native.address().port, ...args],
    { env: { ...process.env, ID_RECHARGE_BRIDGE_SECRET: 'test-fixture-'.repeat(3) }, timeout: 5000 });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await cli(), plan);
  assert.deepEqual(readRechargeDebugCleanupDocuments(database), before);
  assert.ok(subscriptionForOrder(forViews(before), debug.id, now));
  assert.ok(store.orderCompletionView(actor, new URLSearchParams(), () => []).items.some(row => row.orderNo === debug.orderNo));
  const snapshotDir = join(directory, 'snapshot');
  const restoredDir = join(directory, 'restored');
  await createRuntimeSnapshot({ dataDir, output: snapshotDir });
  const receipt = await restoreSnapshot({ input: snapshotDir, key: database + '.key', output: restoredDir, exercise: true });
  assert.equal(receipt.result, 'passed');
  const restored = readRechargeDebugCleanupDocuments(join(restoredDir, 'local-business.sqlite'));
  const removal = { verified, orderNos: new Set([debug.orderNo]), confirmation: plan.confirmation, restoredBackup: restored };
  assert.throws(() => store.removeRechargeDebugOrders({ ...removal, confirmation: '0'.repeat(64) }), /清理清单已变化/);
  assert.throws(() => store.removeRechargeDebugOrders({ ...removal, restoredBackup: {} }), /未覆盖/);
  assert.deepEqual(readRechargeDebugCleanupDocuments(database), before);
  const applied = await cli('--order-no', debug.orderNo, '--apply', plan.confirmation, '--restored-backup-dir', restoredDir);
  assert.deepEqual(applied.removed, [debug.orderNo]);
  assert.ok(requests.every(([method, path]) => method === 'GET' && path.startsWith('/api/admin/task-logs/')));
  const after = readRechargeDebugCleanupDocuments(database);
  assert.deepEqual(after.commerce.data.orders, before.commerce.data.orders.filter(row => row.id !== debug.id));
  assert.deepEqual(after.commerce.data.logs, []);
  assert.equal(after['order-sync'].data.since, since);
  assert.equal(after['order-sync'].data.orderSequenceFloor, 62);
  assert.equal(after['order-sync'].data.rows[0].excluded, true);
  assert.equal(subscriptionForOrder(forViews(after), debug.id, now), undefined);
  assert.ok(subscriptionForOrder(forViews(after), real.id, now));
  assert.equal(store.orderCompletionView(actor, new URLSearchParams(), () => []).items.some(row => row.orderNo === debug.orderNo), false);
  const params = businessListQuery(ordersPageDomain, { product: 'GPT', tab: 'pending', page: 1, pageSize: 20 });
  assert.doesNotMatch(JSON.stringify(readOrdersPage(params, { snapshot: after.commerce, managers: true, at: now })), /OD-LOCAL-0062/);
  const profile = customerQuery(forViews(after), [], 'detail', { customerId: customer.id, tab: 'orders' }, now);
  assert.match(JSON.stringify(profile), /OD-LOCAL-0058/);
  assert.doesNotMatch(JSON.stringify(profile), /OD-LOCAL-0062/);
  assert.equal(renewalSidebar(store, now).count, remindersBefore.count - 1);
  const stats = commerce => buildEmployeeStatistics({ commerce, employees: [], inventory: {}, requests: [], nativeCodes: [] },
    { date: '2026-11-25', kind: 'order', metric: 'syncedOrders', employee: 'system', page: 1, pageSize: 20 }, now);
  assert.equal(stats(before.commerce.data).total - stats(after.commerce.data).total, 1);
  assert.doesNotMatch(JSON.stringify(stats(after.commerce.data)), /OD-LOCAL-0062/);
  const sync = createRechargeOrderSync({ store, client, clock: () => now });
  await sync.runCommitted({ apply: true, jobKeys: [debug.taskId] });
  assert.deepEqual(store.load('commerce'), after.commerce);
  assert.throws(() => store.removeRechargeDebugOrders(removal), /清理清单已变化/);
  const task = { jobKey: 'next-real', cdk: 'next-real-code' };
  const next = order(task.jobKey, '0000', { rechargeCode: task.cdk });
  assert.equal(store.applyRechargeOrder({ since, row: { jobKey: task.jobKey, needs: [] }, order: next,
    admission: usedRechargeCode(task) }).orderNo, 'OD-LOCAL-0063');
});
