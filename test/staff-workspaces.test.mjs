import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createStaffWorkspaces } from '../server/staff-workspaces.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createOrderRechargeClient } from '../server/order-recharge-client.mjs';
import { employeeCommerce, financeCommerce, nativeBrowserVerification, nativeManagerAccess, protectedSettingsChanged, registrarInventory, retailAccess } from '../server/access-roles.mjs';
import { mailboxRegistrationAssignment, registrationMailboxSource } from '../server/tools/mailbox-pool.mjs';
import { calculateConfirmedNetReceipt } from '../modules/finance/accounting.mjs';
import { verifyRechargeAssertion } from '../modules/recharge/assertion.mjs';

const actors = Object.fromEntries(['super', 'admin', 'supervisor', 'finance', 'registrar', 'employee', 'other']
  .map(role => [role, { id: role + '-fixture', name: role, email: role + '@example.test', role }]));
const origin = 'https://staff.example.test';
const commerce = { version: 5, data: { orders: [
  { id: 'mine', orderNo: 'OD-1', product: 'GPT', plan: 'Plus', ownerId: actors.employee.id,
    customerId: 'customer-1', email: 'fixture@example.test', proCardNumber: 'fixture-card-number', proCardSerial: 'fixture-serial',
    source: '管理员手工', payment: '银行卡', paymentId: '0000000000000123', paidAmount: '20.00', paidCurrency: 'USD', paidConfirmed: true,
    saleAmount: '200', saleCurrency: 'CNY', receiptConfirmed: true, refunds: [{ at: '2026-11-01', amount: '10', currency: 'CNY' }] },
  { id: 'theirs', ownerId: actors.other.id, createdById: actors.employee.id, customerId: 'customer-2', email: 'other@example.test' }
], customers: [
  { id: 'customer-1', name: '甲', phone: 'fixture phone', active: true, createdById: actors.employee.id },
  { id: 'customer-2', name: '乙', active: true, createdById: actors.other.id }
], tenants: [], operating: [], rentBatches: [], logs: [] } };

const inventory = { version: 4, data: { mailboxes: [
  { id: 'mail-own', email: 'reg@example.test', type: 'google', version: 1, createdById: actors.registrar.id,
    appPassword: 'fixture-app-password', totp: 'JBSWY3DPEHPK3PXP' },
  { id: 'mail-other', email: 'other@example.test', version: 1, createdById: actors.other.id }
], accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [],
appleRelay: { parents: [{ id: 'parent-1', status: 'ACTIVE', email: 'parent@example.test', appPassword: 'fixture-parent-password' }] } } };

