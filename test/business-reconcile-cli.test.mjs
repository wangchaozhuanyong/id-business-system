import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOrderSnapshot, snapshotAction } from '../modules/finance/accounting.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const cli = fileURLToPath(new URL('../server/business-reconcile-cli.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
const asOf = '2026-11-13T13:00:00.000Z';
const actualOrder = {
  id: 'fixture-order', orderNo: 'QA-MAX', product: 'Claude Max', plan: '20x',
  businessType: '开通', source: '管理员手工', payment: '苹果内购', accountSource: '客户自有',
  start: '2026-11-08T10:00', paidAmount: '250', paidCurrency: 'USD',
  saleAmount: '2100', saleCurrency: 'CNY', actualCostAmount: '1550', actualCostCurrency: 'CNY',
  costBasis: 'actual', costSettings: { version: 4 }, paidConfirmed: false,
  receiptConfirmed: false, refunds: [], bankReturns: [], email: 'private-test@example.test'
};

const cardOrder = {
  id: 'fixture-card-order', orderNo: 'QA-GPT', version: 1, product: 'GPT', plan: 'Plus',
  businessType: '开通', source: '管理员手工', payment: '银行卡', accountSource: '客户自有',
  start: '2026-11-08T10:00', paidAmount: '100', paidCurrency: 'CNY',
  saleAmount: '200', saleCurrency: 'CNY', costBasis: 'standard',
  costSettings: { version: 4, cardPercent: '0.008', cardPerPaymentUsd: '0' },
  paidConfirmed: false, receiptConfirmed: false, refunds: [], bankReturns: []
};

async function createSnapshot(t, orders) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'audit-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'local-business.sqlite');
  const store = createLocalBusinessStore(database);
  try {
    store.saveBatch([
      { domain: 'inventory', version: 0, data: {
        mailboxes: [{ id: 'private-asset', type: 'google', email: 'private-test@example.test', password: 'private-fixture-secret' }],
        accounts: [], batches: [], registrationRecords: [], returnRecords: [], importRecords: [], tableSettings: [], undo: []
      } },
      { domain: 'commerce', version: 0, data: {
        customers: [], tenants: [], orders, operating: [], rentBatches: [], logs: []
      } },
      { domain: 'appleBalance', version: 0, data: { wallets: [], allocations: [], movements: [], refunds: [] } }
    ]);
  } finally {
    store.close();
  }
  return { directory, database };
}

const audit = (directory, ...args) => spawnSync(process.execPath, [cli, '--data-dir', directory, '--as-of', asOf, ...args],
  { encoding: 'utf8' });

test('加密恢复副本只读对账可复跑，Apple 历史缺项不吞掉已录入实际成本的 CNY 利润', async t => {
  const { directory, database } = await createSnapshot(t, [actualOrder]);
  const before = await readFile(database);
  const run = audit(directory, '--strict');
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.versions, { inventory: 1, commerce: 1, appleBalance: 1, expenseReceipts: 0 });
  assert.deepEqual(report.finance.operating.CNY, { ready: 1, pending: 0, excluded: 0, profit: '550' });
  assert.equal(report.finance.operating.MYR.pending, 1);
  assert.equal(report.finance.orders[0].calculations.CNY.status, 'pending');
  assert.deepEqual(report.finance.orders[0].operatingCalculations.CNY.items, [{
    key: 'actual-total', label: '实际总成本（退回前）', amount: '1550.0000', originalAmount: '1550.0000', originalCurrency: 'CNY'
  }]);
  assert.equal(report.apple.orders[0].debitEvidence, 'none');
  assert.equal(report.inventory.simulation.changedOnRepeat, false);
  assert.doesNotMatch(run.stdout, /private-test@example\.test|private-fixture-secret/);
  const repeated = audit(directory, '--strict');
  assert.equal(repeated.stdout, run.stdout);
  assert.deepEqual(await readFile(database), before);
  assert.deepEqual((await readdir(directory)).sort(), ['local-business.sqlite', 'local-business.sqlite.key']);
});

