import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSnapshot, restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { createSubscriptionHandler, ownerForSubscriptionOrder, projectSubscriptions } from '../server/subscription-management.mjs';
import { attributeCommerce, createLocalBusinessStore } from '../server/local-business.mjs';
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';

const now = Date.parse('2026-11-10T02:00:00Z');
const origin = 'https://subscriptions.example.test';
const admin = { id: 'admin', name: '录单人', role: 'admin' };
const owner = { id: 'employee', name: '归属员工', role: 'employee' };
const actor = { id: 'staff', name: '普通员工', role: 'employee' };
const email = 'synthetic@example.test';
const makeOrder = (id, product, extra = {}) => ({ id, orderNo: id, product, email, customerId: 'customer-a',
  plan: product === 'Gemini' ? 'Google AI Pro' : 'Plus', start: '2026-11-01 10:00', expiry: '2026-12-01 10:00',
  paidConfirmed: true, createdById: admin.id, createdBy: admin.name, ...extra });
function fixtures(orders = []) {
  return { commerce: { version: 1, data: { orders } }, inventory: { version: 1, data: { accounts: [], mailboxes: [] } },
    mailboxes: { version: 1, data: { items: [] } }, subscriptions: { version: 0, data: null } };
}
function fakeStore(snapshots) {
  const events = [];
  return {
    events,
    loadClaudeGoogleCopySettings: () => ({ copy1: '短后缀', copy2: '完整后缀' }),
    withSubscriptions(_actor, operation) {
      return operation(snapshots, (action, ids) => events.push({ action, ids }), (data, action, id) => {
        snapshots.subscriptions = { version: snapshots.subscriptions.version + 1, data };
        events.push({ action, ids: [id] });
      });
    }
  };
}
async function request(handler, action, body, user = admin, headers = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { host: 'subscriptions.example.test', origin, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', ...headers }
  });
  let status, value, responseHeaders;
  const res = { writeHead(code, header) { status = code; responseHeaders = header; },
    end(output) { value = JSON.parse(output); } };
  await handler(req, res, '/api/local/subscriptions/' + action, user);
  return { status, body: value, headers: responseHeaders };
}

test('按产品和账号汇总历史订单，订阅有效期与查询码有效期分开', () => {
  const old = makeOrder('old', 'Gemini', { entitlementStatus: 'active', start: '2026-09-01 10:00', expiry: '2026-10-01 10:00' });
  const recent = makeOrder('recent', 'Gemini', { entitlementStatus: 'active' });
  const data = fixtures([old, recent]);
  const [row] = projectSubscriptions(data, now);
  assert.equal(row.status, 'active');
  assert.equal(row.history.length, 2);
  assert.equal(row.series[0].orderNo, 'recent');
  assert.equal(row.series[0].remainingDays, 21);
  assert.deepEqual(row.queryCode, { status: 'missing', remainingDays: null });
  assert.equal(row.ownerName, '');
  assert.equal(row.operatorName, '录单人');
  assert.equal(projectSubscriptions(data, Date.parse('2026-12-02T02:00:00Z'))[0].status, 'expired');
});

test('Claude 已开通历史独立进入订阅，不生成订单；付款与成功分开', () => {
  const data = fixtures([makeOrder('paid-only', 'Claude Pro')]);
  data.inventory.data.accounts.push({ id: 'historical', type: 'claude', email: 'history@example.test',
    claudeHistory: { phase: 'opened', plan: 'Max 20x', start: '2026-09-01', expiry: '2026-10-01' } });
  const rows = projectSubscriptions(data, now);
  assert.equal(rows.length, 2);
  const historic = rows.find(row => row.account === 'history@example.test');
  assert.equal(historic.status, 'expired');
  assert.equal(historic.history[0].source, 'history');
  assert.equal(historic.history[0].orderNo, '');
  assert.equal(rows.find(row => row.account === email).status, 'pending');
  assert.equal(data.commerce.data.orders.length, 1);
});

