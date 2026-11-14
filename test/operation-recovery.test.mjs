import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';

const admin = { id: 'synthetic-a', name: '合成管理员甲', role: 'admin' };
const other = { id: 'synthetic-b', name: '合成管理员乙', role: 'super' };
const employee = { id: 'synthetic-staff', name: '合成员工', role: 'employee' };
const STAGING = 'https://operation-recovery.test';
const archive = 'inventory/archive';
const recovery = id => `audit/${id}/recovery`;
const uuid = () => randomUUID();
const fixtureMaterial = 'synthetic-stock-material-never-in-audit';
const asset = (id, type, fields = {}) => ({ id, type, email: `${id}@example.test`, password: fixtureMaterial,
  status: '正常', health: 'normal', inventoryState: 'available', used: false, version: 1, ...fields });
const order = (id, fields = {}) => ({ id, orderNo: `ORD-${id}`, email: `${id}@orders.example.test`,
  product: 'GPT', plan: 'Plus', payment: '银行卡', businessType: '续费', source: '手工录单', status: 'draft',
  version: 1, cancelled: false, corrections: [], compensations: [], cancellationEvents: [],
  refunds: [], bankReturns: [], paidConfirmed: false, receiptConfirmed: false, ...fields });
const stock = (mailboxes = [], accounts = []) => ({
  mailboxes, accounts, batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
});
const sales = (orders = []) => ({ customers: [], tenants: [], orders, operating: [], rentBatches: [], logs: [] });
const save = (store, domain, data, action = 'local_save') =>
  store.saveBatch([{ domain, version: store.load(domain).version, data, action }], { actor: admin });

const request = (store, resource, options = {}) => localBusinessRequest(store, resource, {
  actor: admin, publicOrigin: STAGING, ...options
});

const preview = (store, id, options) => request(store, archive + '?id=' + encodeURIComponent(id), options);
const beforeArchive = (snapshot, id, reason = 'wrong_import') => {
  const asset = [...snapshot.data.mailboxes, ...snapshot.data.accounts].find(row => row.id === id);
  return { id, version: snapshot.version, assetVersion: asset.version, reason };
};
const restoreBody = read => ({ version: read.body.version, reason: 'accidental_archive' });
const restoreHealthBody = read => ({ version: read.body.version, reason: 'wrong_status' });
const writeOrder = (store, action, update, { operationId = uuid(), actor = admin, snapshot = store.load('commerce') } = {}) => {
  const { version, data } = structuredClone(snapshot.data ? snapshot : { ...snapshot, data: sales() });
  update(data.orders);
  return request(store, 'commerce', { method: 'PUT', body: { version, data, action }, operationId, actor });
};
const auditId = store => String(store.audit()[0].id);
function updateHealth(row, health) {
  row.health = health;
  row.healthChangedAt = '2026-11-14 11:00';
  row.version = (row.version || 1) + 1;
  row.inventoryHistory = [...(row.inventoryHistory || []), {
    id: uuid(), action: '健康状态变化', detail: health, time: row.healthChangedAt, actorId: 'untrusted', actor: '客户端值'
  }];
}
const writeHealth = (store, update, { operationId = uuid(), actor = admin } = {}) => {
  const { version, data } = store.load('inventory');
  update(data);
  return request(store, 'inventory', { method: 'PUT', body: { version, data, action: 'inventory_health_change' }, operationId, actor });
};
const changeCancellation = (row, cancelled, eventId) => {
  row.cancelled = cancelled;
  row.version++;
  row.cancellationEvents.push({ id: eventId, action: cancelled ? '业务撤单' : '恢复业务订单', reason: '合成业务记录',
    actorId: 'untrusted-actor', actor: '客户端值', at: '2020-01-01 12:00' });
};

