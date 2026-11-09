import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { cardTypeDocument } from '../server/card-management.mjs';
import { normalizeClaudeProMaterials } from '../server/order-policy.mjs';

const origin = 'https://orders.example.test';
const route = '/api/local/commerce';
const admin = { id: 'admin', name: '合成管理员', role: 'admin' };
const employee = { id: 'employee', name: '合成员工', role: 'employee' };
const sampleNumber = '4242424242424242';
const sampleSerial = '00042-FIXTURE-CARD-SERIAL';
const customer = { id: 'customer-pro-test', name: '合成客户' };
const tenant = { id: 'tenant-pro-test', name: '合成认证人', phone: '+60123456789', active: true };
const makeDocument = (orders, tenants = []) => ({
  orders, tenants, customers: [customer], operating: [], rentBatches: [], logs: []
});
const base = (id, changes = {}) => ({
  id,
  product: 'Claude Pro',
  plan: 'Pro',
  businessType: '续费',
  customerId: customer.id,
  email: 'claude-pro-fixture@example.test',
  payment: '银行卡',
  cardId: '',
  paidAmount: '20',
  paidCurrency: 'USD',
  saleAmount: '500',
  saleCurrency: 'CNY',
  paidConfirmed: false,
  receiptConfirmed: false,
  costConfirmed: false,
  costBasis: 'standard',
  start: '2026-11-08T10:00',
  expiry: '2026-12-08T10:00',
  refunds: [],
  bankReturns: [],
  corrections: [],
  version: 1,
  ...changes
});
const manual = (id, changes = {}) => base(id, {
  proMaterialMode: 'manual_card', proCardNumber: sampleNumber, proCardSerial: sampleSerial,
  ...changes
});
const people = (id, changes = {}) => base(id, {
  proMaterialMode: 'people', phone: '+60123456780', ...changes
});

async function request(store, method, data, { actor = admin, path = route, readOrderCards } = {}) {
  const body = data ? [Buffer.from(JSON.stringify(data))] : [];
  const request = Object.assign(Readable.from(body), {
    method, url: path, headers: { host: 'orders.example.test', origin, 'content-type': 'application/json' }
  });
  const headers = {};
  let status, parsed;
  const response = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(code) { status = code; },
    end(value) { parsed = JSON.parse(value); }
  };
  await handleLocalBusiness(request, response, path, store, actor, { publicOrigin: origin, readOrderCards });
  return { status, data: parsed, headers };
}

function save(store, version, data, action = '新增独立订单', options) {
  return request(store, 'PUT', { version, data, action }, options);
}

function edit(before, changes) {
  const { corrections, refunds, bankReturns, ...previous } = before;
  return {
    ...before, ...changes, version: before.version + 1,
    corrections: [...corrections, {
      id: 'correction-' + before.version, reason: '资料核对更正', previous,
      versionAfter: before.version + 1
    }]
  };
}

test('Pro rejects missing, mixed and out-of-product materials without touching order or audit', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const invalid = [
      base('no-mode'),
      manual('mixed', { tenantId: tenant.id }),
      manual('missing-serial', { proCardSerial: '' }),
      manual('card-pool', { cardId: 'tenant:pool' }),
      people('no-people', { phone: '' }),
      people('mixed-people', { proCardSerial: sampleSerial }),
      people('unverified-tenant', { tenantId: 'absent', kyc: 'KYC 认证' }),
      manual('max', { product: 'Claude Max', plan: 'Max 5x' }),
      manual('apple', { payment: '苹果内购' })
    ];
    for (const order of invalid) {
      const result = await save(store, 0, makeDocument([order]));
      assert.equal(result.status, 400, order.id);
      assert.doesNotMatch(JSON.stringify(result.data), /4242424242424242|00042-FIXTURE-CARD-SERIAL/);
    }
    assert.equal(store.load('commerce').version, 0);
    assert.equal(store.audit().length, 0);
    const existingMax = base('legacy-max', { product: 'Claude Max', plan: 'Max 5x' });
    const existingApple = base('apple-pro', { payment: '苹果内购' });
    const safe = await save(store, 0, makeDocument([existingMax, existingApple]));
    assert.equal(safe.status, 200);
    assert.ok(safe.data.data.orders.every((order) => !Object.hasOwn(order, 'proMaterialMode')));
  } finally { store.close(); }
});