function fixture() {
  let verified = false;
  const audited = [], writes = [], used = new Map(), upstream = [];
  const state = { commerce: structuredClone(commerce), inventory: structuredClone(inventory) };
  const rawCards = { cards: [{ id: 5, last4: '0123', is_active: 1, card_number: 'fixture-number', card_cvc: 'fixture-cvc',
    allowed_plans: ['plus'], usage_count: 2 }], planPolicy: { strict: false, version: 7 } };
  const store = {
    load: domain => structuredClone(state[domain]),
    featureDocument: () => ({}),
    replayWrite(operation) {
      if (!used.has(operation.domain)) return null;
      if (used.get(operation.domain) !== operation.fingerprint)
        throw Object.assign(new Error('保存内容已变化'), { status: 409 });
      return [];
    },
    saveBatch([entry], { actor, operation }) {
      if (state[entry.domain].version !== entry.version) throw Object.assign(new Error('版本不同'), { status: 409 });
      writes.push({ ...entry, actor });
      state[entry.domain] = { version: entry.version + 1, data: entry.data };
      if (operation) used.set(operation.domain, operation.fingerprint);
    },
    saveStaffOrder(write, actor, operation) { return this.saveBatch([write], { actor, operation }); },
    registrationMailbox(id, actor) {
      const asset = state.inventory.data.mailboxes.find(row => row.id === id && row.createdById === actor.id);
      return asset ? { asset, item: { email: asset.email } } : null;
    },
    loadBitBrowserProxies: () => ({ version: 0, items: [] }),
    saveBitBrowserProxy: (body, actor) => ({ version: body.version + 1, items: [{ actorId: actor.id }] }),
    recordAuthEvent: event => audited.push(event)
  };
  const client = {
    async get(path) {
      upstream.push({ path });
      if (path.startsWith('/api/admin/billing?')) return { total: 21, records: [{
        id: 'bill-1', payment_time: '2026-11-13T12:00:00Z', status: 'success',
        currency: 'USD', amount: '20', plan_type: 'plus', card_last4: '0123', card_number: 'fixture-billing-number'
      }] };
      assert.equal(path, '/api/admin/cards');
      return structuredClone(rawCards);
    },
    async writeCardMaintenance(method, path, command, actor) {
      upstream.push({ method, path, command, actor });
      rawCards.planPolicy.version++;
      return { imported: command.cards?.length || 0, planPolicy: { ...rawCards.planPolicy } };
    },
    async stopCardUse(refs) { upstream.push({ refs }); rawCards.cards[0].is_active = 0; return { state: 'stopped', refs }; },
    async addBusinessProxy(command) { upstream.push({ proxy: command }); return { added: 1, labeled: 0, skipped: 0 }; }
  };
  const createHandler = (selectedStore = store) => createStaffWorkspaces({ store: selectedStore, client,
    publicOrigin: origin, getAuth: () => ({ recentlyVerified: () => verified, teamFor: () => [actors.employee] }),
    readMailbox: async () => [{ body: 'Your verification code is 123456. Private fixture message', receivedAt: '2026-11-13T12:01:00Z' }] });
  let handler = createHandler();
  async function call(role, path, body, headers = {}) {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    request.url = '/api/local/staff/' + path;
    const route = request.url.split('?')[0];
    request.method = body ? 'POST' : 'GET';
    request.headers = { origin, 'content-type': 'application/json',
      ...(path === 'finance/cards' && body && { 'x-id-operation': randomBytes(24).toString('hex') }), ...headers };
    let status, data;
    await handler(request, { writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); } }, route, actors[role]);
    return { status, data };
  }
  return { call, audited, writes, upstream, client, rawCards, useStore: business => { handler = createHandler(business); },
    verify: () => { verified = true; } };
}

test('role policy keeps the business administrator and blocks global settings or scoped role mutations', () => {
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/recharge-routing', 'PUT'), false);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/region', 'POST'), false);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/proxies', 'POST'), true);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/subscription/batch-renewal-status', 'GET'), true);
  assert.equal(nativeManagerAccess(actors.super, '/api/admin/region', 'POST'), true);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/billing', 'GET'), true);
  assert.equal(nativeManagerAccess(actors.super, '/api/admin/billing/fixture', 'DELETE'), false);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/task-logs/fixture', 'DELETE'), false);
  assert.equal(nativeManagerAccess(actors.admin, '/api/admin/unknown-future-operation', 'POST'), false);
  assert.equal(nativeBrowserVerification('/api/admin/proxies', 'POST'), true);
  assert.equal(nativeBrowserVerification('/api/admin/task-logs/fixture', 'GET'), false);
  assert.equal(protectedSettingsChanged({ mailboxTypes: ['new'] }, { mailboxTypes: ['old'] }), true);
  assert.equal(protectedSettingsChanged({ mailboxTypes: ['old'], orderPrices: { a: 1 } }, { mailboxTypes: ['old'] }), false);
  assert.equal(retailAccess(actors.finance, '/api/local/commerce', 'GET'), true);
  assert.equal(retailAccess(actors.finance, '/api/local/commerce', 'PUT'), false);
  assert.equal(retailAccess(actors.finance, '/api/local/batch', 'PUT'), false);
  assert.equal(retailAccess(actors.finance, '/api/local/finance/expense-receipts', 'POST'), false);
  assert.equal(retailAccess(actors.supervisor, '/api/local/subscription-card-details', 'GET'), false);
  assert.equal(retailAccess(actors.employee, '/api/local/toolbox', 'PUT'), true);
  assert.equal(retailAccess(actors.employee, '/api/local/saved-totp/code', 'POST'), true);
  assert.equal(retailAccess(actors.registrar, '/api/local/apple-relay/primary-save', 'POST'), false);
  const ours = employeeCommerce(commerce, actors.employee);
  assert.deepEqual(ours.data.orders.map(row => row.id), ['mine']);
  assert(!Object.hasOwn(ours.data.orders[0], 'proCardNumber'));
  const finance = financeCommerce(commerce);
  assert.equal(finance.data.orders[0].email, 'fixture@example.test');
  assert.equal(finance.data.orders[0].paidAmount, '20.00');
  assert.equal(finance.data.orders[0].paymentId, '0123');
  assert.equal(calculateConfirmedNetReceipt(finance.data.orders[0]), '190.0000');
  assert(!JSON.stringify(finance).includes('fixture-card-number'));
  const registration = registrarInventory(inventory, actors.registrar);
  assert.equal(registration.data.mailboxes[0].hasAuthenticator, true);
  assert(!JSON.stringify(registration).includes('fixture-app-password'));
  assert(!JSON.stringify(registration).includes('fixture-parent-password'));
});

