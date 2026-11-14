import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { documentDelta } from '../modules/data/document-delta.mjs';

const admin = { id: 'admin', name: '合成管理员', role: 'admin' };
const superAdmin = { id: 'super', name: '合成超级管理员', role: 'super' };
const employee = { id: 'employee', name: '合成员工', role: 'employee' };
const origin = 'https://synthetic-id.test';

function storeFixture(t, path = ':memory:') {
  const store = createLocalBusinessStore(path);
  t.after(() => store.close());
  return store;
}

function seed(store) {
  const data = {
    customers: [
      { id: 'customer-a', name: '合成客户', phone: '+60 11111', version: 1, active: true,
        notes: 'synthetic-note-before', tags: ['长期客户'], createdById: admin.id },
      { id: 'customer-b', name: '另一位客户', phone: '+60 22222', version: 1, active: true }
    ],
    tenants: [{ id: 'tenant-a', name: '合成租户', phone: '+60 33333', version: 1, active: true }],
    orders: [{ id: 'payment-order', version: 1, customerId: 'customer-a', tenantId: 'tenant-a',
      product: 'GPT', plan: 'Plus', businessType: '续费', payment: '银行卡',
      paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY' }],
    logs: [], operating: [], rentBatches: []
  };
  store.saveBatch([{ domain: 'commerce', version: 0, action: '新增资料', data },
    { domain: 'settings', version: 0, action: 'local_save',
      data: { mailboxTypes: [], costSettings: {}, customerTags: ['长期客户', '新客户'] } }], { actor: superAdmin });
}

async function request(store, resource, {
  body, method = body === undefined ? 'GET' : 'POST', operationId, actor = admin, source = origin, authorizeSensitive
} = {}) {
  const url = '/api/local/' + resource;
  const msg = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(msg, { method, url, headers: { origin: source,
    ...(body !== undefined && { 'content-type': 'application/json' }),
    ...(operationId && { 'x-id-operation': operationId }) } });
  const response = {};
  await handleLocalBusiness(msg, {
    setHeader: (key, value) => { response[key] = value; },
    writeHead: status => { response.status = status; },
    end: text => { response.body = JSON.parse(text); }
  }, url.split('?')[0], store, actor, { publicOrigin: origin, authorizeSensitive });
  return response;
}

async function edit(store, list, index, changes, { action = '修改资料', transport = 'full', actor = admin } = {}) {
  const { version, data } = store.load('commerce');
  const base = transport === 'delta' ? structuredClone(data) : undefined;
  const prior = structuredClone(data[list][index]);
  const after = { ...prior, ...changes, version: prior.version + 1 };
  const log = { id: randomUUID(), type: action, entityId: prior.id, actorId: actor.id };
  data[list][index] = after;
  data.logs.unshift(log);
  const recordChange = { before: prior, after, list, log };
  const body = transport === 'delta' ? { version, action, delta: documentDelta('commerce', base, data) }
    : { version, data, action, ...(transport === 'record' && { recordChange }) };
  const result = await request(store, 'commerce', {
    method: 'PUT', actor, operationId: randomUUID(), body
  });
  assert.equal(result.status, 200, result.body.error);
  return String(store.audit()[0].id);
}

const resource = id => 'audit/' + id + '/recovery';
const requiredConfirmation = { authorizeSensitive: () => true };

async function preview(store, id, options) {
  const result = await request(store, resource(id), options);
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result['Cache-Control'], 'private, no-store');
  return result.body;
}

test('restores only the supported fields of a saved edit, even after unrelated writes and more than 1,000 logs', async t => {
  const store = storeFixture(t);
  seed(store);
  const originalId = await edit(store, 'customers', 0, {
    phone: '+60 44444', notes: 'synthetic-note-after', tags: ['新客户']
  }, { transport: 'record' });
  await edit(store, 'customers', 1, { source: '合成来源' });
  store.recordAuthEvents(Array.from({ length: 10_000 }, () => ({ action: 'auth_login', actor: employee })));
  assert(!store.audit().some(row => String(row.id) === originalId));
  const list = await request(store, 'audit/page?view=recovery&query=' + encodeURIComponent(admin.name));
  assert.equal(list.body.total, 2);
  assert(list.body.items.some(row => row.id === originalId && row.recovery === 'original'));
  assert(!JSON.stringify(list.body).includes('+60 11111'));
  store.saveBatch([{ domain: 'inventory', version: 0, action: 'inventory_create', data: {
    mailboxes: [{ id: 'apple-a', type: 'apple', email: 'apple-a@example.test',
      status: '正常', health: 'normal', appStoreRegion: 'US', appleOpeningBalance: '25' }],
    accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
  } }], { actor: admin });
  const expense = { items: [{ id: 'synthetic-bill', orderId: 'payment-order', amount: '20', currency: 'USD' }] };
  store.saveFeatureDocument('order-expense-receipts', 0, expense);
  const before = store.load('commerce');
  const related = ['inventory', 'appleBalance', 'settings'].map(domain => store.load(domain));
  assert.equal(related[1].data.wallets[0].balance, '25');
  const versions = store.changeVersions(admin);
  const diff = await preview(store, originalId);
  assert.equal(diff.status, 'available');
  assert.equal(diff.targetName, '合成客户');
  assert.deepEqual(diff.changes, [
    { label: '联系电话', current: '+60 44444', restore: '+60 11111' },
    { label: '客户标签', current: ['新客户'], restore: ['长期客户'] }
  ]);
  assert(!JSON.stringify(diff).includes('synthetic-note'));
  const operationId = randomUUID(), body = { version: diff.version, reason: 'wrong_value' };
  const saved = await request(store, resource(originalId), { body, operationId, ...requiredConfirmation });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.reason, '资料填错');
  const after = store.load('commerce');
  const { customers, logs, ...rest } = after.data;
  const { customers: previousCustomers, logs: previousLogs, ...previousRest } = before.data;
  assert.deepEqual(rest, previousRest);
  assert.deepEqual(customers[1], previousCustomers[1]);
  assert.equal(customers[0].phone, '+60 11111');
  assert.deepEqual(customers[0].tags, ['长期客户']);
  assert.equal(customers[0].notes, 'synthetic-note-after');
  assert.equal(customers[0].version, 3);
  assert.equal(customers[0].updatedById, admin.id);
  assert.equal(customers[0].createdById, previousCustomers[0].createdById);
  assert.deepEqual(logs.slice(1), previousLogs);
  assert.deepEqual(['inventory', 'appleBalance', 'settings'].map(domain => store.load(domain)), related);
  assert.deepEqual(store.featureDocument('order-expense-receipts'), { version: 1, data: expense });
  const newVersions = store.changeVersions(admin);
  assert.equal(Number(newVersions.commerce), Number(versions.commerce) + 1);
  assert.equal(Number(newVersions.audit), Number(versions.audit) + 1);
  assert.deepEqual(await preview(store, saved.body.record.id), saved.body);
  assert.deepEqual((await preview(store, originalId)).receipt, saved.body);
  assert.deepEqual((await request(store, resource(originalId), { body, operationId })).body, saved.body);
  assert.equal((await request(store, resource(originalId), { body: { ...body, reason: 'wrong_contact' }, operationId })).status, 409);
  assert.deepEqual(store.load('commerce'), after);
});