test('Grok 的 X 账号允许没有邮箱，同一账号不同系列可按各自状态筛选', async () => {
  const common = { email: '', xHandle: '@sample', loginMethod: 'x', entitlementStatus: 'active' };
  const data = fixtures([
    makeOrder('grok-a', 'Grok', { ...common, plan: 'SuperGrok' }),
    makeOrder('grok-b', 'Grok', { ...common, plan: 'X Premium', start: '2026-10-01 10:00', expiry: '2026-11-01 10:00' })
  ]);
  const [row] = projectSubscriptions(data, now);
  assert.equal(row.account, '@sample');
  assert.equal(row.registrationEmail, '');
  assert.equal(row.series.length, 2);
  assert.equal(row.status, 'active');
  assert.deepEqual(new Set(row.series.map(item => item.status)), new Set(['active', 'expired']));
  const handler = createSubscriptionHandler({ store: fakeStore(data), publicOrigin: origin, clock: () => now });
  for (const status of ['active', 'expired']) {
    const result = await request(handler, 'list', { product: 'Grok', status });
    assert.equal(result.body.total, 1);
    assert.equal(result.body.accountCount, 1, '总账号数按账号去重');
    assert.equal(result.body.counts.active, 1);
    assert.equal(result.body.counts.expired, 1);
  }
});

test('客户或账号关联冲突时保留待核对，并禁止复制凭据', async () => {
  const data = fixtures([makeOrder('one', 'Claude Pro'), makeOrder('two', 'Claude Pro', { customerId: 'customer-b' })]);
  data.inventory.data.mailboxes.push({ id: 'mail', type: 'google', email, password: 'synthetic-password', totp: 'synthetic-totp' });
  const store = fakeStore(data), handler = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => now });
  const list = await request(handler, 'list', { product: 'Claude' });
  assert.equal(list.body.items[0].status, 'pending');
  assert.equal(list.body.items[0].conflict, true);
  assert.ok(!JSON.stringify(list.body).includes('synthetic-password'));
  const copied = await request(handler, 'copy', { id: list.body.items[0].id, mode: 'full', revision: list.body.revision });
  assert.equal(copied.status, 409);
  assert.ok(!JSON.stringify(store.events).includes('synthetic-password'));
});

test('未确认库存账号与客户的关联时，不复制同名账号凭据', async () => {
  const data = fixtures([makeOrder('legacy', 'GPT', { accountId: '' })]);
  data.inventory.data.accounts.push({ id: 'unlinked-account', type: 'gpt', email,
    password: 'synthetic-unlinked-password', totp: 'synthetic-unlinked-totp' });
  data.inventory.data.mailboxes.push({ id: 'mail', type: 'google', email,
    password: 'synthetic-mail-password', totp: 'synthetic-mail-totp' });
  const handler = createSubscriptionHandler({ store: fakeStore(data), publicOrigin: origin, clock: () => now });
  const list = await request(handler, 'list', { product: 'GPT' });
  const copy = await request(handler, 'copy', { id: list.body.items[0].id, mode: 'full', revision: list.body.revision });
  assert.equal(copy.status, 200);
  assert.match(copy.body.text, /synthetic-mail-password/);
  assert.doesNotMatch(copy.body.text, /synthetic-unlinked/);
  assert.deepEqual(copy.body.omitted, ['产品账号密码', '产品账号 2FA']);
});