test('registry permissions depend on the assigned record and can be withdrawn without changing buyer delivery', () => {
  const registrar = actors.registrar;
  const own = { id: 'registration-fixture', type: 'microsoft', email: 'owned@example.test', createdById: registrar.id };
  const item = { id: 'provider-fixture', provider: 'microsoft', email: own.email, active: true, queryCode: 'fixture-code' };
  const pool = items => ({ version: 2, data: { items } });
  assert.deepEqual(registrationMailboxSource(pool([item]), own, registrar), { asset: own });
  const assigned = mailboxRegistrationAssignment(item, [own], own.id, id => id === registrar.id);
  assert.equal(registrationMailboxSource(pool([assigned]), own, registrar).item.id, item.id);
  assert.equal(registrationMailboxSource(pool([assigned]), { ...own, id: 'other-record' }, registrar).item, undefined);
  const revoked = mailboxRegistrationAssignment(assigned, [own], null, () => false);
  assert.equal(registrationMailboxSource(pool([revoked]), own, registrar).item, undefined);
  assert.deepEqual(revoked, item);
  assert.throws(() => mailboxRegistrationAssignment(item, [own], own.id, () => false), { status: 409 });
});

test('financial and proxy commands are signed for the allowed original recharge endpoints', async () => {
  const secret = randomBytes(32).toString('hex');
  const calls = [];
  const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:4000', secret }, async (url, options) => {
    const credentials = verifyRechargeAssertion(secret, options.method, url.pathname + url.search,
      options.headers['x-id-recharge-assertion']);
    assert(credentials);
    calls.push([options.method, url.pathname, credentials.id, credentials.sensitive]);
    return Response.json({ success: true });
  });
  await client.writeCardMaintenance('POST', '/api/admin/cards/import', {}, actors.finance);
  await client.writeCardMaintenance('PUT', '/api/admin/cards/plan-policy', {}, actors.finance);
  await client.addBusinessProxy({}, actors.supervisor);
  await assert.rejects(client.writeCardMaintenance('DELETE', '/api/admin/cards/5', {}, actors.finance));
  assert.throws(() => client.writeCardMaintenance('POST', '/api/admin/cards/import', {}, actors.supervisor));
  assert.deepEqual(calls, [
    ['POST', '/api/admin/cards/import', actors.finance.id, true],
    ['PUT', '/api/admin/cards/plan-policy', actors.finance.id, true],
    ['POST', '/api/admin/recharge-routing/proxies', actors.supervisor.id, false]
  ]);
});

test('finance can read cards and statements, and uses explicit verification for narrow writes', async t => {
  const f = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  f.useStore(store);
  assert.equal((await f.call('supervisor', 'finance/cards')).status, 403);
  assert.equal((await f.call('admin', 'finance/cards')).status, 403);
  const cards = await f.call('finance', 'finance/cards');
  assert.equal(cards.status, 200);
  assert.equal(cards.data.items[0].last4, '0123');
  assert(!JSON.stringify(cards).includes('fixture-number'));
  const billing = await f.call('finance', 'finance/reconciliation?page=1&from=2026-11-13&to=2026-11-13');
  assert.equal(billing.status, 200);
  assert.deepEqual(billing.data.items[0], { reference: 'bill-1', time: '2026-11-13T12:00:00Z',
    amount: '20', currency: 'USD', plan: 'plus', status: 'success', last4: '0123', cardNumber: '',
    cardType: '', cardTypeState: 'missing-number', email: '', paymentReference: '', errorCode: '' });
  assert.equal(billing.data.hasMore, true);
  const statementQuery = new URL(f.upstream.at(-1).path, origin).searchParams;
  assert.equal(statementQuery.get('start_date'), '2026-11-12 16:00:00.000');
  assert.equal(statementQuery.get('end_date'), '2026-11-13 15:59:59.999');
  const plan = { action: 'plans', version: 7, cardIds: [5], plans: ['pro200'] };
  assert.equal((await f.call('finance', 'finance/cards', plan)).status, 403);
  f.verify();
  assert.equal((await f.call('finance', 'finance/cards', plan, { origin: 'https://other.test' })).status, 403);
  assert.equal((await f.call('finance', 'finance/cards', plan)).status, 200);
  assert.equal((await f.call('finance', 'finance/cards', plan)).status, 409);
  assert.equal((await f.call('finance', 'finance/cards', { action: 'import', version: 8, plans: ['plus'],
    lines: '0000000000000123 | 10/29 | 001' })).status, 200);
  assert.equal((await f.call('finance', 'finance/cards', { action: 'stop', version: 9, id: 5 })).status, 200);
  const events = store.audit().filter(row => row.action !== 'finance_card_requested').reverse();
  assert.deepEqual(events.map(row => row.action), ['finance_card_plans', 'finance_card_import', 'finance_card_stop']);
  assert(!JSON.stringify(events).includes('0000000000000123'));
});