test('归档未使用邮箱保留原状态和批次，超过 30 天及 1,000 条日志仍可恢复，重试返回原回执', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T03:00:00Z') });
  const seed = stock([
    asset('mail-a', 'google', { health: 'dead', status: '死号', importId: 'import-old',
      inventoryHistory: [{ id: 'prior-edit', action: '资料录入' }] }),
    asset('mail-b', 'google')
  ]);
  seed.importRecords.push({ id: 'import-old', type: 'google', results: [{ id: 'line1', assetId: 'mail-a' }] });
  save(store, 'inventory', seed, 'inventory_create');
  save(store, 'commerce', sales([order('other-order')]));
  store.saveFeatureDocument('order-expense-receipts', 0, { items: [{ id: 'synthetic-expense', value: '15' }] });
  const unrelated = () => [store.load('commerce'), store.load('appleBalance'), store.featureDocument('order-expense-receipts')];
  const otherData = unrelated();
  const start = store.load('inventory');
  const first = await preview(store, 'mail-a');
  assert.equal(first.status, 200);
  assert.equal(first['Cache-Control'], 'private, no-store');
  assert.equal(first.body.status, 'available');
  assert(!JSON.stringify(first.body).includes(fixtureMaterial));
  const archiveWrite = { body: beforeArchive(start, 'mail-a'), operationId: uuid() };
  const archived = await request(store, archive, archiveWrite);
  assert.equal(archived.status, 200, archived.body.error);
  assert.equal(archived.body.version, start.version + 1);
  assert.equal((await preview(store, 'mail-a')).status, 404);
  assert.deepEqual(store.load('inventory').data.mailboxes, [start.data.mailboxes[1]]);
  assert.deepEqual(store.load('inventory').data.importRecords, start.data.importRecords);
  assert.deepEqual(await request(store, archive, archiveWrite), archived);
  assert.equal(store.audit().filter(row => row.action === 'inventory_archive').length, 1);

  t.mock.timers.tick(40 * 24 * 60 * 60 * 1000);
  store.recordAuthEvents(Array.from({ length: 1100 }, () => ({ action: 'auth_login', actor: employee })));
  const id = archived.body.auditId;
  assert(!store.audit().some(row => String(row.id) === id));
  const records = await request(store, 'audit/page?view=recovery&module=mailbox&query=' + encodeURIComponent(admin.name));
  assert.equal(records.body.items[0].id, id);
  assert.equal((await request(store, 'audit/page?view=recovery&module=account')).body.total, 0);
  const read = await request(store, recovery(id));
  assert.equal(read.body.archiveReason, '误导入');
  assert.equal(read.body.status, 'available');
  assert.deepEqual(read.body.changes, [{ label: '库存位置', current: '已归档', restore: '原库存' },
    { label: '健康状态', current: '死号', restore: '死号' }]);
  assert(!JSON.stringify(read.body).includes(fixtureMaterial));

  const receiptOp = { body: restoreBody(read), operationId: uuid() };
  const [receipt, competing] = await Promise.all([request(store, recovery(id), receiptOp),
    request(store, recovery(id), { ...receiptOp, operationId: uuid(), actor: other })]);
  assert.deepEqual([receipt.status, competing.status].sort(), [200, 409]);
  const win = receipt.status === 200 ? receipt : competing;
  const after = store.load('inventory');
  assert.equal(after.version, start.version + 2);
  const { inventoryHistory, lastOperatedById, lastOperatedBy, lastOperatedAt, ...restored } = after.data.mailboxes[0];
  const { inventoryHistory: originalHistory, lastOperatedById: _actorId, lastOperatedBy: _actor,
    lastOperatedAt: _time, ...originalAsset } = start.data.mailboxes[0];
  assert.deepEqual(restored, { ...originalAsset, version: 2 });
  assert.deepEqual(inventoryHistory.slice(0, -1), originalHistory);
  assert.equal(inventoryHistory.at(-1).action, '恢复归档资料');
  assert.equal(lastOperatedBy, win.body.record.actor);
  assert.equal(lastOperatedById, receipt.status === 200 ? admin.id : other.id);
  assert(lastOperatedAt);
  if (receipt.status === 200) assert.deepEqual(await request(store, recovery(id), receiptOp), receipt);
  assert.deepEqual((await request(store, recovery(win.body.record.id))).body, win.body);
  assert.equal((await request(store, recovery(id))).body.receipt.record.id, win.body.record.id);
  assert.deepEqual(unrelated(), otherData);
});

