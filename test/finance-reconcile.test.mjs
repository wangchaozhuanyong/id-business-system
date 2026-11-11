import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { demoClock, demoOrders } from '../server/finance/reconcile-demo.mjs';
import { reconcileOrders } from '../server/finance/reconcile-orders.mjs';

const find = (report, id) => report.orders.find((order) => (order.orderId ?? order.id) === id);
const run = (input) => reconcileOrders(input, { clock: demoClock });

test('迁移前按原币逐笔对账，留存历史版本和旧快照，待回款不抵减成本', () => {
  const input = demoOrders();
  find(input.commerce, 'QA-BANK').costConfirmed = false;
  const before = structuredClone(input);
  const report = run(input);
  assert.deepEqual(report.counts, { ready: 4, pending: 1, excluded: 0 });
  const old = find(report, 'QA-NO-FX');
  assert.equal(old.snapshotKind, null);
  assert.deepEqual(old.original.paid, { amount: '5000', currency: 'CLP' });
  assert.match(old.pendingReasons.join(), /缺少有效汇率快照/);
  assert.equal(old.calculations.CNY.profit, undefined);

  const bank = find(report, 'QA-BANK');
  assert.deepEqual(bank.original.customerRefunds.total, { amount: '70', currency: 'CNY' });
  assert.deepEqual(bank.original.bankReturns.total, { amount: '200', currency: 'PHP' });
  assert.equal(bank.calculations.CNY.profit, '73.2400');
  assert.equal(bank.calculations.MYR.profit, '45.7750');

  const pending = find(report, 'QA-APPLE-PENDING');
  const received = find(report, 'QA-APPLE-RECEIVED');
  assert.deepEqual(pending.original.apple.pending, { amount: '7', currency: 'USD' });
  assert.deepEqual(pending.original.apple.received, { amount: '0', currency: 'USD' });
  assert.equal(pending.calculations.CNY.profit, '13.8000');
  assert.deepEqual(received.original.apple.received, { amount: '7', currency: 'USD' });
  assert.equal(received.calculations.CNY.recoveredCost, '40.3200');
  assert.equal(received.calculations.CNY.profit, '54.1200');

  const idr = find(report, 'QA-IDR');
  assert.deepEqual(idr.original.actualCost, { amount: '100000', currency: 'IDR' });
  assert.equal(idr.calculations.CNY.profit, '120.0000');
  assert.equal(idr.calculations.MYR.profit, '60.0000');
  assert.deepEqual([bank.feeRuleVersion, received.feeRuleVersion, idr.feeRuleVersion], [1, 2, 3]);
  assert.deepEqual(input, before);
});

test('缺失账本和明细不当成零，错误银行卡及 Apple 流水阻止核算', () => {
  const input = demoOrders();
  const bank = find(input.commerce, 'QA-BANK');
  delete bank.refunds;
  bank.bankReturns[0].cardId = 'other-card';
  input.appleBalance.movements = input.appleBalance.movements.filter(({ id }) => id !== 'qa-apple-posted');
  const report = run(input);
  const checkedBank = find(report, 'QA-BANK');
  assert.equal(checkedBank.original.customerRefunds.total, null);
  assert.equal(checkedBank.original.bankReturns.total, null);
  assert.equal(checkedBank.calculations.CNY.profit, undefined);
  assert.match(checkedBank.pendingReasons.join(), /零笔和未导出.*原付款银行卡/);

  const apple = find(report, 'QA-APPLE-RECEIVED');
  assert.equal(apple.original.apple.received, null);
  assert.equal(apple.calculations.CNY.profit, undefined);
  assert.match(apple.pendingReasons.join(), /实际到账流水无法对应/);
  delete input.appleBalance;
  assert.match(find(run(input), 'QA-APPLE-PENDING').pendingReasons.join(), /缺少 Apple/);
});

test('汇率窗口、缺币种、原始证据和孤立流水各自报告', () => {
  const input = demoOrders();
  const bank = find(input.commerce, 'QA-BANK');
  bank.start = '2026-11-04T12:00';
  const idr = find(input.commerce, 'QA-IDR');
  delete idr.fxSnapshot.rates.MYR;
  idr.notes = 'do-not-export-this';
  const apple = find(input.commerce, 'QA-APPLE-PENDING');
  apple.receiptConfirmed = false;
  input.appleBalance.movements.push({
    id: 'orphan', orderId: 'not-exported', kind: 'order-charge'
  });
  const report = run(input);
  assert.match(find(report, 'QA-BANK').pendingReasons.join(), /有效期/);
  const partial = find(report, 'QA-IDR');
  assert.equal(partial.calculations.CNY.status, 'ready');
  assert.match(partial.calculations.MYR.reason, /缺少 MYR/);
  assert.match(find(report, apple.id).pendingReasons.join(), /实收待确认/);
  assert.match(report.batchIssues.join(), /未导出的原订单/);
  assert.doesNotMatch(JSON.stringify(report), /do-not-export-this|fixture-wallet|fixture-card/);
});

test('Apple 重复到账或同编号跨单会阻止以流水合计抵减成本', () => {
  const input = demoOrders();
  const movement = input.appleBalance.movements.at(-1);
  input.appleBalance.movements.push({ ...movement });
  input.appleBalance.refunds.at(-1).id = input.appleBalance.refunds[0].id;
  const report = run(input);
  for (const id of ['QA-APPLE-PENDING', 'QA-APPLE-RECEIVED']) {
    const order = find(report, id);
    assert.match(order.pendingReasons.join(), /重复/);
    assert.equal(order.original.apple.received, null);
    assert.equal(order.calculations.CNY.profit, undefined);
  }
});

test('CLI 可重复运行虚构批次和隔离 JSON，并区分待核算及输入失败的退出状态', () => {
  const cli = fileURLToPath(new URL('../server/finance/reconcile-cli.mjs', import.meta.url));
  const call = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input, encoding: 'utf8'
  });
  const demo = call(['--demo']);
  assert.equal(demo.status, 0, demo.stderr);
  assert.deepEqual(JSON.parse(demo.stdout), run(demoOrders()));
  const strict = call(['--strict', '--as-of', new Date(demoClock).toISOString()], JSON.stringify(demoOrders()));
  assert.equal(strict.status, 2, strict.stderr);
  assert.equal(strict.stdout, demo.stdout);
  const bad = call([], 'invalid JSON');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /有效 JSON/);
});
