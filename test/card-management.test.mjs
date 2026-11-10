import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { cardFundingEstimate, cardTypeDocument, cardTypeSnapshot, createCardManagementHandler } from '../server/card-management.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const origin = 'https://unit.example.test';
const admin = { id: 'admin-card-qa', name: '合成管理员', role: 'admin' };
const date = '2026-11-09T12:00:00.000Z';
const now = Date.parse(date);
const quote = { provider: 'exchange-rate-api-open', source: 'ExchangeRate-API', at: '2026-11-09T00:00:00.000Z',
  expiresAt: '2026-11-10T00:00:00.000Z', fetchedAt: date, rates: { PHP: '0.125', USD: '7.2' } };
const pan = '4242424242424242';
const order = {
  id: 'sample-order', version: 1, product: 'GPT', plan: 'Plus', payment: '银行卡', cardId: 'recharge:7',
  paymentId: '4242', paidAmount: '10000', paidCurrency: 'PHP', paidConfirmed: true
};

function request(handler, route, { body, actor = admin, requestOrigin = origin } = {}) {
  const data = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(data), { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json' } });
  return new Promise(resolve => {
    let status, headers;
    const res = { writeHead: (code, values) => { status = code; headers = values; },
      end: value => resolve({ status, headers, data: JSON.parse(value) }) };
    void handler(req, res, '/api/local/' + route, actor);
  });
}

test('预计余额按同一有效报价换成美元，加当前固定费和 2 美元后向上取整', () => {
  const result = cardFundingEstimate(order, '0.3', [quote], now);
  assert.equal(result.usd, '175.92');
  assert.equal(result.quotedAt, quote.at);
  assert.equal(cardFundingEstimate({ ...order, paidCurrency: 'USD', paidAmount: '20.001' }, '0.325', [], now).usd, '22.33');
  assert.equal(cardFundingEstimate({ ...order, paidConfirmed: false }, '0.3', [quote], now).usd, undefined);
  assert.equal(cardFundingEstimate(order, '0.3', [quote], Date.parse(quote.expiresAt)).usd, undefined);
  assert.equal(cardFundingEstimate(order, '0.3', [
    { ...quote, rates: { PHP: '0.125' } }, { ...quote, rates: { USD: '7.2' } }
  ], now).usd, undefined);
});

test('共用类型按真实卡 ID 保存，跨站和过期版本被拒，已引用类型可停用并回读', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const client = { get: async () => ({ cards: [{ id: 7, card_number: pan, card_cvc: '987' }] }) };
  const handler = createCardManagementHandler({ store, client, publicOrigin: origin });
  const get = () => request(handler, 'card-types');
  const post = (body, options) => request(handler, 'card-types', { body, ...options });
  const initial = (await get()).data;
  assert.deepEqual(initial.items.map(item => item.name), ['vccwc999', 'wise潘', 'wise佳', '小红卡峰']);
  const id = initial.items[1].id;
  const assign = { action: 'assign', version: 0, cardId: 'recharge:7', typeId: id };
  assert.equal((await post(assign, { requestOrigin: 'https://other.example.test' })).status, 403);
  assert.equal((await post(assign, { actor: { ...admin, role: 'employee' } })).status, 403);
  assert.equal((await post({ ...assign, cardId: 'recharge:9' })).status, 404);
  assert.equal((await post(assign)).status, 200);
  assert.equal((await post(assign)).status, 409);
  assert.equal((await post({ action: 'rename', version: 1, id, name: '合成分类' })).status, 200);
  assert.equal((await post({ action: 'remove', version: 2, id })).status, 200);
  const saved = (await get()).data;
  assert.equal(saved.assignments['recharge:7'], id);
  assert.deepEqual(saved.items.find(item => item.id === id), { id, name: '合成分类', active: false });
  assert.equal(store.featureDocument(cardTypeDocument).version, 3);
  assert.doesNotMatch(JSON.stringify([saved, store.audit()]), /4242424242424242|"987"/);
});