test('账号已转给其他客户时，旧订阅不能复制当前账号资料', async () => {
  const order = makeOrder('old-order', 'Gemini', { accountId: 'stock', entitlementStatus: 'active' });
  const data = fixtures([order]);
  const account = { id: 'stock', type: 'gemini', email, password: 'synthetic-current-password',
    accountLifecycle: { customerId: 'customer-b', disposition: 'in_use' }, accountLifecycleEvents: [] };
  data.inventory.data.accounts.push(account);
  const handler = createSubscriptionHandler({ store: fakeStore(data), publicOrigin: origin, clock: () => now });
  for (const released of [false, true]) {
    account.accountLifecycleEvents = released ? [{ action: 'release', orderIds: [order.id] }] : [];
    const list = await request(handler, 'list', { product: 'Gemini' });
    assert.equal(list.body.items[0].status, 'pending');
    assert.equal(list.body.items[0].conflict, true);
    const copy = await request(handler, 'copy', { id: list.body.items[0].id, mode: 'full', revision: list.body.revision });
    assert.equal(copy.status, 409);
    assert.ok(!JSON.stringify(copy.body).includes('synthetic-current-password'));
  }
});

test('手工核实与账号归属独立留痕，旧版本重试有幂等回执', async () => {
  const order = makeOrder('manual', 'GPT', { accountId: 'gpt-account' });
  const data = fixtures([order]);
  data.inventory.data.accounts.push({ id: 'gpt-account', type: 'gpt', email, password: 'synthetic-account-password',
    totp: 'synthetic-account-2fa', accountLifecycle: { customerId: 'customer-a', disposition: 'in_use' } });
  data.inventory.data.mailboxes.push({ id: 'mail', type: 'google', email, password: 'synthetic-mail-password',
    totp: 'synthetic-mail-2fa', usageLinks: [{ kind: 'registration', accountId: 'gpt-account' }] });
  const store = fakeStore(data), handler = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => now,
    readOwners: () => [owner] });
  let list = await request(handler, 'list', { product: 'GPT' });
  const id = list.body.items[0].id;
  assert.equal(list.body.items[0].status, 'pending');
  assert.equal((await request(handler, 'list', { product: 'GPT' }, actor)).status, 403);
  assert.equal((await request(handler, 'list', { product: 'GPT' }, admin, { origin: 'https://other.example.test' })).status, 403);
  const confirmation = { id, orderId: order.id, revision: list.body.revision, confirmed: true,
    reason: '已核对平台开通', commandId: 'confirm-1' };
  assert.equal((await request(handler, 'confirm', confirmation)).status, 200);
  assert.equal((await request(handler, 'confirm', confirmation)).body.replayed, true);
  assert.equal((await request(handler, 'confirm', { ...confirmation, reason: '不同依据' })).status, 409);
  list = await request(handler, 'list', { product: 'GPT' });
  assert.equal(list.body.items[0].status, 'active');
  const assign = { id, ownerId: owner.id, revision: list.body.revision, commandId: 'owner-1' };
  assert.equal((await request(handler, 'owner', assign)).status, 200);
  list = await request(handler, 'list', { product: 'GPT' });
  assert.equal(list.body.items[0].ownerName, owner.name);
  assert.equal(list.body.items[0].operatorName, admin.name);
  assert.equal(ownerForSubscriptionOrder({ ...order, id: 'renewal' }, data.subscriptions.data).ownerId, owner.id);
  assert.equal(ownerForSubscriptionOrder({ ...order, accountId: 'other-account' }, data.subscriptions.data), null);
  const copy = await request(handler, 'copy', { id, mode: 'full', revision: list.body.revision });
  assert.equal(copy.status, 200);
  assert.match(copy.body.text, /synthetic-mail-password/);
  assert.match(copy.body.text, /synthetic-account-password/);
  assert.ok(!JSON.stringify(store.events).includes('synthetic-mail-password'));
  assert.match(copy.headers['Cache-Control'], /no-store/);
  order.expiry = '2026-12-02 10:00';
  assert.equal(projectSubscriptions(data, now)[0].status, 'pending');
});

