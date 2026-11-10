import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  checkNewOrder, checkClaudeProMaterialHistory, normalizeClaudeProMaterials, normalizePaymentEvidence,
  redactClaudeProOrderMaterials, retainOrderCardNumber
} from '../server/order-policy.mjs';
import { checkBankReturns } from '../server/local-business-integrity.mjs';
import { readPoolCards } from '../server/order-recharge-client.mjs';
import { createCardManagementHandler, orderCardArchiveDocument, preserveReferencedOrderCard } from '../server/card-management.mjs';

// All materials and stores are synthetic plain objects; these tests never open a database.
const number = '4242424242424242', replacement = '4000000000000002';
const actor = { id: 'fixture-admin', role: 'admin', name: '测试管理员' };
const origin = 'https://cards.example.test';
const base = (product = 'GPT') => ({ id: 'fixture-order', product,
  plan: { GPT: 'Plus', 'Claude Pro': 'Pro', 'Claude Max': 'Max 5x', Gemini: 'AI Pro', Grok: 'SuperGrok' }[product],
  businessType: '续费', payment: '银行卡', cardId: '', paymentId: '4242', email: 'fixture@example.test',
  proMaterialMode: 'manual_card', proCardNumber: number, proCardSerial: '', version: 1,
  paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', corrections: [], refunds: [], bankReturns: [] });
const correction = (prior, changes) => {
  const { corrections, refunds, bankReturns, ...previous } = prior;
  return { ...prior, ...changes, version: prior.version + 1,
    corrections: [...corrections, { reason: '核对银行卡资料', previous, versionAfter: prior.version + 1 }] };
};

test('五种订单都接受手填卡号，Claude 序列号可空且保留前导零', () => {
  for (const product of ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']) {
    const row = { ...base(product), proCardNumber: '4242 4242-4242 4242' };
    assert.equal(normalizeClaudeProMaterials(row, undefined, []), undefined, product);
    assert.equal(row.proCardNumber, number);
    assert.equal(row.paymentId, '4242');
    assert.equal(row.proCardSerial, '');
    if (!['Gemini', 'Grok'].includes(product)) assert.equal(checkNewOrder(row), undefined, product);
  }
  const serial = { ...base('Claude Pro'), proCardSerial: '00042' };
  assert.equal(normalizeClaudeProMaterials(serial, undefined, []), undefined);
  assert.equal(serial.proCardSerial, '00042');
  for (const invalid of ['', '1234', '424242424242424x', '1'.repeat(20)])
    assert.match(normalizeClaudeProMaterials({ ...base(), proCardNumber: invalid }, undefined, []), /银行卡号/);
  for (const invalid of ['x'.repeat(121), 'test\u0001', 123])
    assert.match(normalizeClaudeProMaterials({ ...base('Claude Pro'), proCardSerial: invalid }, undefined, []), /序列号/);
});

test('所有产品可选择卡池，完整卡号由可信卡资料产生并在删除后保留', async () => {
  const source = { cards: [{ id: 7, last4: '4242', card_number: number, is_active: 1 }] };
  const client = { get: async () => source };
  assert.equal(Object.hasOwn((await readPoolCards(client))[0], 'number'), false, '选择列表不返回完整号');
  const [card] = await readPoolCards(client, { includeNumbers: true });
  for (const product of ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']) {
    const row = { ...base(product), cardId: card.id, proMaterialMode: 'pool_card', proCardNumber: replacement };
    assert.equal(normalizeClaudeProMaterials(row, undefined, []), undefined);
    assert.equal(row.proCardNumber, undefined, '不信任浏览器提供的卡池卡号');
    retainOrderCardNumber(row, undefined, card);
    assert.equal(row.proCardNumber, number);
    const later = { ...row, notes: '卡池已经删除' };
    retainOrderCardNumber(later, row);
    assert.equal(later.proCardNumber, number);
    const changed = { ...later, cardId: 'recharge:8' };
    retainOrderCardNumber(changed, row);
    assert.equal(changed.proCardNumber, undefined, '不同卡不继承旧号');
  }
});

test('已付款订单更正卡号保留旧卡和金额，缺少历史或篡改历史被拒绝', () => {
  for (const product of ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']) {
    const prior = base(product);
    normalizePaymentEvidence(prior);
    const next = correction(prior, { proCardNumber: replacement });
    assert.equal(normalizeClaudeProMaterials(next, prior, []), undefined);
    assert.equal(checkClaudeProMaterialHistory(next, prior, '更正订单'), undefined);
    normalizePaymentEvidence(next, prior);
    assert.deepEqual(next.financialEvidence, prior.financialEvidence);
    assert.equal(next.corrections[0].previous.proCardNumber, number);
    assert.match(checkClaudeProMaterialHistory({ ...next, corrections: [] }, prior, '更正订单'), /更正/);
    const tampered = structuredClone(next);
    tampered.corrections[0].previous.proCardNumber = replacement;
    assert.match(checkClaudeProMaterialHistory(tampered, prior, '更正订单'), /更正/);
    assert.doesNotMatch(JSON.stringify(redactClaudeProOrderMaterials(next, { role: 'employee' })), new RegExp(number + '|' + replacement));
  }
});

test('卡池改手填、换卡及后续更正不会重复添加付款，原回款仍保留', () => {
  const prior = { ...base(), cardId: 'recharge:7', proMaterialMode: 'pool_card',
    bankReturns: [{ id: 'fixture-return', cardId: 'recharge:7', amount: '2', currency: 'USD' }] };
  normalizePaymentEvidence(prior);
  const next = correction(prior, { cardId: '', proMaterialMode: 'manual_card', proCardNumber: replacement });
  normalizePaymentEvidence(next, prior);
  assert.deepEqual(next.financialEvidence, prior.financialEvidence);
  assert.equal(checkBankReturns({ orders: [prior] }, { orders: [next] }), undefined);
  const later = correction(next, { notes: '再次核对' });
  normalizePaymentEvidence(later, next);
  assert.deepEqual(later.financialEvidence, prior.financialEvidence);
  const forged = { ...next, bankReturns: [...next.bankReturns,
    { id: 'new-forged-return', cardId: 'recharge:7', amount: '1', currency: 'USD' }] };
  assert.match(checkBankReturns({ orders: [prior] }, { orders: [forged] }), /原付款/);
});

function fakeStore(orders) {
  const docs = new Map();
  const audit = [];
  return {
    audit,
    load: domain => ({ version: 1, data: domain === 'commerce' ? { orders, customers: [], tenants: [] }
      : domain === 'inventory' ? { accounts: [] } : { costSettings: {} } }),
    featureDocument: domain => structuredClone(docs.get(domain) || { version: 0, data: null }),
    saveFeatureDocument(domain, version, data, event) {
      assert.equal(version, this.featureDocument(domain).version);
      docs.set(domain, { version: version + 1, data: structuredClone(data) });
      audit.push(event);
    },
    auditFeature: (domain, version, event) => audit.push(event)
  };
}
async function cardRequest(store, client, route, body) {
  const handler = createCardManagementHandler({ store, client, publicOrigin: origin });
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }
  });
  let status, data;
  await handler(request, { writeHead: code => { status = code; }, end: value => { data = JSON.parse(value); } },
    '/api/local/' + route, actor);
  return { status, data };
}