test('Pro manual cards are normalized, excluded from pool, and exposed only to managers', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const input = manual('manual-order', {
      proCardNumber: '4242 4242-4242 4242', paymentId: '9999', paidConfirmed: true
    });
    const saved = await save(store, 0, makeDocument([input]));
    assert.equal(saved.status, 200);
    assert.equal(saved.data.data.orders[0].proCardNumber, sampleNumber);
    assert.equal(saved.data.data.orders[0].proCardSerial, sampleSerial);
    assert.equal(saved.data.data.orders[0].paymentId, '4242');
    assert.equal(saved.data.data.orders[0].cardId, '');
    assert.equal(saved.data.data.orders[0].financialEvidence[0].cardId, '');
    assert.deepEqual(store.featureDocument('tenant-cards'), { data: null, version: 0 });
    assert.doesNotMatch(JSON.stringify(store.audit()), /4242424242424242|00042-FIXTURE-CARD-SERIAL/);
    const full = await request(store, 'GET');
    assert.equal(full.data.data.orders[0].proCardNumber, sampleNumber);
    const masked = await request(store, 'GET', undefined, { actor: employee });
    assert.equal(masked.headers['Cache-Control'], 'private, no-store');
    assert.equal(masked.data.data.orders[0].proCardNumber, '•••• 4242');
    assert.equal(Object.hasOwn(masked.data.data.orders[0], 'proCardSerial'), false);
    const stale = await save(store, 0, makeDocument([input]));
    assert.equal(stale.status, 409);
    assert.deepEqual(Object.keys(stale.data), ['error']);
    assert.equal(store.load('commerce').data.orders.length, 1);
  } finally { store.close(); }
});

test('Pro can correct unconfirmed material mode and retains the original encrypted-history fields', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const created = await save(store, 0, makeDocument([manual('switch')], [tenant]));
    assert.equal(created.status, 200);
    const before = created.data.data.orders[0];
    const amended = edit(before, {
      proMaterialMode: 'people', proCardNumber: '', proCardSerial: '', tenantId: tenant.id,
      verifier: '伪造认证人', verifierPhone: '99999', kyc: 'KYC 认证'
    });
    const nextDoc = { ...created.data.data, orders: [amended] };
    assert.equal((await save(store, 1, nextDoc, '退款登记')).status, 409);
    const corrected = await save(store, 1, nextDoc, '更正订单');
    assert.equal(corrected.status, 200);
    const order = corrected.data.data.orders[0];
    assert.equal(order.proMaterialMode, 'people');
    assert.equal(order.proCardNumber, undefined);
    assert.equal(order.verifier, tenant.name);
    assert.equal(order.verifierPhone, tenant.phone);
    assert.deepEqual(order.costSettings, before.costSettings);
    assert.equal(order.corrections[0].previous.proCardNumber, sampleNumber);
    const tampered = { ...order, version: order.version + 1, corrections: [] };
    assert.equal((await save(store, 2, { ...corrected.data.data, orders: [tampered] }, '更正订单')).status, 409);
    const redacted = await request(store, 'GET', undefined, { actor: employee });
    assert.equal(redacted.data.data.orders[0].corrections[0].previous.proCardNumber, '•••• 4242');
    assert.doesNotMatch(JSON.stringify(redacted.data), /4242424242424242|00042-FIXTURE-CARD-SERIAL/);
  } finally { store.close(); }
});

test('Pro protects confirmed payment, supports people-mode return and allows same-card serial correction', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const created = await save(store, 0, makeDocument([
      manual('confirmed-card', { paidConfirmed: true }), people('confirmed-people', { paidConfirmed: true })
    ]));
    assert.equal(created.status, 200);
    const [card, person] = created.data.data.orders;
    const replacement = edit(card, { proCardNumber: '4000000000000002' });
    const update = (version, orders, action = '更正订单') => save(store, version, { ...created.data.data, orders }, action);
    assert.equal((await update(1, [replacement, person])).status, 409);
    const serialOnly = edit(card, { proCardSerial: '00043-REVISED' });
    const correction = await update(1, [serialOnly, person]);
    assert.equal(correction.status, 200);
    assert.deepEqual(correction.data.data.orders[0].financialEvidence, card.financialEvidence);
    const back = { ...person, version: 2, bankReturns: [
      { id: 'return-pro-people', cardId: '', amount: '2', currency: 'USD' }
    ] };
    const returned = await update(2, [correction.data.data.orders[0], back], '银行卡回款登记');
    assert.equal(returned.status, 200);
    assert.equal(returned.data.data.orders[1].bankReturns[0].amount, '2');
  } finally { store.close(); }
});

