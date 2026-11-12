import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRelayDeliveryJournal, createRelayDeliveryReset } from '../server/apple-relay/code-reset.mjs';
import { createCardManagementHandler, orderCardHealth, orderCardHealthReference } from '../server/card-management.mjs';
import { createCustomerQueryHandler, customerQuery } from '../server/customer-query.mjs';
import { attributeInventory } from '../server/inventory-attribution.mjs';
import { checkAppleIdHealthChanges } from '../server/inventory-history.mjs';
import { applyMailboxPoolWrite, createManagedMailboxQuery, findMailboxQuery, inventoryMailboxPool, mailboxPoolMetadata,
  managedMailboxQueryRoute, planMailboxRotations, storefrontMailboxQueryRoute } from '../server/tools/mailbox-pool.mjs';
import { describeWriteOperation } from '../server/write-operation.mjs';

const now = Date.parse('2026-11-13T02:00:00Z');
const day = 86_400_000;
const time = days => new Date(now + days * day).toISOString();
const actor = { id: 'unit-admin', name: '合成管理员', role: 'admin' };
const code = 'MBX-' + 'b'.repeat(32);
const inventory = { version: 3, data: { mailboxes: [
  { id: 'google', type: 'google', email: 'One+Tag@example.test', health: 'normal', status: '正常' },
  { id: 'apple', type: 'apple', email: 'one+tag@example.test', health: 'dead', status: '正常' },
  { id: 'second', type: 'google', email: 'one.tag@example.test' },
  { id: 'ms', type: 'microsoft', email: 'new@example.test' },
  { id: 'relay', type: 'relay', email: 'hidden@example.test' }
], accounts: [{ id: 'claude', type: 'claude', email: 'not-a-mailbox@example.test' }] } };
const bound = { id: 'bound', provider: 'google', email: 'one+tag@example.test', active: true,
  expiresAt: time(-1), queryCode: code, appPassword: 'offline-fixture' };
const snapshot = { version: 7, data: { items: [bound, { ...bound, id: 'failed', email: 'failed@example.test',
  queryCode: 'MBX-' + 'c'.repeat(32), authFailed: true }, { ...bound, id: 'hidden', email: 'hidden@example.test' }] } };

test('邮箱池用邮箱库存合并真实绑定，隐藏邮箱和产品登录账号不进入列表', () => {
  const result = inventoryMailboxPool(mailboxPoolMetadata(snapshot), inventory);
  assert.equal(result.inventoryVersion, 3);
  assert.equal(result.defaultValidDays, 30);
  assert.deepEqual(result.items.map(row => row.id), ['bound', 'failed', 'inventory:second', 'inventory:ms']);
  assert.deepEqual(result.items[0].inventorySources, ['google', 'apple']);
  assert.equal(result.items[0].associationConflict, true, '与历史记录共用查询码时应标记待核对');
  assert.equal(result.items[2].authorizationPending, true);
  assert.doesNotMatch(JSON.stringify(result), /offline-fixture|MBX-/);
});

test('普通邮箱更换查询码、应用配置天数、批量跳过未授权及拒绝过期版本', () => {
  const source = { version: 7, data: { items: [{ ...bound, expiresAt: time(2) }, snapshot.data.items[1]], defaultValidDays: 12 } };
  const request = { scope: 'google', mode: 'single', ids: ['google'], version: 7, inventoryVersion: 3 };
  const single = planMailboxRotations(source, inventory, request, now);
  assert.equal(findMailboxQuery(source, code, now).id, 'bound');
  assert.equal(single.issued.expiresAt, time(12));
  assert.notEqual(single.issued.queryCode, code);
  const after = { version: 8, data: { items: single.items, defaultValidDays: 12 } };
  assert.equal(findMailboxQuery(after, code, now), null);
  assert.equal(findMailboxQuery(after, single.issued.queryCode, now).id, 'bound');
  assert.throws(() => planMailboxRotations(after, inventory, request, now), { status: 409 });
  const batch = planMailboxRotations(source, inventory, { ...request, scope: 'pool', mode: 'all' }, now);
  assert.deepEqual(batch.results.map(row => row.status), ['success', 'skipped', 'skipped', 'skipped']);
  assert.equal(batch.issued, undefined);
  assert.deepEqual(batch.results.slice(1).map(row => row.reason), ['邮箱授权已失效', '未绑定邮箱', '未绑定邮箱']);
  assert.equal(applyMailboxPoolWrite(after, { action: 'settings', version: 8, validDays: 60, applyExisting: true }, now).items[0].expiresAt, time(12));
});