test('previews and reverses a disable once when two administrators submit', async t => {
  const store = storeFixture(t);
  seed(store);
  const id = await edit(store, 'tenants', 0, { active: false }, { action: '停用资料', transport: 'delta' });
  const diff = await preview(store, id);
  assert.deepEqual(diff.changes, [{ label: '状态', current: false, restore: true }]);
  const body = { version: diff.version, reason: 'accidental_disable' };
  const responses = await Promise.all([admin, superAdmin].map(actor =>
    request(store, resource(id), { body, operationId: randomUUID(), actor })));
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
  assert.equal(store.load('commerce').data.tenants[0].active, true);
  assert.equal(store.audit().filter(row => row.action === 'contact_recover').length, 1);
});

test('blocks stale targets, duplicate restored contacts and labels removed from settings', async t => {
  const store = storeFixture(t);
  seed(store);
  const staleId = await edit(store, 'customers', 0, { phone: '+60 44444' });
  const stale = await preview(store, staleId);
  await edit(store, 'customers', 0, { notes: '后续合法修改' });
  assert.match((await preview(store, staleId)).message, /已有更新/);
  assert.equal((await request(store, resource(staleId), { operationId: randomUUID(),
    body: { version: stale.version, reason: 'wrong_value' } })).status, 409);
  const tagId = await edit(store, 'customers', 0, { tags: ['新客户'] });
  const tag = await preview(store, tagId);
  const settings = store.load('settings');
  settings.data.customerTags = ['新客户'];
  store.saveBatch([{ domain: 'settings', ...settings, action: 'customer_tags_save' }], { actor: superAdmin });
  assert.match((await preview(store, tagId)).message, /标签已变化/);
  assert.equal((await request(store, resource(tagId), { operationId: randomUUID(),
    body: { version: tag.version, reason: 'wrong_value' } })).status, 409);
  const numberId = await edit(store, 'customers', 0, { phone: '+60 55555' });
  const number = await preview(store, numberId);
  await edit(store, 'customers', 1, { name: '合成客户', phone: '+60 44444' });
  assert.match((await preview(store, numberId)).message, /相同姓名和联系方式/);
  assert.equal((await request(store, resource(numberId), { operationId: randomUUID(),
    body: { version: number.version, reason: 'wrong_value' } })).status, 409);
  const linked = store.load('commerce');
  linked.data.customers[0].phone = '合成电话';
  linked.data.customers[0].version++;
  linked.data.orders[0].notes = '关联订单同时修改';
  linked.data.orders[0].version++;
  linked.data.logs.unshift({ id: randomUUID(), type: '修改资料', entityId: 'customer-a' });
  store.saveBatch([{ domain: 'commerce', action: '修改资料', ...linked }], { actor: admin });
  assert.equal((await preview(store, String(store.audit()[0].id))).status, 'unavailable');
  assert.equal(store.audit().filter(row => row.action === 'contact_recover').length, 0);
});

