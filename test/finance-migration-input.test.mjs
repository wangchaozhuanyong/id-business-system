import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { adaptFinanceMigrationInput } from '../server/finance/migration-input.mjs';
import { migrationDemo } from '../server/finance/migration-demo.mjs';
import { demoClock } from '../server/finance/reconcile-demo.mjs';
import { reconcileOrders } from '../server/finance/reconcile-orders.mjs';

function convert(input) {
  const adapted = adaptFinanceMigrationInput(input);
  return { adapted, report: reconcileOrders(adapted, { clock: demoClock }) };
}
const orderReport = (report, id) => report.orders.find((row) => row.orderId === id);

test('旧通用订单与同编号订阅隔离，已冻结快照和金额逐笔透传', () => {
  const input = migrationDemo();
  input.orders[0].order.email = input.orders[1].order.email = 'private@example.test';
  input.orders[0].order.refundCostAmount = '7';
  const before = structuredClone(input);
  const { adapted, report } = convert(input);
  assert.equal(adapted.commerce.orders.length, 3);
  assert.equal(report.excludedLegacy.length, 1);
  assert.equal(report.excludedLegacy[0].orderId, 'QA-BANK');
  assert.deepEqual(report.excludedLegacy[0].receivedOriginal, { amount: '50.00', currency: 'MYR' });
  const order = adapted.commerce.orders[0];
  assert.deepEqual(order.fxSnapshot, input.orders[1].evidence.fxSnapshot);
  assert.notEqual(order.fxSnapshot, input.orders[1].evidence.fxSnapshot);
  assert.deepEqual(order.costSettings, {
    version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5'
  });
  assert.equal(orderReport(report, 'QA-BANK').calculations.CNY.profit, '73.2400');
  assert.doesNotMatch(JSON.stringify(adapted), /private@example|receivedFxRateToCny|refundCostAmount/);
  assert.deepEqual(input, before);
});

test('费用版本、关联、历史汇率或明细不足时停在待核算', () => {
  const input = migrationDemo();
  const bank = input.orders[1];
  bank.evidence.feeRule.version = 4;
  bank.evidence.bankReturns[0].orderId = 'different-order';
  bank.evidence.customerRefunds[0].amount = '49';
  const { adapted, report } = convert(input);
  const unknown = adapted.commerce.orders.find((row) => row.id === 'QA-UNKNOWN');
  assert.equal(unknown.fxSnapshot, undefined);
  assert.equal(unknown.costSettings, undefined);
  assert.equal(unknown.actualCostAmount, undefined);
  assert.equal(unknown.refunds, undefined, '汇总零不等于逐笔明细明确零笔');
  const reason = orderReport(report, 'QA-BANK').pendingReasons.join();
  assert.match(reason, /所用版本/);
  assert.match(reason, /原付款卡不一致/);
  assert.match(reason, /汇总.*无法对平/);
  assert.equal(orderReport(report, 'QA-BANK').calculations.CNY.profit, undefined);
  assert.match(orderReport(report, 'QA-UNKNOWN').pendingReasons.join(), /历史汇率/);

  bank.evidence.orderId = 'unrelated';
  const disconnected = convert(input);
  assert.match(orderReport(disconnected.report, 'QA-BANK').pendingReasons.join(), /补充凭据.*不一致/);
  assert.equal(disconnected.adapted.commerce.orders[0].fxSnapshot, undefined);
});

test('Apple 待回款与实际到账分别转换，错误钱包、金额与冲正类型进入待核算', () => {
  const input = migrationDemo();
  const apple = input.orders.at(-1).evidence.apple;
  const valid = convert(input);
  assert.equal(orderReport(valid.report, 'QA-APPLE-RECEIVED').original.apple.received.amount, '7');
  assert.equal(valid.adapted.appleBalance.movements.at(-1).refundId, 'qa-a2');
  apple.walletEntries.at(-1).appleAccountId = 'other-wallet';
  const unlinked = convert(input);
  assert.match(orderReport(unlinked.report, 'QA-APPLE-RECEIVED').pendingReasons.join(), /缺少对应钱包/);
  assert.equal(unlinked.adapted.appleBalance.movements.length, 1);
  apple.walletEntries.at(-1).appleAccountId = apple.allocation.appleIdId;
  apple.walletEntries.at(-1).entry.amountUsd = '8';
  assert.match(orderReport(convert(input).report, 'QA-APPLE-RECEIVED').pendingReasons.join(), /到账金额无法直接映射/);
  apple.refunds[0].returnStatus = 'reversed';
  assert.match(orderReport(convert(input).report, 'QA-APPLE-RECEIVED').pendingReasons.join(), /已撤回/);

  apple.refunds[0].returnStatus = 'pending';
  apple.refunds[0].receivedLedgerEntryId = null;
  apple.refunds[0].receivedAt = null;
  apple.walletEntries.pop();
  apple.allocation.returned = '0';
  const pending = orderReport(convert(input).report, 'QA-APPLE-RECEIVED');
  assert.equal(pending.status, 'ready');
  assert.equal(pending.original.apple.pending.amount, '7');
  assert.equal(pending.original.apple.received.amount, '0');
  assert.equal(pending.calculations.CNY.recoveredCost, '0.0000');
});

test('无来源标记及重复来源编号被拒绝，CLI 输出可直接串接核对', () => {
  const input = migrationDemo();
  assert.throws(() => adaptFinanceMigrationInput({ orders: input.orders }), /显式声明/);
  const duplicate = structuredClone(input);
  duplicate.orders.push(duplicate.orders[1]);
  assert.throws(() => adaptFinanceMigrationInput(duplicate), /订单编号重复/);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const adapter = spawnSync(process.execPath, ['server/finance/migration-input-cli.mjs', '--demo'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(adapter.status, 0, adapter.stderr);
  const reconciler = spawnSync(process.execPath, [
    'server/finance/reconcile-cli.mjs', '--strict', '--as-of', new Date(demoClock).toISOString()
  ], { cwd: root, input: adapter.stdout, encoding: 'utf8' });
  assert.equal(reconciler.status, 2, reconciler.stderr);
  const report = JSON.parse(reconciler.stdout);
  assert.deepEqual(report.counts, { ready: 2, pending: 1, excluded: 0 });
  assert.equal(report.excludedLegacy.length, 1);
});