test('billing revision tracks card classification and archives only for the existing finance readers', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const scope = 'recharge-billing';
  assert.equal(store.changeVersions(actors.finance)[scope], '0:0');
  store.saveFeatureDocument('card-types', 0, { items: [], assignments: {} }, { actor: actors.super });
  assert.equal(store.changeVersions(actors.finance)[scope], '1:0');
  store.saveFeatureDocument('order-card-archive', 0, { cards: {} }, { actor: actors.super });
  assert.equal(store.changeVersions(actors.finance)[scope], '1:1');
  assert.equal(store.changeVersions(actors.super)[scope], '1:1');
  assert.equal(store.changeVersions(actors.admin)[scope], undefined);
  assert.equal(store.changeVersions(actors.employee)[scope], undefined);
});

test('uncertain card write survives a new request, can be checked without another write and is audited once', async t => {
  const f = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  f.useStore(store);
  f.verify();
  let writes = 0;
  f.client.writeCardMaintenance = async () => {
    writes++;
    throw new Error('synthetic lost response');
  };
  const number = '0000000000006012';
  const plans = ['pro500'];
  const command = { action: 'import', version: 7, plans, lines: number + ' | 10/29 | 567' };
  const op = { 'x-id-operation': 'fixture-finance-card-import' };
  assert.equal((await f.call('finance', 'finance/cards', command, op)).status, 503);
  f.useStore(store);
  const { pending: [pending] } = (await f.call('finance', 'finance/cards')).data;
  assert.equal(pending.label, '导入银行卡');
  assert.equal(pending.canReview, true);
  assert(!JSON.stringify(pending).includes(number));
  const stored = store.pendingFinanceCardOperations()[0];
  assert(!JSON.stringify(stored).includes(number));
  assert.deepEqual(Object.keys(stored.evidence).sort(), ['imported', 'intent', 'plans', 'version']);
  assert(stored.evidence.imported.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal((await f.call('finance', 'finance/cards', command)).status, 409);
  f.client.stopCardUse = async refs => { f.rawCards.cards[0].is_active = 0; return { state: 'stopped', refs }; };
  assert.equal((await f.call('finance', 'finance/cards', { action: 'stop', version: 7, id: 5 })).status, 200);
  const check = { action: 'reconcile', version: 7, id: pending.id, confirmed: true };
  assert.equal((await f.call('finance', 'finance/cards', check)).status, 409);
  assert.equal(store.audit().filter(row => row.action === 'finance_card_reconciled').length, 0);
  f.rawCards.cards.push({ id: 7, last4: '6012', card_number: number, card_expiry: '11/29', card_cvc: '567',
    is_active: 1, allowed_plans: plans });
  f.rawCards.planPolicy.version = 8;
  assert.equal((await f.call('finance', 'finance/cards', { ...check, version: 8 })).status, 409);
  f.rawCards.cards.at(-1).card_expiry = '10/29';
  const recovered = await f.call('super', 'finance/cards', { ...check, version: 8 });
  assert.deepEqual(recovered.data, { saved: true, count: 1, reconciled: true });
  assert.deepEqual((await f.call('finance', 'finance/cards')).data.pending, []);
  assert.equal((await f.call('finance', 'finance/cards', command, op)).data.count, 1);
  assert.equal(writes, 1);
  const audit = store.audit().filter(row => row.action === 'finance_card_reconciled');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, actors.super.id);
  assert.equal(audit[0].targetId, pending.id);
  assert.equal(store.audit().filter(row => row.action === 'finance_card_requested' && row.targetId === pending.id).length, 1);
  assert(!JSON.stringify(audit).includes(number));
});