test('普通库存写入无法绕过归档，归档和恢复分别校验权限、领用与重复', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const listed = asset('purchased', 'gpt', { source: '线上购买', acquisitionMethod: 'purchased' });
  const registered = asset('registered', 'claude', { source: '自己注册' });
  const mailbox = asset('claim-mail', 'google');
  const linked = asset('linked-order', 'google');
  const queried = asset('authorized', 'google');
  const recoveryMail = asset('recovery-mail', 'google');
  const microsoft = asset('microsoft', 'microsoft', { source: '线上购买', auxiliary: recoveryMail.email, mailboxUsage: 'available',
    microsoftSecurity: { loginMode: 'password', recoveryAccess: 'inventory', twoStep: 'unknown',
      recoveryMailboxId: recoveryMail.id, verificationMethods: ['email'] } });
  const occupiedMicrosoft = asset('microsoft-used', 'microsoft', { source: '线上购买', mailboxUsage: 'used',
    microsoftSecurity: { loginMode: 'password', recoveryAccess: 'unknown', twoStep: 'unknown', verificationMethods: [] } });
  save(store, 'inventory', stock([mailbox, linked, queried, recoveryMail, microsoft, occupiedMicrosoft], [listed, registered]),
    'inventory_create');
  store.saveManagedMailboxPool({ action: 'create', version: 0, provider: 'google', email: queried.email,
    appPassword: fixtureMaterial }, admin);
  save(store, 'commerce', sales([order('mail-buyer', { email: linked.email })]));
  const start = store.load('inventory');
  assert.equal((await preview(store, listed.id, { actor: employee })).status, 403);
  assert.match((await preview(store, registered.id)).body.message, /注册来源/);
  assert.match((await preview(store, linked.id)).body.message, /关联订单/);
  for (const protectedMailbox of [queried, recoveryMail, microsoft])
    assert.match((await preview(store, protectedMailbox.id)).body.message, /辅助邮箱或收信授权/);
  assert.match((await preview(store, occupiedMicrosoft.id)).body.message, /已使用/);
  assert.equal((await preview(store, listed.id)).body.status, 'available');

  const direct = structuredClone(start.data);
  direct.accounts.shift();
  assert.throws(() => save(store, 'inventory', direct, 'inventory_delete'), /请通过归档/);
  const cmd = { body: beforeArchive(start, listed.id), operationId: uuid() };
  assert.equal((await request(store, archive, { ...cmd, actor: employee })).status, 403);
  assert.equal((await request(store, archive, { ...cmd, origin: 'https://other.test' })).status, 403);
  const needConfirmation = await request(store, archive, { ...cmd, authorizeSensitive: () => false });
  assert.equal(needConfirmation.body.code, 'SECURITY_CONFIRMATION_REQUIRED');
  assert.deepEqual(store.load('inventory'), start);

  const claim = { id: 'claim-a', assetId: mailbox.id, type: mailbox.type, email: mailbox.email, status: 'pending' };
  const claiming = structuredClone(start.data);
  Object.assign(claiming.mailboxes[0], { inventoryState: 'claimed', used: true, claimId: claim.id, claimBatchId: 'batch-a' });
  claiming.batches = [{ id: 'batch-a', kind: 'mail', actorId: admin.id, items: [claim] }];
  const pendingArchive = request(store, archive, { body: beforeArchive(start, mailbox.id), operationId: uuid() });
  save(store, 'inventory', claiming, 'inventory_extract');
  const blockedClaim = await pendingArchive;
  assert.equal(blockedClaim.status, 409);
  assert.match((await preview(store, mailbox.id)).body.message, /领用/);

  const snapshot = store.load('inventory');
  const archived = await request(store, archive, { ...cmd, body: beforeArchive(snapshot, listed.id) });
  assert.equal(archived.status, 200, archived.body.error);
  const later = store.load('inventory').data;
  assert.throws(() => save(store, 'inventory', { ...later, accounts: [...later.accounts, listed] }, 'inventory_create'), /处于归档状态/);
  const draft = await request(store, recovery(archived.body.auditId));
  assert.equal(draft.body.status, 'available');
  const substitute = { ...listed, id: 'new-account', email: listed.email.toUpperCase() };
  save(store, 'inventory', { ...later, accounts: [...later.accounts, substitute] }, 'inventory_create');
  const url = recovery(archived.body.auditId);
  assert.match((await request(store, url)).body.message, /已经存在/);
  assert.equal((await request(store, url, { body: restoreBody(draft), operationId: uuid(), actor: employee })).status, 403);
  assert.equal((await request(store, url, { body: restoreBody(draft), operationId: uuid() })).status, 409);
  const duplicate = await request(store, url, { body: { ...restoreBody(draft), version: store.load('inventory').version }, operationId: uuid() });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /已经存在/);
  assert.equal(store.load('inventory').data.accounts.filter(row => row.email.toLowerCase() === listed.email).length, 1);
});

