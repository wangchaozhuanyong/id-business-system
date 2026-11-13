import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';

const actor = { id: 'audit-admin', name: 'Synthetic auditor', role: 'super', active: true };
const seedOrder = () => ({ id: 'audit-order', orderNo: 'AUDIT-1', product: 'GPT', plan: 'Plus',
  source: '管理员手工', businessType: '新开', customerId: 'audit-customer', email: 'audit@example.test',
  payment: '银行卡', cardId: '', paymentId: '', paidAmount: '20.0000', paidCurrency: 'USD', paidConfirmed: true,
  saleAmount: '100.0000', saleCurrency: 'CNY', receiptConfirmed: true,
  start: '2026-11-01T10:30', expiry: '2026-12-01T10:30', ownerId: actor.id, owner: actor.name,
  refunds: [], bankReturns: [], corrections: [], version: 1 });
function setup(extra = {}, dataOverrides = {}) {
  const store = createLocalBusinessStore(':memory:');
  store.saveBatch([{ domain: 'commerce', version: 0, action: '新增独立订单', data: {
    customers: [{ id: 'audit-customer', name: 'Synthetic customer', active: true }], tenants: [],
    orders: [{ ...seedOrder(), ...extra }], operating: [], rentBatches: [], logs: [], ...dataOverrides
  } }]);
  return store;
}
async function submit(store, mutate, action = '修改资料', options = {}) {
  const snapshot = store.load('commerce'); mutate(snapshot.data);
  const body = { ...snapshot, action, ...options.body };
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.headers = { host: 'audit.invalid', origin: 'http://audit.invalid', 'content-type': 'application/json',
    'x-id-operation': options.operation || 'audit-operation-0001' };
  request.method = 'PUT'; request.url = '/api/local/commerce';
  let status, value;
  const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } };
  await handleLocalBusiness(request, response, request.url, store, actor,
    { readOrderCards: async () => [], readOrderOwners: () => [actor], requireRenewalHandoff: true });
  return { status, body: value };
}

test('control: stale document version rejects and does not change the order', async () => {
  const store = setup();
  const result = await submit(store, data => { data.orders[0].saleAmount = '999.0000'; }, '更正订单', { body: { version: 0 } });
  assert.equal(result.status, 409); assert.equal(store.load('commerce').data.orders[0].saleAmount, '100.0000'); store.close();
});
test('control: negative receipt through the correction action is rejected', async () => {
  const store = setup(); const result = await submit(store, data => { data.orders[0].saleAmount = '-1'; }, '更正订单');
  assert.equal(result.status, 400, JSON.stringify(result)); store.close();
});
test('control: direct cancellation of an order with recorded money is rejected', async () => {
  const store = setup(); const result = await submit(store, data => { data.orders[0].cancelled = true; }, '业务撤单');
  assert.equal(result.status, 409, JSON.stringify(result)); store.close();
});
test('DA-F01: unknown action cannot change recorded receipt without correction history or row revision', async () => {
  const store = setup(); const result = await submit(store, data => { data.orders[0].saleAmount = '999.0000'; }, 'audit-unknown-action');
  assert.equal(result.status, 409, JSON.stringify(result));
  const saved = store.load('commerce').data.orders[0];
  assert.equal(saved.saleAmount, '100.0000'); assert.equal(saved.version, 1); assert.deepEqual(saved.corrections, []);
  assert.notEqual(store.audit()[0].action, 'local_save'); store.close();
});
test('DA-F01: contact action also rejects a negative recorded receipt', async () => {
  const store = setup(); const result = await submit(store, data => { data.orders[0].saleAmount = '-1'; }, '修改资料');
  assert.equal(result.status, 400, JSON.stringify(result)); assert.equal(store.load('commerce').data.orders[0].saleAmount, '100.0000'); store.close();
});
test('DA-F02: removing a referenced customer is rejected', async () => {
  const store = setup(); const result = await submit(store, data => { data.customers = []; }, '修改资料');
  assert.equal(result.status, 409, JSON.stringify(result));
  const saved = store.load('commerce').data;
  assert.equal(saved.customers.length, 1); assert.equal(saved.orders[0].customerId, 'audit-customer'); store.close();
});
test('control: bank order ordinary correction history cannot be deleted', async () => {
  const store = setup({ version: 2, corrections: [{ id: 'audit-correction', reason: 'Synthetic correction',
    versionAfter: 2, previous: { ...seedOrder(), saleAmount: '90.0000' } }],
    financialEvidence: [{ kind: 'receipt', amount: '90.0000', currency: 'CNY', at: '2026-11-01T00:00:00Z' }] });
  const result = await submit(store, data => { data.orders[0].corrections = []; data.orders[0].financialEvidence = []; });
  assert.equal(result.status, 409, JSON.stringify(result)); store.close();
});
test('DA-F01: correction requires a reason, original snapshot and row revision', async () => {
  const store = setup(); const result = await submit(store, data => { data.orders[0].saleAmount = '999.0000'; }, '更正订单');
  assert.equal(result.status, 409, JSON.stringify(result));
  const saved = store.load('commerce').data.orders[0];
  assert.equal(saved.saleAmount, '100.0000'); assert.equal(saved.version, 1); assert.deepEqual(saved.corrections, []); store.close();
});
test('DA-F03: external Apple history cannot be removed', async () => {
  const original = { ...seedOrder(), payment: '苹果内购', externalApplePayment: true, saleAmount: '90.0000' };
  const store = setup({ payment: '苹果内购', externalApplePayment: true, version: 2,
    corrections: [{ id: 'audit-correction', reason: 'Synthetic correction', versionAfter: 2, previous: original }],
    financialEvidence: [{ kind: 'receipt', amount: '90.0000', currency: 'CNY', at: '2026-11-01T00:00:00Z' }] });
  const result = await submit(store, data => { data.orders[0].corrections = []; data.orders[0].financialEvidence = []; });
  assert.equal(result.status, 409, JSON.stringify(result));
  const saved = store.load('commerce').data.orders[0];
  assert.equal(saved.corrections.length, 1); assert.equal(saved.financialEvidence.some(row => row.kind === 'receipt'), true); store.close();
});
test('control: previously stored customer refund cannot be deleted', async () => {
  const store = setup({ refunds: [{ id: 'audit-refund', amount: '10', currency: 'CNY', payment: '银行卡' }] });
  const result = await submit(store, data => { data.orders[0].refunds = []; });
  assert.equal(result.status, 409, JSON.stringify(result)); store.close();
});
const paidRentBatch = () => ({ id: 'RENT-LOCAL-001', at: '2026-11-01 10:00', notes: '', items: [{
  id: 'synthetic-rent-item', orderId: 'audit-order', email: 'rental@example.test', tenantId: 'synthetic-tenant',
  start: '2026-11-01', end: '2026-11-30', period: '2026-11-01 至 2026-11-30', status: '已发放',
  version: 2, paidAt: '2026-11-02 10:00', notes: 'Synthetic payment confirmed',
  payments: [{ status: '已发放', at: '2026-11-02 10:00', actorId: actor.id, actor: actor.name, notes: 'Synthetic receipt' }]
}] });