test('未订阅库存账号可预先设置归属，后续新订单沿用归属但录入人不变', async () => {
  const data = fixtures();
  data.inventory.data.accounts.push({ id: 'unused-gpt', type: 'gpt', email });
  const store = fakeStore(data), handler = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => now,
    readOwners: () => [owner] });
  const account = await request(handler, 'account', { accountId: 'unused-gpt' });
  assert.equal(account.status, 200);
  assert.equal(account.body.ownerName, '');
  assert.equal((await request(handler, 'owner', { id: account.body.id, accountId: 'unused-gpt', ownerId: owner.id,
    revision: account.body.revision, commandId: 'owner-before-opening' })).status, 200);
  const stale = makeOrder('stale-order', 'GPT', { accountId: 'unused-gpt', ownerId: admin.id, owner: admin.name });
  assert.throws(() => attributeCommerce({ orders: [stale], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] },
    { orders: [], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] }, admin, [owner], data.subscriptions.data),
  /账号归属已变化/);
  const next = makeOrder('new-order', 'GPT', { accountId: 'unused-gpt', ownerId: owner.id, owner: owner.name });
  const document = { orders: [next], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] };
  const previous = { orders: [], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] };
  attributeCommerce(document, previous, admin, [owner], data.subscriptions.data);
  assert.equal(next.ownerId, owner.id);
  assert.equal(next.owner, owner.name);
  assert.equal(next.createdById, admin.id);
  assert.equal(next.createdBy, admin.name);
  const lookup = await request(handler, 'lookup', { order: { product: 'GPT', accountId: 'unused-gpt', email,
    customerId: 'customer-a' } });
  assert.equal(lookup.body.ownerId, owner.id);
});

test('Claude 非谷歌邮箱复制保留两种格式，查询码到期与订阅到期独立', async () => {
  const order = makeOrder('claude-microsoft', 'Claude Pro', { email: 'synthetic@outlook.example', accountId: 'claude-stock' });
  const data = fixtures([order]);
  data.inventory.data.accounts.push({ id: 'claude-stock', type: 'claude', email: order.email, emailType: 'microsoft',
    accountLifecycle: { customerId: 'customer-a', disposition: 'in_use' } });
  data.inventory.data.mailboxes.push({ id: 'microsoft-mail', type: 'microsoft', email: order.email,
    password: 'synthetic-mail-password', totp: 'synthetic-mail-2fa',
    usageLinks: [{ kind: 'registration', accountId: 'claude-stock' }] });
  const code = 'MBX-' + 'A'.repeat(32);
  data.mailboxes.data.items.push({ provider: 'microsoft', email: order.email, queryCode: code, active: true,
    expiresAt: '2026-11-12T02:00:00Z' });
  const store = fakeStore(data), handler = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => now });
  let list = await request(handler, 'list', { product: 'Claude' });
  const id = list.body.items[0].id;
  assert.equal(list.body.items[0].series[0].remainingDays, 21);
  assert.equal(list.body.items[0].queryCode.remainingDays, 2);
  assert.ok(!JSON.stringify(list.body).includes(code));
  const short = await request(handler, 'copy', { id, mode: 'short', revision: list.body.revision });
  assert.match(short.body.text, new RegExp(code));
  assert.match(short.body.text, /短后缀/);
  assert.doesNotMatch(short.body.text, /synthetic-mail-password/);
  const full = await request(handler, 'copy', { id, mode: 'full', revision: list.body.revision });
  assert.match(full.body.text, /synthetic-mail-password/);
  assert.match(full.body.text, /synthetic-mail-2fa/);
  assert.match(full.body.text, /完整后缀/);
  assert.doesNotMatch(full.body.text, /产品账号密码/);
  data.mailboxes.data.items[0].expiresAt = '2026-11-09T02:00:00Z';
  data.mailboxes.version++;
  assert.equal((await request(handler, 'copy', { id, mode: 'short', revision: list.body.revision })).status, 409);
  list = await request(handler, 'list', { product: 'Claude' });
  assert.equal(list.body.items[0].queryCode.status, 'expired');
  const expired = await request(handler, 'copy', { id, mode: 'short', revision: list.body.revision });
  assert.ok(expired.body.omitted.includes('买家查询码'));
  assert.doesNotMatch(expired.body.text, new RegExp(code));
  for (const secret of [code, 'synthetic-mail-password', 'synthetic-mail-2fa'])
    assert.ok(!JSON.stringify(store.events).includes(secret));

  data.mailboxes.data.items[0].expiresAt = '2026-11-12T02:00:00Z';
  data.mailboxes.version++;
  list = await request(handler, 'list', { product: 'Claude' });
  const confirmation = { id, orderId: order.id, revision: list.body.revision, confirmed: true,
    reason: '合成开通证据', commandId: 'confirm-before-end' };
  assert.equal((await request(handler, 'confirm', confirmation)).status, 200);
  order.subscriptionEnded = true;
  data.commerce.version++;
  list = await request(handler, 'list', { product: 'Claude', status: 'ended' });
  assert.equal(list.body.items[0].queryCode.status, 'not_applicable');
  const ended = await request(handler, 'copy', { id, mode: 'full', revision: list.body.revision });
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.body.omitted, ['邮箱密码', '邮箱 2FA', '买家查询码']);
  assert.equal(ended.body.text, '邮箱账号：' + order.email + '\n完整后缀');
});