test('归档与恢复写入失败时都回滚库存、日志和回执，重启后可以安全重试', async t => {
  const work = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, 'stock-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.sqlite');
  let store = createLocalBusinessStore(file);
  const control = new DatabaseSync(file);
  try {
    save(store, 'inventory', stock([asset('retry-mail', 'google')]), 'inventory_create');
    const start = store.load('inventory'), firstAudit = store.audit();
    const command = { body: beforeArchive(start, 'retry-mail'), operationId: uuid() };
    control.exec(`CREATE TRIGGER synthetic_archive_error BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'write-receipt:%' BEGIN SELECT RAISE(ABORT, 'synthetic test'); END`);
    assert.equal((await request(store, archive, command)).status, 500);
    assert.deepEqual(store.load('inventory'), start);
    assert.deepEqual(store.audit(), firstAudit);
    control.exec('DROP TRIGGER synthetic_archive_error');
    const success = await request(store, archive, command);
    assert.equal(success.status, 200, success.body.error);
    const held = store.load('inventory'), heldAudit = store.audit();
    const url = recovery(success.body.auditId);
    const restore = { body: restoreBody(await request(store, url)), operationId: uuid() };
    control.exec(`CREATE TRIGGER synthetic_restore_error BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'write-receipt:%' BEGIN SELECT RAISE(ABORT, 'synthetic test'); END`);
    assert.equal((await request(store, url, restore)).status, 500);
    assert.deepEqual(store.load('inventory'), held);
    assert.deepEqual(store.audit(), heldAudit);
    control.exec('DROP TRIGGER synthetic_restore_error');
    assert(!(await readFile(file)).includes(Buffer.from(fixtureMaterial)));
    store.close();
    store = createLocalBusinessStore(file);
    const receipt = await request(store, url, restore);
    assert.equal(receipt.status, 200, receipt.body.error);
    assert.equal(store.load('inventory').data.mailboxes[0].password, fixtureMaterial);
    assert.deepEqual(await request(store, archive, command), success);
    assert.deepEqual(await request(store, url, restore), receipt);
    assert.equal(store.audit().filter(row => row.action === 'inventory_restore_archive').length, 1);
  } finally { control.close(); store.close(); }
});

