import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateOrder, createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { checkFinanceSnapshots, historicalFeeAction } from '../server/finance/snapshot-integrity.mjs';

const actor = { id: 'synthetic-admin', name: '合成管理员', role: 'admin' };
const originalRules = { version: 2, currency: 'CNY', cardPercent: '0.08', cardPerPaymentUsd: '0.3',
  cardIssueUsd: '0.5', appleDiscount: '0.8', claudeBankFeeMyr: '100', claudeAccountCostMyr: '50' };
const newRules = { ...originalRules, version: 3, cardPercent: '0.008' };
const order = () => ({
  id: 'synthetic-order', orderNo: 'QA-01', version: 4, product: 'GPT', payment: '银行卡',
  source: '管理员手工', costBasis: 'standard', costSettings: structuredClone(originalRules),
  paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
  paidConfirmed: true, receiptConfirmed: true, costConfirmed: true, start: '2026-11-04T10:30',
  issueFeeSnapshot: { applied: true, amountUsd: '0.5' }, refunds: [], bankReturns: [], corrections: []
});
const previous = () => ({ orders: [order()], logs: [], customers: [] });
const options = () => ({ action: historicalFeeAction, currentCostSettings: structuredClone(newRules), actor });
function correction(before = previous()) {
  const prior = before.orders[0], snapshot = structuredClone(prior);
  delete snapshot.corrections; delete snapshot.refunds; delete snapshot.bankReturns;
  const reason = '已核对本单手续费标准';
  const next = { ...structuredClone(prior), version: prior.version + 1, costSettings: structuredClone(newRules),
    updatedAt: '2026-11-10 10:00', updatedBy: actor.name, updatedById: actor.id,
    corrections: [...prior.corrections, { id: 'synthetic-correction', kind: 'historical-card-fee', verified: true,
      at: '2026-11-10 10:00', actor: actor.name, actorId: actor.id, reason,
      versionAfter: prior.version + 1, previous: snapshot }] };
  return { ...structuredClone(before), orders: [next], logs: [{ id: 'synthetic-log', type: historicalFeeAction,
    entityId: prior.id, actor: actor.name, actorId: actor.id, at: '2026-11-10 10:00', detail: `QA-01 · 原因：${reason}` }] };
}

test('逐笔更正只使用已核实的规则，保留原快照、其他金额和冻结汇率', () => {
  const before = previous();
  const clock = Date.parse('2026-11-05T05:00:00Z');
  before.orders[0].fxSnapshot = createOrderSnapshot({ source: '合成凭据', at: '2026-11-04T09:00',
    expiresAt: '2026-11-04T12:00', rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' } }, before.orders[0], clock);
  const next = correction(before);
  assert.equal(checkFinanceSnapshots(before, next, options()), '');
  assert.deepEqual(next.orders[0].corrections[0].previous.costSettings, originalRules);
  assert.deepEqual(next.orders[0].fxSnapshot, before.orders[0].fxSnapshot);
  assert.deepEqual(next.orders[0].issueFeeSnapshot, before.orders[0].issueFeeSnapshot);
  assert.equal(calculateOrder(before.orders[0], { clock }).profit, '109.2400');
  assert.equal(calculateOrder(next.orders[0], { clock }).profit, '118.2400');
});

test('拒绝未经核实、其他订单或不匹配的当前费用规则', () => {
  for (const mutate of [
    next => { next.orders[0].corrections[0].verified = false; },
    next => { next.orders[0].corrections[0].reason = ''; },
    next => { next.orders[0].corrections[0].previous.costSettings.cardPercent = '0.008'; },
    next => { next.orders[0].costSettings.cardPercent = '0.08'; },
    next => { next.orders[0].version += 1; },
    next => { next.orders[0].paidAmount = '900'; },
    next => { next.orders[0].issueFeeSnapshot.amountUsd = '0.6'; },
    next => { next.customers.push({ id: 'synthetic-customer' }); },
    next => { next.logs = []; }
  ]) {
    const before = previous(), next = correction(before);
    mutate(next);
    assert(checkFinanceSnapshots(before, next, options()));
  }
  const before = previous(), next = correction(before);
  assert(checkFinanceSnapshots(before, next, { ...options(), actor: { ...actor, role: 'employee' } }));
  assert(checkFinanceSnapshots(before, next, { ...options(), currentCostSettings: { ...newRules, cardIssueUsd: '0.6' } }));
  assert(checkFinanceSnapshots(before, next, { ...options(), currentCostSettings: { ...newRules, cardPercent: '0.08' } }));
  assert(checkFinanceSnapshots(before, next, { ...options(), action: '更正订单' }));
  for (const change of [{ product: 'Claude Pro' }, { source: '线上代充' }, { costBasis: 'actual' },
    { cancelled: true }, { costSettings: { ...originalRules, version: 1 } }]) {
    const old = previous(); Object.assign(old.orders[0], change);
    assert(checkFinanceSnapshots(old, correction(old), options()));
  }
});

test('更正记录以后不可伪造、删除、修改、重复更正或通过普通撤回覆盖', () => {
  const old = previous(), corrected = correction(old);
  const tampered = structuredClone(corrected);
  tampered.orders[0].corrections[0].previous.costSettings.cardPercent = '0.008';
  assert.match(checkFinanceSnapshots(corrected, tampered, { action: '更正订单' }), /不可覆盖/);
  const removed = structuredClone(corrected); removed.orders[0].corrections = [];
  assert.match(checkFinanceSnapshots(corrected, removed, { action: '更正订单' }), /不可覆盖/);
  const changedRule = structuredClone(corrected); changedRule.orders[0].costSettings.cardPercent = '0.08';
  assert.match(checkFinanceSnapshots(corrected, changedRule, { action: '更正订单' }), /费用规则不可覆盖/);
  const undo = structuredClone(corrected); undo.orders[0].version++;
  assert.match(checkFinanceSnapshots(corrected, undo, { action: '补偿撤回更正' }), /普通撤回/);
  assert(checkFinanceSnapshots(corrected, correction(corrected), options()));
});
