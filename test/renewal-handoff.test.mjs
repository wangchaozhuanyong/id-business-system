import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditAppleWallets } from '../server/finance/apple-wallet-audit.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { stageConfirmedRenewalDebit } from '../server/apple-funding.mjs';
import { cardTypeDocument } from '../server/card-management.mjs';
import { subscriptionDomain, subscriptionAccountId } from '../server/subscription-management.mjs';
import { createRenewalHandoff, renewalHandoffDomain, renewalHandoffPath } from '../server/renewal-handoff.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';

const origin = 'https://renewal.example.test';
const actors = {
  employee: { id: 'first-employee', name: '员工甲', role: 'employee' },
  other: { id: 'second-employee', name: '员工乙', role: 'employee' },
  finance: { id: 'first-finance', name: '财务甲', role: 'finance' },
  financeOther: { id: 'second-finance', name: '财务乙', role: 'finance' },
  supervisor: { id: 'manager', name: '主管甲', role: 'supervisor' },
  super: { id: 'supervisor', name: '超管', role: 'super' },
  registrar: { id: 'registration', name: '注册员', role: 'registrar' }
};
const firstCard = '4242424242424242';
const replacement = '4111111111111111';
const initialOrder = { id: 'original', ownerId: actors.employee.id, owner: actors.employee.name,
  orderNo: 'OD-FIXTURE-001', customerId: 'customer', email: 'customer@example.test', product: 'GPT', plan: 'Plus',
  payment: '银行卡', proMaterialMode: 'manual_card', proCardNumber: firstCard, proCardSerial: 'fixture-original-card',
  paymentId: '4242', paidAmount: '20.00', paidCurrency: 'USD', saleAmount: '150.00', saleCurrency: 'CNY',
  paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', businessType: '续费',
  start: '2026-10-12T11:00', expiry: '2026-11-12T11:00', source: '管理员手工', version: 1 };
const emptyCommerce = { customers: [{ id: 'customer', name: '测试客户', active: true }],
  tenants: [], operating: [], rentBatches: [], logs: [] };
const finishFields = { start: '2026-11-13T12:00', expiry: '2026-12-13T11:00', saleAmount: '160.00', saleCurrency: 'CNY' };

function fixture(t, orders = [initialOrder], setup, database = ':memory:') {
  const store = createLocalBusinessStore(database);
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  t.after(close);
  const data = { ...structuredClone(emptyCommerce), orders: structuredClone(orders) };
  if (setup) setup(store, data);
  else store.saveBatch([{ domain: 'commerce', version: 0, data }]);
  return { store, close, send: sender(store), submit: { action: 'submit', confirmed: true, orders: [{ id: orders[0].id, version: 1 }] } };
}

function sender(store) {
  const handler = createRenewalHandoff({ store, publicOrigin: origin, clock: () => Date.UTC(2026, 10, 13, 5),
    getAuth: () => ({ recentlyVerified: request => request.readVerified, orderOwners: () => Object.values(actors),
      teamFor: () => [actors.employee] }), client: { get: async () => ({ cards: [] }) } });
  return async function send(actor, value, { view = 'staff', itemId, operationId = randomUUID(), verified = false, source = origin } = {}) {
    const request = Readable.from(value ? [Buffer.from(JSON.stringify(value))] : []);
    request.method = value ? 'POST' : 'GET';
    request.url = renewalHandoffPath + (value ? '' : '?' + new URLSearchParams({ view, ...(itemId && { id: itemId }) }));
    request.readVerified = verified;
    request.headers = { origin: source, 'content-type': 'application/json', 'x-id-operation': operationId };
    let status, data;
    await handler(request, { writeHead(code) { status = code; }, end(value) { data = JSON.parse(value); } }, actors[actor]);
    return { status, data };
  }
}

