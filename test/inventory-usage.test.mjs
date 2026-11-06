import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { inspectInventoryUsage } from '../server/inventory-usage.mjs';

const actor = { id: 'operator-a', name: '测试员甲', role: 'admin' };
const other = { id: 'operator-b', name: '测试员乙', role: 'admin' };
const claimedAt = '2026-01-01 10:30';
const occurred = '2026-01-01T11:30';
const stock = (id, type, email = `${id}@example.test`) => ({
  id, type, email, inventoryState: 'available', health: 'normal', status: '正常', usageLinks: [], version: 1
});
const document = (mailboxes = [], accounts = []) => ({
  mailboxes, accounts, batches: [], returnRecords: [], importRecords: [], registrationRecords: [],
  tableSettings: [], undo: []
});
const commerce = (orders = [], customers = []) => ({
  orders, customers, tenants: [], operating: [], rentBatches: [], logs: []
});
const order = (email, options = {}) => ({
  id: 'order-1', orderNo: 'ORD-1', businessType: '续费', product: 'GPT',
  accountSource: '客户自有', email, start: occurred, expiry: '2026-02-01T11:30',
  paidConfirmed: true, paidAmount: '20', createdById: actor.id, refunds: [], ...options
});
function extract(data, rows, kind, purpose = '') {
  const batch = { id: `batch-${data.batches.length + 1}`, kind, purpose, actorId: actor.id, time: claimedAt, items: [] };
  for (const asset of rows) {
    const item = {
      id: `${batch.id}-${asset.id}`, assetId: asset.id, type: asset.type, email: asset.email,
      status: 'pending', claimedAt
    };
    batch.items.push(item);
    Object.assign(asset, { inventoryState: 'claimed', used: true, claimId: item.id, claimBatchId: batch.id });
  }
  data.batches.push(batch);
  return batch;
}
function returnRows(data, batch, items) {
  for (const item of items) {
    const asset = [...data.mailboxes, ...data.accounts].find((row) => row.id === item.assetId);
    Object.assign(item, { status: 'returned', returnedAt: '2026-01-01 12:00' });
    Object.assign(asset, { inventoryState: 'available', used: false, claimId: '', claimBatchId: '' });
    data.returnRecords.push({ id: `return-${item.id}`, assetId: asset.id, batchId: batch.id });
  }
}
function save(store, domain, data, action, operator = actor) {
  return store.saveBatch([{ domain, version: store.load(domain).version, data, action }], { actor: operator });
}

test('批量登记六个账号同步六条邮箱用量，原十条提取批次只能归还剩余四条', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const initial = document(Array.from({ length: 10 }, (_, i) => stock(`mail-${i}`, 'google')));
  const batch = extract(initial, initial.mailboxes, 'mail', '注册 GPT');
  save(store, 'inventory', initial, 'inventory_extract');
  const before = store.load('inventory');
  const next = structuredClone(before.data);
  next.accounts = next.mailboxes.slice(0, 6).map((row, i) => ({
    ...stock(`account-${i}`, 'gpt', ` ${row.email.toUpperCase()} `),
    emailType: '谷歌邮箱', registered: occurred
  }));
  save(store, 'inventory', next, 'inventory_import');
  const matched = store.load('inventory').data;
  assert.deepEqual(matched.batches[0].items.map((item) => item.status), [
    ...Array(6).fill('used'), ...Array(4).fill('pending')
  ]);
  assert.ok(matched.accounts.every((row) => row.inventoryState === 'available'));
  const link = matched.mailboxes[0].usageLinks[0];
  assert.equal(link.accountId, 'account-0');
  assert.equal(link.claimId, batch.items[0].id);
  assert.equal(link.occurredAt, '2026-01-01 11:30');
  assert.throws(() => store.saveBatch([{
    domain: 'inventory', version: before.version, data: before.data, action: 'inventory_return'
  }], { actor }), { status: 409 });
  const forbidden = structuredClone(matched);
  returnRows(forbidden, forbidden.batches[0], [forbidden.batches[0].items[0]]);
  assert.throws(() => save(store, 'inventory', forbidden, 'inventory_return'), { status: 409 });
  returnRows(matched, matched.batches[0], matched.batches[0].items.slice(6));
  save(store, 'inventory', matched, 'inventory_return');
  const saved = store.load('inventory').data;
  assert.equal(saved.returnRecords.length, 4);
  assert.equal(saved.batches[0].items.filter((item) => item.status === 'used').length, 6);
  assert.equal(saved.mailboxes[0].usageLinks.length, 1);
});

