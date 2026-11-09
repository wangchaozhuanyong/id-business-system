import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createClaudeGoogleSubscriptionsHandler, projectClaudeGoogleSubscriptions } from '../server/claude-google-subscriptions.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const origin = 'https://subscriptions.example.test';
const admin = { id: 'fixture-admin', name: '录单管理员甲', role: 'admin' };
const secondAdmin = { id: 'fixture-other-admin', name: '管理员丙', role: 'super' };
const employee = { id: 'fixture-employee', name: '归属员工乙', role: 'employee' };
const email = 'fixture.claude+qa@gmail.com';
const expiredEmail = 'fixture.expired@gmail.com';
const gmailPassword = 'synthetic-google-login-secret';
const gmailTotp = 'JBSWY3DPEHPK3PXP';
const imapPassword = 'synthetic-imap-secret';
const day = 86_400_000;

function request(handler, path, { body, method = 'POST', actor = admin, requestOrigin = origin,
  fetchSite = 'same-origin' } = {}) {
  const input = body ? [Buffer.from(JSON.stringify(body))] : [];
  const route = '/api/local/claude-google-subscriptions/' + path;
  const req = Object.assign(Readable.from(input), { method, url: route,
    headers: { host: 'subscriptions.example.test', origin: requestOrigin, 'sec-fetch-site': fetchSite, 'content-type': 'application/json' } });
  const headers = {};
  let status, data;
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(code, values = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
    },
    end(value) { data = value ? JSON.parse(value) : null; }
  };
  return Promise.resolve(handler(req, res, route, actor)).then(() => ({ status, data, headers }));
}

function fixture(t) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const now = Date.now() + 2 * day;
  const date = offset => new Date(now + offset * day).toISOString();
  const order = (id, address, from, changes = {}) => ({
    id, orderNo: id, product: 'Claude Pro', plan: 'Pro', businessType: '续费', email: address,
    customerId: 'fixture-customer', accountSource: '客户自有', payment: '银行卡', paidAmount: '20',
    paidCurrency: 'USD', saleAmount: '180', saleCurrency: 'CNY', paidConfirmed: true, proMaterialMode: 'none',
    start: date(from), expiry: date(from + 30), createdAt: date(from), createdById: admin.id, createdBy: admin.name,
    ownerId: employee.id, owner: employee.name, corrections: [], refunds: [], bankReturns: [], version: 1,
    ...changes
  });
  const commerce = {
    customers: [{ id: 'fixture-customer', name: '合成客户' }], tenants: [], operating: [], rentBatches: [], logs: [],
    orders: [
      order('renewed', email.toUpperCase(), -2),
      order('original', email, -35),
      order('unpaid', 'fixture.unpaid@gmail.com', -1, { paidConfirmed: false }),
      order('future', 'fixture.future@gmail.com', 2),
      order('canceled', 'fixture.canceled@gmail.com', -1, { cancelled: true }),
      order('expired', expiredEmail, -50, { product: 'Claude Max', plan: 'Max 5x', proMaterialMode: '', cardId: 'tenant:fixture' }),
      order('non-google', 'fixture@other.example.test', -1),
      order('google-without-code', 'fixture.nocode@gmail.com', -4)
    ]
  };
  const inventory = {
    mailboxes: [
      { id: 'google-mailbox', type: 'google', email, password: gmailPassword, totp: gmailTotp },
      { id: 'expired-mailbox', type: 'google', email: expiredEmail, password: 'synthetic-expired-password' }
    ],
    accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
  };
  store.saveBatch([{ domain: 'inventory', version: 0, data: inventory },
    { domain: 'commerce', version: 0, data: commerce }]);
  const addMailbox = (address, validDays, version) => store.saveManagedMailboxPool({
    action: 'create', version, provider: 'google', email: address, validDays, appPassword: imapPassword
  }, admin);
  const active = addMailbox(email, 7, 0);
  const expired = addMailbox(expiredEmail, 1, 1);
  const handler = createClaudeGoogleSubscriptionsHandler({ store, publicOrigin: origin, clock: () => now });
  return { store, handler, commerce, inventory, active, expired };
}

