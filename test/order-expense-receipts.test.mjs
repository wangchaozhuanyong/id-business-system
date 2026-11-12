import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createOrderExpenseHandler, orderExpenseDomain } from '../server/finance/expense-receipts.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const origin = 'https://expense-test.example.test';
const admin = { id: 'admin', name: '合成管理员', role: 'admin' };
const employee = { ...admin, role: 'employee' };
const charge = { category: 'kyc', chargedOn: '2026-11-11', source: '合成机构', reference: 'KYC-123',
  amount: '20', currency: 'MYR', settlementAmount: '32.12', settlementCurrency: 'CNY', orderNo: 'SYN-CLAUDE' };

function setup(t) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const card = { product: 'GPT', payment: '银行卡', cardId: 'recharge:7', start: '2026-11-03T12:00',
    paidAmount: '20', paidCurrency: 'USD', paidConfirmed: false, costBasis: 'standard' };
  const orders = [
    { id: 'claude-fixture', orderNo: 'SYN-CLAUDE', email: 'private-fixture@example.test',
      product: 'Claude Pro', payment: '银行卡', costBasis: 'standard',
      paidAmount: '20', paidCurrency: 'USD', paidConfirmed: false },
    { id: 'actual-fixture', orderNo: 'SYN-ACTUAL', paidConfirmed: true, costBasis: 'actual',
      paidAmount: '40', paidCurrency: 'CNY', actualCostAmount: '40', actualCostCurrency: 'CNY' },
    { ...card, id: 'card-fixture', orderNo: 'SYN-CARD', issueFeeSnapshot: { cardId: card.cardId, applied: true, amountUsd: '0.5' } },
    { ...card, id: 'second-card-use', orderNo: 'SYN-CARD-2' },
    { ...card, cardId: 'recharge:8', id: 'incomplete-card', orderNo: 'SYN-CARD-INCOMPLETE' },
    { id: 'draft-fixture', orderNo: 'SYN-DRAFT', draft: true }
  ];
  const handler = createOrderExpenseHandler({ publicOrigin: origin, clock: () => Date.parse('2026-11-10T18:00:00Z'),
    store: { ...store, load: domain => domain === 'commerce' ? { data: { orders } } : store.load(domain) } });
  const send = (body, { actor = admin, requestOrigin = origin, contentType = 'application/json' } = {}) =>
    new Promise(resolve => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
        method: body === undefined ? 'GET' : 'POST', headers: { origin: requestOrigin, 'content-type': contentType }
      });
      let status, headers;
      void handler(req, { writeHead(code, values) { status = code; headers = values; },
        end(raw) { resolve({ status, headers, body: JSON.parse(raw) }); } }, actor);
    });
  return { store, send, orders };
}

test('实付凭据按原币与账单结算分开保存，可追原订单及作废审计', async t => {
  const { store, send } = setup(t);
  assert.deepEqual((await send()).body, { version: 0, items: [] });
  const saved = await send({ action: 'record', version: 0, entry: charge });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers['Cache-Control'], 'private, no-store');
  const [row] = saved.body.items;
  assert.equal(row.orderId, 'claude-fixture');
  assert.equal(row.amount, '20');
  assert.equal(row.settlementAmount, '32.12');
  assert.doesNotMatch(JSON.stringify(row), /private-fixture/);
  assert.equal((await send({ action: 'record', version: 1,
    entry: { ...charge, reference: 'kyc-123' } })).status, 409);

  const voided = await send({ action: 'void', version: 1, id: row.id, reason: '合成账单更正' });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.items[0].voidReason, '合成账单更正');
  assert.equal(voided.body.items[0].amount, row.amount);
  assert.equal((await send({ action: 'void', version: 2, id: row.id, reason: '重复作废' })).status, 409);

  const corrected = await send({ action: 'record', version: 2, entry: { ...charge, amount: '18' } });
  assert.equal(corrected.status, 200);
  assert.deepEqual((await send()).body.items.map(item => [item.amount, Boolean(item.voidedAt)]),
    [['18', false], ['20', true]]);
  assert.equal(store.audit().filter(event => event.domain === orderExpenseDomain).length, 3);
});