test('普通邮箱买家接口在读取邮件期间重置旧码时拒绝旧响应，也拒绝历史重复码', { timeout: 5000 }, async t => {
  const host = 'mail.example.test', origin = `https://${host}`;
  let clock = now;
  const active = { ...bound, expiresAt: time(2) };
  let current = { version: 7, data: { items: [active], defaultValidDays: 12 } };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const reads = [], audits = [];
  const handler = createManagedMailboxQuery({
    publicOrigin: origin, storefrontOrigin: origin, clock: () => clock,
    store: {
      findManagedMailbox: (input, at) => findMailboxQuery(current, input, at),
      recordManagedMailboxQuery: id => audits.push(id)
    },
    async readMailbox({ id, revision }) {
      reads.push(id);
      if (revision === 7) { entered.resolve(); await release.promise; }
      return [{ subject: '合成邮件', receivedAt: time(0), body: '合成验证内容' }];
    }
  });
  t.after(() => handler.close());
  const query = (queryCode, url = managedMailboxQueryRoute) => new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify({ queryCode }))]);
    Object.assign(request, { method: 'POST', url, headers: { host, origin, 'content-type': 'application/json' } });
    let status, headers;
    void handler(request, { writeHead: (code, values) => { status = code; headers = values; },
      end: output => resolve({ status, headers, body: JSON.parse(output) }) });
  });
  const pending = query(code);
  let newCode;
  try {
    await Promise.race([entered.promise, pending.then(result => assert.fail(`未开始模拟收信，接口返回 ${result.status}`))]);
    const plan = planMailboxRotations(current, inventory, { scope: 'pool', mode: 'single', ids: ['bound'], version: 7, inventoryVersion: 3 }, now);
    current = { version: 8, data: { items: plan.items, defaultValidDays: 12 } };
    newCode = plan.issued.queryCode;
  } finally { release.resolve(); }
  assert.equal((await pending).status, 404);
  assert.deepEqual(audits, []);
  assert.equal((await query(code, storefrontMailboxQueryRoute)).status, 400);
  const success = await query(`${active.email}----${newCode}`, storefrontMailboxQueryRoute);
  assert.equal(success.status, 200);
  assert.equal(success.headers['Cache-Control'], 'private, no-store');
  assert.equal(success.body.data.email, active.email);
  assert.equal(success.body.data.items[0].subject, '合成邮件');
  assert.doesNotMatch(JSON.stringify(success.body), /offline-fixture|MBX-/);
  assert.deepEqual(audits, ['bound']);
  const valid = current.data.items[0];
  current.data.items.push({ ...valid, id: 'conflicting', email: 'conflicting@example.test', active: false });
  assert.equal((await query(newCode)).status, 404);
  current.data.items.pop();
  clock = Date.parse(time(12));
  assert.equal((await query(newCode)).status, 404);
  assert.deepEqual(reads, ['bound', 'bound']);
});

test('大库存按邮箱合并，选中重置不会改变其余记录', () => {
  for (const size of [1000, 10000]) {
    const large = { version: 3, data: { mailboxes: [...inventory.data.mailboxes, ...Array.from({ length: size }, (_, i) =>
      ({ id: `large-${i}`, type: 'google', email: `item-${i}@example.test` }))] } };
    const source = { version: 7, data: { items: [bound] } };
    assert.equal(inventoryMailboxPool(mailboxPoolMetadata(source), large).items.length, size + 3);
    const plan = planMailboxRotations(source, large, { scope: 'google', mode: 'selected', ids: ['google', `large-${size - 1}`],
      inventoryVersion: 3, version: 7 }, now);
    assert.deepEqual(plan.results.map(row => row.status), ['success', 'skipped']);
    assert.equal(plan.issued, undefined);
  }
});