test('Claude Google 投影按已订阅的完整邮箱去重，分别读取录入人、归属、库存凭据及查询码', async t => {
  const { handler, active, expired, store } = fixture(t);
  const list = () => request(handler, 'list', { body: {} });
  assert.ok([401, 403].includes((await request(handler, 'list', { body: {}, actor: null })).status));
  assert.equal((await request(handler, 'list', { body: {}, actor: employee })).status, 403);
  assert.equal((await request(handler, 'list', { body: {}, requestOrigin: 'https://other.example.test', fetchSite: 'cross-site' })).status, 403);
  const result = await list();
  assert.equal(result.status, 200);
  assert.match(result.headers['cache-control'], /no-store/);
  assert.deepEqual(result.data.items.map(row => row.id), ['renewed', 'google-without-code', 'expired']);
  const [recent, withoutCode, old] = result.data.items;
  assert.equal(recent.email.toLowerCase(), email);
  assert.equal(recent.operatorId, admin.id);
  assert.equal(recent.operatorName, admin.name);
  assert.equal(recent.ownerId, employee.id);
  assert.equal(recent.ownerName, employee.name);
  assert.equal(recent.password, gmailPassword);
  assert.equal(recent.totp, gmailTotp);
  assert.equal(recent.queryCode, active.issuedCode);
  assert.equal(recent.codeStatus, 'active');
  assert.equal(withoutCode.codeStatus, 'missing');
  assert.equal(old.queryCode, expired.issuedCode);
  assert.equal(old.codeStatus, 'expired');
  assert.equal(old.remainingDays, 0);
  assert.ok(!JSON.stringify(result.data).includes(imapPassword));
  const page = await request(handler, 'list', { body: { page: 2, pageSize: 1 } });
  assert.deepEqual([page.data.total, page.data.page, page.data.items[0].id], [3, 2, 'google-without-code']);
  const filtered = await request(handler, 'list', { body: { status: 'missing' } });
  assert.deepEqual(filtered.data.items.map(row => row.id), ['google-without-code']);
  const searched = await request(handler, 'list', { body: { query: gmailPassword } });
  assert.equal(searched.data.total, 0);
  const audit = JSON.stringify(store.audit());
  for (const secret of [gmailPassword, gmailTotp, active.issuedCode, expired.issuedCode, imapPassword]) {
    assert.ok(!audit.includes(secret), 'audit omits credential values');
  }
});

test('复制按实时可用字段与登录人后缀生成，邮箱池轮换让旧列表回执失效', async t => {
  const { handler, store, active } = fixture(t);
  const settings = (method, body, actor) => request(handler, 'copy-settings', { method, body, actor });
  assert.deepEqual((await settings('GET')).data, { version: 0, copy1: '', copy2: '' });
  const saved = await settings('PUT', { version: 0, copy1: '合成短后缀', copy2: '合成长后缀\n第二行' });
  assert.equal(saved.status, 200);
  assert.equal((await settings('PUT', { version: 0, copy1: '陈旧', copy2: '' })).status, 409);
  assert.deepEqual((await settings('GET', undefined, secondAdmin)).data, { version: 0, copy1: '', copy2: '' });
  const list = actor => request(handler, 'list', { body: {}, actor });
  const getCopy = (id, mode, revision, actor) => request(handler, 'copy', { body: { id, mode, revision }, actor });
  let { revision } = (await list()).data;
  const short = await getCopy('renewed', 1, revision);
  assert.equal(short.status, 200);
  assert.match(short.data.text, /^邮箱账号：/);
  assert.ok(short.data.text.includes(active.issuedCode));
  assert.ok(short.data.text.endsWith('合成短后缀'));
  assert.ok(!short.data.text.includes(gmailPassword));
  assert.deepEqual(short.data.omitted, []);
  const full = await getCopy('renewed', 2, revision);
  assert.equal(full.status, 200);
  assert.deepEqual(full.data.text.split('\n').slice(1), [
    '邮箱密码：' + gmailPassword, '邮箱 2FA：' + gmailTotp, '买家查询码：' + active.issuedCode, '合成长后缀', '第二行'
  ]);
  const old = await getCopy('expired', 1, revision);
  assert.deepEqual(old.data.omitted, ['买家查询码']);
  const wrongActor = await getCopy('renewed', 2, revision, secondAdmin);
  assert.equal(wrongActor.status, 409);

  const pool = store.loadManagedMailboxPool();
  const current = pool.items.find(row => row.email === email);
  const rotated = store.saveManagedMailboxPool({ action: 'rotate', id: current.id, version: pool.version }, admin);
  assert.equal((await getCopy('renewed', 1, revision)).status, 409);
  revision = (await list()).data.revision;
  const fresh = await getCopy('renewed', 1, revision);
  assert.ok(fresh.data.text.includes(rotated.issuedCode));
  assert.ok(!fresh.data.text.includes(active.issuedCode));
  store.saveManagedMailboxPool({ action: 'status', id: current.id, version: rotated.version, active: false }, admin);
  const disabled = (await list()).data;
  const disabledRow = disabled.items.find(row => row.id === 'renewed');
  assert.equal(disabledRow.codeStatus, 'disabled');
  assert.equal(disabledRow.queryCode, rotated.issuedCode);
  const disabledCopy = await getCopy('renewed', 1, disabled.revision);
  assert.deepEqual(disabledCopy.data.omitted, ['买家查询码']);
  assert.ok(!disabledCopy.data.text.includes(rotated.issuedCode));
});