test('Pro shortcut renewal verifies the original version and never duplicates its successor', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const created = await save(store, 0, makeDocument([people('renewal-source', { paidConfirmed: true })]));
    assert.equal(created.status, 200);
    const source = created.data.data.orders[0];
    const renewal = manual('renewal-next', {
      proRenewalSourceId: source.id, proRenewalSourceVersion: source.version,
      start: source.expiry, expiry: '2027-01-08T10:00',
      proCardSerial: '00043-NEW-CARD-SERIAL'
    });
    const update = (version, orders) => save(store, version, { ...created.data.data, orders });
    assert.equal((await update(1, [source, { ...renewal, proRenewalSourceVersion: 99 }])).status, 409);
    assert.equal((await update(1, [source, { ...renewal, claudeRenewalId: 'another-order' }])).status, 409);
    assert.equal((await update(1, [source, manual('legacy-source-only', { claudeRenewalId: source.id })])).status, 409);
    assert.equal((await update(1, [{ ...source, notes: '同批改写源单' }, renewal])).status, 409);
    assert.equal((await update(1, [source, { ...renewal, email: 'other@example.test' }])).status, 409);
    const saved = await update(1, [source, renewal]);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.data.orders[0], source);
    assert.equal(saved.data.data.orders[1].proRenewalSourceId, source.id);
    assert.equal(saved.data.data.orders[1].paidConfirmed, false);
    const duplicate = { ...renewal, id: 'second-next' };
    assert.equal((await update(2, [...saved.data.data.orders, duplicate])).status, 409);
    assert.equal(store.load('commerce').data.orders.length, 2);
  } finally { store.close(); }
});

test('Pro bank renewal recognizes successors recorded with the existing source field', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const created = await save(store, 0, makeDocument([people('legacy-successor-source')]));
    assert.equal(created.status, 200);
    const [source] = created.data.data.orders;
    const apple = base('apple-legacy-successor', { payment: '苹果内购', claudeRenewalId: source.id });
    const existing = await save(store, 1, makeDocument([source, apple]));
    assert.equal(existing.status, 200);
    const successor = manual('new-bank-successor', {
      proRenewalSourceId: source.id, proRenewalSourceVersion: source.version,
      claudeRenewalId: source.id
    });
    const duplicate = await save(store, 2, { ...existing.data.data, orders: [...existing.data.data.orders, successor] });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.data.error, /已有续费记录/);
  } finally { store.close(); }
});

test('legacy Pro records without material mode remain readable without inventing new card facts', () => {
  const prior = base('legacy-order', { cardId: 'tenant:historical', paymentId: '4242', paidConfirmed: true });
  const order = { ...prior, notes: '旧订单备注' };
  assert.equal(normalizeClaudeProMaterials(order, prior, []), undefined);
  assert.equal(order.cardId, prior.cardId);
  assert.equal(order.paymentId, prior.paymentId);
  assert.equal(Object.hasOwn(order, 'proMaterialMode'), false);
});