test('隐藏邮箱批量并发有上限，丢失上游响应先读回，重放与并发操作不重复重置', async () => {
  const documents = new Map(), audits = [], attempts = [];
  const storage = { read: id => documents.get(id) || { version: 0, data: null },
    write: (id, version, data) => documents.set(id, { version, data: structuredClone(data) }),
    transaction: fn => fn(), inventoryVersion: () => 3, audit: (_, id) => audits.push(id), now: () => now };
  const aliases = new Map(Array.from({ length: 6 }, (_, i) => [String(i), { id: String(i), version: 1,
    email: `relay-${i}@example.test`, health: i === 5 ? 'dead' : 'normal' }]));
  const codes = new Map([...aliases].map(([id, row]) => [id, { id, aliasEmail: row.email, primaryAccountId: 'parent',
    buyerQueryCode: `OLD-FAKE-${id}`, codeExpiresAt: time(2) }]));
  const lookup = async (_, id) => ({ local: aliases.get(id), remoteId: id, remote: codes.get(id),
    owner: { remoteId: 'parent', remote: { status: 'ACTIVE' } } });
  let running = 0, maximum = 0;
  const factory = () => createRelayDeliveryReset({ lookup, journal: createRelayDeliveryJournal(storage), now: () => now,
    readAliases: async () => ({ aliases }),
    mutate: async (_, id, days) => {
      attempts.push(id);
      maximum = Math.max(maximum, ++running);
      await new Promise(resolve => setImmediate(resolve));
      running--;
      const result = { ...codes.get(id), buyerQueryCode: `NEW-FAKE-${id}`, codeExpiresAt: time(days), codeResetIntervalDays: days };
      codes.set(id, result);
      if (id === '2') throw new Error('合成响应丢失');
      return result;
    } });
  const command = { mode: 'all', inventoryVersion: 3 };
  const result = await factory()(command, actor, 'bulk-operation-000001');
  assert.equal(maximum, 4);
  assert.equal(result.results[2].status, 'pending');
  assert.equal(result.results[5].status, 'skipped');
  assert.deepEqual(attempts, ['0', '1', '2', '3', '4']);
  const competing = await factory()({ mode: 'single', ids: ['2'], inventoryVersion: 3 }, { ...actor, id: 'another-admin' }, 'single-operation-00002');
  assert.equal(competing.results[0].status, 'skipped');
  assert.match(competing.results[0].reason, /上一操作已核对/);
  const replay = await factory()(command, actor, 'bulk-operation-000001');
  assert.equal(replay.results[2].status, 'success');
  assert.equal(attempts.length, 5);
  assert.equal(audits.length, 5);
  assert.doesNotMatch(JSON.stringify([...documents.values()]), /OLD-FAKE|NEW-FAKE/);
  await assert.rejects(() => factory()(command, actor, 'bad'), { status: 400 });
  await assert.rejects(() => factory()({ ...command, inventoryVersion: 2 }, actor, 'stale-operation-000003'), { status: 409 });
  const newAlias = { id: '6', email: 'never-sent@example.test', version: 1 };
  aliases.set(newAlias.id, newAlias);
  codes.set(newAlias.id, { id: newAlias.id, aliasEmail: newAlias.email, primaryAccountId: 'parent',
    buyerQueryCode: 'OLD-FAKE-6', codeExpiresAt: time(2) });
  const queued = { mode: 'single', ids: [newAlias.id], inventoryVersion: 3 };
  const interrupted = 'interrupted-reset-0001';
  const operation = describeWriteOperation(interrupted, actor, ['apple-relay-delivery', 'single', queued.ids, 3]);
  createRelayDeliveryJournal(storage).start(operation, 3, [newAlias]);
  const resumed = await factory()(queued, actor, interrupted);
  assert.equal(resumed.replayed, true);
  assert.equal(resumed.issued.queryCode, 'NEW-FAKE-6');
  assert.equal((await factory()(queued, actor, interrupted)).issued.queryCode, resumed.issued.queryCode);
  assert.equal(attempts.filter(id => id === newAlias.id).length, 1);
});