test('续费日志定位同一笔申请和订单，沿用原接口退回且保留原申请', async t => {
  const { store, send, submit } = fixture(t);
  const audit = (resource, options = {}) => localBusinessRequest(store, resource, {
    actor: actors.super, publicOrigin: origin, ...options
  });
  const submitted = await send('employee', submit);
  assert.equal(submitted.status, 200, submitted.data.error);
  const [row] = (await send('finance', null, { view: 'finance' })).data.items;
  const firstLog = store.audit().find(log => log.action === 'renewal_submit');
  const url = 'audit/' + firstLog.id + '/recovery';
  const page = await audit('audit/page?view=recovery&module=renewal&query=' + initialOrder.orderNo);
  assert.deepEqual(page.body.items.map(item => [item.id, item.targetId, item.orderNo]),
    [[String(firstLog.id), row.id, initialOrder.orderNo]]);
  const preview = await audit(url);
  assert.equal(preview.body.status, 'business');
  assert.deepEqual(preview.body.renewal, { id: row.id, state: 'pending' });
  assert.deepEqual(preview.body.order, { id: initialOrder.id });
  assert(!JSON.stringify(preview.body).includes(firstCard));
  assert(!JSON.stringify(preview.body).includes(initialOrder.email));
  assert.equal((await audit(url, { actor: actors.employee })).status, 403);
  assert.equal((await audit(url, { body: { version: 1, reason: 'wrong_record' }, operationId: randomUUID() })).status, 409);
  const before = store.load('commerce');
  const ledger = store.load('appleBalance');
  assert.equal((await send('finance', { action: 'claim', id: row.id, version: 1 })).status, 200);
  const returned = { action: 'return', id: row.id, version: 2, confirmed: true, reason: '合成误送' };
  const operationId = randomUUID();
  assert.equal((await send('finance', returned, { operationId })).status, 200);
  assert.equal((await send('finance', returned, { operationId })).status, 200);
  const returnLogs = store.audit().filter(log => log.action === 'renewal_return');
  assert.equal(returnLogs.length, 1);
  for (const id of [firstLog.id, returnLogs[0].id]) {
    const result = await audit('audit/' + id + '/recovery');
    assert.deepEqual(result.body.renewal, { id: row.id, state: 'returned' });
    assert.match(result.body.message, /已退回/);
  }
  assert.deepEqual(store.load('commerce'), before);
  assert.deepEqual(store.load('appleBalance'), ledger);
});

test('confirmed staff handoff, exclusive finance claim, verified card replacement and one new order', async t => {
  const { store, send, submit } = fixture(t);
  const original = structuredClone(store.load('commerce').data.orders[0]);
  assert.equal((await send('employee', { ...submit, confirmed: false })).status, 400);
  assert.equal((await send('employee', { ...submit, confirmed: 'false' })).status, 400);
  assert.equal((await send('other', submit)).status, 404);
  assert.equal((await send('registrar', null)).status, 403);
  assert.equal((await send('employee', null, { view: 'finance' })).status, 403);
  const sendId = randomUUID();
  assert.equal((await send('employee', submit, { operationId: sendId })).status, 200);
  assert.equal((await send('employee', submit, { operationId: sendId })).status, 200);
  assert.equal((await send('employee', submit)).status, 409);
  const { items: [row] } = (await send('finance', null, { view: 'finance' })).data;
  assert.equal(row.canTake, true);
  assert.equal(row.order.originalLast4, '4242');
  const claim = { action: 'claim', id: row.id, version: 1 };
  const claims = await Promise.all([send('finance', claim), send('financeOther', claim)]);
  assert.deepEqual(claims.map(item => item.status), [200, 409]);
  assert.equal((await send('employee', { action: 'finish', id: row.id, version: 2, ...finishFields })).status, 409);
  const payment = { action: 'paid', id: row.id, version: 2, confirmed: true, amount: '22.25', currency: 'USD',
    cardMode: 'manual', cardNumber: replacement, cardSerial: 'fixture-replacement', reference: 'fixture-receipt' };
  assert.equal((await send('finance', payment)).status, 403);
  assert.equal((await send('financeOther', payment, { verified: true })).status, 409);
  assert.equal((await send('finance', payment, { verified: true })).status, 200);
  assert.equal(store.load('commerce').data.orders.length, 1);
  const teamRow = (await send('supervisor', null)).data.items[0];
  assert.equal(teamRow.last4, undefined);
  assert.equal(teamRow.amount, undefined);
  assert.equal(teamRow.order.previousPaidCurrency, undefined);
  assert.equal((await send('other', null)).data.items.length, 0);
  const staff = (await send('employee', null)).data.items[0];
  assert.equal(staff.last4, '1111');
  assert.equal(staff.canFinish, true);
  assert(!JSON.stringify(staff).includes(replacement));
  assert(!JSON.stringify(staff).includes(firstCard));
  const finish = { action: 'finish', id: row.id, version: 3, ...finishFields };
  assert.equal((await send('employee', { ...finish, amount: '0.01', cardNumber: firstCard })).status, 400);
  assert.equal((await send('finance', finish, { verified: true })).status, 403);
  assert.equal((await send('supervisor', finish)).status, 403);
  const operationId = randomUUID();
  const completed = await send('employee', finish, { operationId });
  assert.equal(completed.status, 200, completed.data.error);
  assert.equal((await send('employee', finish, { operationId })).data.orderNo, completed.data.orderNo);
  assert.equal((await send('employee', finish)).status, 409);
  const { data } = store.load('commerce');
  assert.equal(data.orders.length, 2);
  assert.deepEqual(data.orders[1], original);
  assert.equal(data.orders[0].previousOrderId, original.id);
  assert.equal(data.orders[0].paidAmount, '22.25');
  assert.equal(data.orders[0].proCardNumber, replacement);
  assert.equal(data.orders[0].paymentId, '1111');
  assert.equal(data.orders[0].ownerId, actors.employee.id);
  const receipt = store.featureDocument(renewalHandoffDomain).data.items[0];
  assert.equal(receipt.status, 'complete');
  assert(!JSON.stringify(receipt).includes(replacement));
  assert(!JSON.stringify(receipt).includes(firstCard));
  assert(!JSON.stringify(store.audit()).includes(replacement));
});