test('unconfirmed card result can be documented by its submitter without retrying the bank-card maintenance', async t => {
  const f = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  f.useStore(store);
  f.verify();
  let attempts = 0;
  f.client.writeCardMaintenance = async () => { attempts++; throw new Error('synthetic unavailable response'); };
  const command = { action: 'strict', strict: true, version: 7 };
  const op = { 'x-id-operation': 'fixture-card-unconfirmed-result' };
  assert.equal((await f.call('finance', 'finance/cards', command, op)).status, 503);
  const { pending: [pending] } = (await f.call('finance', 'finance/cards')).data;
  const review = { action: 'reconcile', id: pending.id, version: 7, confirmed: true, outcome: 'unconfirmed' };
  assert.equal((await f.call('finance', 'finance/cards', { ...review, confirmed: false })).status, 409);
  assert.deepEqual((await f.call('finance', 'finance/cards', review)).data, { saved: true, unconfirmed: true });
  assert.deepEqual((await f.call('finance', 'finance/cards', command, op)).data, { saved: true, unconfirmed: true });
  assert.deepEqual((await f.call('finance', 'finance/cards')).data.pending, []);
  assert.equal(attempts, 1);
  assert.equal(store.audit().filter(row => row.action === 'finance_card_unconfirmed' && row.targetId === pending.id).length, 1);
});

test('registration and customer writes use scoped records, replay receipts and only return necessary data', async () => {
  const f = fixture();
  assert.equal((await f.call('employee', 'registration')).status, 403);
  assert.equal((await f.call('registrar', 'mail-code', { id: 'mail-other' })).status, 404);
  const mails = await f.call('registrar', 'mail-code', { id: 'mail-own' });
  assert.deepEqual(mails.data, { items: [{ code: '123456', receivedAt: '2026-11-13T12:01:00Z' }] });
  const code = await f.call('registrar', 'registration-code', { id: 'mail-own' });
  assert.match(code.data.code, /^\d{6}$/);
  const registration = { version: 4, type: 'gpt', email: 'reg@example.test', mailboxId: 'mail-own' };
  const op = { 'x-id-operation': 'fixture-registration-action' };
  assert.equal((await f.call('registrar', 'registration', registration, op)).status, 200);
  assert.equal((await f.call('registrar', 'registration', registration, op)).status, 200);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.accounts[0].sourceMailboxId, 'mail-own');
  assert.equal((await f.call('employee', 'customer-service', { action: 'renewal', version: 5, sourceId: 'theirs' })).status, 409);
  assert.equal((await f.call('employee', 'customer-service', { action: 'manual-order', version: 5, customerId: 'customer-2' })).status, 404);
  const team = await f.call('supervisor', 'team');
  assert.deepEqual(team.data.items, [{ name: 'employee', orders: 1, customers: 1 }]);
  const entered = await f.call('employee', 'customer-service', { action: 'manual-order', version: 5, customerId: 'customer-1',
    planChoice: 'GPT|Plus', email: 'customer@example.test', start: '2026-11-13T10:00', expiry: '2026-12-13T10:00',
    payment: '银行卡', saleAmount: '150', saleCurrency: 'CNY', paidAmount: '20', paidCurrency: 'USD' });
  assert.equal(entered.status, 200);
  assert.equal(f.writes[1].data.orders[0].ownerId, actors.employee.id);
  const gemini = await f.call('employee', 'customer-service', { action: 'manual-order', version: 6, customerId: 'customer-1',
    planChoice: 'Gemini|Google AI Plus', email: 'customer@example.test', start: '2026-11-13T10:00', expiry: '2026-12-13T10:00',
    payment: '银行卡', saleAmount: '150', saleCurrency: 'CNY', paidAmount: '20', paidCurrency: 'USD' });
  assert.equal(gemini.status, 200);
  assert.equal(f.writes[2].data.orders[0].loginMethod, 'google');
  assert.equal((await f.call('supervisor', 'business-proxies', { version: 0, id: 'unowned' })).status, 403);
  f.verify();
  assert.equal((await f.call('supervisor', 'business-proxies', { action: 'recharge', countryCode: 'PH',
    kind: 'static_residential', link: 'proxy.example.test:1000' })).status, 200);
});