const old = { id: 'old', orderNo: 'ORDER-OLD', version: 1, customerId: 'customer-a', product: 'GPT', plan: 'Plus',
  start: time(-36), expiry: time(-6), paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
  email: 'gpt@example.test', payment: '苹果内购', appleIdId: 'apple', taskId: 'internal-task', paidAmount: '99' };
const bank = { ...old, id: 'bank', orderNo: 'ORDER-BANK', start: time(-6), expiry: time(24), payment: '银行卡',
  appleIdId: '', cardId: 'recharge:7', proCardNumber: '4242424242424242', paymentId: '4242' };
const claude = { ...bank, id: 'claude-order', orderNo: 'ORDER-CLAUDE', email: 'claude@example.test',
  product: 'Claude Pro', plan: 'Pro', tenantId: 'tenant-a', cardId: 'tenant:7', verifierPhone: 'internal-tenant-phone',
  proCardSerial: 'internal-card-serial', phone: 'internal-order-phone' };
const customers = [{ id: 'customer-a', name: '同名客户', wechat: 'wechat-a', phone: '公开客户电话' },
  { id: 'customer-b', name: '同名客户', wechat: 'wechat-b' }];
const data = { inventory, commerce: { version: 2, data: { customers, orders: [old, bank, claude,
  { ...bank, id: 'other', customerId: 'customer-b', email: 'other@example.test' }, { ...old, id: 'unknown', customerId: '', wechat: 'wechat-a' }],
  tenants: [{ id: 'tenant-a', name: '合成租户', phone: 'internal-tenant-phone' }], logs: [] } } };

test('客户查询按客户编号隔离，保留死号 Apple ID 原绑定，Claude 字段白名单及录单预填生效', () => {
  const cards = { health: { 'recharge:7': { state: 'normal' }, 'tenant:7': { state: 'dead' } } };
  const run = (action, params) => customerQuery(data, cards, action, params, now);
  assert.deepEqual(run('search', { query: '同名客户' }).items.map(row => row.id), ['customer-a', 'customer-b']);
  const details = run('detail', { customerId: 'customer-a', tab: 'accounts' });
  assert.equal(details.unresolved, 1);
  assert.equal(details.items.length, 2);
  const gpt = details.items.find(row => row.product === 'GPT');
  assert.equal(gpt.status, 'active');
  assert.deepEqual(gpt.appleBindings.map(({ account, state, historical }) => ({ account, state, historical })),
    [{ account: 'one+tag@example.test', state: 'dead', historical: true }]);
  const row = details.items.find(row => row.product === 'Claude Pro');
  assert.deepEqual(row.bank, { state: 'dead', private: true });
  assert.equal(row.payment, '');
  assert.doesNotMatch(JSON.stringify(details), /internal-(?:task|tenant-phone|order-phone|card-serial)|4242424242424242|other@example.test/);
  assert.deepEqual(run('copy-claude', { customerId: 'customer-a', orderId: claude.id }), { text: 'claude@example.test----合成租户' });
  assert.throws(() => run('prefill', { customerId: 'customer-a', orderId: 'other' }), { status: 404 });
  const prefill = run('prefill', { customerId: 'customer-a', orderId: old.id }).values;
  assert.equal(prefill.email, old.email);
  for (const key of ['appleIdId', 'paidConfirmed', 'receiptConfirmed', 'paidAmount', 'start', 'expiry', 'taskId'])
    assert(!Object.hasOwn(prefill, key), key);
  const customerOnly = run('prefill', { customerId: 'customer-a', product: 'Gemini' }).values;
  assert.equal(customerOnly.wechat, 'wechat-a');
  assert.equal(customerOnly.email, undefined);
  assert.equal(run('prefill', { customerId: 'customer-a', orderId: bank.id }).values.cardId, bank.cardId);
  assert.equal(run('prefill', { customerId: 'customer-a', orderId: claude.id }).values.cardId, undefined);
  const eligible = customerQuery(data, {}, 'prefill', { customerId: 'customer-a', orderId: claude.id }, now).values;
  assert.equal(eligible.cardId, claude.cardId);
  assert.equal(eligible.proMaterialMode, 'tenant_card');
  assert.doesNotMatch(JSON.stringify(eligible), /internal-(?:tenant-phone|order-phone|card-serial)|4242424242424242/);
  const readyApple = { ...data, inventory: { data: { mailboxes: [{ id: 'apple', type: 'apple', status: '正常', appStoreRegion: 'US' }] } },
    appleBalance: { data: { wallets: [{ id: 'apple', currency: 'USD', balance: '50' }],
      allocations: [{ orderId: old.id, appleIdId: 'apple' }] } } };
  assert.equal(customerQuery(readyApple, {}, 'prefill', { customerId: 'customer-a', orderId: old.id }, now).values.appleIdId, 'apple');
});

