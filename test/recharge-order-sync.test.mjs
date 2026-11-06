import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRechargeClient } from '../server/order-recharge-client.mjs';
import { buildRechargeOrder, createRechargeOrderSync, rechargeOrderEvidence } from '../server/recharge-order-sync.mjs';
import { checkAppleOrder, deriveCardIssueFee, nextOrderNo } from '../server/order-policy.mjs';

const createdAt = '2026-10-31T15:30:00.000Z';
const completedAt = '2026-10-31T15:45:00.000Z';
const now = Date.parse('2026-10-31T16:00:00.000Z');
const session = { jobKey: 'task-a', status: 'success', cdk: 'example-code', createdAt, cardLast4: '2345' };
const ownerData = { requests: [{ id: 'batch-a', status: 'issued', applicantId: 'employee-a', codes: ['EXAMPLE-CODE'] }] };

test('browser reconciliation uses the terminal timestamp but does not promote an estimated billing amount', () => {
  const context = {
    now, ownerData,
    bills: [{
      cdk_code: session.cdk, email: 'account@example.test', status: 'success', plan_type: 'pro200',
      amount: '100', currency: 'PHP', payment_time: completedAt, stripe_session_id: 'synthetic-payment',
      card_last4: '2345', card_number: '4000000000002345'
    }],
    cards: [{ id: 1, last4: '2345', card_number: '4000000000002345' }],
    runtimeEntries: [{
      source: 'task', text: '任务结束 status=success progress=100 message=开通成功',
      jobKey: session.jobKey, ts: Date.parse(completedAt)
    }]
  };
  const evidence = rechargeOrderEvidence(session, context);
  assert.equal(evidence.expiry, '2026-11-30T23:45');
  assert.equal(evidence.cardId, 'recharge:1');
  assert.equal(evidence.employeeId, 'employee-a');
  assert.equal(evidence.paidAmount, '');
  assert.equal(rechargeOrderEvidence({ ...session, status: 'failed' }, context), null);
  assert.equal(rechargeOrderEvidence(session, { ...context, runtimeEntries: [] }).start, '');
  assert.equal(rechargeOrderEvidence(session, { ...context, bills: [...context.bills, ...context.bills] }).email, '');
  const order = buildRechargeOrder(evidence, { orderPrices: { GPT: { 'Pro 200': { CNY: '300' } } } }, now);
  assert.equal(order.saleAmount, '300');
  assert.equal(order.receiptConfirmed, false);
  assert.equal(order.paidConfirmed, false);
  assert.doesNotMatch(JSON.stringify(order), /4000000000002345|example-code/);
});

test('only a matching terminal provider receipt supplies the actual amount', () => {
  const open = { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
    orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test',
    planCode: 'pro100', completedAt, payment: { amount: '124.31', currency: 'PHP' }
  }) };
  const evidence = rechargeOrderEvidence(open, { now, ownerData });
  assert.equal(evidence.paidAmount, '124.31');
  assert.equal(evidence.paidCurrency, 'PHP');
  assert.equal(evidence.plan, 'Pro 100');
  assert.equal(buildRechargeOrder(evidence, {}, now).paidConfirmed, true);
  const linkedCard = rechargeOrderEvidence(open, { now, orbitCards: [{ cardId: 71, recharges: [{
    jobKey: 'task-a', orderId: 'provider-a', cardLast4: '2345', status: 'success',
    planType: 'pro100', useNumber: 2
  }] }] });
  assert.equal(linkedCard.cardId, 'orbitcard:71');
  assert.equal(linkedCard.firstUse, false);
  assert.equal(rechargeOrderEvidence({ ...open, gptApiOrderId: 'provider-other' }, { now }).paidAmount, '');
  const legacy = { ...session, gptApiOrderId: '30', gptApiRaw: JSON.stringify({
    id: 30, status: 'success', recharge_account: 'account@example.test', plan: 'plus',
    amount: '70.12', currency: 'PHP', settled_at: '2026-10-31 15:45:00'
  }) };
  const legacyEvidence = rechargeOrderEvidence(legacy, { now });
  assert.equal(legacyEvidence.paidAmount, '70.12');
  assert.equal(legacyEvidence.start, '');
  assert.equal(legacyEvidence.plan, 'Plus');
});

