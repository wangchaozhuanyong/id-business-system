import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalGptCardBackfillError as check, matchesBackfilledPayment } from '../server/order-policy.mjs';
import { checkFinanceSnapshots } from '../server/finance/snapshot-integrity.mjs';

const clone = value => structuredClone(value);
const card = { id: 'recharge:synthetic', active: true, last4: '1234' };
const actor = { id: 'admin', role: 'admin' };
const prior = () => ({
  id: 'order-synthetic', product: 'GPT', source: '管理员手工', taskId: '',
  payment: '银行卡', cardId: '', paymentId: '', paidConfirmed: true, receiptConfirmed: true,
  paidAmount: '983', paidCurrency: 'PHP', saleAmount: '130', saleCurrency: 'CNY',
  costBasis: 'standard', costConfirmed: false, start: '2026-10-01T12:00',
  expiry: '2026-11-01T12:00', version: 3, updatedAt: '2026-11-01 10:00',
  issueFeeSnapshot: { cardId: '', applied: false, pending: true },
  financialEvidence: [{ kind: 'payment', payment: '银行卡', amount: '983', currency: 'PHP', cardId: '', at: '2026-11-01T00:00:00Z' }],
  refunds: [], bankReturns: [], corrections: []
});
function candidate(before = prior()) {
  const previous = clone(before);
  delete previous.corrections;
  delete previous.refunds;
  delete previous.bankReturns;
  return { ...clone(before), cardId: card.id, paymentId: card.last4, version: before.version + 1,
    cardBackfillConfirmed: true, correctionReason: '已按历史付款记录核对', updatedAt: '2026-11-10 10:00', updatedById: actor.id,
    corrections: [...(before.corrections || []), { id: 'correction-synthetic',
      kind: 'historical-card-backfill', verified: true, actorId: actor.id, at: '2026-11-10 10:00',
      reason: '已按历史付款记录核对', previous, versionAfter: before.version + 1 }] };
}
const context = (extra = {}) => ({ action: '更正订单', card, actor, changedOrderCount: 1,
  previousLogs: [], nextLogs: [{ id: 'log-synthetic', type: '更正订单', entityId: 'order-synthetic',
    actorId: actor.id, detail: '已按历史付款记录核对' }], ...extra });

test('a verified historical GPT payment may attach one original card without altering payment evidence', () => {
  const old = prior(), next = candidate(old), history = clone(old.financialEvidence);
  assert.equal(check(old, next, context()), undefined);
  assert.deepEqual(next.financialEvidence, history);
  assert.deepEqual(next.issueFeeSnapshot, old.issueFeeSnapshot);
});

test('requires explicit confirmation, current version, audit reason and a single changed order', () => {
  const old = prior();
  for (const [next, options] of [
    [{ ...candidate(old), cardBackfillConfirmed: false }, context()],
    [{ ...candidate(old), version: old.version }, context()],
    [candidate(old), context({ action: '新增独立订单' })],
    [candidate(old), context({ changedOrderCount: 2 })],
    [candidate(old), context({ nextLogs: [] })],
    [{ ...candidate(old), corrections: [] }, context()],
    [{ ...candidate(old), correctionReason: '' }, context()]
  ]) assert(check(old, next, options));
});

test('rejects automatic, cancelled, refunded and previously identified payment sources', () => {
  for (const change of [
    { product: 'Claude Pro' }, { source: '线上代充' }, { taskId: 'synthetic-task' }, { cancelled: true },
    { paidConfirmed: false }, { cardId: 'recharge:other' }, { refunds: [{ id: 'refund' }] },
    { bankReturns: [{ id: 'return' }] }, { issueFeeSnapshot: { applied: true, cardId: '' } },
    { financialEvidence: [{ kind: 'payment', payment: '银行卡', cardId: 'recharge:other' }] },
    { corrections: [{ previous: { cardId: 'recharge:other' } }] }
  ]) {
    const old = { ...prior(), ...change };
    assert(check(old, candidate(old), context()), JSON.stringify(change));
  }
});

test('rejects an unavailable card, mismatched historical tail, altered money or rewritten evidence', () => {
  const old = prior();
  for (const [next, options] of [
    [candidate(old), context({ card: { ...card, active: false } })],
    [candidate(old), context({ card: { ...card, id: 'recharge:another' } })],
    [{ ...candidate(old), paymentId: '9999' }, context()],
    [{ ...candidate(old), paidAmount: '984' }, context()],
    [{ ...candidate(old), receiptConfirmed: false }, context()],
    [{ ...candidate(old), financialEvidence: [] }, context()],
    [{ ...candidate(old), issueFeeSnapshot: { applied: true, amountUsd: '0.5', cardId: card.id } }, context()],
    [{ ...candidate(old), customerId: 'different-customer' }, context()]
  ]) assert(check(old, next, options));
  const knownTail = { ...prior(), paymentId: '5678' };
  assert(check(knownTail, candidate(knownTail), context()));
});

test('does not allow a second card replacement or a card number in the audit reason', () => {
  const old = prior(), once = candidate(old);
  delete once.cardBackfillConfirmed;
  assert(check(once, { ...candidate(once), cardId: 'recharge:another' }, context()));
  const dangerous = candidate(old);
  dangerous.correctionReason = '测试 4111 1111 1111 1111';
  dangerous.corrections.at(-1).reason = dangerous.correctionReason;
  assert(check(old, dangerous, context({ nextLogs: [{ id: 'log', type: '更正订单',
    entityId: old.id, actorId: actor.id, detail: dangerous.correctionReason }] })));
});

test('original evidence without a card and its later card association describe the same payment', () => {
  const old = prior(), updated = candidate(old), evidence = old.financialEvidence[0];
  const payment = { amount: old.paidAmount, currency: old.paidCurrency, payment: old.payment, cardId: card.id };
  assert.equal(matchesBackfilledPayment(updated, payment, evidence), true);
  assert.equal(matchesBackfilledPayment(updated, { ...payment, amount: '984' }, evidence), false);
  assert.equal(matchesBackfilledPayment(updated, { ...payment, cardId: 'recharge:other' }, evidence), false);
  assert.equal(matchesBackfilledPayment({ ...updated, corrections: [] }, payment, evidence), false);
});

test('the card backfill audit cannot be forged, erased or undone by ordinary order edits', () => {
  const old = prior(), next = candidate(old), options = context();
  delete next.cardBackfillConfirmed;
  const before = { orders: [old], logs: [] };
  const after = { orders: [next], logs: options.nextLogs };
  assert.match(checkFinanceSnapshots(before, after, { action: '更正订单' }), /更正入口/);
  assert.equal(checkFinanceSnapshots(before, after, { action: '更正订单', verifiedCardBackfillId: old.id }), '');
  const erased = structuredClone(after); erased.orders[0].corrections = [];
  assert.match(checkFinanceSnapshots(after, erased, { action: '更正订单' }), /不可覆盖/);
  const undo = structuredClone(after); undo.orders[0].version++;
  assert.match(checkFinanceSnapshots(after, undo, { action: '补偿撤回更正' }), /普通撤回/);
});