test('财务续费暂不登记卡号时可提交实付，明确沿用死卡仍拦截', async t => {
  const { store, send, submit } = fixture(t);
  const cardKey = 'pan:' + createHash('sha256').update('order-card-health\0' + firstCard).digest('hex');
  store.saveFeatureDocument(cardTypeDocument, 0, {
    items: [], assignments: {}, health: { [cardKey]: { state: 'dead', revision: 1 } }
  });
  assert.equal((await send('employee', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  const payment = { action: 'paid', id, version: 2, confirmed: true, amount: '22.25', currency: 'USD' };
  const invalid = await send('finance', { ...payment, cardMode: 'original' }, { verified: true });
  assert.equal(invalid.status, 409);
  assert.match(invalid.data.error, /这张卡的状态需要核对/);
  assert.equal((await send('finance', { ...payment, cardMode: 'none' })).status, 403);
  const paid = await send('finance', { ...payment, cardMode: 'none' }, { verified: true });
  assert.equal(paid.status, 200, paid.data.error);
  const finished = await send('employee', { action: 'finish', id, version: 3, ...finishFields });
  assert.equal(finished.status, 200, finished.data.error);
  const [saved, prior] = store.load('commerce').data.orders;
  assert.equal(saved.previousOrderId, prior.id);
  assert.equal(saved.paidAmount, '22.25');
  assert.equal(saved.paidConfirmed, true);
  assert.equal(saved.cardId, '');
  assert.equal(saved.proCardNumber, undefined);
  assert.equal(prior.proCardNumber, firstCard);
});

test('verified handoff transfers unfinished work with its payment review and history intact', async t => {
  const { store, send, submit } = fixture(t);
  await send('employee', submit);
  const [row] = (await send('finance', null, { view: 'finance' })).data.items;
  await send('finance', { action: 'claim', id: row.id, version: 1 });
  const transfer = { action: 'transfer', id: row.id, version: 2, confirmed: true, review: true, reason: '交给下一班核对' };
  assert.equal((await send('financeOther', transfer, { verified: true })).status, 403);
  assert.equal((await send('finance', transfer)).status, 403);
  assert.equal((await send('finance', transfer, { verified: true })).status, 200);
  const [pending] = (await send('financeOther', null, { view: 'finance' })).data.items;
  assert.equal(pending.paymentReview, true);
  assert.equal(pending.canTake, true);
  assert.equal((await send('financeOther', { action: 'claim', id: pending.id, version: pending.version })).status, 200);
  const [stored] = store.featureDocument(renewalHandoffDomain).data.items;
  assert.equal(stored.transfers[0].from.id, actors.finance.id);
  assert.equal(stored.processingBy.id, actors.financeOther.id);
  assert.equal(stored.funding, undefined);
  assert.equal((await send('financeOther', { action: 'return', id: row.id, version: 4, confirmed: true,
    reason: '待核对时退回' })).status, 403);
});

test('verified finance can reconcile corrected dates without changing the paid receipt or duplicating the order', async t => {
  const { store, send, submit } = fixture(t);
  const verify = { verified: true };
  assert.equal((await send('employee', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  assert.equal((await send('finance', { action: 'paid', id, version: 2, confirmed: true, amount: '22.25',
    currency: 'USD', cardMode: 'none', reference: 'synthetic-payment' }, verify)).status, 200);
  const paidLog = store.audit().find(log => log.action === 'renewal_paid');
  const auditUrl = 'audit/' + paidLog.id + '/recovery';
  const audit = (options = {}) => localBusinessRequest(store, auditUrl, { actor: actors.super, publicOrigin: origin, ...options });
  const paidPreview = await audit();
  assert.deepEqual(paidPreview.body.renewal, { id, state: 'paid' });
  assert.match(paidPreview.body.message, /已有实付记录/);
  assert(!JSON.stringify(paidPreview.body).includes('synthetic-payment'));
  assert.equal((await audit({ body: { version: 3, reason: 'wrong_record' }, operationId: randomUUID() })).status, 409);
  const funding = store.featureDocument(renewalHandoffDomain).data.items[0].funding;
  const change = (changes, version) => {
    const commerce = store.load('commerce');
    Object.assign(commerce.data.orders[0], changes, { version });
    store.saveBatch([{ domain: 'commerce', ...commerce }]);
  };
  change({ expiry: '2026-11-13T11:00', email: 'other@example.test' }, 2);
  let review = { action: 'review-source', id, version: 3, sourceVersion: 2, confirmed: true, reason: '原单日期录入更正' };
  assert.equal((await send('finance', null, { view: 'finance' })).data.items[0].sourceReview, undefined);
  assert.equal((await send('finance', review, verify)).status, 409);
  change({ email: initialOrder.email }, 3);
  const row = (await send('finance', null, { view: 'finance' })).data.items[0];
  assert.deepEqual(row.sourceReview, { version: 3, expiry: '2026-11-13T11:00', originalLast4: '4242' });
  assert.equal((await send('employee', null)).data.items[0].canFinish, false);
  assert.equal((await send('finance', review, verify)).status, 409);
  review = { ...review, sourceVersion: 3 };
  assert.equal((await send('financeOther', review, verify)).status, 403);
  assert.equal((await send('finance', review)).status, 403);
  const operationId = randomUUID();
  assert.equal((await send('finance', review, { ...verify, operationId })).status, 200);
  assert.equal((await send('finance', review, { ...verify, operationId })).status, 200);
  const current = store.featureDocument(renewalHandoffDomain).data.items[0];
  assert.deepEqual(current.funding, funding);
  assert.equal(current.sourceReviews.length, 1);
  assert.equal(store.audit().filter(item => item.action === 'renewal_review_source').length, 1);
  assert.equal((await send('employee', { action: 'finish', id, version: 4, ...finishFields })).status, 200);
  const [created, source] = store.load('commerce').data.orders;
  assert.equal(created.previousOrderId, source.id);
  assert.equal(created.paidAmount, funding.amount);
  assert.equal((await send('employee', { action: 'finish', id, version: 4, ...finishFields })).status, 409);
});

test('finance may return unpaid work to selection and a former version cannot submit', async t => {
  const { send, submit } = fixture(t);
  assert.equal((await send('supervisor', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  assert.equal((await send('finance', { action: 'return', id, version: 2, reason: '客户尚未决定', confirmed: false })).status, 400);
  assert.equal((await send('finance', { action: 'return', id, version: 2, reason: '客户尚未决定' })).status, 200);
  const staff = (await send('employee', null)).data;
  assert.equal(staff.candidates.length, 1);
  assert.equal(staff.items[0].status, 'returned');
  assert.equal((await send('employee', { ...submit, orders: [{ id: 'original', version: 0 }] })).status, 409);
  assert.equal((await send('employee', submit)).status, 200);
});


function appleFixture(t, database = ':memory:') {
  const appleId = 'renewal-wallet';
  const source = { ...initialOrder, product: 'Gemini', plan: 'Google AI Pro', subscriptionSeries: 'google_ai',
    loginMethod: 'google', businessType: '首次开通', payment: '苹果内购', appleIdId: appleId, appleStoreRegion: 'US', appleGoogleVerified: true,
    billingChannel: 'app_store',
    proCardNumber: undefined, proMaterialMode: undefined, proCardSerial: undefined, paymentId: undefined };
  const result = fixture(t, [source], (store, data) => {
    const inventory = { accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [],
      tableSettings: [], undo: [], mailboxes: [{ id: appleId, type: 'apple', email: 'wallet@example.test',
        status: '正常', health: 'normal', appStoreRegion: 'US', appleOpeningBalance: '45' }] };
    const settings = { mailboxTypes: [], costSettings: {}, applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } } };
    store.saveBatch([{ domain: 'settings', version: 0, data: settings, action: 'apple_paid_prices_save' },
      { domain: 'inventory', version: 0, data: inventory, action: 'inventory_create' }]);
    const ledger = store.load('appleBalance');
    store.saveBatch([{ domain: 'commerce', version: 0, data }, { domain: 'appleBalance', version: ledger.version,
      action: 'apple_order_charge', data: stageConfirmedRenewalDebit(ledger.data, source, actors.finance, '2026-10-12T03:00:00Z') }]);
  }, database);
  return { ...result, appleId, source };
}

async function claimedApple(t, database) {
  const result = appleFixture(t, database);
  assert.equal((await result.send('employee', result.submit)).status, 200);
  const [{ id }] = (await result.send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await result.send('finance', { action: 'claim', id, version: 1 })).status, 200);
  return { ...result, id, payment: { action: 'paid', id, version: 2, confirmed: true, amount: '21.25', currency: 'USD' } };
}

async function databaseFixture(t) {
  const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'renewal-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'business.sqlite');
}

test('paid Apple handoff requires verified finance source review and finishes without another debit', async t => {
  const { store, send, id, payment } = await claimedApple(t);
  assert.equal((await send('finance', payment, { verified: true })).status, 200);
  const paidLedger = store.load('appleBalance').data;
  const funding = store.featureDocument(renewalHandoffDomain).data.items[0].funding;
  const correction = expiry => {
    const current = store.load('commerce');
    current.data.orders[0].expiry = expiry; current.data.orders[0].version++;
    store.saveBatch([{ domain: 'commerce', ...current, action: '更正订单' }]);
  };
  correction('2026-11-13T11:00');
  const finish = { action: 'finish', id, version: 3, ...finishFields };
  assert.equal((await send('employee', finish)).status, 409);
  assert.equal((await send('employee', null)).data.items[0].canFinish, false);
  let row = (await send('finance', null, { view: 'finance' })).data.items[0];
  const reviewed = { action: 'review-source', id, version: 3, sourceVersion: row.sourceReview.version,
    confirmed: true, reason: '已核对原到期时间更正，保留本次实付依据' };
  assert.equal((await send('employee', reviewed, { verified: true })).status, 403);
  assert.equal((await send('finance', reviewed)).status, 403);
  correction('2026-11-14T11:00');
  assert.equal((await send('finance', reviewed, { verified: true })).status, 409);
  assert.deepEqual(store.load('appleBalance').data, paidLedger);
  row = (await send('finance', null, { view: 'finance' })).data.items[0];
  reviewed.sourceVersion = row.sourceReview.version;
  const reviewOperation = randomUUID();
  assert.equal((await send('finance', reviewed, { verified: true, operationId: reviewOperation })).status, 200);
  assert.equal((await send('finance', reviewed, { verified: true, operationId: reviewOperation })).status, 200);
  assert.deepEqual(store.load('appleBalance').data, paidLedger);
  assert.deepEqual(store.featureDocument(renewalHandoffDomain).data.items[0].funding, funding);
  const ready = { ...finish, version: 4 };
  assert.equal((await send('employee', { ...ready, expiry: '2026-11-14T10:00' })).status, 400);
  const operationId = randomUUID();
  const saved = await send('employee', ready, { operationId });
  assert.equal(saved.status, 200, saved.data.error);
  assert.equal((await send('employee', ready, { operationId })).status, 200);
  const ledger = store.load('appleBalance').data, handoff = store.featureDocument(renewalHandoffDomain).data.items[0];
  assert.equal(ledger.wallets[0].balance, '3.7500');
  assert.equal(ledger.movements.length, paidLedger.movements.length);
  assert.equal(ledger.allocations.filter(item => item.orderId === 'order-' + id).length, 1);
  assert.equal(handoff.sourceReviews.length, 1);
  assert.equal(handoff.sourceReviews[0].by.id, actors.finance.id);
  assert.equal(handoff.paidSource.expiry, '2026-11-12T11:00');
  assert.equal(store.load('commerce').data.orders[0].paidAmount, '21.25');
});

test('a lost paid response remains idempotent after reopening the SQLite store', async t => {
  const database = await databaseFixture(t);
  const { store, send, close, id, payment } = await claimedApple(t, database);
  const operationId = randomUUID();
  assert.equal((await send('finance', payment, { verified: true, operationId })).status, 200);
  const ledger = store.load('appleBalance');
  close();
  const recovered = createLocalBusinessStore(database); t.after(() => recovered.close());
  const again = sender(recovered);
  assert.equal((await again('finance', payment, { verified: true, operationId })).status, 200);
  assert.deepEqual(recovered.load('appleBalance'), ledger);
  assert.equal((await again('finance', payment, { verified: true })).status, 409);
  const result = await again('employee', { action: 'finish', id, version: 3, ...finishFields });
  assert.equal(result.status, 200, result.data.error);
  assert.equal(recovered.load('appleBalance').data.wallets[0].balance, '3.7500');
  assert.equal(recovered.load('appleBalance').data.movements.length, ledger.data.movements.length);
});

test('failure after the debit write rolls the ledger and paid receipt back together', async t => {
  const database = await databaseFixture(t);
  const { store, send, payment } = await claimedApple(t, database);
  const ledger = store.load('appleBalance'), queue = store.featureDocument(renewalHandoffDomain), audit = store.audit();
  const fault = new DatabaseSync(database); t.after(() => fault.close());
  fault.exec("CREATE TRIGGER synthetic_renewal_failure BEFORE UPDATE ON business_document WHEN NEW.domain='renewal-handoffs' BEGIN SELECT RAISE(ABORT, 'synthetic renewal persistence failure'); END");
  const operationId = randomUUID();
  assert.equal((await send('finance', payment, { verified: true, operationId })).status, 503);
  assert.deepEqual(store.load('appleBalance'), ledger);
  assert.deepEqual(store.featureDocument(renewalHandoffDomain), queue);
  assert.deepEqual(store.audit(), audit);
  fault.exec('DROP TRIGGER synthetic_renewal_failure');
  assert.equal((await send('finance', payment, { verified: true, operationId })).status, 200);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '3.7500');
});

test('competing payment registrations produce only one debit and one paid receipt', async t => {
  const { store, send, payment } = await claimedApple(t);
  const responses = await Promise.all([send('finance', payment, { verified: true }), send('finance', payment, { verified: true })]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '3.7500');
  assert.equal(store.load('appleBalance').data.movements.filter(row => row.orderId === 'order-' + payment.id).length, 1);
});

test('paid registration uses a concurrent wallet topup and retains its immutable history', async t => {
  const database = await databaseFixture(t);
  const { store, send, payment, appleId } = await claimedApple(t, database);
  const other = createLocalBusinessStore(database); t.after(() => other.close());
  const originalSave = store.saveRenewalQueue.bind(store);
  store.saveRenewalQueue = (...args) => {
    const ledger = other.load('appleBalance'), wallet = ledger.data.wallets[0];
    const before = wallet.balance;
    wallet.balance = '35'; wallet.version++;
    ledger.data.movements.push({ id: 'concurrent-topup', appleIdId: appleId, kind: 'topup', amount: '10',
      before, after: wallet.balance, versionAfter: wallet.version, reason: '合成到账凭据' });
    other.saveBatch([{ domain: 'appleBalance', ...ledger, action: 'apple_topup' }], { actor: actors.finance });
    return originalSave(...args);
  };
  const paid = await send('finance', payment, { verified: true });
  assert.equal(paid.status, 200, paid.data.error);
  const ledger = store.load('appleBalance');
  assert.equal(ledger.data.wallets[0].balance, '13.7500');
  assert.equal(ledger.data.movements.at(-2).id, 'concurrent-topup');
  const changed = structuredClone(ledger);
  const wallet = changed.data.wallets[0];
  wallet.balance = '23.7500'; wallet.version++;
  changed.data.movements.push({ id: 'after-paid-topup', appleIdId: appleId, kind: 'topup', amount: '10',
    before: '13.7500', after: wallet.balance, versionAfter: wallet.version, reason: '合成后续到账' });
  changed.data.movements.at(-2).actorId = actors.financeOther.id;
  assert.throws(() => store.saveBatch([{ domain: 'appleBalance', ...changed, action: 'apple_topup' }]), /流水/);
  assert.deepEqual(store.load('appleBalance'), ledger);
  changed.data.movements.at(-2).actorId = actors.finance.id;
  store.saveBatch([{ domain: 'appleBalance', ...changed, action: 'apple_topup' }], { actor: actors.finance });
  const result = await send('employee', { action: 'finish', id: payment.id, version: 3, ...finishFields });
  assert.equal(result.status, 200, result.data.error);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '23.7500');
});

test('an older unposted paid handoff completes with exactly one debit', async t => {
  const { store, send, id, appleId } = await claimedApple(t);
  const queue = store.featureDocument(renewalHandoffDomain);
  Object.assign(queue.data.items[0], { status: 'paid', version: 3, funding: {
    payment: '苹果内购', amount: '21.25', currency: 'USD', appleIdId: appleId, appleStoreRegion: 'US',
    actor: { id: actors.finance.id, name: actors.finance.name }, at: '2026-11-13T05:00:00.000Z'
  } });
  store.saveFeatureDocument(renewalHandoffDomain, queue.version, queue.data);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '25.0000');
  const operationId = randomUUID(), command = { action: 'finish', id, version: 3, ...finishFields };
  const result = await send('employee', command, { operationId });
  assert.equal(result.status, 200, result.data.error);
  assert.equal((await send('employee', command, { operationId })).status, 200);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '3.7500');
  assert.equal(store.load('appleBalance').data.movements.filter(row => row.orderId === 'order-' + id).length, 1);
});

test('finance posts the Apple debit when paid and completing the order does not debit again', async t => {
  const { store, send, submit, appleId, source } = appleFixture(t);
  assert.equal((await send('employee', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  const payment = { action: 'paid', id, version: 2, confirmed: true, amount: '25.01', currency: 'USD' };
  const shortage = await send('finance', payment, { verified: true });
  assert.equal(shortage.status, 409);
  assert.match(shortage.data.error, /余额不足/);
  const paid = await send('finance', { ...payment, amount: '21.25' }, { verified: true });
  assert.equal(paid.status, 200, paid.data.error);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '3.7500');
  const pending = store.featureDocument(renewalHandoffDomain).data;
  assert.equal(pending.items[0].funding.ledgerPosted, true);
  assert.equal(store.load('commerce').data.orders.length, 1);
  assert.equal(auditAppleWallets({ commerce: store.load('commerce').data, inventory: store.load('inventory').data,
    appleBalance: store.load('appleBalance').data, renewalHandoffs: pending }).counts.issueCount, 0);
  assert(auditAppleWallets({ commerce: store.load('commerce').data, inventory: store.load('inventory').data,
    appleBalance: store.load('appleBalance').data }).counts.issueCount > 0);
  const finish = { action: 'finish', id, version: 3, ...finishFields };
  const operationId = randomUUID();
  const completed = await send('employee', finish, { operationId });
  assert.equal(completed.status, 200, completed.data.error);
  assert.equal((await send('employee', finish, { operationId })).data.orderNo, completed.data.orderNo);
  const ledger = store.load('appleBalance').data;
  const [latest] = store.load('commerce').data.orders;
  assert.equal(ledger.wallets[0].balance, '3.7500');
  assert.equal(ledger.allocations.filter(row => row.orderId === latest.id).length, 1);
  const movements = ledger.movements.filter(row => row.orderId === latest.id);
  assert.deepEqual(movements.map(row => [row.orderNo, row.amount, row.actorId]),
    [[completed.data.orderNo, '-21.25', actors.finance.id]]);
  assert.equal(latest.appleIdId, appleId);
  assert.equal(latest.previousOrderId, source.id);
});

test('subscription reassignment controls staff access and final order ownership', async t => {
  const { store, send, submit } = fixture(t);
  const key = subscriptionAccountId('GPT', initialOrder);
  store.saveFeatureDocument(subscriptionDomain, 0, { owners: { [key]: {
    ownerId: actors.other.id, ownerName: actors.other.name, customerId: initialOrder.customerId
  } } });
  assert.equal((await send('employee', null)).data.candidates.length, 0);
  assert.equal((await send('supervisor', null)).data.candidates.length, 0);
  assert.equal((await send('other', null)).data.candidates[0].owner, actors.other.name);
  assert.equal((await send('employee', submit)).status, 404);
  assert.equal((await send('other', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  assert.equal((await send('finance', { action: 'paid', id, version: 2, confirmed: true,
    amount: '20', currency: 'USD', cardMode: 'none' }, { verified: true })).status, 200);
  const completed = await send('other', { action: 'finish', id, version: 3, ...finishFields });
  assert.equal(completed.status, 200, completed.data.error);
  assert.equal(store.load('commerce').data.orders[0].ownerId, actors.other.id);
});

test('finance sees only unused authorized tenant cards and cannot register the already used card', async t => {
  const tenant = { id: 'renewal-tenant', active: true, name: '测试租户' };
  const source = { ...initialOrder, product: 'Claude Pro', plan: 'Pro', tenantId: tenant.id,
    cardId: 'tenant:used', proMaterialMode: 'tenant_card', proCardSerial: undefined };
  const { store, send, submit } = fixture(t, [source], (store, data) => {
    store.saveBatch([{ domain: 'commerce', version: 0, data: { ...data, tenants: [tenant] } }]);
    store.saveFeatureDocument('tenant-cards', 0, { items: [
      { id: 'tenant:used', tenantId: tenant.id, active: true, number: firstCard },
      { id: 'tenant:unused', tenantId: tenant.id, active: true, number: replacement },
      { id: 'tenant:other', tenantId: 'other-tenant', active: true, number: '5555555555554444' }
    ] });
  });
  assert.equal((await send('employee', submit)).status, 200);
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  const cards = () => ({ view: 'cards', itemId: id, verified: true });
  assert.equal((await send('financeOther', null, cards())).status, 404);
  assert.equal((await send('finance', null, { ...cards(), verified: false })).status, 403);
  assert.deepEqual((await send('finance', null, cards())).data.items,
    [{ id: 'tenant:unused', last4: '1111', label: '租户卡' }]);
  const payment = { action: 'paid', id, version: 2, confirmed: true, amount: '20', currency: 'USD' };
  const used = await send('finance', { ...payment, cardMode: 'original' }, { verified: true });
  assert.equal(used.status, 409);
  const paid = await send('finance', { ...payment, cardMode: 'pool', cardId: 'tenant:unused' }, { verified: true });
  assert.equal(paid.status, 200, paid.data.error);
  const completed = await send('employee', { action: 'finish', id, version: 3, ...finishFields });
  assert.equal(completed.status, 200, completed.data.error);
  assert.equal(store.load('commerce').data.orders[0].cardId, 'tenant:unused');
  const moved = store.featureDocument('tenant-cards').data.items.find(row => row.id === 'tenant:unused');
  assert.equal(moved.firstUse.orderId, store.load('commerce').data.orders[0].id);
});

test('已完成的续费可直接入账，有进行中记录或已有同一期续费时不会重复建单', async t => {
  const { store, send, submit } = fixture(t);
  async function put(data, action, domain = 'commerce') {
    const change = { domain: 'commerce', version: store.load('commerce').version, data, action };
    const request = Readable.from([Buffer.from(JSON.stringify(domain === 'batch' ? [change] : change))]);
    request.url = '/api/local/' + domain;
    request.method = 'PUT';
    request.headers = { origin, 'content-type': 'application/json' };
    let status, result;
    await handleLocalBusiness(request, { setHeader() {}, writeHead(code) { status = code; },
      end(response) { result = JSON.parse(response); } }, request.url, store, actors.super,
      { publicOrigin: origin, requireRenewalHandoff: true, readOrderCards: async () => [], readOrderOwners: () => Object.values(actors) });
    return { status, result };
  }
  const snapshot = store.load('commerce');
  const direct = { ...initialOrder, id: 'direct-copy', orderNo: 'OD-DIRECT-RENEWAL', ...finishFields,
    previousOrderId: undefined, paidConfirmed: false, receiptConfirmed: false };
  const repeated = { ...snapshot.data, orders: [...snapshot.data.orders, direct] };
  const queued = await send('employee', { action: submit.action, orders: submit.orders });
  assert.equal(queued.status, 200);
  for (const domain of ['commerce', 'batch']) {
    const bypass = await put(repeated, '新增独立订单', domain);
    assert.equal(bypass.status, 409);
    assert.match(bypass.result.error, /已有进行中的续费/);
  }
  const [{ id }] = (await send('finance', null, { view: 'finance' })).data.items;
  assert.equal((await send('finance', { action: 'claim', id, version: 1 })).status, 200);
  assert.equal((await send('finance', { action: 'return', id, version: 2, reason: '实际付款已在线下完成' })).status, 200);
  const batch = await put({ ...snapshot.data, rentBatches: [{ id: 'new-batch', items: [] }] }, '更新订单表头');
  assert.equal(batch.status, 403);
  assert.equal(store.load('commerce').version, snapshot.version);
  const registered = await put(repeated, '新增独立订单');
  assert.equal(registered.status, 200, registered.result.error);
  const latest = store.load('commerce').data;
  const linked = latest.orders.find(row => row.id === direct.id);
  assert.equal(linked.previousOrderId, initialOrder.id);
  assert.equal(linked.paidConfirmed, true);
  assert.equal(linked.receiptConfirmed, true);
  assert.equal(linked.entitlementStatus, 'active');
  const replay = await put({ ...latest, orders: [...latest.orders, { ...direct, id: 'another-renewal',
    orderNo: 'OD-DUPLICATE-RENEWAL', previousOrderId: initialOrder.id }] }, '新增独立订单');
  assert.equal(replay.status, 409);
  assert.match(replay.result.error, /已有续费订单/);
  const { proCardNumber, proCardSerial, ...ordinary } = initialOrder;
  const newOrder = { ...ordinary, ...finishFields, id: 'manual-without-email-or-card',
    orderNo: 'OD-MISSING-MATERIALS', ownerId: actors.super.id, email: '', paymentId: '', proMaterialMode: 'none' };
  const saved = await put({ ...latest, orders: [...latest.orders, newOrder] }, '新增独立订单');
  assert.equal(saved.status, 200, saved.result.error);
  const order = saved.result.data.orders.find(row => row.id === newOrder.id);
  assert.equal(order.email, '');
  assert.equal(order.paymentId, '');
  assert.equal(order.paidConfirmed, true);
  assert.equal(order.entitlementStatus, 'active');
});