test('确认付款的订单目标邮箱在同一事务消费，客户自有续费不消费同邮箱库存账号', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mail = stock('mail', 'google');
  const initial = document([mail, stock('contact', 'google'), stock('payer', 'google')], [
    stock('gpt', 'gpt', mail.email), stock('claude', 'claude', mail.email)
  ]);
  extract(initial, initial.mailboxes, 'mail');
  extract(initial, initial.accounts, 'account', '客户交付');
  // The accounts were imported earlier and have no verified registration date.
  for (const account of initial.accounts) account.source = '客户提供';
  save(store, 'inventory', initial, 'inventory_extract');
  const results = save(store, 'commerce', commerce([order(mail.email, {
    customerEmail: initial.mailboxes[1].email, paymentId: initial.mailboxes[2].email
  })]), '新增独立订单');
  assert.deepEqual(results.map((entry) => entry.domain), ['commerce', 'inventory']);
  const used = store.load('inventory').data;
  assert.deepEqual(used.mailboxes.map((row) => row.inventoryState), ['used', 'claimed', 'claimed']);
  assert.ok(used.accounts.every((row) => row.inventoryState === 'claimed'));
  assert.equal(used.batches[0].items[0].orderId, 'order-1');
});

test('未确认订单锁定归还，撤销未执行订单后可以归还', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mail = stock('mail', 'google');
  const initial = document([mail]);
  extract(initial, [mail], 'mail');
  save(store, 'inventory', initial, 'inventory_extract');
  const pending = order(mail.email, { paidConfirmed: false, paidAmount: '' });
  save(store, 'commerce', commerce([pending]), '新增独立订单');
  assert.equal(store.inventorySnapshot().usageReview[0].status, 'review');
  const returned = store.load('inventory').data;
  returnRows(returned, returned.batches[0], returned.batches[0].items);
  assert.throws(() => save(store, 'inventory', returned, 'inventory_return'), { status: 409 });
  save(store, 'commerce', commerce([{ ...pending, cancelled: true }]), '业务撤单');
  save(store, 'inventory', returned, 'inventory_return');
  assert.equal(store.load('inventory').data.batches[0].items[0].status, 'returned');
});

test('成品订单只能由本领取人交付已提取账号，订单和原提取明细同时提交', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const stockAccount = stock('gpt', 'gpt');
  const initial = document([], [stockAccount]);
  extract(initial, [stockAccount], 'account', '客户交付');
  save(store, 'inventory', initial, 'inventory_extract');
  const before = store.load('inventory');
  const next = structuredClone(before.data);
  Object.assign(next.accounts[0], {
    inventoryState: 'used', usageLinks: [{ kind: 'order-sale', orderId: 'order-1', time: occurred }]
  });
  Object.assign(next.batches[0].items[0], { status: 'used', orderId: 'order-1', usedAt: occurred });
  const entries = [{
    domain: 'commerce', version: 0, action: '新增独立订单',
    data: commerce([order(stockAccount.email, {
      businessType: '成品交付', accountSource: '库存', accountId: stockAccount.id
    })])
  }, { domain: 'inventory', version: before.version, data: next, action: 'inventory_order_sale' }];
  assert.throws(() => store.saveBatch(structuredClone(entries), { actor: other }), { status: 409 });
  assert.deepEqual(store.load('inventory'), before);
  store.saveBatch(entries, { actor });
  assert.equal(store.load('inventory').data.batches[0].items[0].status, 'used');
  assert.equal(store.load('commerce').data.orders[0].accountId, stockAccount.id);
});

test('历史补录邮箱引用原账号，不凭空生成领取批次', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const existing = { ...stock('gpt', 'gpt'), registered: occurred, emailType: 'google' };
  save(store, 'inventory', document([], [existing]), 'inventory_import');
  const next = store.load('inventory').data;
  next.mailboxes.push(stock('mail', 'google', existing.email));
  save(store, 'inventory', next, 'inventory_import');
  const saved = store.load('inventory').data;
  assert.equal(saved.mailboxes[0].inventoryState, 'used');
  assert.equal(saved.mailboxes[0].usageLinks[0].accountId, 'gpt');
  assert.equal(saved.batches.length, 0);
});

test('历史核对先只读预览，确认后写入一次并保留批次', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T11:00:00+08:00') });
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mail = stock('mail', 'google');
  const initial = document([mail]);
  extract(initial, [mail], 'mail');
  save(store, 'inventory', initial, 'inventory_extract');
  save(store, 'commerce', commerce([order(mail.email)]), '新增独立订单');
  assert.equal(store.inventorySnapshot().usageReview[0].status, 'review');
  t.mock.timers.setTime(new Date('2026-01-01T12:00:00+08:00').getTime());
  const review = store.inventorySnapshot();
  assert.equal(review.usageReview[0].status, 'used');
  assert.equal(review.data.batches[0].items[0].status, 'pending');
  save(store, 'inventory', review.data, 'inventory_reconcile_usage');
  const saved = store.inventorySnapshot();
  assert.equal(saved.usageReview, undefined);
  assert.equal(saved.data.batches[0].items[0].status, 'used');
  assert.equal(saved.data.mailboxes[0].usageLinks.length, 1);
});