test('导入批次只给存在且未分类的卡设置类型，重复保存保留已有分类', async () => {
  const type = { id: 'type-new', name: '合成导入类型', active: true };
  const previous = { id: 'type-existing', name: '原分类', active: true };
  let current = { version: 4, data: {
    items: [type, previous, { id: 'type-disabled', name: '已停用分类', active: false }],
    assignments: { 'recharge:8': previous.id, 'recharge:9': type.id }
  } };
  const audit = [];
  const store = {
    featureDocument: () => current,
    saveFeatureDocument(domain, version, data, event) {
      assert.equal(domain, cardTypeDocument);
      assert.equal(version, current.version);
      audit.push(event);
      return current = { version: version + 1, data };
    }
  };
  let reads = 0;
  const handler = createCardManagementHandler({ store, publicOrigin: origin, client: {
    async get(path) {
      assert.equal(path, '/api/admin/cards');
      reads++;
      return { cards: [{ id: 7 }, { id: 8 }, { id: 9 }] };
    }
  } });
  const actor = { ...admin, role: 'super' };
  const post = (body, options) => request(handler, 'card-types', { body, actor, ...options });
  const command = { action: 'assign-imported', version: 4, typeId: type.id,
    cardIds: ['recharge:7', 'recharge:8', 'recharge:9', 'recharge:10', 'recharge:7'] };
  assert.equal((await post(command, { actor: admin })).status, 403);
  assert.equal((await post({ ...command, typeId: 'type-disabled' })).status, 400);
  assert.equal((await post({ ...command, cardIds: ['tenant:other'] })).status, 400);
  assert.equal(reads, 0);
  const result = await post(command);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.importTypes, { assigned: 1, alreadyAssigned: 1, conflict: 1, missing: 1 });
  assert.deepEqual(current.data.assignments, {
    'recharge:7': type.id, 'recharge:8': previous.id, 'recharge:9': type.id
  });
  assert.deepEqual(cardTypeSnapshot(current.data, { cardId: 'recharge:7' }), { id: type.id, name: type.name });
  assert.equal((await post(command)).status, 409);
  const repeated = await post({ ...command, version: 5 });
  assert.deepEqual(repeated.data.importTypes, { assigned: 0, alreadyAssigned: 2, conflict: 1, missing: 1 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].targetId, type.id);
});

test('复制从当前关联取卡号，结果按固定顺序，已删除或无法核对的卡不泄漏', async () => {
  let liveOrder = order;
  let cards = [{ id: 7, is_active: 1, card_number: pan, card_cvc: '987' }];
  const audits = [];
  const store = {
    load(domain) {
      return { data: domain === 'commerce' ? { orders: [liveOrder], tenants: [{ id: 'tenant-owner', active: true }] } :
        { costSettings: { cardPerPaymentUsd: '0.3' } } };
    },
    featureDocument(domain) {
      return { version: 1, data: domain === 'finance-rates' ? { quotes: [quote] } :
        domain === 'tenant-cards' ? { items: [{ id: 'tenant:one', tenantId: 'tenant-owner', number: pan, active: true }] } :
          { items: [{ id: 'type', name: 'wise潘', active: true }], assignments: { 'recharge:7': 'type' } } };
    },
    auditFeature(domain, version, data) { audits.push({ domain, version, data }); }
  };
  const handler = createCardManagementHandler({ store, client: { get: async () => ({ cards }) },
    publicOrigin: origin, clock: () => now });
  const copy = (cardId, actor) => request(handler, 'subscription-card-copy', { body: { orderId: order.id, cardId }, actor });
  const estimates = await request(handler, 'subscription-card-estimates');
  assert.equal(estimates.data.items[0].usd, '175.92');
  assert.doesNotMatch(JSON.stringify(estimates.data), /4242424242424242|"987"/);
  assert.equal((await copy('recharge:8')).status, 409);
  assert.equal((await copy('recharge:7', { ...admin, role: 'employee' })).status, 403);
  const result = await copy('recharge:7');
  assert.deepEqual(result.data, { text: 'wise潘 / ' + pan + ' / GPT Plus / 175.92 USD' });
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(audits[0].data.targetId, order.id);
  assert.doesNotMatch(JSON.stringify(audits), /4242424242424242|"987"/);
  cards[0].is_active = 0;
  assert.equal((await copy('recharge:7')).status, 404);
  assert.equal(audits.length, 1);
  cards = [];
  assert.equal((await copy('recharge:7')).status, 404);
  liveOrder = { ...order, cardId: '', financialEvidence: [{ kind: 'payment', payment: '银行卡', cardId: 'recharge:7' }] };
  assert.equal((await request(handler, 'subscription-card-estimates')).data.items.length, 1);
  liveOrder = { ...order, cardId: '', proMaterialMode: 'none' };
  assert.equal((await request(handler, 'subscription-card-estimates')).data.items.length, 0);
  liveOrder = { ...order, cardId: 'tenant:one', tenantId: 'different-owner' };
  assert.equal((await copy('tenant:one')).status, 404);
  liveOrder = { ...order, cardId: 'tenant:one', tenantId: 'tenant-owner', paidAmount: '' };
  assert.match((await copy('tenant:one')).data.text, /\/ 待核算$/);
});