test('已确认的自动充值和平台权益可进入有效订阅，退款不自动终止', () => {
  const automatic = makeOrder('auto', 'GPT', { source: '线上代充', taskId: 'job-1', paidConfirmed: false,
    rechargeCompletedAt: '2026-11-01T02:00:00Z', refunds: [{ amount: '20' }] });
  const personal = makeOrder('gemini', 'Gemini', { entitlementStatus: 'active', refunds: [{ amount: '20' }] });
  const data = fixtures([automatic, personal]);
  let rows = projectSubscriptions(data, now);
  assert.deepEqual(rows.map(row => row.status), ['active', 'active']);
  automatic.subscriptionEnded = true;
  rows = projectSubscriptions(data, now);
  assert.equal(rows.find(row => row.product === 'GPT').status, 'ended');
  assert.equal(rows.find(row => row.product === 'Gemini').status, 'active');
});

test('缺失账号或客户的订单单独待核对，撤单不会被误认为有效', () => {
  const data = fixtures([
    makeOrder('missing-one', 'GPT', { email: '', accountId: '', customerId: 'customer-a' }),
    makeOrder('missing-two', 'GPT', { email: '', accountId: '', customerId: 'customer-b' }),
    makeOrder('missing-customer', 'Gemini', { entitlementStatus: 'active', customerId: '' }),
    makeOrder('cancelled', 'Grok', { entitlementStatus: 'active', cancelled: true })
  ]);
  const rows = projectSubscriptions(data, now);
  const missing = rows.filter(row => row.product === 'GPT');
  assert.equal(missing.length, 2);
  assert.notEqual(missing[0].id, missing[1].id);
  assert.ok(missing.every(row => row.status === 'pending' && row.conflict));
  assert.equal(rows.find(row => row.product === 'Gemini').status, 'pending');
  assert.equal(rows.find(row => row.product === 'Grok').status, 'pending');
});