test('有利润但缺少开卡费分摊时严格模式报告待处理，并按订单去重', async t => {
  const { directory, database } = await createSnapshot(t, [cardOrder]);
  const store = createLocalBusinessStore(database);
  try {
    const current = store.load('commerce');
    const [order] = current.data.orders;
    order.fxSnapshot = createOrderSnapshot({
      source: '核对凭据 QA-01', at: '2026-11-08T00:00', expiresAt: '2026-11-09T00:00', rates: { MYR: '2' }
    }, order, Date.parse(asOf));
    Object.assign(order, { version: order.version + 1, updatedAt: '', updatedBy: '', updatedById: '' });
    current.data.logs.unshift({ id: 'fixture-fx', type: snapshotAction, entityId: order.id });
    store.saveBatch([{ domain: 'commerce', ...current, action: snapshotAction }]);
  } finally {
    store.close();
  }

  const before = await readFile(database);
  const run = audit(directory, '--strict');
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.outstanding, true);
  assert.equal(report.unallocatedCardFees, 1);
  assert.deepEqual(report.finance.operating.CNY, { ready: 1, pending: 0, excluded: 0, profit: '99.2' });
  assert.deepEqual(report.finance.operating.MYR, { ready: 1, pending: 0, excluded: 0, profit: '49.6' });
  assert.equal(report.finance.orders[0].operatingCalculations.CNY.cardIssueUnallocated, true);
  assert.equal(report.finance.orders[0].operatingCalculations.MYR.cardIssueUnallocated, true);
  assert.equal(audit(directory).status, 0);
  assert.deepEqual(await readFile(database), before);
});

test('邮箱和卡号可空，一次性卡费用计入两币利润且严格核对通过', async t => {
  const { directory, database } = await createSnapshot(t, [{
    ...cardOrder, costSettings: { ...cardOrder.costSettings, cardIssueUsd: '0.5' }
  }]);
  const store = createLocalBusinessStore(database);
  try {
    const current = store.load('commerce');
    const [order] = current.data.orders;
    order.fxSnapshot = createOrderSnapshot({
      source: '核对凭据 QA-02', at: '2026-11-08T00:00', expiresAt: '2026-11-09T00:00', rates: { MYR: '2', USD: '7' }
    }, order, Date.parse(asOf));
    Object.assign(order, { version: order.version + 1, updatedAt: '', updatedBy: '', updatedById: '' });
    current.data.logs.unshift({ id: 'fixture-fx', type: snapshotAction, entityId: order.id });
    store.saveBatch([{ domain: 'commerce', ...current, action: snapshotAction }]);
  } finally {
    store.close();
  }
  const run = audit(directory, '--strict');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.unallocatedCardFees, 0);
  assert.equal(report.finance.operating.CNY.profit, '95.7');
  assert.equal(report.finance.operating.MYR.profit, '47.85');
});

test('利润缺汇率时仍统计已知成本里的开卡费缺项', async t => {
  const { directory } = await createSnapshot(t, [{ ...cardOrder, saleCurrency: 'USD' }]);
  const run = audit(directory, '--strict');
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.unallocatedCardFees, 1);
  assert.equal(report.finance.orders[0].operatingCalculations.CNY.status, 'pending');
  assert.equal(report.finance.orders[0].operatingCalculations.CNY.knownCost.cardIssueUnallocated, true);
});

test('快照无待处理时严格模式成功，错误原密钥拒绝读取且不泄露输入', async t => {
  const { directory, database } = await createSnapshot(t, []);
  const clear = audit(directory, '--strict');
  assert.equal(clear.status, 0, clear.stderr);
  const report = JSON.parse(clear.stdout);
  assert.equal(report.outstanding, false);
  assert.equal(report.unallocatedCardFees, 0);
  const key = database + '.key';
  const badKey = await readFile(key);
  badKey[0] ^= 0xff;
  await writeFile(key, badKey);
  badKey.fill(0);
  const failed = audit(directory, '--strict');
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.doesNotMatch(failed.stderr, /private-fixture-secret|audit-fixture-/);
  await chmod(key, 0o644);
  assert.equal(audit(directory).status, 1);
});
