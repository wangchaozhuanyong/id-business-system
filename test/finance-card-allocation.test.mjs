import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCardIssueAllocations, calculateOrder, createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { reconcileOrders } from '../server/finance/reconcile-orders.mjs';
import { checkFinanceSnapshots } from '../server/finance/snapshot-integrity.mjs';

const clock = Date.parse('2026-11-10T08:00:00Z');
const rules = { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5',
  claudeBankFeeMyr: '100', claudeAccountCostMyr: '50' };
const cardId = 'recharge:1';
const quote = (start, rates = {}, basis = 'reference') => ({
  source: '隔离历史凭据 FX-' + start.slice(5, 10), basis,
  at: start.slice(0, 10) + 'T00:00', expiresAt: start.slice(0, 10) + 'T23:59',
  rates: { MYR: '1.6', USD: '7.2', PHP: '0.125', ...rates }
});
function bank(id, start, fields = {}, rates) {
  const order = {
    id, orderNo: id.toUpperCase(), cardId, paymentId: '1234', source: '管理员手工', product: 'GPT',
    payment: '银行卡', start, paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '140', saleCurrency: 'CNY',
    paidConfirmed: true, receiptConfirmed: true, costConfirmed: true, costBasis: 'standard', version: 1,
    costSettings: { ...rules }, issueFeeSnapshot: { applied: false, cardId }, refunds: [], bankReturns: [],
    ...fields
  };
  order.fxSnapshot = createOrderSnapshot(quote(start, rates), order, clock);
  return order;
}
function trio() {
  return [
    bank('order-a', '2026-11-03T12:00', { issueFeeSnapshot: { applied: true, cardId, amountUsd: '0.50' } }),
    bank('order-b', '2026-11-04T13:00', {
      costSettings: { ...rules, version: 2, cardPercent: '0.01', cardPerPaymentUsd: '0.4', cardIssueUsd: '0.9' }
    }, { USD: '7', PHP: '0.1' }),
    bank('order-c', '2026-11-05T14:00', {}, { USD: '7.5', PHP: '0.12' })
  ];
}
const allocate = (orders, at = clock) => buildCardIssueAllocations(orders, { clock: at });
const compute = (order, allocations, currency = 'CNY') =>
  calculateOrder(order, { clock, currency, cardIssueAllocations: allocations });

test('同卡一单到三单按原币均摊，稳定分配尾差，各单按自身汇率和费用规则换算', () => {
  const [a, b, c] = trio();
  const before = structuredClone([a, b, c]);
  assert.equal(allocate([a]).get(a.id).amountUsd, '0.5000');
  assert.equal(allocate([b, a]).get(b.id).amountUsd, '0.2500');
  const other = bank('unrelated', '2026-11-02T12:00', {
    cardId: 'recharge:2', issueFeeSnapshot: { applied: true, cardId: 'recharge:2', amountUsd: '0.80' }
  });
  const allocation = allocate([other, c, b, a]);
  assert.deepEqual([a, b, c].map(({ id }) => allocation.get(id).amountUsd), ['0.1667', '0.1667', '0.1666']);
  assert.equal(allocation.get(other.id).amountUsd, '0.8000');
  assert.equal(allocation.get(a.id).asOf, new Date(clock).toISOString());
  assert.equal(allocation.get(a.id).count, 3);
  assert.deepEqual([a, b, c].map((order) => compute(order, allocation).profit), ['10.6398', '35.0331', '15.5405']);
  assert.equal(compute(b, allocation, 'MYR').profit, '21.8957');
  assert.deepEqual([a, b, c], before);
});

test('分母保留成功后撤单与退款，排除重复任务、失败和未来开通', () => {
  const [a, b, c] = trio();
  b.source = '线上代充';
  b.taskId = 'original-job';
  b.rechargeCompletedAt = '2026-11-04T05:00:10.000Z';
  const copied = { ...b, id: 'later-duplicate', orderNo: 'ZZ-ORDER-COPY' };
  c.cancelled = true;
  c.paidConfirmed = false;
  c.financialEvidence = [{ kind: 'payment', payment: '银行卡', cardId }];
  c.refunds = [{ amount: '140', currency: 'CNY' }];
  const future = { ...c, id: 'future', start: '2026-11-11T12:00', cancelled: false, paidConfirmed: true };
  const failed = { ...c, id: 'failed', status: 'failed' };
  const draft = { ...c, id: 'draft', draft: true };
  const waiting = { ...a, id: 'waiting', paidConfirmed: false };
  const allocation = allocate([waiting, copied, a, failed, c, draft, b, future]);
  assert.equal(allocation.get(a.id).count, 3);
  assert.equal(allocation.get(c.id).amountUsd, '0.1666');
  assert.match(compute(copied, allocation).reason, /重复代充任务/);
  assert.equal(allocation.has(failed.id), false);
  assert.equal(allocation.has(draft.id), false);
  assert.equal(allocation.get(future.id).status, 'pending');
  assert.equal(allocation.get(waiting.id).status, 'pending');
  assert.equal(allocate([a, b, c], Date.parse('2026-11-04T05:00:00.000Z')).get(a.id).count, 1);
});