test('从原日志恢复普通账号和邮箱的健康状态，保留其他库存、登记与财务记录', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mailbox = asset('health-google', 'google', { health: 'unlocking', inventoryHistory: [] });
  const registered = asset('health-account', 'gpt', { email: 'registered@example.test', source: '自己注册',
    inventoryHistory: [{ id: 'import-original', action: '资料录入' }] });
  save(store, 'inventory', stock([mailbox], [registered]), 'inventory_create');
  save(store, 'commerce', sales([order('unrelated-order', {
    paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', saleAmount: '160', saleCurrency: 'CNY'
  })]));
  store.saveFeatureDocument('order-expense-receipts', 0, { items: [{ id: 'unrelated-expense', value: '15' }] });
  const unaffected = () => [store.load('commerce'), store.load('appleBalance'), store.featureDocument('order-expense-receipts')];
  const original = unaffected();

  const changed = await writeHealth(store, ({ accounts }) => updateHealth(accounts[0], 'dead'));
  assert.equal(changed.status, 200, changed.body.error);
  const accountId = auditId(store), accountUrl = recovery(accountId);
  const readAccount = await request(store, accountUrl);
  assert.equal(readAccount.status, 200);
  assert.equal(readAccount.body.status, 'available');
  assert.deepEqual(readAccount.body.changes, [{ label: '健康状态', current: '死号', restore: '正常' }]);
  assert.equal(readAccount.body.targetLabel, 'ChatGPT · r***@example.test');
  assert(!JSON.stringify(readAccount.body).includes(fixtureMaterial));
  assert(!JSON.stringify(readAccount.body).includes(registered.email));
  assert.equal((await request(store, accountUrl, { actor: employee })).status, 403);

  const later = await writeHealth(store, ({ mailboxes }) => updateHealth(mailboxes[0], 'normal'));
  assert.equal(later.status, 200, later.body.error);
  const mailboxId = auditId(store), mailboxUrl = recovery(mailboxId);
  const readMailbox = await request(store, mailboxUrl);
  assert.equal(readMailbox.body.status, 'available');
  assert.equal(readMailbox.body.targetLabel, '谷歌邮箱 · h***@example.test');
  assert.deepEqual(readMailbox.body.changes, [{ label: '健康状态', current: '正常', restore: '解封中' }]);
  const inventory = store.load('inventory');
  store.recordAuthEvents(Array.from({ length: 1100 }, () => ({ action: 'auth_login', actor: employee })));
  assert(!store.audit().some(row => String(row.id) === accountId));
  const filtered = await request(store, 'audit/page?view=recovery&module=account&query=' + encodeURIComponent('#' + accountId));
  assert.deepEqual(filtered.body.items.map(row => row.id), [accountId]);

  const attempt = { body: restoreHealthBody(readAccount), operationId: uuid() };
  assert.equal((await request(store, accountUrl, { ...attempt, authorizeSensitive: () => false })).status, 403);
  assert.equal((await request(store, accountUrl, { ...attempt, actor: employee })).status, 403);
  assert.equal((await request(store, accountUrl, { ...attempt, body: { ...attempt.body, restore: 'normal' } })).status, 400);
  const [receipt, competitor] = await Promise.all([request(store, accountUrl, attempt),
    request(store, accountUrl, { ...attempt, operationId: uuid(), actor: other })]);
  assert.deepEqual([receipt.status, competitor.status], [200, 409]);
  assert.equal(receipt.body.record.action, '撤回库存状态变更');
  assert.equal(receipt.body.reason, '状态标错');
  assert.deepEqual(await request(store, accountUrl, attempt), receipt);
  assert.deepEqual((await request(store, recovery(receipt.body.record.id))).body, receipt.body);
  assert.deepEqual((await request(store, accountUrl)).body.receipt, receipt.body);
  const { version, data } = store.load('inventory');
  assert.equal(version, inventory.version + 1);
  const [row] = data.accounts;
  const prior = inventory.data.accounts[0];
  assert.deepEqual(row, { ...prior, health: 'normal', version: prior.version + 1, healthChangedAt: row.lastOperatedAt,
    lastOperatedAt: row.lastOperatedAt, inventoryHistory: [...prior.inventoryHistory, row.inventoryHistory.at(-1)] });
  assert.deepEqual(row.inventoryHistory.at(-1), { id: row.inventoryHistory.at(-1).id, action: '健康状态变化',
    detail: 'normal', reason: '状态标错', recoveryOf: accountId, actorId: admin.id, actor: admin.name, time: row.lastOperatedAt });
  assert.deepEqual(data, { ...inventory.data, accounts: [row] });
  assert.equal((await request(store, mailboxUrl, { body: restoreHealthBody(readMailbox), operationId: uuid() })).status, 200);
  assert.equal(store.load('inventory').data.mailboxes[0].health, 'unlocking');
  assert.deepEqual(unaffected(), original);
});