test('相同完整邮箱出现多个 Google 库存记录时，不回传或复制候选凭据', async t => {
  const { handler, store, inventory } = fixture(t);
  const extraPassword = 'synthetic-conflicting-login-secret';
  store.saveBatch([{ domain: 'inventory', version: 1, data: {
    ...inventory, mailboxes: [...inventory.mailboxes, { id: 'duplicate-mail', type: 'google', email, password: extraPassword }]
  } }]);
  const list = await request(handler, 'list', { body: {} });
  assert.equal(list.status, 200);
  const current = list.data.items.find(row => row.id === 'renewed');
  assert.equal(current.credentialStatus, 'conflict');
  const copied = await request(handler, 'copy', { body: { id: current.id, mode: 2, revision: list.data.revision } });
  assert.equal(copied.status, 200);
  for (const secret of [gmailPassword, extraPassword, gmailTotp]) {
    assert.ok(!JSON.stringify([current, copied.data]).includes(secret));
  }
  assert.ok(copied.data.omitted.includes('邮箱密码'));
});

test('库存回收和再交付时，历史订单不返回下一位客户的邮箱凭据', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const old = { id: 'delivery-a', product: 'Claude Pro', email, customerId: 'client-a',
    accountId: 'stock-claude', accountSource: '库存', businessType: '成品交付',
    start: '2026-09-03 12:00', expiry: '2026-10-03 12:00', paidConfirmed: true };
  const next = { ...old, id: 'delivery-b', customerId: 'client-b', start: '2026-11-07 12:00', expiry: '2026-12-07 12:00' };
  const code = 'MBX-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const pool = { data: { items: [{ provider: 'google', email, queryCode: code,
    active: true, expiresAt: '2026-12-07T12:00:00Z' }] } };
  const account = { id: 'stock-claude', type: 'claude', email, emailType: 'google',
    accountLifecycleEvents: [{ action: 'release', orderIds: [old.id], customerId: old.customerId }] };
  const mailbox = { id: 'linked-mail', type: 'google', email, password: gmailPassword, totp: gmailTotp,
    usageLinks: [{ kind: 'registration', accountId: account.id }] };
  const view = (orders, disposition, customerId) => projectClaudeGoogleSubscriptions({
    commerce: { data: { orders } }, mailboxes: pool, inventory: { data: { mailboxes: [mailbox],
      accounts: [{ ...account, accountLifecycle: { disposition, customerId } }] } }
  }, now);
  const [recovered] = view([old], 'recovered', '');
  assert.equal(recovered.id, old.id);
  assert.equal(recovered.credentialStatus, 'conflict');
  assert.equal(recovered.password, '');
  assert.equal(recovered.queryCode, '');
  const reassigned = view([old, next], 'in_use', 'client-b');
  assert.deepEqual(reassigned.map(row => row.id), [next.id]);
  assert.equal(reassigned[0].password, gmailPassword);
  assert.equal(reassigned[0].queryCode, code);
});

test('客户自有账号已登记 Google 收信时，可查同邮箱的买家查询码', () => {
  const code = 'MBX-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const [row] = projectClaudeGoogleSubscriptions({
    commerce: { data: { orders: [{ id: 'owned', product: 'Claude Pro', email, accountSource: '客户自有',
      paidConfirmed: true, start: '2026-11-05T00:00:00Z' }] } },
    inventory: { data: { accounts: [{ id: 'owned-account', type: 'claude', source: '客户提供', emailType: 'google', email }] } },
    mailboxes: { data: { items: [{ provider: 'google', email, queryCode: code, active: true, expiresAt: '2026-11-12T00:00:00Z' }] } }
  }, Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(row.queryCode, code);
  assert.equal(row.remainingDays, 3);
  assert.equal(row.password, '');
});