test('开卡费凭据、同卡开通日期和稳定卡编号不足时待核算', () => {
  const [a, b, c] = trio();
  assert.match(compute(b, allocate([b])).reason, /开卡费凭据缺失/);
  const incomplete = { ...b, start: '' };
  assert.match(compute(a, allocate([a, incomplete])).reason, /同卡开通记录存在待核对/);
  const originalFee = c.issueFeeSnapshot;
  c.issueFeeSnapshot = { ...a.issueFeeSnapshot };
  assert.match(compute(a, allocate([a, c])).reason, /多份开卡费凭据/);
  c.issueFeeSnapshot = originalFee;
  c.cardId = '1234';
  assert.match(compute(c, allocate([a, c])).reason, /稳定编号/);

  const sameTaskA = { ...b, source: '线上代充', taskId: 'duplicate-key', rechargeCompletedAt: '2026-11-04T05:00:00.000Z' };
  const sameTaskB = { ...sameTaskA, id: 'separate', cardId: 'recharge:2' };
  assert.match(compute(a, allocate([a, sameTaskA, sameTaskB])).reason, /同卡开通记录存在待核对/);
});

test('共享用卡计入真实开通笔数，实际总成本沿用已核对的完整账单', () => {
  const [a, b, c] = trio();
  b.product = 'Claude Pro';
  c.costBasis = 'actual';
  c.actualCostAmount = '112.14';
  c.actualCostCurrency = 'CNY';
  c.fxSnapshot = createOrderSnapshot(quote(c.start, {}, 'settlement'), c, clock);
  const allocation = allocate([a, b, c]);
  assert.equal(allocation.get(a.id).count, 3);
  const claude = compute(b, allocation);
  assert.equal(claude.items.find((item) => item.label === '开卡成本分摊').originalAmount, '0.1667');
  assert.deepEqual(claude.items.slice(-3).map((item) => item.label), ['代付服务费', 'KYC 认证成本', '补充邮箱成本']);
  const actual = compute(c, allocation);
  assert.equal(actual.cardIssue.amountUsd, '0.1666');
  assert.equal(actual.basis, 'actual');
  assert.equal(actual.originalCost, '112.1400');
  assert.equal(actual.profit, '27.8600');
  assert.equal(actual.items.length, 1);
  assert.equal(compute(a, allocation).basis, 'reference');
});

test('Gemini 和 Grok 只以实际开通进入同卡分摊，失败单的开卡费证据保留', () => {
  const [gemini, grok, gpt] = trio();
  Object.assign(gemini, { product: 'Gemini', entitlementStatus: 'pending' });
  Object.assign(grok, { product: 'Grok', entitlementStatus: 'active' });
  assert.match(allocate([gemini, grok, gpt]).get(gpt.id).reason, /同卡开通记录存在待核对/);
  gemini.entitlementStatus = 'active';
  assert.equal(allocate([gemini, grok, gpt]).get(grok.id).count, 3);
  gemini.entitlementStatus = 'failed';
  const allocation = allocate([gemini, grok, gpt]);
  assert.equal(allocation.has(gemini.id), false);
  assert.equal(allocation.get(grok.id).count, 2);
  assert.equal(allocation.get(gpt.id).amountUsd, '0.2500');
  assert.equal(compute(grok, allocation).items.find(item => item.label === '开卡成本分摊').originalAmount, '0.2500');
});

test('自动订单按已确认开通回执的准确时间冻结汇率，并保留原已冻结记录', () => {
  const [a] = trio();
  const auto = { ...a, source: '线上代充', taskId: 'terminal', rechargeCompletedAt: '2026-11-03T04:00:35.000Z' };
  assert.throws(() => createOrderSnapshot({
    ...quote(a.start), expiresAt: '2026-11-03T04:00:30.000Z'
  }, auto, clock), /尚未生效或已过期/);
  const snap = createOrderSnapshot(quote(a.start, {}, 'settlement'), auto, clock);
  assert.equal(snap.basisAt, auto.rechargeCompletedAt);
  assert.equal(snap.basis, 'settlement');
  const before = { orders: [{ ...auto, fxSnapshot: snap }], logs: [] };
  assert.match(checkFinanceSnapshots(before, { ...before, orders: [
    { ...before.orders[0], fxSnapshot: { ...snap, basis: 'reference' } }
  ] }, { action: '更正订单', clock }), /已冻结/);
});

test('原币退款和实际回款分列，保留两类手续费及分摊', () => {
  const [a, b, c] = trio();
  a.refunds = [{ amount: '20', currency: 'CNY' }];
  a.bankReturns = [{ amount: '100', currency: 'PHP' }];
  const result = compute(a, allocate([a, b, c]));
  assert.equal(result.revenue, '120.0000');
  assert.equal(result.originalCost, '129.3602');
  assert.equal(result.recoveredCost, '12.5000');
  assert.equal(result.profit, '3.1398');
  assert.equal(result.items.find((item) => item.label === '支付比例手续费').originalAmount, '8.0000');
  assert.equal(result.items.find((item) => item.label === '每笔固定手续费').originalAmount, '0.3000');
});

test('完整卡历史的只读对账返回原份额、重算份额及其差额', () => {
  const orders = trio();
  const original = structuredClone(orders);
  const report = reconcileOrders({ commerce: { orders } }, { clock, fullCardHistory: true });
  assert.deepEqual(report.counts, { ready: 3, pending: 0, excluded: 0 });
  assert.deepEqual(report.orders.map((row) => row.cardIssueAllocation.differenceUsd), ['-0.3333', '0.1667', '0.1666']);
  assert.equal(report.orders[0].calculations.CNY.profit, '10.6398');
  assert.doesNotMatch(JSON.stringify(report), /recharge:1/);
  assert.deepEqual(orders, original);
});