// Run the on-disk fixture only in the project's isolated CI.
test('真实 SQLite 中归属版本竞争、库存续费和加密备份恢复', async t => {
  const directory = fileURLToPath(new URL('../backups/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(join(directory, '.subscription-ci-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, 'fixture.sqlite'), output = join(fixture, 'snapshot'), restored = join(fixture, 'restored');
  const { inventory, commerce } = lifecycleFixture('gpt');
  const account = inventory.accounts[0], originalLink = account.usageLinks[0];
  Object.assign(account, { inventoryState: 'available', used: false, usageLinks: [] });
  const store = createLocalBusinessStore(source);
  let profile, commerceSnapshot, winningCommand;
  try {
    store.saveBatch([{ domain: 'inventory', version: 0, data: { ...inventory, tableSettings: [], undo: [] },
      action: 'inventory_create' }], { actor: admin });
    const stock = store.load('inventory');
    Object.assign(stock.data.accounts[0], { inventoryState: 'used', used: true, version: 2, usageLinks: [originalLink] });
    store.saveBatch([{ domain: 'commerce', version: 0, data: commerce, action: '新增独立订单' },
      { domain: 'inventory', ...stock, action: 'inventory_order_sale' }], { actor: admin });
    const firstOrder = structuredClone(store.load('commerce').data.orders[0]);
    const handler = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => now, readOwners: () => [owner] });
    let list = await request(handler, 'list', { product: 'GPT' });
    assert.equal(list.body.pageSize, 20);
    const id = list.body.items[0].id;
    const commands = ['owner-a', 'owner-b'].map(commandId => ({ id, accountId: account.id, ownerId: owner.id,
      revision: list.body.revision, commandId }));
    const competing = await Promise.all(commands.map(command => request(handler, 'owner', command)));
    assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
    winningCommand = commands[competing.findIndex(response => response.status === 200)];
    assert.equal(store.featureDocument('subscription-management').version, 1);

    list = await request(handler, 'list', { product: 'GPT' });
    const confirmation = await request(handler, 'confirm', { id, orderId: firstOrder.id, revision: list.body.revision,
      confirmed: true, reason: 'synthetic-confirmation-for-encryption', commandId: 'confirm-1' });
    assert.equal(confirmation.status, 200);
    profile = store.featureDocument('subscription-management');
    const beforeAudit = store.audit().length;
    assert.throws(() => store.withSubscriptions(admin, (_snapshots, _audit, save) => {
      save({}, 'subscription_owner', id);
      throw new Error('fixture rollback');
    }), /fixture rollback/);
    assert.deepEqual(store.featureDocument('subscription-management'), profile);
    assert.equal(store.audit().length, beforeAudit);

    const next = store.load('commerce');
    const renewal = { ...structuredClone(firstOrder), id: 'renewed-order', orderNo: 'QA-2',
      businessType: '续费', accountId: '', start: '2026-11-07T12:00', expiry: '2026-12-07T12:00' };
    delete renewal.ownerId;
    delete renewal.owner;
    next.data.orders.push(renewal);
    store.saveBatch([{ domain: 'commerce', ...next, action: '新增独立订单' }],
      { actor: admin, readOrderOwners: () => [owner] });
    commerceSnapshot = store.load('commerce');
    assert.deepEqual(commerceSnapshot.data.orders[0], firstOrder);
    const saved = commerceSnapshot.data.orders[1];
    assert.equal(saved.accountId, account.id);
    assert.equal(saved.ownerId, owner.id);
    assert.equal(saved.createdById, admin.id);
    assert.ok(!JSON.stringify(store.audit()).includes('synthetic-confirmation-for-encryption'));
  } finally {
    store.close();
  }

  await createSnapshot({ source, output });
  const snapshot = await readFile(join(output, 'local-business.sqlite'));
  assert.ok(!snapshot.includes(Buffer.from('synthetic-confirmation-for-encryption')));
  await restoreSnapshot({ input: output, key: source + '.key', output: restored });
  const recovered = createLocalBusinessStore(join(restored, 'local-business.sqlite'));
  try {
    assert.deepEqual(recovered.featureDocument('subscription-management'), profile);
    assert.deepEqual(recovered.load('commerce'), commerceSnapshot);
    const handler = createSubscriptionHandler({ store: recovered, publicOrigin: origin, clock: () => now });
    assert.equal((await request(handler, 'owner', winningCommand)).body.replayed, true);
    assert.equal(recovered.featureDocument('subscription-management').version, 2);
  } finally {
    recovered.close();
  }
});