function correct(row, changes) {
  const previous = structuredClone(row);
  for (const field of ['corrections', 'refunds', 'bankReturns']) delete previous[field];
  Object.assign(row, changes, { version: row.version + 1 });
  row.corrections.push({ id: 'audit-correction-new', reason: '核对原始凭据', previous, versionAfter: row.version });
}

test('valid monetary correction and compensating undo preserve the complete history', async () => {
  const store = setup();
  const result = await submit(store, data => correct(data.orders[0], { saleAmount: '150.0000' }), '更正订单');
  assert.equal(result.status, 200, JSON.stringify(result));
  const corrected = store.load('commerce');
  assert.equal(corrected.data.orders[0].saleAmount, '150.0000');
  const undo = await submit(store, data => {
    const row = data.orders[0], change = row.corrections.at(-1);
    row.saleAmount = change.previous.saleAmount;
    row.version++;
    row.compensations = [{ id: 'audit-compensation', correctionId: change.id, reason: '恢复核对前金额',
      fromVersion: 2, toVersion: 3 }];
  }, '补偿撤回更正', { operation: 'audit-operation-0002' });
  assert.equal(undo.status, 200, JSON.stringify(undo));
  const saved = store.load('commerce').data.orders[0];
  assert.equal(saved.saleAmount, '100.0000'); assert.equal(saved.version, 3);
  assert.equal(saved.corrections.length, 1); assert.equal(saved.compensations.length, 1);
  store.close();
});

test('forged original amount and an undo without a compensation receipt are rejected atomically', async () => {
  const store = setup(), before = store.load('commerce');
  const forged = await submit(store, data => {
    correct(data.orders[0], { saleAmount: '150.0000' });
    data.orders[0].corrections[0].previous.saleAmount = '1';
  }, '更正订单');
  assert.equal(forged.status, 409); assert.deepEqual(store.load('commerce'), before);
  assert.equal((await submit(store, data => correct(data.orders[0], { saleAmount: '150.0000' }), '更正订单')).status, 200);
  const corrected = store.load('commerce');
  const undo = await submit(store, data => { data.orders[0].saleAmount = '100.0000'; data.orders[0].version++; },
    '补偿撤回更正', { operation: 'audit-operation-0002' });
  assert.equal(undo.status, 409); assert.deepEqual(store.load('commerce'), corrected); store.close();
});

test('valid correction records cannot smuggle negative actual costs or invalid cost currencies', async () => {
  for (const changes of [{ costBasis: 'actual', actualCostAmount: '-1', actualCostCurrency: 'CNY' },
    { costBasis: 'actual', actualCostAmount: '100', actualCostCurrency: 'INVALID' },
    { emailCostAmount: '-1', emailCostCurrency: 'CNY' },
    { costBasis: 'actual', actualCostAmount: '100', actualCostCurrency: 'USD', appleRecoverableCostAmount: '101' }]) {
    const store = setup(), before = store.load('commerce');
    const result = await submit(store, data => correct(data.orders[0], changes), '更正订单');
    assert.equal(result.status, 409, JSON.stringify(result)); assert.deepEqual(store.load('commerce'), before); store.close();
  }
});