test('旧单删卡前写入独立留存文档，删除后查看和复制不读取卡池', async () => {
  const order = { ...base(), cardId: 'recharge:7', proMaterialMode: undefined, proCardNumber: undefined };
  const store = fakeStore([order]);
  const original = structuredClone(order);
  let reads = 0;
  const client = { get: async () => { reads++; return { cards: [{ id: 7, last4: '4242', card_number: number }] }; } };
  await preserveReferencedOrderCard(store, client, order.cardId, actor);
  assert.equal(store.featureDocument(orderCardArchiveDocument).data.cards[order.cardId].number, number);
  assert.deepEqual(order, original, '不改原订单、金额或历史');
  client.get = async () => { throw new Error('卡池已删除'); };
  await preserveReferencedOrderCard(store, client, order.cardId, actor);
  assert.equal(reads, 1, '已有留存不重复回源');
  const revealed = await cardRequest(store, client, 'subscription-card-reveal', { orderId: order.id, version: 1 });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.data.number, number);
  const copied = await cardRequest(store, client, 'subscription-card-copy', { orderId: order.id, cardId: order.cardId });
  assert.equal(copied.status, 200);
  assert.ok(copied.data.text.includes(number));
  assert.doesNotMatch(JSON.stringify(store.audit), new RegExp(number));
});

test('新单留存卡号和手填卡号可独立读取；旧单缺失原卡时不伪造资料', async () => {
  const client = { get: async () => { throw new Error('不得依赖卡池'); } };
  for (const product of ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']) {
    const order = base(product), store = fakeStore([order]);
    const result = await cardRequest(store, client, 'subscription-card-reveal', { orderId: order.id });
    assert.equal(result.status, 200, product);
    assert.equal(result.data.number, number);
  }
  const order = { ...base(), cardId: 'recharge:7', proMaterialMode: undefined, proCardNumber: undefined };
  const store = fakeStore([order]);
  await assert.rejects(preserveReferencedOrderCard(store, { get: async () => ({ cards: [] }) }, order.cardId, actor));
  assert.equal(store.featureDocument(orderCardArchiveDocument).version, 0);
  assert.equal(store.audit.length, 0);
});