test('Pro can save verified pool and tenant cards while keeping paid card and historical return sources fixed', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const secondTenant = { ...tenant, id: 'tenant-other-test', name: '另一认证人' };
    const tenants = [tenant, secondTenant];
    const tenantCardId = 'tenant:verified';
    const poolCardId = 'recharge:17';
    let poolActive = true;
    let poolReads = 0;
    const options = { readOrderCards: async () => {
      poolReads++;
      return [{ id: poolCardId, active: poolActive, last4: '1919', usageCount: 0 }];
    } };
    store.saveFeatureDocument('tenant-cards', 0, {
      items: [{ id: tenantCardId, tenantId: tenant.id, active: true, number: sampleNumber }]
    });
    const pool = base('pool-order', {
      proMaterialMode: 'pool_card', cardId: poolCardId, paidConfirmed: true, paymentId: '9999'
    });
    const tenantOrder = base('tenant-order', {
      proMaterialMode: 'tenant_card', cardId: tenantCardId, tenantId: tenant.id, paidConfirmed: true,
      verifier: '伪造姓名', verifierPhone: '99999'
    });
    const none = base('none-order', { proMaterialMode: 'none', paidConfirmed: true, paymentId: '9999' });
    const create = (orders) => save(store, 0, makeDocument(orders, tenants), '新增独立订单', options);
    assert.equal((await create([{ ...tenantOrder, tenantId: secondTenant.id }])).status, 409);
    assert.equal((await create([{ ...pool, proCardNumber: sampleNumber }])).status, 400);
    assert.equal((await create([{ ...pool, cardId: tenantCardId }])).status, 400);
    assert.equal((await create([{ ...none, tenantId: tenant.id }])).status, 400);
    assert.equal((await create([{ ...pool, product: 'Claude Max', plan: 'Max 5x', proMaterialMode: '' }])).status, 400);
    poolActive = false;
    assert.equal((await create([pool])).status, 409);
    assert.equal(store.load('commerce').version, 0);
    poolActive = true;
    const created = await create([pool, tenantOrder, none]);
    assert.equal(created.status, 200);
    const [poolSaved, tenantSaved, noneSaved] = created.data.data.orders;
    assert.equal(poolSaved.paymentId, '1919');
    assert.equal(poolSaved.financialEvidence[0].cardId, poolCardId);
    assert.equal(poolSaved.issueFeeSnapshot, undefined);
    assert.equal(tenantSaved.paymentId, '4242');
    assert.equal(tenantSaved.verifier, tenant.name);
    assert.equal(tenantSaved.verifierPhone, tenant.phone);
    assert.equal(noneSaved.paymentId, '');
    assert.equal(noneSaved.financialEvidence[0].cardId, '');
    assert.doesNotMatch(JSON.stringify(created.data), /4242424242424242/);
    const reads = poolReads;
    const change = async (orders, action = '更正订单') =>
      save(store, 1, { ...created.data.data, orders }, action, options);
    assert.equal((await change([poolSaved, tenantSaved, edit(noneSaved, {
      proMaterialMode: 'pool_card', cardId: poolCardId
    })])).status, 409);
    assert.equal((await change([poolSaved, edit(tenantSaved, { tenantId: secondTenant.id }), noneSaved])).status, 409);
    const bankReturn = { ...poolSaved, version: 2, bankReturns: [
      { id: 'pool-return', cardId: tenantCardId, currency: 'USD', amount: '1' }
    ] };
    assert.equal((await change([bankReturn, tenantSaved, noneSaved], '银行卡回款登记')).status, 409);
    bankReturn.bankReturns[0].cardId = poolCardId;
    assert.equal((await change([bankReturn, tenantSaved, noneSaved], '银行卡回款登记')).status, 200);
    assert.equal(poolReads, reads);
  } finally { store.close(); }
});

test('GPT manual payment can omit a card without applying the pool first-use fee', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const order = base('gpt-no-card', { product: 'GPT', plan: 'Plus', paymentId: '9999', paidConfirmed: true });
    const saved = await save(store, 0, makeDocument([order]));
    assert.equal(saved.status, 200);
    const [manualGpt] = saved.data.data.orders;
    assert.equal(manualGpt.paymentId, '');
    assert.equal(manualGpt.financialEvidence[0].cardId, '');
    assert.deepEqual(manualGpt.issueFeeSnapshot, { cardId: '', applied: false, pending: true });
    const editPayment = edit(manualGpt, { cardId: 'recharge:1' });
    assert.equal((await save(store, 1, { ...saved.data.data, orders: [editPayment] }, '更正订单')).status, 409);
  } finally { store.close(); }
});