function renewalCardsFixture(orders, { accounts = [], tenants = [], tenantCards = [], get } = {}) {
  const commerce = { version: 1, data: { orders, tenants, customers: [] } };
  const inventory = { version: 1, data: { accounts } };
  const audits = [];
  const store = {
    load(domain) {
      if (domain === 'commerce') return { ...commerce };
      if (domain === 'inventory') return { ...inventory };
      return { data: { costSettings: { cardPerPaymentUsd: '0.3' } } };
    },
    featureDocument(domain) {
      return { version: 1, data: domain === 'finance-rates' ? { quotes: [quote] } :
        domain === 'tenant-cards' ? { items: tenantCards } : null };
    },
    auditFeature(domain, version, data) { audits.push({ domain, version, data }); }
  };
  return {
    handler: createCardManagementHandler({ store, client: { get }, publicOrigin: origin, clock: () => now }),
    commerce, inventory, audits
  };
}

test('续费银行卡详情分别返回原单和可信后继，保留 Orbitcard 同步余额并阻止无关订单', async () => {
  const original = {
    ...order, orderNo: 'QA-OLD', email: 'account@example.test', customerId: 'customer-a',
    accountSource: '客户自有', cardId: 'orbitcard:9', start: '2026-10-11T20:00', expiry: '2026-11-11T20:00'
  };
  const nextPan = '4000000000000002';
  const renewal = {
    ...original, id: 'renewal-order', orderNo: 'QA-NEW', email: 'ACCOUNT@example.test',
    cardId: 'recharge:8', paymentId: '0002', start: '2026-11-11T20:00', expiry: '2026-12-11T20:00'
  };
  const calls = [];
  const { handler, audits } = renewalCardsFixture([original, renewal, {
    ...renewal, id: 'other-customer', customerId: 'customer-b', cardId: 'recharge:90'
  }], { get: async path => {
    calls.push(path);
    return path === '/api/admin/cards'
      ? { cards: [{ id: 8, is_active: 1, card_number: nextPan, card_cvc: '991' }] }
      : { cards: [
        { cardId: 19, status: 'ACTIVE', cardNumber: nextPan, balance: 999, balanceCurrency: 'USD', balanceUpdatedAt: date },
        { cardId: 9, status: 'ACTIVE', providerStatus: 'ACTIVE', cardNumber: pan, cardCvc: '991',
          balance: 8.25, balanceCurrency: 'USD', balanceUpdatedAt: date }
      ] };
  } });
  const details = (renewalOrderId, options) => request(handler, 'subscription-card-details', {
    body: { orderId: original.id, renewalOrderId }, ...options
  });
  const found = await details(renewal.id);
  assert.equal(found.status, 200);
  assert.match(found.headers['Cache-Control'], /no-store/);
  assert.deepEqual(found.data.order.account, {
    email: original.email, source: '客户自有', status: '未关联库存', canRenew: true
  });
  assert.equal(found.data.order.card.last4, '4242');
  assert.equal(found.data.order.card.canReveal, true);
  assert.deepEqual(found.data.order.card.paid, { amount: '10000', currency: 'PHP' });
  assert.equal(found.data.order.card.estimate.usd, '175.92');
  assert.deepEqual(found.data.order.card.balance, { amount: '8.25', currency: 'USD', updatedAt: date });
  assert.equal(found.data.renewal.id, renewal.id);
  assert.equal(found.data.renewal.card.last4, '0002');
  assert.equal(found.data.renewal.card.balance, null);
  assert.doesNotMatch(JSON.stringify(found.data), /4242424242424242|4000000000000002|cardCvc|card_cvc/);
  assert.ok(calls.includes('/api/admin/orbitcard/usage?page_size=100&keyword=9'));
  assert.ok(calls.every(path => !path.includes('refresh')));
  calls.length = 0;
  const unrelated = await details('other-customer');
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.data.renewal, null);
  assert.equal(unrelated.data.renewalStatus, '续费新单关联待核对');
  assert.equal(calls.includes('/api/admin/cards'), false);
  assert.equal((await details(renewal.id, { actor: { ...admin, role: 'employee' } })).status, 403);
  assert.equal((await details(renewal.id, { requestOrigin: 'https://outside.example.test' })).status, 403);
  assert.equal((await request(handler, 'subscription-card-reveal', {
    body: { orderId: original.id, version: 2 }
  })).status, 409);
  assert.deepEqual((await request(handler, 'subscription-card-reveal', {
    body: { orderId: original.id, version: 1 }
  })).data, { number: pan });
  const copied = await request(handler, 'subscription-card-copy', {
    body: { orderId: original.id, cardId: original.cardId, context: 'renewal', version: 1 }
  });
  assert.deepEqual(copied.data, { text: '未设置 / ' + pan + ' / GPT Plus / 175.92 USD' });
  assert.equal((await request(handler, 'subscription-card-copy', {
    body: { orderId: original.id, cardId: renewal.cardId, context: 'renewal' }
  })).status, 409);
  assert.deepEqual(audits.map(row => row.data.action), ['查看续费银行卡号', '复制续费银行卡资料']);
  assert.doesNotMatch(JSON.stringify(audits), /4242424242424242|4000000000000002/);
});