test('库存状态撤回拒绝历史缺值、期满、二次编辑和新出现的业务关联', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T03:00:00Z') });
  const accounts = ['pending', 'edited', 'expired', 'batch'].map(id => asset(id, 'gpt', { source: '线上购买' }));
  const usedMailbox = asset('used-mail', 'microsoft', { source: '线上购买', mailboxUsage: 'used',
    microsoftSecurity: { loginMode: 'password', recoveryAccess: 'unknown', twoStep: 'unknown', verificationMethods: [] } });
  save(store, 'inventory', stock([usedMailbox], accounts), 'inventory_create');
  const oldId = auditId(store);
  assert.equal((await request(store, recovery(oldId))).body.status, 'unavailable');
  const batch = await writeHealth(store, ({ accounts }) => {
    updateHealth(accounts[3], 'dead');
    accounts[2].notes = '同一保存另改资料';
  });
  assert.equal(batch.status, 200, batch.body.error);
  assert.equal((await request(store, recovery(auditId(store)))).body.status, 'unavailable');

  for (const [index, health] of [[0, 'dead'], [1, 'unlocking'], [2, 'dead']]) {
    const changed = await writeHealth(store, ({ accounts }) => updateHealth(accounts[index], health));
    assert.equal(changed.status, 200, changed.body.error);
    accounts[index].auditId = auditId(store);
  }
  const used = await writeHealth(store, ({ mailboxes }) => updateHealth(mailboxes[0], 'dead'));
  assert.equal(used.status, 200, used.body.error);
  assert.match((await request(store, recovery(auditId(store)))).body.message, /已使用/);

  const [pending, edited, expired] = accounts.map(row => recovery(row.auditId));
  const readPending = await request(store, pending);
  assert.equal(readPending.body.status, 'available');
  const readEdited = await request(store, edited);
  const revised = store.load('inventory').data;
  Object.assign(revised.accounts[1], { notes: '原资料后来更新', version: 3 });
  save(store, 'inventory', revised, 'inventory_edit');
  save(store, 'commerce', sales([order('new-relation', { email: accounts[0].email })]));
  const blocked = store.load('inventory');
  const beforeExpiry = await request(store, expired);
  assert.equal(beforeExpiry.body.status, 'available');
  assert.match((await request(store, pending)).body.message, /关联订单或订阅/);
  assert.equal((await request(store, pending, { body: restoreHealthBody(readPending), operationId: uuid() })).status, 409);
  assert.match((await request(store, edited)).body.message, /已有更新/);
  assert.equal((await request(store, edited, { body: restoreHealthBody(readEdited), operationId: uuid() })).status, 409);
  t.mock.timers.tick(30 * 24 * 60 * 60 * 1000 + 1);
  assert.match((await request(store, expired)).body.message, /超过 30 天/);
  assert.equal((await request(store, expired, { body: restoreHealthBody(beforeExpiry), operationId: uuid() })).status, 409);
  assert.equal((await request(store, 'audit/page?view=recovery')).body.total, 0);
  assert.deepEqual(store.load('inventory'), blocked);
});