test('隐藏邮箱来源类型、领取人及归还前的旧业务分别核验', () => {
  const relay = stock('relay', 'relay', 'shared@example.test');
  const google = stock('google', 'google', relay.email);
  const account = {
    ...stock('gpt', 'gpt', relay.email), registered: occurred, emailType: 'relay', createdById: actor.id
  };
  const initial = document([relay, google], [account]);
  const batch = extract(initial, [relay, google], 'mail', '注册 GPT');
  assert.deepEqual([...inspectInventoryUsage(initial, commerce()).keys()], ['relay']);
  assert.equal(inspectInventoryUsage(initial, commerce()).get('relay').status, 'used');
  account.createdById = other.id;
  assert.equal(inspectInventoryUsage(initial, commerce()).get('relay').status, 'review');
  account.createdById = actor.id;
  returnRows(initial, batch, [batch.items[0]]);
  const next = extract(initial, [relay], 'mail', '注册 GPT');
  next.items[0].claimedAt = '2026-01-01 13:00';
  assert.equal(inspectInventoryUsage(initial, commerce()).get('relay').status, 'review');
  delete account.emailType;
  const ambiguous = inspectInventoryUsage(initial, commerce());
  assert.equal(ambiguous.get('relay').status, 'review');
  assert.equal(ambiguous.get('google').status, 'review');
});

test('误关联更正保留原依据，恢复原领取且不重新绑定已更正的账号', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mail = stock('mail', 'google');
  const initial = document([mail]);
  const batch = extract(initial, [mail], 'mail', '注册 GPT');
  save(store, 'inventory', initial, 'inventory_extract');
  const next = store.load('inventory').data;
  next.accounts.push({ ...stock('account', 'gpt', mail.email), emailType: 'google', registered: occurred });
  save(store, 'inventory', next, 'inventory_create');
  const before = store.load('inventory');
  const originalLink = before.data.mailboxes[0].usageLinks[0];
  const body = { version: before.version, data: { assetId: mail.id, linkIndex: 0, reason: '核实该账号未使用此库存' } };
  assert.throws(() => store.saveInventoryUsageCorrection(body, { ...other, role: 'employee' }), { status: 403 });
  assert.throws(() => store.saveInventoryUsageCorrection({ ...body, version: before.version - 1 }, actor), { status: 409 });
  const forged = structuredClone(before.data);
  forged.mailboxes[0].usageCorrections = [{ originalLink }];
  assert.throws(() => save(store, 'inventory', forged, 'inventory_edit'), { status: 409 });

  const corrected = store.saveInventoryUsageCorrection(body, actor);
  const asset = corrected.data.mailboxes[0];
  assert.equal(asset.inventoryState, 'claimed');
  assert.equal(asset.claimId, batch.items[0].id);
  assert.deepEqual(asset.usageLinks, []);
  assert.equal(corrected.usageReview.length, 0);
  assert.equal(corrected.data.batches[0].items[0].status, 'pending');
  assert.deepEqual(asset.usageCorrections[0].originalLink, originalLink);
  assert.equal(asset.usageCorrections[0].originalClaim.status, 'used');
  assert.equal(asset.usageCorrections[0].actorId, actor.id);
  assert.equal(store.audit().at(0).action, 'inventory_usage_correction');
  assert.throws(() => store.saveInventoryUsageCorrection(body, actor), { status: 409 });
  const cleared = structuredClone(corrected.data);
  delete cleared.mailboxes[0].usageCorrections;
  assert.throws(() => save(store, 'inventory', cleared, 'inventory_edit'), { status: 409 });
  returnRows(corrected.data, corrected.data.batches[0], corrected.data.batches[0].items);
  save(store, 'inventory', corrected.data, 'inventory_return');
  assert.equal(store.load('inventory').data.mailboxes[0].inventoryState, 'available');
  assert.equal(store.load('inventory').data.mailboxes[0].usageCorrections.length, 1);
});

test('更正一条自动关联保留独立的使用依据，正式使用登记不可从该入口移除', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const mail = stock('mail', 'google');
  const initial = document([mail]);
  extract(initial, [mail], 'mail');
  save(store, 'inventory', initial, 'inventory_extract');
  save(store, 'commerce', commerce([order(mail.email)]), '新增独立订单');
  const next = store.load('inventory').data;
  next.accounts.push({ ...stock('account', 'gpt', mail.email), emailType: 'google', registered: occurred });
  save(store, 'inventory', next, 'inventory_create');
  const prior = store.load('inventory');
  assert.deepEqual(prior.data.mailboxes[0].usageLinks.map((link) => link.kind), ['order-use', 'registration']);
  const corrected = store.saveInventoryUsageCorrection({
    version: prior.version, data: { assetId: mail.id, linkIndex: 0, reason: '该订单和库存无关' }
  }, actor);
  assert.equal(corrected.data.mailboxes[0].inventoryState, 'used');
  assert.equal(corrected.data.batches[0].items[0].status, 'used');
  assert.equal(corrected.data.mailboxes[0].usageLinks[0].accountId, 'account');
  const confirmed = { kind: 'registration', registrationId: 'verified-registration', label: '核验注册' };
  corrected.data.mailboxes[0].usageLinks.push(confirmed);
  save(store, 'inventory', corrected.data, 'inventory_registration_result');
  const newest = store.load('inventory');
  assert.throws(() => store.saveInventoryUsageCorrection({
    version: newest.version, data: { assetId: mail.id, linkIndex: 1, reason: '不能撤销正式登记' }
  }, actor), { status: 409 });
});