test('卡池故障保留可信历史金额和卡尾，异步读取后订单变化不能查看卡号', async () => {
  const original = {
    ...order, email: 'account@example.test', paidConfirmed: false, paidAmount: '888',
    financialEvidence: [{ kind: 'payment', cardId: order.cardId, payment: '银行卡', amount: '20', currency: 'USD' }]
  };
  let changed = false;
  const { handler, commerce, audits } = renewalCardsFixture([original], { get: async () => {
    if (!changed) throw new Error('Synthetic upstream offline');
    commerce.version++;
    return { cards: [{ id: 7, is_active: 1, card_number: pan }] };
  } });
  const view = await request(handler, 'subscription-card-details', { body: { orderId: original.id } });
  assert.equal(view.status, 200);
  assert.equal(view.data.order.account.source, '历史账号来源未登记');
  assert.equal(view.data.order.card.status, '卡池暂时无法读取');
  assert.equal(view.data.order.card.canReveal, false);
  assert.equal(view.data.order.card.last4, '4242');
  assert.equal(view.data.order.card.paid.amount, '20');
  assert.equal(view.data.order.card.estimate.usd, '22.30');
  assert.equal((await request(handler, 'subscription-card-reveal', { body: { orderId: original.id } })).status, 503);
  changed = true;
  const stale = await request(handler, 'subscription-card-reveal', { body: { orderId: original.id } });
  assert.equal(stale.status, 409);
  assert.doesNotMatch(JSON.stringify(stale.data), /4242424242424242/);
  assert.deepEqual(audits, []);
});

test('Orbitcard 只有核对过的尾号时仍可展示最近同步余额', async () => {
  const original = { ...order, cardId: 'orbitcard:9' };
  const orbit = {
    cardId: 9, cardLast4: '4242', status: 'ACTIVE', cardNumber: '', balance: 0,
    balanceCurrency: 'USD', balanceUpdatedAt: date
  };
  const { handler } = renewalCardsFixture([original], { get: async () => ({ cards: [orbit] }) });
  const body = { orderId: original.id };
  const details = () => request(handler, 'subscription-card-details', { body });
  const first = await details();
  assert.equal(first.data.order.card.status, '完整卡号未登记');
  assert.deepEqual(first.data.order.card.balance, { amount: '0', currency: 'USD', updatedAt: date });
  assert.equal(first.data.order.card.canReveal, false);
  assert.equal((await request(handler, 'subscription-card-reveal', { body })).status, 404);
  orbit.cardLast4 = '9999';
  const conflict = (await details()).data.order.card;
  assert.equal(conflict.status, '原卡资料待核对');
  assert.equal(conflict.balance, null);
  assert.equal(conflict.last4, '4242');
});

test('回收过的库存账号和冲突付款证据只显示安全历史信息', async () => {
  const original = { ...order, product: 'Claude Pro', plan: 'Pro', proMaterialMode: 'manual_card',
    email: 'stock@example.test', customerId: 'old-customer', accountId: 'stock', cardId: '', proCardNumber: pan };
  const conflict = { ...order, id: 'conflict-order', financialEvidence: [
    { kind: 'payment', cardId: 'recharge:8', payment: '银行卡', amount: '20', currency: 'USD' }
  ] };
  const { handler, audits } = renewalCardsFixture([original, conflict], {
    accounts: [{ id: 'stock', type: 'claude', email: original.email, password: 'secret-not-projected',
      inventoryState: 'available', accountLifecycle: { disposition: 'recovered' },
      accountLifecycleEvents: [{ action: 'release', orderIds: [original.id] }] }],
    get: async () => { throw new Error('These rows do not need an upstream lookup'); }
  });
  const view = id => request(handler, 'subscription-card-details', { body: { orderId: id } });
  const released = await view(original.id);
  assert.equal(released.status, 200);
  assert.equal(released.data.order.account.status, '本单使用已结束');
  assert.equal(released.data.order.account.canRenew, false);
  assert.equal(released.data.order.card.canReveal, false);
  assert.equal(released.data.order.card.last4, '4242');
  assert.doesNotMatch(JSON.stringify(released.data), /4242424242424242|secret-not-projected/);
  assert.equal((await request(handler, 'subscription-card-reveal', { body: { orderId: original.id } })).status, 404);
  assert.equal((await view(conflict.id)).data.order.card.status, '卡片关联待核对');
  assert.deepEqual(audits, []);
});