test('preview writes nothing and confirmed synchronization only reads the selected task', async () => {
  let checkpoint = { version: 0, data: null };
  const applied = [];
  const store = {
    featureDocument: (domain) => domain === 'order-sync' ? checkpoint : { version: 1, data: ownerData },
    saveFeatureDocument(_domain, version, data) {
      checkpoint = { version: version + 1, data };
      return checkpoint;
    },
    load: () => ({ version: 0, data: null }),
    applyRechargeOrder({ row, order }) {
      applied.push({ row, order });
      return { ...row, orderNo: 'OD-LOCAL-0001' };
    }
  };
  const other = { ...session, jobKey: 'task-b' };
  const open = { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
    orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test',
    planCode: 'plus', completedAt, payment: { amount: '123', currency: 'PHP' }
  }) };
  const paths = [];
  const client = {
    listCodes: async () => [],
    async get(path) {
      paths.push(path);
      if (path.includes('/sessions')) return {
        items: [session, other].map(({ jobKey }) => ({ job_key: jobKey, status: 'success' })), total: 2
      };
      if (path.includes('/cards')) return { cards: [] };
      if (path.includes('/billing')) return { total: 0, records: [] };
      return { task: { ...open, jobKey: path.split('/').at(-1) } };
    }
  };
  let clock = Date.parse('2026-10-31T15:00:00.000Z');
  const sync = createRechargeOrderSync({ store, client, clock: () => clock });
  clock = now;
  assert.equal((await sync.run()).rows.length, 2);
  assert.equal(checkpoint.version, 0);
  assert.equal(applied.length, 0);
  paths.length = 0;
  assert.equal((await sync.run({ apply: true, jobKeys: ['task-a'] })).rows[0].orderNo, 'OD-LOCAL-0001');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].order.createdById, 'employee-a');
  assert.equal(paths.includes('/api/admin/task-logs/task-b'), false);
  assert.equal(checkpoint.data.since, Date.parse('2026-10-31T15:00:00.000Z'));
});

test('accounting transport rejects checkout routes before any request', async () => {
  const attempts = [];
  const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:4349', secret: 'x'.repeat(40) },
    async (url, options) => {
      attempts.push([url.pathname, options.method]);
      return Response.json([]);
    });
  await assert.rejects(client.get('/api/run-process'), /不支持/);
  await assert.rejects(client.get('https://example.test/api/admin/cards'), /不支持/);
  await assert.rejects(client.get('/api/admin/orbitcard/usage?refresh=1'), /不支持/);
  await client.listCodes();
  await client.importCodes({ codes: ['synthetic-code'], plan: 'plus' });
  assert.deepEqual(attempts, [['/api/admin/cdks', 'GET'], ['/api/admin/cdks/import', 'POST']]);
});

test('Apple renewals enforce original binding and first-use card fees use actual history', () => {
  const inventory = { mailboxes: [
    { type: 'apple', id: 'apple-1', status: '正常' }, { type: 'apple', id: 'apple-2', status: '正常' }
  ] };
  const ledger = { wallets: [
    { id: 'apple-1', currency: 'USD', balance: '18' }, { id: 'apple-2', currency: 'USD', balance: '75' }
  ], movements: [] };
  const order = {
    id: 'new', payment: '苹果内购', product: 'GPT', plan: 'Plus', businessType: '续费',
    appleIdId: 'apple-1', paidAmount: '10', email: 'same@example.test', paidConfirmed: true
  };
  const prior = { ...order, id: 'old', start: '2026-10-01T10:00' };
  assert.equal(checkAppleOrder(order, null, [prior], ledger, inventory, [order, prior]), undefined);
  assert.match(checkAppleOrder({ ...order, appleIdId: 'apple-2' }, null, [prior], ledger, inventory, [order, prior]), /原订阅/);
  assert.match(checkAppleOrder({ ...order, businessType: '成品交付' }, null, [], ledger, inventory, [order]), /区间/);
  const cardOrder = { ...order, payment: '银行卡', cardId: 'recharge:1', costSettings: { cardIssueUsd: '0.5' } };
  assert.equal(deriveCardIssueFee(cardOrder, null, [], { usageCount: 0 }).applied, true);
  const payment = { kind: 'payment', cardId: cardOrder.cardId };
  assert.equal(deriveCardIssueFee(cardOrder, null, [{ id: 'old', financialEvidence: [payment] }], { usageCount: 0 }).applied, false);
  assert.equal(deriveCardIssueFee(cardOrder, null, [], { usageCount: 2 }).pending, true);
  assert.equal(nextOrderNo([{ orderNo: 'OD-LOCAL-0042' }]), 'OD-LOCAL-0043');
});