test('客户查询按现有订阅终止规则选当前记录，Claude 租户关联冲突时不可复制', () => {
  const ended = { ...bank, id: 'ended', start: time(-3), subscriptionEnded: true };
  const pending = { ...bank, id: 'pending', start: time(-1), entitlementStatus: 'pending' };
  const snapshots = { ...data, commerce: { data: { ...data.commerce.data, orders: [bank, ended, pending, claude],
    tenants: [...data.commerce.data.tenants, { id: 'tenant-a', name: '关联待核对的同编号租户' }] } } };
  const request = { customerId: 'customer-a', tab: 'accounts' };
  const result = customerQuery(snapshots, {}, 'detail', request, now);
  const gpt = result.items.find(row => row.product === 'GPT');
  assert.equal(gpt.id, pending.id);
  assert.equal(gpt.status, 'pending');
  const row = result.items.find(row => row.product === 'Claude Pro');
  assert.equal(row.tenant, null);
  assert.equal(row.tenantConflict, true);
  assert.equal(row.copyClaude, false);
  assert.throws(() => customerQuery(snapshots, {}, 'copy-claude', { ...request, orderId: claude.id }, now), { status: 409 });
});

test('客户查询按同一平台编号关联登录变更后的订单和原苹果 ID', () => {
  const original = { ...old, product: 'Grok', plan: 'SuperGrok', platformAccountId: 'grok-fixture-1',
    loginMethod: 'email', email: 'old-grok@example.test' };
  const current = { ...bank, product: 'Grok', plan: 'SuperGrok', platformAccountId: original.platformAccountId,
    loginMethod: 'x', email: '', xHandle: '@fixture_grok' };
  const another = { ...current, id: 'different-account', xHandle: '@another_fixture', platformAccountId: 'grok-fixture-2' };
  const snapshots = { ...data, commerce: { data: { ...data.commerce.data, orders: [current, original, another] } } };
  const result = customerQuery(snapshots, {}, 'detail', { customerId: 'customer-a', tab: 'accounts' }, now);
  assert.equal(result.items.length, 2);
  const row = result.items.find(item => item.account === current.xHandle);
  assert.equal(row.id, current.id);
  assert.equal(row.bank.state, 'normal');
  assert.deepEqual(row.appleBindings.map(({ id, historical }) => ({ id, historical })), [{ id: 'apple', historical: true }]);
});

test('客户查询接口拒绝跨站及跨客户复制，Claude 成功回执只审计订单编号', async () => {
  const origin = 'https://customers.example.test', audit = [];
  const handler = createCustomerQueryHandler({
    publicOrigin: origin, clock: () => now, store: {
      featureDocument: () => ({ data: {} }),
      withSubscriptions: (_, run) => run(data, (action, ids) => audit.push({ action, ids }))
    }
  });
  const copy = (body, who = actor, headers = {}) => new Promise(resolve => {
    const input = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }
    });
    let status;
    void handler(input, { writeHead: code => { status = code; },
      end: output => resolve({ status, data: JSON.parse(output) }) }, '/api/local/customer-query/copy-claude', who);
  });
  const command = { customerId: 'customer-a', orderId: claude.id };
  assert.equal((await copy(command, { ...actor, role: 'employee' })).status, 403);
  assert.equal((await copy(command, actor, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await copy({ ...command, customerId: 'customer-b' })).status, 404);
  assert.deepEqual(audit, []);
  assert.deepEqual(await copy(command), { status: 200, data: { text: 'claude@example.test----合成租户' } });
  assert.deepEqual(audit, [{ action: 'copy', ids: [claude.id] }]);
});