test('管理员核对费用归属，限制重复替换和原单已含费用合计', async t => {
  const { store, send, orders } = setup(t);
  const before = structuredClone(orders);
  const record = (version, entry) => send({ action: 'record', version, entry });
  const account = (version, id, mode, options) => send({ action: 'account', version, id, mode }, options);
  const first = (await record(0, charge)).body.items[0];
  assert.equal(first.accountingMode, undefined);
  assert.equal((await account(1, first.id, 'replace-kyc', { actor: employee })).status, 403);
  assert.equal((await account(1, first.id, 'included')).status, 400);
  const applied = await account(1, first.id, 'replace-kyc');
  assert.equal(applied.status, 200);
  assert.equal(applied.body.items[0].accountingMode, 'replace-kyc');
  assert.equal(applied.body.items[0].amount, charge.amount);
  assert.equal((await account(1, first.id, 'cash')).status, 409);
  const second = (await record(2, { ...charge, reference: 'KYC-2' })).body.items[0];
  assert.match((await account(3, second.id, 'replace-kyc')).body.error, /已有一笔/);
  assert.equal((await account(3, first.id, 'cash')).body.items.find(row => row.id === first.id).accountingMode, 'cash');
  const included = (await record(4, { ...charge, reference: 'KYC-ACT', orderNo: 'SYN-ACTUAL' })).body.items[0];
  assert.equal((await account(5, included.id, 'included')).status, 200);
  const fx = (await record(6, { category: 'fx-fee', chargedOn: charge.chargedOn, source: '合成账单',
    reference: 'FX-ACT', amount: '8', currency: 'CNY', orderNo: 'SYN-ACTUAL' })).body.items[0];
  assert.match((await account(7, fx.id, 'included')).body.error, /合计超过/);
  assert.equal((await account(7, fx.id, 'add-fx')).status, 200);
  assert.deepEqual(orders, before);
  assert.equal(store.audit().filter(row => row.domain === orderExpenseDomain && row.action === 'order_expense_account').length, 4);
});

test('发卡实付绑定原付款卡，拒绝同卡多份及开通历史未核全的凭据', async t => {
  const { send } = setup(t);
  const entry = { category: 'card-issue', chargedOn: '2026-11-02', source: '合成卡商',
    reference: 'CARD-1', amount: '1.0001', currency: 'USD', orderNo: 'SYN-CARD' };
  const saved = await send({ action: 'record', version: 0, entry });
  const account = { action: 'account', version: 1, id: saved.body.items[0].id, mode: 'replace-card' };
  const applied = await send(account);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.items[0].accountingCardId, 'recharge:7');
  const duplicate = await send({ action: 'record', version: 2, entry: { ...entry, reference: 'CARD-2', orderNo: 'SYN-CARD-2' } });
  assert.equal((await send({ ...account, version: 3, id: duplicate.body.items[0].id })).status, 409);
  const missing = await send({ action: 'record', version: 3,
    entry: { ...entry, reference: 'CARD-3', currency: 'CNY', orderNo: 'SYN-CARD-INCOMPLETE' } });
  assert.match((await send({ ...account, version: 4, id: missing.body.items[0].id })).body.error, /核对该卡开通记录/);
});

test('越权、跨站、无效金额和日期被拒，竞争提交保留一次有效写入', async t => {
  const { send } = setup(t);
  const command = { action: 'record', version: 0, entry: charge };
  assert.equal((await send(undefined, { actor: null })).status, 401);
  assert.equal((await send(undefined, { actor: employee })).status, 403);
  assert.equal((await send(command, { requestOrigin: 'https://other.example.test' })).status, 403);
  assert.equal((await send(command, { contentType: 'text/plain' })).status, 403);
  for (const change of [{ chargedOn: '2026-02-30' }, { chargedOn: '2026-11-12' }, { amount: '0.00' },
    { settlementCurrency: 'MYR' }, { settlementAmount: '' }, { orderNo: 'SYN-DRAFT' }, { orderNo: 'UNKNOWN' },
    { category: 'unknown' }, { unexpected: true }]) {
    assert.equal((await send({ ...command, entry: { ...charge, ...change } })).status, 400);
  }
  const cardFee = { category: 'card-issue', chargedOn: '2026-11-01',
    source: '合成卡商', reference: 'CARD-123', amount: '0.5', currency: 'USD' };
  const results = await Promise.all([send(command), send({ ...command, entry: cardFee })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = (await send()).body;
  assert.equal(current.items.length, 1);
  if (current.items[0].category !== 'card-issue') {
    const saved = await send({ ...command, version: 1, entry: cardFee });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.items[0].orderId, undefined);
    assert.equal(saved.body.items[0].settlementAmount, undefined);
  }
});