test('compensation can restore an original actual cost without discarding its audit trail', async () => {
  const store = setup({ costBasis: 'actual', actualCostAmount: '70', actualCostCurrency: 'CNY' });
  const result = await submit(store, data => correct(data.orders[0], { costBasis: 'standard' }), '更正订单');
  assert.equal(result.status, 200, JSON.stringify(result));
  const undo = await submit(store, data => {
    const row = data.orders[0]; row.costBasis = 'actual'; row.version++;
    row.compensations = [{ id: 'restore-actual-cost', correctionId: row.corrections.at(-1).id,
      reason: '恢复原有实际成本凭据', fromVersion: 2, toVersion: 3 }];
  }, '补偿撤回更正', { operation: 'audit-operation-0002' });
  assert.equal(undo.status, 200, JSON.stringify(undo));
  assert.equal(store.load('commerce').data.orders[0].actualCostAmount, '70'); store.close();
});

test('reducing actual cost cannot leave an unchanged recoverable portion above the total', async () => {
  const store = setup({ payment: '苹果内购', externalApplePayment: true, costBasis: 'actual',
    actualCostAmount: '100', actualCostCurrency: 'CNY', appleRecoverableCostAmount: '80' });
  const before = store.load('commerce');
  const result = await submit(store, data => correct(data.orders[0], { actualCostAmount: '50' }), '更正订单');
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.deepEqual(store.load('commerce'), before); store.close();
});

test('customer deactivation and unrelated edits to a legacy orphan remain available', async () => {
  const store = setup();
  assert.equal((await submit(store, data => { data.customers[0].active = false; })).status, 200);
  store.close();
  const legacy = setup({ customerId: 'historic-unlinked-customer' });
  const result = await submit(legacy, data => { data.orders[0].notes = '仅补充备注'; });
  assert.equal(result.status, 200, JSON.stringify(result)); legacy.close();
});

test('receipt-only tampering on an external Apple order is rejected even with preserved corrections', async () => {
  const store = setup({ payment: '苹果内购', externalApplePayment: true,
    financialEvidence: [{ kind: 'receipt', amount: '100.0000', currency: 'CNY', at: '2026-11-01T00:00:00Z' }] });
  const before = store.load('commerce');
  const result = await submit(store, data => { data.orders[0].financialEvidence[0].amount = '1'; });
  assert.equal(result.status, 409); assert.deepEqual(store.load('commerce'), before); store.close();
});

test('an existing pending rent item may append one payment; settled evidence cannot be erased', async () => {
  const batch = paidRentBatch(), item = batch.items[0];
  Object.assign(item, { status: '待发放', version: 1, payments: [], notes: '', paidAt: '' });
  const store = setup({}, { rentBatches: [batch] });
  const result = await submit(store, data => {
    const row = data.rentBatches[0].items[0];
    Object.assign(row, { status: '已发放', version: 2, notes: '核对发放凭据', paidAt: '2026-11-03 10:00' });
    row.payments.push({ status: row.status, at: row.paidAt, notes: row.notes, actorId: actor.id, actor: actor.name });
  }, '租金发放登记');
  assert.equal(result.status, 200, JSON.stringify(result));
  const paid = store.load('commerce');
  for (const mutation of [data => { data.rentBatches[0].items = []; },
    data => { data.rentBatches[0].items[0].payments = []; },
    data => { data.rentBatches[0].items[0].status = '待发放'; }]) {
    const invalid = await submit(store, mutation, '修改资料', { operation: 'audit-operation-0002' });
    assert.equal(invalid.status, 409); assert.deepEqual(store.load('commerce'), paid);
  }
  store.close();
});
test('DA-F04: generic save cannot erase an already-paid rent batch', async () => {
  const store = setup({}, { rentBatches: [paidRentBatch()] });
  const result = await submit(store, data => { data.rentBatches = []; });
  assert.equal(result.status, 409, JSON.stringify(result)); assert.deepEqual(store.load('commerce').data.rentBatches, [paidRentBatch()]); store.close();
});
test('control: retired rent action and generic creation both reject new rent batches', async () => {
  const batch = paidRentBatch(), duplicate = structuredClone(batch);
  duplicate.id = 'RENT-LOCAL-002'; duplicate.items[0].id = 'synthetic-rent-item-2';
  duplicate.items[0].status = '待发放'; duplicate.items[0].paidAt = ''; duplicate.items[0].payments = [];
  const store = setup({}, { rentBatches: [batch] });
  const result = await submit(store, data => { data.rentBatches.push(duplicate); }, '建立租金发放批次');
  assert.equal(result.status, 403, JSON.stringify(result));
  const generic = await submit(store, data => { data.rentBatches.push(duplicate); }, '修改资料');
  assert.equal(generic.status, 403, JSON.stringify(generic)); assert.equal(store.load('commerce').data.rentBatches.length, 1); store.close();
});