test('库存状态的原操作和恢复分别原子提交，回执可在数据库重开后重试', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const dir = await mkdtemp(join(runtime, 'stock-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.sqlite');
  let store = createLocalBusinessStore(path);
  const control = new DatabaseSync(path);
  try {
    save(store, 'inventory', stock([asset('atomic-mail', 'google')]), 'inventory_create');
    const original = store.load('inventory'), audit = store.audit();
    control.exec(`CREATE TRIGGER stock_health_capture_error BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'inventory-health-recovery:%' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const setDead = ({ mailboxes }) => updateHealth(mailboxes[0], 'dead');
    assert.equal((await writeHealth(store, setDead)).status, 500);
    assert.deepEqual(store.load('inventory'), original);
    assert.deepEqual(store.audit(), audit);
    control.exec('DROP TRIGGER stock_health_capture_error');
    assert.equal((await writeHealth(store, setDead)).status, 200);
    const url = recovery(auditId(store)), preview = await request(store, url);
    assert.equal(preview.body.status, 'available');
    const attempt = { body: restoreHealthBody(preview), operationId: uuid() };
    const changed = store.load('inventory'), changedAudit = store.audit();
    control.exec(`CREATE TRIGGER stock_health_recovery_error BEFORE INSERT ON business_document
      WHEN NEW.domain LIKE 'write-receipt:%' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    assert.equal((await request(store, url, attempt)).status, 500);
    assert.deepEqual(store.load('inventory'), changed);
    assert.deepEqual(store.audit(), changedAudit);
    assert.equal((await request(store, url)).body.status, 'available');
    control.exec('DROP TRIGGER stock_health_recovery_error');
    const otherConnection = createLocalBusinessStore(path);
    const [receipt, rival] = await Promise.all([request(store, url, attempt),
      request(otherConnection, url, { ...attempt, operationId: uuid(), actor: other })]).finally(() => otherConnection.close());
    assert.equal(receipt.status, 200, receipt.body.error);
    assert.equal(rival.status, 409);
    store.close();
    store = createLocalBusinessStore(path);
    assert.deepEqual(await request(store, url, attempt), receipt);
    assert.equal(store.audit().filter(row => row.action === 'inventory_restore_health').length, 1);
    assert.equal(store.load('inventory').data.mailboxes[0].health, 'normal');
    assert(!(await readFile(path)).includes(Buffer.from(fixtureMaterial)));
  } finally { control.close(); store.close(); }
});

test('订单日志定位原单、独立登记撤单及恢复；状态不能从一般保存更改', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const draft = order('one');
  save(store, 'commerce', sales([order('legacy')]));
  const oldId = auditId(store);
  assert.equal((await request(store, recovery(oldId))).body.status, 'unavailable');
  const created = await writeOrder(store, '新增独立订单', rows => rows.push(draft));
  assert.equal(created.status, 200, created.body.error);
  const orderNo = store.load('commerce').data.orders.at(-1).orderNo;
  const original = auditId(store);
  const open = await request(store, recovery(original));
  assert.equal(open.body.status, 'business');
  assert.deepEqual(open.body.order, { id: draft.id, mode: 'cancel', version: 1 });
  assert.equal(open.body.record.orderNo, orderNo);
  assert.equal((await request(store, recovery(original), {
    body: { version: 1, reason: 'wrong_value' }, operationId: uuid()
  })).status, 409);
  assert.equal((await writeOrder(store, 'local_save', rows => { rows.at(-1).cancelled = true; })).status, 409);
  assert.equal((await writeOrder(store, '业务撤单', rows => changeCancellation(rows.at(-1), true, 'unauthorized'),
    { actor: employee })).status, 403);
  assert.equal((await writeOrder(store, '业务撤单', rows => {
    changeCancellation(rows.at(-1), true, 'forged'); rows.at(-1).notes = '不能一起改写';
  })).status, 409);

  const snapshot = store.load('commerce'), operationId = uuid();
  const cancel = rows => changeCancellation(rows.at(-1), true, 'cancel-event');
  const cancelled = await writeOrder(store, '业务撤单', cancel, { snapshot, operationId });
  assert.equal(cancelled.status, 200, cancelled.body.error);
  assert.deepEqual(await writeOrder(store, '业务撤单', cancel, { snapshot, operationId }), cancelled);
  const cancellationId = auditId(store);
  assert.notEqual(cancellationId, original);
  assert.match((await request(store, recovery(original))).body.message, /已变化/);
  assert.deepEqual((await request(store, recovery(cancellationId))).body.order,
    { id: draft.id, mode: 'restore', version: 2, eventId: 'cancel-event' });
  assert.equal((await writeOrder(store, '恢复业务订单', rows => changeCancellation(rows.at(-1), false, 'restore-event'))).status, 200);
  const restored = store.load('commerce').data.orders.at(-1);
  assert.equal(restored.cancelled, false);
  assert.deepEqual(restored.cancellationEvents.map(row => row.id), ['cancel-event', 'restore-event']);
  assert(restored.cancellationEvents.every(row => row.actorId === admin.id && row.actor === admin.name && row.at !== '2020-01-01 12:00'));
  const page = await request(store, 'audit/page?view=recovery&module=order&query=' + encodeURIComponent(orderNo));
  assert.deepEqual(page.body.items.map(item => item.action), ['恢复业务订单', '业务撤单', '新增独立订单']);
});