test('bank card type snapshots come from the current taxonomy and retain historical labels', async () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const cardId = 'recharge:41';
    const typeId = 'card-type-fixture';
    const data = { items: [{ id: typeId, name: '测试卡类型', active: true }], assignments: { [cardId]: typeId } };
    store.saveFeatureDocument(cardTypeDocument, 0, data);
    assert.equal(store.changeVersions(admin)[cardTypeDocument], '1');
    assert.equal(store.changeVersions(employee)[cardTypeDocument], undefined);
    const options = { readOrderCards: async () => [{ id: cardId, active: true, last4: '1234', usageCount: 1 }] };
    const order = base('type-snapshot', { proMaterialMode: 'pool_card', cardId, cardTypeName: '客户端伪造类型' });
    const saved = await save(store, 0, makeDocument([order]), '新增独立订单', options);
    assert.equal(saved.status, 200);
    const [prior] = saved.data.data.orders;
    assert.equal(prior.cardTypeId, typeId);
    assert.equal(prior.cardTypeName, '测试卡类型');
    store.saveFeatureDocument(cardTypeDocument, 1, {
      ...data, items: [{ id: typeId, name: '已改名并停用', active: false }]
    });
    const rejected = await save(store, 1, {
      ...saved.data.data, orders: [prior, base('type-inactive', { proMaterialMode: 'none', cardTypeId: typeId })]
    }, '新增独立订单', options);
    assert.equal(rejected.status, 400);
    const corrected = edit(prior, { notes: '更正说明', cardTypeName: '客户端覆盖标签' });
    corrected.corrections[0].previous.cardTypeName = '客户端覆盖历史标签';
    const updated = await save(store, 1, { ...saved.data.data, orders: [corrected] }, '更正订单', options);
    assert.equal(updated.status, 200);
    const [updatedOrder] = updated.data.data.orders;
    assert.equal(updatedOrder.cardTypeName, '测试卡类型');
    assert.equal(updatedOrder.corrections[0].previous.cardTypeName, '测试卡类型');
    const cleared = edit(updatedOrder, { cardTypeId: '' });
    assert.equal((await save(store, 2, { ...updated.data.data, orders: [cleared] },
      '退款登记', options)).status, 409);
    const removed = await save(store, 2, { ...updated.data.data, orders: [cleared] }, '更正订单', options);
    assert.equal(removed.status, 200);
    assert.equal(removed.data.data.orders[0].cardTypeId, undefined);
    assert.equal(removed.data.data.orders[0].cardTypeName, undefined);
  } finally { store.close(); }
});

test('confirmed recharge readback snapshots a type only on first association with its card', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const cardId = 'recharge:61';
    const typeId = 'card-type-recharge';
    const data = { items: [{ id: typeId, name: '同步卡类型', active: true }], assignments: { [cardId]: typeId } };
    store.saveFeatureDocument(cardTypeDocument, 0, data);
    const order = base('incoming', {
      product: 'GPT', plan: 'Plus', source: '线上代充', taskId: 'synthetic-job', cardId
    });
    const input = { since: 0, row: { jobKey: order.taskId, needs: [] }, order };
    store.applyRechargeOrder(input);
    const [original] = store.load('commerce').data.orders;
    assert.equal(original.cardTypeId, typeId);
    assert.equal(original.cardTypeName, '同步卡类型');
    store.saveFeatureDocument(cardTypeDocument, 1, {
      ...data, items: [{ id: typeId, name: '更新卡类型', active: true }]
    });
    store.applyRechargeOrder(input);
    const [latest] = store.load('commerce').data.orders;
    assert.deepEqual(latest, original);
  } finally { store.close(); }
});

test('Pro file-backed isolated fixture reopens with data intact and no plaintext card data', async () => {
  const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'claude-pro-'));
  const file = join(directory, 'fixture.sqlite');
  let store = createLocalBusinessStore(file);
  try {
    const saved = await save(store, 0, makeDocument([manual('reopen')]));
    assert.equal(saved.status, 200);
    store.close();
    store = undefined;
    const bytes = await readFile(file);
    assert.ok(!bytes.includes(Buffer.from(sampleNumber)));
    assert.ok(!bytes.includes(Buffer.from(sampleSerial)));
    store = createLocalBusinessStore(file);
    const order = store.load('commerce').data.orders[0];
    assert.equal(order.proCardNumber, sampleNumber);
    assert.equal(order.proCardSerial, sampleSerial);
    assert.doesNotMatch(JSON.stringify(store.audit()), /4242424242424242|00042-FIXTURE-CARD-SERIAL/);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