test('requires role, origin, security confirmation and a recovery idempotency key', async t => {
  const store = storeFixture(t);
  seed(store);
  const id = await edit(store, 'tenants', 0, { name: '合成租户新名称', phone: '9090' });
  const detail = await preview(store, id);
  assert.equal(detail.changes.length, 2);
  assert.equal(detail.status, 'available');
  const body = { version: detail.version, reason: 'wrong_value' }, operationId = randomUUID();
  assert.equal((await request(store, 'audit/page?view=recovery', { actor: employee })).status, 403);
  assert.equal((await request(store, resource(id), { actor: employee })).status, 403);
  assert.equal((await request(store, resource(id), { actor: null })).status, 401);
  assert.equal((await request(store, resource(id), { body, operationId, actor: employee })).status, 403);
  assert.equal((await request(store, resource(id), { body, operationId, source: 'https://unrelated.test' })).status, 403);
  const stepUp = await request(store, resource(id), { body, operationId, authorizeSensitive: () => false });
  assert.equal(stepUp.status, 403);
  assert.equal(stepUp.body.code, 'SECURITY_CONFIRMATION_REQUIRED');
  assert.equal((await request(store, resource(id), { body })).status, 400);
  assert.equal((await request(store, resource(id), { body: { ...body, phone: '123' }, operationId })).status, 400);
  assert.equal((await request(store, resource(id), { body, operationId, ...requiredConfirmation })).status, 200);
  assert.equal(store.load('commerce').data.tenants[0].name, '合成租户');
});