test('只链接对应更正事件，已有实收或后续续费的订单不能直接撤单', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T03:00:00Z') });
  const created = await writeOrder(store, '新增独立订单', rows => rows.push(order('editable')));
  assert.equal(created.status, 200, created.body.error);
  const creation = auditId(store);
  const correct = (rows, id, notes) => {
    const row = rows[0], { corrections, refunds, bankReturns, ...previous } = structuredClone(row);
    row.notes = notes;
    row.version++;
    row.corrections.push({ id, previous, reason: '合成更正', versionAfter: row.version });
  };
  assert.equal((await writeOrder(store, '更正订单', rows => correct(rows, 'edit-a', '修订一'))).status, 200);
  const first = auditId(store);
  assert.deepEqual((await request(store, recovery(first))).body.order,
    { id: 'editable', mode: 'undo', version: 2, eventId: 'edit-a' });
  assert.equal((await writeOrder(store, '更正订单', rows => correct(rows, 'edit-b', '修订二'))).status, 200);
  const second = auditId(store);
  assert.match((await request(store, recovery(first))).body.message, /已变化/);
  const compensation = await writeOrder(store, '补偿撤回更正', rows => {
    const row = rows[0], change = row.corrections.at(-1), version = row.version;
    row.notes = change.previous.notes;
    row.version++;
    row.compensations.push({ id: 'comp-b', correctionId: change.id, reason: '恢复第一笔更正', fromVersion: version, toVersion: row.version });
  });
  assert.equal(compensation.status, 200, compensation.body.error);
  const after = store.load('commerce').data.orders[0];
  assert.equal(after.notes, '修订一');
  assert.equal(after.corrections.length, 2);
  assert.match((await request(store, recovery(second))).body.message, /已变化/);

  const paid = order('paid', { payment: '银行卡', paidConfirmed: true, paidAmount: '11', paidCurrency: 'USD',
    receiptConfirmed: true, saleAmount: '80', saleCurrency: 'CNY' });
  assert.equal((await writeOrder(store, '新增独立订单', rows => rows.push(paid))).status, 200);
  const paidId = auditId(store);
  assert.match((await request(store, recovery(paidId))).body.message, /已有付款、实收/);
  assert.equal((await writeOrder(store, '业务撤单', rows => changeCancellation(rows.at(-1), true, 'paid-cancel'))).status, 409);
  assert.equal((await writeOrder(store, '新增独立订单', rows => rows.push(order('parent')))).status, 200);
  const parent = auditId(store);
  save(store, 'commerce', { ...store.load('commerce').data,
    orders: [...store.load('commerce').data.orders, order('child', { previousOrderId: 'parent' })] });
  assert.match((await request(store, recovery(parent))).body.message, /后续订单/);
  assert.equal((await writeOrder(store, '业务撤单', rows => changeCancellation(rows.find(row => row.id === 'parent'),
    true, 'dependent-cancel'))).status, 409);
  t.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
  assert.match((await request(store, recovery(creation))).body.message, /超过 30 天/);
  assert.equal((await request(store, 'audit/page?view=recovery&module=order')).body.total, 0);
});