test('卡片状态按稳定关联或完整手填卡号生效，拒绝同尾号、过期版本和重放修改', async () => {
  let cardTypes = { version: 0, data: null };
  const writes = new Map();
  const store = { featureDocument: () => cardTypes, load: () => data.commerce,
    replayWrite(operation) {
      const receipt = writes.get(operation.domain);
      if (!receipt) return null;
      if (receipt !== operation.fingerprint) throw Object.assign(new Error('操作内容已变化'), { status: 409 });
      return [cardTypes];
    },
    saveFeatureDocument(_, version, value, { operation }) {
      cardTypes = { version: version + 1, data: value };
      writes.set(operation.domain, operation.fingerprint);
      return cardTypes;
    } };
  const origin = 'https://offline.example.test';
  const handler = createCardManagementHandler({ store, publicOrigin: origin, clock: () => now });
  const submit = (command, id = 'card-health-00000001') => new Promise(resolve => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(command))]), { method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-id-operation': id } });
    let status;
    void handler(request, { writeHead: value => { status = value; }, end: value => resolve({ status, value: JSON.parse(value) }) },
      '/api/local/card-types', actor);
  });
  const request = { action: 'health', orderId: bank.id, orderVersion: 1, version: 0, state: 'dead', reason: '合成死卡' };
  const saved = await submit(request);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.health, { 'recharge:7': 'dead' });
  assert.doesNotMatch(JSON.stringify(saved.value), /4242424242424242|pan:/);
  assert.equal(orderCardHealth(cardTypes.data, 'recharge:7'), 'dead');
  assert.equal(customerQuery(data, cardTypes.data, 'detail', { customerId: 'customer-b', tab: 'accounts' }, now).items[0].bank.state, 'dead');
  assert.equal(orderCardHealth(cardTypes.data, 'recharge:8', '5555555555554242'), 'normal');
  const manual = orderCardHealthReference({ ...bank, proMaterialMode: 'manual_card', cardId: '' });
  assert.equal(orderCardHealth(cardTypes.data, manual.id, manual.number), 'dead');
  assert.equal((await submit(request)).value.version, 1);
  assert.equal((await submit({ ...request, state: 'normal' })).status, 409);
  assert.equal((await submit(request, 'card-health-00000002')).status, 409);
  assert.equal((await submit({ ...request, version: 1, state: 'normal' }, 'card-health-00000003')).status, 200);
  assert.equal(orderCardHealth(cardTypes.data, manual.id, manual.number), 'normal');
});

test('Apple ID 状态变更必须记录原因，保留旧绑定独立于状态', () => {
  const apple = { id: 'id', type: 'apple', health: 'normal', inventoryHistory: [] };
  const prior = { mailboxes: [apple] };
  const next = { mailboxes: [{ ...apple, health: 'dead', inventoryHistory: [
    { id: 'event', action: '健康状态变化', detail: 'dead', reason: '合成停用', actorId: 'client-supplied' }
  ] }] };
  assert.equal(checkAppleIdHealthChanges(prior, next, 'inventory_health_change', actor, new Date(now)), '');
  assert.equal(next.mailboxes[0].inventoryHistory[0].actorId, actor.id);
  assert.equal(next.mailboxes[0].inventoryHistory[0].time, next.mailboxes[0].healthChangedAt);
  assert.match(checkAppleIdHealthChanges(prior, next, 'inventory_edit'), /填写原因/);
  const importRecord = { id: 'import-apple', type: 'apple', time: 'client-supplied', actor: 'client-supplied',
    success: 0, failed: 1, results: [{ line: 1, reason: '重复邮箱' }] };
  assert.equal(attributeInventory(prior, { ...next, accounts: [], importRecords: [importRecord] }, actor, 'inventory_import'), undefined);
  assert.equal(importRecord.actor, actor.name);
  assert.notEqual(importRecord.time, 'client-supplied');
});