test('does not offer recovery for old, expired, note-only or multi-record writes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-14T00:00:00.000Z') });
  const store = storeFixture(t);
  seed(store);
  assert.equal((await preview(store, String(store.audit().find(row => row.action === '新增资料').id))).status, 'unavailable');
  const id = await edit(store, 'customers', 0, { phone: '98765' });
  const diff = await preview(store, id);
  t.mock.timers.tick(30 * 24 * 60 * 60 * 1_000);
  assert.equal((await preview(store, id)).status, 'available');
  t.mock.timers.tick(1);
  assert.match((await preview(store, id)).message, /超过 30 天/);
  assert.equal((await request(store, resource(id), { operationId: randomUUID(),
    body: { version: diff.version, reason: 'wrong_value' } })).status, 409);
  const note = await edit(store, 'customers', 1, { notes: '仅误填备注' });
  assert.equal((await preview(store, note)).status, 'unavailable');
  const batch = store.load('commerce');
  for (const row of batch.data.customers) { row.name += '批量'; row.version++; }
  batch.data.logs.unshift({ id: randomUUID(), type: '修改资料', entityId: 'customer-a' });
  store.saveBatch([{ domain: 'commerce', action: '修改资料', ...batch }], { actor: admin });
  assert.equal((await preview(store, String(store.audit()[0].id))).status, 'unavailable');
  assert.equal((await request(store, 'audit/page?view=recovery')).body.total, 0);
});

test('failed restore rolls back the business write, audit and receipt, then a retry survives restart', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const folder = await mkdtemp(join(runtime, 'contact-recovery-'));
  const path = join(folder, 'business.sqlite');
  let store = createLocalBusinessStore(path);
  const control = new DatabaseSync(path);
  try {
    seed(store);
    control.exec(`CREATE TRIGGER synthetic_recovery_history_failure BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'contact-recovery:%' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const original = store.load('commerce');
    const rejected = structuredClone(original);
    Object.assign(rejected.data.customers[0], { phone: 'never-save-this-number', version: 2 });
    rejected.data.logs.unshift({ id: randomUUID(), type: '修改资料', entityId: 'customer-a' });
    const originalAudit = store.audit();
    assert.throws(() => store.saveBatch([{ domain: 'commerce', action: '修改资料', ...rejected }], { actor: admin }));
    assert.deepEqual(store.load('commerce'), original);
    assert.deepEqual(store.audit(), originalAudit);
    control.exec('DROP TRIGGER synthetic_recovery_history_failure');
    const id = await edit(store, 'customers', 0, { wechat: 'synthetic-changed-wechat' });
    assert(!(await readFile(path)).includes(Buffer.from('synthetic-changed-wechat')));
    const diff = await preview(store, id);
    const body = { version: diff.version, reason: 'wrong_value' }, operationId = randomUUID();
    const before = store.load('commerce'), audit = store.audit();
    let notifications = 0;
    store.subscribeChanges(() => notifications++);
    control.exec(`CREATE TRIGGER synthetic_recovery_receipt_failure BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'write-receipt:%' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    assert.equal((await request(store, resource(id), { body, operationId })).status, 500);
    assert.deepEqual(store.load('commerce'), before);
    assert.deepEqual(store.audit(), audit);
    assert.equal(notifications, 0);
    control.exec('DROP TRIGGER synthetic_recovery_receipt_failure');
    const result = await request(store, resource(id), { body, operationId });
    assert.equal(result.status, 200);
    assert.equal(notifications, 1);
    store.close();
    store = createLocalBusinessStore(path);
    assert.deepEqual((await request(store, resource(id), { body, operationId })).body, result.body);
    assert.equal(store.audit().filter(row => row.action === 'contact_recover').length, 1);
    assert(!Object.hasOwn(store.load('commerce').data.customers[0], 'wechat'));
  } finally {
    control.close();
    store.close();
    await rm(folder, { recursive: true });
  }
});
