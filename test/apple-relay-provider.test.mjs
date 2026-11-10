import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import {
  createAppleRelayService,
  loadAppleRelayConfig
} from '../server/apple-relay/local-service.mjs';

const future = '2099-01-01T00:00:00Z';
const historyCounts = {
  scannedCount: 12,
  matchedCount: 7,
  updatedCount: 0,
  unmatchedCount: 3,
  ambiguousCount: 2,
  unresolvedCount: 5,
  skippedCount: 0
};
const primary = (id, email, masterQueryCode) => ({
  id,
  email,
  masterQueryCode,
  status: 'ACTIVE',
  codeExpiresAt: future
});
const alias = (id, primaryAccountId, aliasEmail, buyerQueryCode, codeExpiresAt = future) => ({
  id,
  primaryAccountId,
  aliasEmail,
  buyerQueryCode,
  codeExpiresAt,
  status: 'ACTIVE'
});
const mail = (id, primaryAccountId, virtualEmailId, extra = {}) => ({
  id,
  messageId: id,
  primaryAccountId,
  virtualEmailId,
  fromAddress: 'verification@example.test',
  subject: '验证码：123456',
  receivedAt: '2026-11-05T10:15:00Z',
  bodyText: '示例邮件正文',
  ...extra
});

test('imports old primary authorizations, then creates and edits through the existing Vendure operations', async (t) => {
  const state = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  state.config.primaryBindings = {};
  state.config.importAliasIds = ['va-first', 'va-other'];
  state.inventory = {
    ...Object.fromEntries(['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords',
      'registrationRecords', 'tableSettings', 'undo'].map((key) => [key, []])),
    appleRelay: { parents: [{ id: 'prior-local', email: 'one@example.test', version: 1 }], imports: [], events: [] }
  };
  store.saveBatch([{ domain: 'inventory', version: 0, data: state.inventory }]);
  let localConflict = false;
  state.savePrimaries = (rows, actor, aliases) => {
    if (localConflict) throw Object.assign(new Error('fixture conflict'), { status: 409 });
    const saved = store.saveAppleRelayPrimaries(rows, { ...actor, name: '授权测试员' }, aliases);
    state.inventory = saved.data;
    return saved;
  };
  const request = await listen(t, state);
  assert.equal((await request('primary-import', {}, undefined, 'employee', 'employee')).status, 403);
  assert.equal((await request('primary-import', {}, 'https://untrusted.example.test')).status, 403);
  const imported = await request('primary-import', {});
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.importedAliases, 2);
  assert.deepEqual(
    imported.body.inventory.data.mailboxes.map(({ remoteAliasId }) => remoteAliasId).sort(),
    ['va-first', 'va-other']
  );
  assert.equal((await request('status')).body.aliasIds.length, 2);
  assert(!JSON.stringify(imported.body).includes('BUY-FIRST'));
  const prior = imported.body.inventory.data.appleRelay.parents.find(({ id }) => id === 'prior-local');
  assert.equal(prior.remotePrimaryId, 'vp-one');
  assert.equal(prior.version, 2);
  assert.equal(prior.queryExpiry, future);
  assert(!JSON.stringify(imported.body).includes('MSTR-ONE'));
  assert.deepEqual((await request('primary-import', {})).body, { imported: 0, importedAliases: 0 });
  assert.equal(state.upstream.calls.some(({ query }) => query.includes('mutation')), false);
  assert.equal((await request('test', { parentId: prior.id })).body.success, true);

  const fields = { email: 'new@example.test', note: '新增测试', days: 31 };
  assert.equal((await request('primary-save', fields)).status, 400);
  const created = await request('primary-save', { ...fields, appPassword: 'fixture-apple-app-password' });
  assert.equal(created.status, 200);
  assert(!JSON.stringify(created.body).includes('fixture-apple-app-password'));
  assert(!JSON.stringify(store.audit()).includes('fixture-apple-app-password'));
  assert(store.audit().some((row) => row.targetId === created.body.parentId));
  assert.equal((await request('primary-save', { ...fields, appPassword: 'fixture-apple-app-password' })).status, 409);
  assert.equal(state.upstream.calls.filter(({ query }) => query.includes('createIcloudPrimaryAccount')).length, 1);

  const update = { ...fields, id: created.body.parentId, version: 1, note: '只修改备注', status: 'ACTIVE' };
  assert.equal((await request('primary-save', update)).status, 200);
  assert.equal((await request('primary-save', update)).status, 409);
  assert.equal(state.upstream.calls.filter(({ query }) => query.includes('updateIcloudPrimaryAccount')).length, 1);
  assert((await request('status')).body.parentIds.includes(created.body.parentId));

  const stale = store.load('inventory');
  stale.data.appleRelay.parents[0].remotePrimaryId = 'forged-provider-id';
  assert.throws(() => store.saveBatch([{ domain: 'inventory', ...stale }]), { status: 409 });

  localConflict = true;
  const retry = { ...fields, email: 'retry@example.test', appPassword: 'fixture-apple-app-password' };
  const uncertain = await request('primary-save', retry);
  assert.equal(uncertain.status, 409);
  assert.match(uncertain.body.message, /导入已有主邮箱/);
  localConflict = false;
  assert.equal((await request('primary-save', retry)).status, 409);
  assert.equal((await request('primary-import', {})).body.imported, 1);
  assert.equal(state.upstream.calls.filter(({ query }) => query.includes('createIcloudPrimaryAccount')).length, 2);
});

test('registers only submitted Apple aliases, reconciles an interrupted batch and never stores upstream codes', async (t) => {
  const state = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  state.inventory = {
    ...Object.fromEntries(['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords',
      'registrationRecords', 'tableSettings', 'undo'].map((key) => [key, []])),
    appleRelay: { parents: state.inventory.appleRelay.parents, imports: [], events: [] }
  };
  store.saveBatch([{ domain: 'inventory', version: 0, data: state.inventory }]);
  state.savePrimaries = (rows, actor, aliases, registration) => {
    const saved = store.saveAppleRelayPrimaries(rows, { ...actor, name: '登记测试员' }, aliases, registration);
    state.inventory = saved.data;
    return saved;
  };
  const request = await listen(t, state);
  const fields = { parentId: 'one', parentVersion: 1, days: 31, batch: false };
  const rows = [{ email: 'new-alias@example.test', note: '登记测试' }];
  assert.equal((await request('alias-register', { ...fields, rows }, undefined, 'employee', 'employee')).status, 403);
  assert.equal((await request('alias-register', { ...fields, parentVersion: 2, rows })).status, 409);
  assert.equal((await request('alias-register', {
    ...fields, rows: [{ email: 'other@example.test', note: '' }]
  })).status, 409);
  assert.equal(state.upstream.calls.some(({ query }) => query.includes('mutation')), false);

  const registered = await request('alias-register', { ...fields, rows });
  assert.equal(registered.status, 200);
  const [saved] = registered.body.inventory.data.mailboxes;
  assert.equal(saved.email, rows[0].email);
  assert.equal(saved.createdBy, '登记测试员');
  assert.equal(saved.inventoryHistory[0].action, '登记隐藏邮箱');
  assert((await request('status')).body.aliasIds.includes(saved.id));
  const eligibility = await request('extraction-eligibility', { aliasIds: [saved.id] });
  assert.equal(eligibility.status, 200);
  assert.deepEqual(eligibility.body, { items: [{ id: saved.id, eligible: true, reason: null }] });
  assert(!JSON.stringify(registered.body).includes('BUY-REGISTERED'));
  assert(!JSON.stringify(store.audit()).includes('BUY-REGISTERED'));
  assert(store.audit().some((row) => row.targetId === saved.id && row.action === 'inventory_relay_alias_save'));
  assert.equal((await request('alias-register', { ...fields, rows })).status, 409);
  assert.equal(state.upstream.calls.filter(({ query }) => query.includes('createIcloudVirtualEmail')).length, 1);

  const batch = { ...fields, batch: true, rows: [
    { email: 'unbound@example.test', note: '已登记到同一主邮箱' },
    { email: 'batch-first@example.test', note: '备注,可包含逗号' },
    { email: 'batch-last@example.test', note: '' }
  ] };
  state.upstream.interruptAliasBatch = true;
  const interrupted = await request('alias-register', batch);
  assert.equal(interrupted.status, 502);
  assert.match(interrupted.body.message, /第 3 条/);
  assert.equal(state.inventory.mailboxes.length, 1);
  assert.deepEqual(state.inventory.appleRelay.imports, []);
  const recovered = await request('alias-register', batch);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.registered, 3);
  assert.equal(state.inventory.mailboxes.length, 4);
  const [entry] = state.inventory.appleRelay.imports;
  assert.equal(entry.total, 3);
  assert.equal(entry.actorId, 'relay-tester');
  assert.equal(entry.results[1].note, batch.rows[1].note);
  const mutations = state.upstream.calls.filter(({ query }) => query.includes('batchCreateIcloudVirtualEmails'));
  assert.deepEqual(mutations.map(({ variables }) => variables.input.rawInput), [
    'batch-first@example.test,备注,可包含逗号\nbatch-last@example.test', 'batch-last@example.test'
  ]);
  assert.equal(state.upstream.aliases.filter(({ aliasEmail }) => aliasEmail === 'batch-first@example.test').length, 1);
});

test('binds a previously recorded alias without replacing its identity, usage, provenance or history', async (t) => {
  const state = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const original = {
    id: 'previous-local', aliasId: 'previous-local', type: 'relay',
    email: 'unbound@example.test', parentMailboxId: 'one', relayStatus: 'ACTIVE',
    notes: '原录入备注', codeResetIntervalDays: 30, version: 4,
    inventoryState: 'available', used: false, usageLinks: [],
    source: 'Apple 主邮箱登记', importId: 'previous-import',
    createdAt: '2026-11-01T01:02:00Z', importedAt: '2026-11-02T01:02:00Z',
    createdById: 'original-operator', createdBy: '原录入人',
    inventoryHistory: [{ id: 'original-event', action: '登记隐藏邮箱', time: '2026-11-03 10:00', actor: '原录入人' }]
  };
  state.inventory = {
    ...Object.fromEntries(['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords',
      'registrationRecords', 'tableSettings', 'undo'].map((key) => [key, []])),
    mailboxes: [original],
    appleRelay: { parents: state.inventory.appleRelay.parents, imports: [], events: [] }
  };
  store.saveBatch([{ domain: 'inventory', version: 0, data: state.inventory }]);
  state.savePrimaries = (rows, actor, aliases, registration) => {
    const result = store.saveAppleRelayPrimaries(rows, { ...actor, name: '补接测试员' }, aliases, registration);
    state.inventory = result.data;
    return result;
  };
  const request = await listen(t, state);
  const input = {
    existingId: original.id, existingVersion: 4, parentId: 'one', parentVersion: 1,
    days: 30, batch: false, rows: [{ email: original.email, note: original.notes }]
  };
  assert.equal((await request('alias-register', { ...input, existingVersion: 3 })).status, 409);
  assert.equal((await request('alias-register', { ...input, parentId: 'two' })).status, 409);
  assert.equal((await request('alias-register', { ...input, batch: true })).status, 400);
  const result = await request('alias-register', input);
  assert.equal(result.status, 200);
  const [saved] = result.body.inventory.data.mailboxes;
  for (const field of ['id', 'aliasId', 'email', 'parentMailboxId', 'notes', 'inventoryState', 'used',
    'usageLinks', 'source', 'importId', 'createdAt', 'importedAt', 'createdById', 'createdBy'])
    assert.deepEqual(saved[field], original[field], field);
  assert.equal(saved.remoteAliasId, 'va-unbound');
  assert.equal(saved.version, 5);
  assert.equal(saved.lastOperatedBy, '补接测试员');
  assert.deepEqual(saved.inventoryHistory.slice(0, -1), original.inventoryHistory);
  assert.equal(saved.inventoryHistory.at(-1).action, '接入收件服务');
  assert.equal(state.upstream.calls.some(({ query }) => query.includes('mutation')), false);
  assert(!JSON.stringify(result.body).includes('BUY-UNBOUND'));
  assert((await request('status')).body.aliasIds.includes(saved.id));
  assert.equal((await request('alias-register', input)).status, 409);
  assert.equal(store.load('inventory').data.mailboxes.length, 1);
});

function fakeVendure() {
  const primaries = [
    primary('vp-one', 'one@example.test', 'MSTR-ONE'),
    primary('vp-two', 'two@example.test', 'MSTR-TWO')
  ];
  const aliases = [
    alias('va-first', 'vp-one', 'first@example.test', 'BUY-FIRST'),
    alias('va-sibling', 'vp-one', 'sibling@example.test', 'BUY-SIBLING'),
    alias('va-other', 'vp-two', 'other@example.test', 'BUY-OTHER'),
    alias('va-unbound', 'vp-one', 'unbound@example.test', 'BUY-UNBOUND'),
    alias('va-expired', 'vp-one', 'expired@example.test', 'BUY-EXPIRED', '2025-01-01T00:00:00Z')
  ];
  const mailRows = [
    mail('first-mail', 'vp-one', 'va-first'),
    mail('duplicate', 'vp-one', 'va-first', { messageId: 'first-mail' }),
    mail('sibling-mail', 'vp-one', 'va-sibling'),
    mail('other-mail', 'vp-two', 'va-other'),
    mail('unbound-mail', 'vp-one', 'va-unbound'),
    mail('pending-mail', 'vp-one', null, { subject: '示例无验证码' })
  ];
  const calls = [];
  const state = { primaries, aliases, mailRows, calls, key: 'isolated-fixture-key', sync: null };
  state.fetch = async (url, input) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(input.redirect, 'error');
    assert.equal(input.headers['vendure-api-key'], state.key);
    const { query, variables } = JSON.parse(input.body);
    calls.push({ query, variables, path: new URL(url).pathname });
    if (query.includes('icloudPrimaryAccounts')) {
      return Response.json({ data: { icloudPrimaryAccounts: primaries } });
    }
    if (query.includes('icloudVirtualEmails')) {
      return Response.json({ data: { icloudVirtualEmails: aliases } });
    }
    const register = ({ primaryAccountId, aliasEmail, note, codeResetIntervalDays }) => {
      const row = {
        ...alias(`va-registered-${aliases.length}`, primaryAccountId, aliasEmail, `BUY-REGISTERED-${aliases.length}`),
        note, codeResetIntervalDays
      };
      aliases.push(row);
      return row;
    };
    if (query.includes('createIcloudVirtualEmail')) {
      const { id } = register(variables.input);
      return Response.json({ data: { result: { id } } });
    }
    if (query.includes('batchCreateIcloudVirtualEmails')) {
      const lines = variables.input.rawInput.split('\n');
      const accepted = state.interruptAliasBatch ? lines.slice(0, 1) : lines;
      for (const line of accepted) {
        const [aliasEmail, ...note] = line.split(',');
        register({ ...variables.input, aliasEmail, note: note.join(',') });
      }
      if (state.interruptAliasBatch) {
        state.interruptAliasBatch = false;
        return Response.json({ errors: [{ message: 'fixture response interrupted' }] });
      }
      return Response.json({ data: { result: { createdCount: accepted.length, skippedCount: 0 } } });
    }
    if (query.includes('createIcloudPrimaryAccount')) {
      const { email, note, codeResetIntervalDays, appPassword } = variables.input;
      assert.equal(appPassword, 'fixture-apple-app-password');
      const row = { ...primary(`vp-created-${primaries.length}`, email, 'MSTR-NEW'), note, codeResetIntervalDays };
      primaries.push(row);
      return Response.json({ data: { result: row } });
    }
    if (query.includes('updateIcloudPrimaryAccount')) {
      const { id, note, status, codeResetIntervalDays } = variables.input;
      const row = primaries.find((entry) => entry.id === id);
      assert(row);
      assert.equal(Object.hasOwn(variables.input, 'appPassword'), false);
      Object.assign(row, { note, ...(status && { status }), codeResetIntervalDays });
      return Response.json({ data: { result: row } });
    }
    if (query.includes('testIcloudConnection')) {
      return Response.json({ data: { result: { success: true, message: 'upstream secret' } } });
    }
    if (query.includes('resetIcloudVirtualEmailCode')) {
      const target = aliases.find((row) => row.id === variables.id);
      if (!target) return Response.json({ errors: [{ message: 'fixture missing alias' }] });
      target.buyerQueryCode = 'BUY-NEW-FIXTURE';
      target.codeResetIntervalDays = variables.codeResetIntervalDays;
      target.codeExpiresAt = future;
      return Response.json({ data: { result: target } });
    }
    if (query.includes('syncIcloudAccount')) {
      const result = state.sync
        ? await state.sync(variables.id)
        : { success: true, syncedCount: 4 };
      return Response.json({ data: { result } });
    }
    if (query.includes('reconcileIcloudMailHistory')) {
      assert.equal(variables.dryRun, true);
      const result = state.historyPreview
        ? await state.historyPreview(variables.primaryAccountId)
        : historyCounts;
      return Response.json({ data: { result } });
    }
    if (query.includes('icloudReceivedMails')) {
      // The bridge filters a deliberately overbroad upstream result a second time.
      return Response.json({ data: { icloudReceivedMails: mailRows } });
    }
    if (query.includes('reassignIcloudMail')) {
      const target = mailRows.find((row) => row.id === variables.mailId);
      target.virtualEmailId = variables.virtualEmailId;
      if (state.failReassignResponse) {
        return Response.json({ errors: [{ message: 'upstream private details' }] });
      }
      return Response.json({ data: { result: target } });
    }
    if (query.includes('icloudQueryMails')) {
      const buyer = aliases.find((row) => row.buyerQueryCode === variables.queryCode);
      const owner = primaries.find((row) => row.masterQueryCode === variables.queryCode);
      const matched = buyer || owner;
      const [address, domain] = (buyer?.aliasEmail ?? owner?.email ?? '@').split('@');
      const masked = `${address.slice(0, 3)}***@${domain}`;
      return Response.json({
        data: {
          icloudQueryMails: {
            success: Boolean(matched),
            targetType: buyer ? 'VIRTUAL' : 'PRIMARY',
            aliasEmail: buyer ? masked : null,
            primaryEmail: owner ? masked : null,
            codeExpiresAt: matched?.codeExpiresAt
          }
        }
      });
    }
    assert.fail('Unexpected Vendure operation');
  };
  return state;
}

function fixture() {
  const upstream = fakeVendure();
  return {
    upstream,
    inventory: {
      appleRelay: {
        parents: [
          { id: 'one', email: 'one@example.test', status: 'ACTIVE' },
          { id: 'two', email: 'two@example.test', status: 'ACTIVE' }
        ]
      },
      mailboxes: [
        { id: 'first', email: 'first@example.test', parentMailboxId: 'one', type: 'relay' },
        { id: 'sibling', email: 'sibling@example.test', parentMailboxId: 'one', type: 'relay' },
        { id: 'other', email: 'other@example.test', parentMailboxId: 'two', type: 'relay' },
        { id: 'expired', email: 'expired@example.test', parentMailboxId: 'one', type: 'relay' }
      ]
    },
    config: {
      adminUrl: 'http://127.0.0.1:9017/admin-api',
      shopUrl: 'http://127.0.0.1:9017/shop-api',
      apiKey: upstream.key,
      primaryBindings: { one: 'vp-one', two: 'vp-two' },
      aliasBindings: {
        first: 'va-first',
        sibling: 'va-sibling',
        other: 'va-other',
        expired: 'va-expired'
      }
    },
    events: []
  };
}

test('历史入库在版本冲突后复用已绑定的收件地址，并原子保存库存和订单', async (t) => {
  const state = fixture();
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  state.inventory = {
    ...Object.fromEntries(['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords',
      'registrationRecords', 'tableSettings', 'undo'].map((key) => [key, []])),
    appleRelay: { parents: state.inventory.appleRelay.parents, imports: [], events: [] }
  };
  store.saveBatch([
    { domain: 'inventory', version: 0, data: state.inventory },
    { domain: 'commerce', version: 0, data: {
      customers: [{ id: 'history-customer', name: '合成客户', wechat: 'history-wechat', active: true }],
      tenants: [], orders: [], operating: [], rentBatches: [], logs: []
    } }
  ]);
  state.planIntake = input => store.planAppleRelayIntake(input);
  let conflict = true;
  state.savePrimaries = (rows, actor, aliases, registration) => {
    if (conflict) {
      conflict = false;
      const current = store.load('commerce');
      current.data.customers[0].notes = '其它窗口已更新';
      store.saveBatch([{ domain: 'commerce', ...current }]);
    }
    const result = store.saveAppleRelayPrimaries(rows, { ...actor, name: '历史测试员' }, aliases, registration);
    state.inventory = result.inventory.data;
    return result;
  };
  const request = await listen(t, state);
  const payload = { parentId: 'one', parentVersion: 1, days: 30, rows: [
    { email: 'history-sold@example.test', registered: '2025/1/5', wechat: 'history-wechat', plan: 'Plus',
      start: '2025/2/1 10:30', expiry: '2025/3/1 10:30', payment: '银行卡', note: '合成来源' },
    { email: 'history-registered@example.test', registered: '2025/1/6' }
  ] };
  const withVersions = async () => {
    const preview = await request('alias-intake-preview', payload);
    assert.equal(preview.status, 200);
    const { inventoryVersion, commerceVersion } = preview.body;
    return { ...payload, inventoryVersion, commerceVersion };
  };
  assert.equal((await request('alias-intake-preview', payload, undefined, 'employee', 'employee')).status, 403);
  assert.equal((await request('alias-intake-confirm', await withVersions())).status, 409);
  assert.deepEqual(store.load('inventory').data.mailboxes, []);
  assert.deepEqual(store.load('commerce').data.orders, []);
  const saved = await request('alias-intake-confirm', await withVersions());
  assert.equal(saved.status, 200, saved.body.message);
  assert.equal(saved.body.ordersCreated, 1);
  assert.equal(saved.body.accountsCreated, 2);
  const inventory = store.load('inventory').data;
  const [order] = store.load('commerce').data.orders;
  assert(inventory.mailboxes.every(row => row.parentMailboxId === 'one' && row.inventoryState === 'used'));
  assert.equal(inventory.accounts.find(row => row.id === order.accountId).inventoryState, 'used');
  assert.equal(order.customerId, 'history-customer');
  assert.equal(order.start, '2025-02-01T10:30');
  assert.equal(order.paidConfirmed, false);
  assert.equal(store.load('commerce').data.customers[0].notes, '其它窗口已更新');
  assert.equal(state.upstream.calls.filter(({ query }) => query.includes('batchCreateIcloudVirtualEmails')).length, 1);
  assert.deepEqual((await request('alias-intake-confirm', await withVersions())).body, { reused: 2 });
});

async function listen(t, state) {
  const service = createAppleRelayService({
    config: state.config,
    readInventory: () => state.inventory,
    savePrimaries: state.savePrimaries,
    planIntake: state.planIntake,
    fetchImpl: state.upstream?.fetch,
    recordAction: (entry) => {
      state.events.push(entry);
      return state.recordAction?.(entry);
    }
  });
  const server = createServer((request, response) => {
    if (request.url === '/api/local/apple-relay/public-query') {
      return service.handlePublicQuery(request, response);
    }
    return service.handle(request, response, request.url, {
      id: request.headers['x-fixture-actor'] ?? 'relay-tester',
      role: request.headers['x-fixture-role'] ?? 'admin'
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async function request(
    action,
    input,
    explicitOrigin = origin,
    actorId = 'relay-tester',
    role = 'admin'
  ) {
    const response = await fetch(
      `${origin}/api/local/apple-relay/${action}`,
      input === undefined
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify(input),
            headers: {
              origin: explicitOrigin,
              'content-type': 'application/json',
              'x-fixture-actor': actorId,
              'x-fixture-role': role
            }
          }
    );
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  };
}

const historyCalls = (state) =>
  state.upstream.calls.filter(({ query }) => query.includes('reconcileIcloudMailHistory'));

function extractionFixture() {
  const state = fixture();
  for (const mailbox of state.inventory.mailboxes) {
    Object.assign(mailbox, { relayStatus: 'ACTIVE', inventoryState: 'available' });
  }
  return state;
}

function makeRelayClaims(state, ids) {
  const batch = { id: 'batch-one', kind: 'mail', actorId: 'other-admin', items: [] };
  for (const id of ids) {
    const row = state.inventory.mailboxes.find((mailbox) => mailbox.id === id);
    const claimId = `claim-${id}`;
    Object.assign(row, { inventoryState: 'claimed', used: true, claimId, claimBatchId: batch.id });
    batch.items.push({
      id: claimId,
      type: 'relay',
      assetId: id,
      email: row.email,
      status: 'pending'
    });
  }
  state.inventory.batches = [batch];
  return batch.items;
}

test('extraction eligibility returns only requested inventory IDs and reasons from read-only Vendure metadata', async (t) => {
  const state = extractionFixture();
  state.upstream.aliases[1].codeExpiresAt = null;
  const request = await listen(t, state);
  const result = await request('extraction-eligibility', {
    aliasIds: ['first', 'expired', 'sibling', 'unknown']
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    items: [
      { id: 'first', eligible: true, reason: null },
      { id: 'expired', eligible: false, reason: '买家查询码已过期或有效期无效' },
      { id: 'sibling', eligible: true, reason: null },
      { id: 'unknown', eligible: false, reason: '找不到该隐藏邮箱库存' }
    ]
  });
  assert.equal(state.upstream.calls.length, 2);
  assert.ok(
    state.upstream.calls.every(
      ({ query, path }) => query.startsWith('query ') && path === '/admin-api'
    )
  );
  assert.deepEqual(state.events, []);
  assert.doesNotMatch(JSON.stringify(result.body), /BUY-|MSTR-|@example|isolated-fixture/);
});

test('extraction eligibility rejects invalid bindings, status and duplicate query codes', async (t) => {
  const state = extractionFixture();
  delete state.config.aliasBindings.sibling;
  const request = await listen(t, state);
  const check = async (id) => {
    const result = await request('extraction-eligibility', { aliasIds: [id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.items[0].eligible, false);
    return result.body.items[0].reason;
  };
  assert.match(await check('sibling'), /绑定/);
  const [parent] = state.upstream.primaries;
  parent.status = 'AUTH_ERROR';
  assert.match(await check('first'), /Vendure 主邮箱/);
  parent.status = 'ACTIVE';
  const [alias] = state.upstream.aliases;
  alias.primaryAccountId = 'vp-two';
  assert.match(await check('first'), /所属主邮箱/);
  alias.primaryAccountId = 'vp-one';
  alias.status = 'DISABLED';
  assert.match(await check('first'), /Vendure 隐藏邮箱/);
  alias.status = 'ACTIVE';
  alias.buyerQueryCode = '';
  assert.match(await check('first'), /未设置/);
  alias.buyerQueryCode = ' mstr-one ';
  assert.match(await check('first'), /重复/);
  alias.buyerQueryCode = 'BUY-FIRST';
  alias.codeExpiresAt = 'not-a-date';
  assert.match(await check('first'), /有效期无效/);
  alias.codeExpiresAt = future;
  state.upstream.aliases.push({ ...alias, buyerQueryCode: 'OTHER' });
  assert.match(await check('first'), /绑定/);
});

test('extraction eligibility reads current inventory after provider lookup and blocks open or completed usage', async (t) => {
  const state = extractionFixture();
  const { fetch } = state.upstream;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  state.upstream.fetch = async (url, options) => {
    if (JSON.parse(options.body).query.includes('icloudVirtualEmails')) {
      started.resolve();
      await release.promise;
    }
    return fetch(url, options);
  };
  const request = await listen(t, state);
  const pending = request('extraction-eligibility', {
    aliasIds: ['first', 'sibling', 'other']
  });
  try {
    await started.promise;
    state.inventory.batches = [{ items: [{ assetId: 'first', status: 'pending' }] }];
    state.inventory.registrationRecords = [
      { assetId: 'sibling', state: '待核对' },
      { assetId: 'other', state: '成功' }
    ];
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 200);
  for (const item of result.body.items) {
    assert.equal(item.eligible, false);
    assert.match(item.reason, /领用、实际使用或注册待核对/);
  }
  state.inventory.batches[0].items[0].status = 'returned';
  state.inventory.registrationRecords[0].state = '失败且未使用';
  const recheck = await request('extraction-eligibility', {
    aliasIds: ['first', 'sibling', 'other']
  });
  assert.deepEqual(
    recheck.body.items.map((item) => item.eligible),
    [true, true, false]
  );
});

test('extraction eligibility requires same-origin administrator access, exact ID payloads and a Shop endpoint', async (t) => {
  const state = extractionFixture();
  delete state.config.shopUrl;
  const request = await listen(t, state);
  const input = { aliasIds: ['first'] };
  assert.equal((await request('extraction-eligibility')).status, 405);
  assert.equal((await request('extraction-eligibility', input, undefined, '')).status, 401);
  assert.equal(
    (await request('extraction-eligibility', input, undefined, 'worker', 'employee')).status,
    403
  );
  assert.equal(
    (await request('extraction-eligibility', input, 'https://unsafe.example.test')).status,
    403
  );
  for (const invalid of [
    { ...input, queryCode: 'secret' },
    { aliasIds: ['first', 'first'] },
    { aliasIds: ['../first'] },
    { aliasIds: [] },
    { aliasIds: Array.from({ length: 101 }, (_, index) => `test-${index}`) }
  ]) {
    assert.equal((await request('extraction-eligibility', invalid)).status, 400);
  }
  assert.equal((await request('extraction-eligibility', input)).status, 503);
  assert.equal(state.upstream.calls.length, 0);
});

test('extraction codes read one catalog, return only the requested pending claims and audit without credentials', async (t) => {
  const state = extractionFixture();
  makeRelayClaims(state, ['first', 'sibling']);
  state.inventory.mailboxes[0].queryCode = 'old-local-fixture-value';
  const original = structuredClone(state.inventory);
  const request = await listen(t, state);
  const result = await request('extraction-codes', { claimIds: ['claim-sibling', 'claim-first'] });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body, {
    items: [
      { id: 'claim-sibling', email: 'sibling@example.test', queryCode: 'BUY-SIBLING' },
      { id: 'claim-first', email: 'first@example.test', queryCode: 'BUY-FIRST' }
    ]
  });
  assert.equal(state.upstream.calls.length, 2);
  assert.ok(
    state.upstream.calls.every(
      ({ query, path }) => query.startsWith('query ') && path === '/admin-api'
    )
  );
  assert.deepEqual(state.inventory, original);
  assert.deepEqual(
    state.events.map(({ action, actor, parentId, aliasId }) => [
      action,
      actor.id,
      parentId,
      aliasId
    ]),
    [
      ['read_code', 'relay-tester', 'one', 'sibling'],
      ['read_code', 'relay-tester', 'one', 'first']
    ]
  );
  assert.doesNotMatch(JSON.stringify(state.events), /BUY-|old-local-fixture-value|@example/);
});

test('extraction codes reject the entire copy for a returned, mismatched or expired claim', async (t) => {
  const state = extractionFixture();
  const [, sibling] = makeRelayClaims(state, ['first', 'sibling']);
  const request = await listen(t, state);
  const copy = () => request('extraction-codes', { claimIds: ['claim-first', 'claim-sibling'] });
  sibling.status = 'returned';
  let result = await copy();
  assert.equal(result.status, 409);
  assert.match(result.body.error, /领用已结束/);
  assert.equal(result.body.items, undefined);
  sibling.status = 'pending';
  state.inventory.mailboxes[1].claimBatchId = 'another-batch';
  result = await copy();
  assert.equal(result.status, 409);
  assert.equal(result.body.items, undefined);
  state.inventory.mailboxes[1].claimBatchId = 'batch-one';
  state.upstream.aliases[1].codeExpiresAt = '2025-01-01T00:00:00Z';
  result = await copy();
  assert.equal(result.status, 409);
  assert.match(result.body.error, /查询码已过期/);
  assert.equal(result.body.items, undefined);
  assert.deepEqual(state.events, []);
  assert.doesNotMatch(JSON.stringify(result.body), /BUY-/);
});

test('extraction codes recheck a claim after asynchronous audit and enforce role, payload and list limits', async (t) => {
  const state = extractionFixture();
  const [claim] = makeRelayClaims(state, ['first']);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  state.recordAction = async () => {
    started.resolve();
    await release.promise;
  };
  const request = await listen(t, state);
  const input = { claimIds: ['claim-first'] };
  assert.equal(
    (await request('extraction-codes', input, undefined, 'worker', 'employee')).status,
    403
  );
  assert.equal((await request('extraction-codes', { ...input, aliasIds: ['first'] })).status, 400);
  assert.equal(
    (await request('extraction-codes', { claimIds: ['claim-first', 'claim-first'] })).status,
    400
  );
  assert.equal(state.upstream.calls.length, 0);
  const longIds = Array.from({ length: 100 }, (_, index) => `${index}-`.padEnd(180, 'a'));
  assert.equal((await request('extraction-codes', { claimIds: longIds })).status, 409);
  assert.equal(
    (await request('extraction-codes', { claimIds: [...longIds, 'excess'] })).status,
    400
  );
  const pending = request('extraction-codes', input);
  try {
    await started.promise;
    claim.status = 'returned';
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.items, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /BUY-/);
});

test('history preview always sends dryRun, returns only fixed counts and records its administrator', async (t) => {
  const state = fixture();
  state.upstream.historyPreview = () => ({
    ...historyCounts,
    mail: 'upstream mail contents should stay private',
    token: 'upstream secret'
  });
  const request = await listen(t, state);
  const result = await request('history-preview', { parentId: 'one' }, undefined, 'owner', 'super');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, historyCounts);
  const calls = historyCalls(state);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/admin-api');
  assert.deepEqual(calls[0].variables, { primaryAccountId: 'vp-one', dryRun: true });
  assert.deepEqual(state.events, [
    {
      action: 'history_preview',
      actor: { id: 'owner', role: 'super' },
      parentId: 'one',
      aliasId: ''
    }
  ]);
});

test('history preview rejects guests, employees, other origins, extra parameters and invalid bindings', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const input = { parentId: 'one' };
  assert.equal((await request('history-preview')).status, 405);
  assert.equal((await request('history-preview', input, undefined, '')).status, 401);
  assert.equal(
    (await request('history-preview', input, undefined, 'worker', 'employee')).status,
    403
  );
  assert.equal(
    (await request('history-preview', input, 'https://unsafe.example.test')).status,
    403
  );
  assert.equal((await request('history-preview', { ...input, dryRun: false })).status, 400);
  assert.equal((await request('history-preview', { parentId: '../one' })).status, 400);
  assert.equal(state.upstream.calls.length, 0);
  assert.equal((await request('history-preview', { parentId: 'unknown' })).status, 409);
  state.upstream.primaries[0].status = 'AUTH_ERROR';
  assert.equal((await request('history-preview', input)).status, 409);
  state.upstream.primaries[0].status = 'ACTIVE';
  state.upstream.primaries[0].email = 'wrong@example.test';
  assert.equal((await request('history-preview', input)).status, 409);
  state.upstream.primaries[0].email = 'one@example.test';
  state.upstream.primaries.push({ ...state.upstream.primaries[0] });
  assert.equal((await request('history-preview', input)).status, 409);
  assert.equal(historyCalls(state).length, 0);
  assert.deepEqual(state.events, []);
});

test('history preview rejects invalid quantities and any upstream update result', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  for (const counts of [
    { ...historyCounts, updatedCount: 1 },
    { ...historyCounts, scannedCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...historyCounts, unmatchedCount: -1 },
    { ...historyCounts, ambiguousCount: '2' },
    { ...historyCounts, skippedCount: undefined },
    null
  ]) {
    state.upstream.historyPreview = () => counts;
    const result = await request('history-preview', { parentId: 'one' });
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /scannedCount|upstream secret/);
  }
  assert.deepEqual(state.events, []);
  assert.ok(historyCalls(state).every(({ variables }) => variables.dryRun === true));
});

test('history preview limits repeated scans and discards a result after the local version changes', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  state.upstream.historyPreview = async () => {
    started.resolve();
    await release.promise;
    return historyCounts;
  };
  const input = { parentId: 'one' };
  const pending = request('history-preview', input);
  try {
    await started.promise;
    assert.equal((await request('history-preview', input)).status, 429);
    state.inventory.appleRelay.parents[0].version = 2;
  } finally {
    release.resolve();
  }
  assert.equal((await pending).status, 409);
  assert.deepEqual(state.events, []);
  assert.equal((await request('history-preview', input)).status, 200);
  assert.equal(historyCalls(state).length, 2);
});

test('admin reset is bound to a reviewed alias and invalidates the previous public code', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const verify = (queryCode) => request('public-query', { queryCode });
  const prepare = (id = 'first') =>
    request('code-reset-prepare', {
      kind: 'alias',
      id,
      validityDays: 90
    });
  assert.equal((await verify('BUY-FIRST')).status, 200);
  assert.equal((await prepare('unknown')).status, 409);
  const result = await prepare();
  assert.equal(result.status, 200);
  assert.equal(result.body.email, 'first@example.test');
  assert.doesNotMatch(JSON.stringify(result.body), /BUY-FIRST/);
  assert.equal(
    state.upstream.calls.filter(({ query }) => query.includes('resetIcloudVirtualEmailCode'))
      .length,
    0
  );

  const confirm = (confirmation) => request('code-reset-confirm', { confirmation });
  const [a, b] = await Promise.all([
    confirm(result.body.confirmation),
    confirm(result.body.confirmation)
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 200 ? a : b).body.queryCode, 'BUY-NEW-FIXTURE');
  assert.equal((await verify('BUY-FIRST')).status, 404);
  assert.equal((await verify('BUY-NEW-FIXTURE')).status, 200);
  assert.equal((await verify('BUY-SIBLING')).status, 200);
  assert.equal(
    state.upstream.calls.filter(({ query }) => query.includes('resetIcloudVirtualEmailCode'))
      .length,
    1
  );
  assert.ok(state.events.some(({ action }) => action === 'reset_code'));
  assert.doesNotMatch(JSON.stringify(state.events), /BUY-NEW-FIXTURE|BUY-FIRST/);
});

test('admin reset stops before contacting the mutation if the reviewed binding changes', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const result = await request('code-reset-prepare', {
    kind: 'alias',
    id: 'first',
    validityDays: 30
  });
  assert.equal(result.status, 200);
  state.upstream.aliases.find((row) => row.id === 'va-first').buyerQueryCode = 'CHANGED-ELSEWHERE';
  const rejected = await request('code-reset-confirm', { confirmation: result.body.confirmation });
  assert.equal(rejected.status, 409);
  assert.equal(
    state.upstream.calls.filter(({ query }) => query.includes('resetIcloudVirtualEmailCode'))
      .length,
    0
  );
});

const reassignmentCalls = ({ upstream }) =>
  upstream.calls.filter(({ query }) => query.includes('reassignIcloudMail'));

test('mail reassignment uses a private, one-use review and writes only one scoped change', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const input = { parentId: 'one', mailId: 'pending-mail', aliasId: 'first', sourceAliasId: '' };
  const { body, status } = await request('mail-reassign-prepare', input);
  const { confirmation, validUntil, ...display } = body;
  assert.equal(status, 200);
  assert.equal(typeof confirmation, 'string');
  assert.ok(validUntil > Date.now());
  assert.deepEqual(display, {
    parentEmail: 'one@example.test',
    aliasEmail: 'first@example.test',
    sourceAliasEmail: '',
    subject: '示例无验证码',
    receivedAt: '2026-11-05 18:15'
  });
  const second = await request(
    'mail-reassign-prepare',
    { ...input, aliasId: 'sibling' },
    undefined,
    'other-admin'
  );
  assert.equal(second.status, 200);
  assert.equal(
    (await request('mail-reassign-confirm', { confirmation }, undefined, 'other-admin')).status,
    409
  );
  assert.equal(
    (await request('mail-reassign-confirm', { confirmation, mailId: 'pending-mail' })).status,
    400
  );
  assert.equal(reassignmentCalls(state).length, 0);
  const outcomes = await Promise.all([
    request('mail-reassign-confirm', { confirmation }),
    request('mail-reassign-confirm', { confirmation })
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 409]);
  assert.deepEqual(outcomes.find(({ status }) => status === 200).body, {
    ok: true,
    parentId: 'one',
    mailId: 'pending-mail',
    aliasId: 'first'
  });
  assert.equal(
    (
      await request(
        'mail-reassign-confirm',
        { confirmation: second.body.confirmation },
        undefined,
        'other-admin'
      )
    ).status,
    409
  );
  const writes = reassignmentCalls(state);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].variables, { mailId: 'pending-mail', virtualEmailId: 'va-first' });
  const lookups = state.upstream.calls.filter(({ query }) =>
    query.includes('IdBusinessMailAssignmentCandidates')
  );
  assert.ok(lookups.length >= 3);
  assert.ok(
    lookups.every(
      ({ query, variables }) =>
        !/bodyText|extractedCode/.test(query) &&
        variables.primaryAccountId === 'vp-one' &&
        variables.limit === 200
    )
  );
  assert.deepEqual(state.events, [
    {
      action: 'mail_reassign',
      actor: { id: 'relay-tester', role: 'admin' },
      parentId: 'one',
      aliasId: 'first'
    }
  ]);
  const listed = await request('mails', { parentId: 'one', aliasId: 'first', refresh: false });
  assert.ok(
    listed.body.items.some(({ id, aliasId }) => id === 'pending-mail' && aliasId === 'first')
  );
});

test('mail reassignment rejects cross-parent, unmapped and stale source records', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const input = { parentId: 'one', mailId: 'first-mail', aliasId: 'sibling' };
  for (const override of [
    { aliasId: 'other' },
    { mailId: 'other-mail' },
    { mailId: 'unbound-mail' },
    { aliasId: 'first' },
    { sourceAliasId: '' }
  ]) {
    assert.equal((await request('mail-reassign-prepare', { ...input, ...override })).status, 409);
  }
  const prepared = await request('mail-reassign-prepare', input);
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.sourceAliasEmail, 'first@example.test');
  state.upstream.mailRows.find(({ id }) => id === 'first-mail').virtualEmailId = null;
  assert.equal(
    (await request('mail-reassign-confirm', { confirmation: prepared.body.confirmation })).status,
    409
  );

  const reviewed = await request('mail-reassign-prepare', input);
  assert.equal(reviewed.status, 200);
  state.inventory.mailboxes.find(({ id }) => id === 'sibling').version = 2;
  assert.equal(
    (await request('mail-reassign-confirm', { confirmation: reviewed.body.confirmation })).status,
    409
  );
  assert.equal(reassignmentCalls(state).length, 0);
  assert.deepEqual(state.events, []);
});

test('an uncertain reassignment response requires fresh review and does not replay the write', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const input = { parentId: 'one', mailId: 'pending-mail', aliasId: 'first' };
  const prepared = await request('mail-reassign-prepare', input);
  assert.equal(prepared.status, 200);
  state.upstream.failReassignResponse = true;
  const confirm = () =>
    request('mail-reassign-confirm', { confirmation: prepared.body.confirmation });
  const result = await confirm();
  assert.equal(result.status, 502);
  assert.match(result.body.message, /结果待核对/);
  assert.doesNotMatch(result.body.message, /upstream/);
  assert.equal((await confirm()).status, 409);
  assert.equal((await request('mail-reassign-prepare', input)).status, 409);
  assert.equal(reassignmentCalls(state).length, 1);
  assert.deepEqual(state.events, []);
});

test('unconfigured and wrong-origin requests do not contact a provider', async (t) => {
  const state = fixture();
  state.config = undefined;
  const request = await listen(t, state);
  const { body } = await request('status');
  assert.deepEqual(body, {
    configured: false,
    codeQueryConfigured: false,
    parentIds: [],
    aliasIds: []
  });
  assert.equal((await request('sync', { parentId: 'one' })).status, 503);
  assert.equal(
    (await request('sync', { parentId: 'one' }, 'http://other.example.test')).status,
    403
  );
  assert.equal((await request('sync')).status, 405);
  const unavailable = await request('public-query', { queryCode: 'BUY-FIRST' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.success, false);
  assert.deepEqual(state.upstream.calls, []);
});

test('the real Vendure operation names sync the verified parent and filter overbroad mail results', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const { body: status } = await request('status');
  assert.deepEqual(status.parentIds, ['one', 'two']);
  assert.deepEqual(status.aliasIds, ['first', 'sibling', 'other', 'expired']);
  assert.equal(status.numbers.parent.one, 'vp-one');
  assert.equal(status.numbers.alias.first, 'va-first');
  assert.equal(JSON.stringify(status).includes(state.upstream.key), false);
  const tested = await request('test', { parentId: 'one' });
  assert.deepEqual(tested.body, { success: true, message: '主邮箱连接正常' });

  const { body: result, status: responseStatus } = await request('mails', { aliasId: 'first' });
  assert.equal(responseStatus, 200, JSON.stringify(result));
  assert.deepEqual(
    result.items.map(({ id }) => id),
    ['first-mail']
  );
  assert.deepEqual(result.items[0], {
    id: 'first-mail',
    parentId: 'one',
    aliasId: 'first',
    from: 'verification@example.test',
    subject: '验证码：123456',
    code: '123456',
    body: '示例邮件正文',
    receivedAt: '2026-11-05 18:15',
    read: false
  });
  const relevant = state.upstream.calls.slice(-2);
  assert.match(relevant[0].query, /syncIcloudAccount/);
  assert.deepEqual(relevant[0].variables, { id: 'vp-one' });
  assert.match(relevant[1].query, /icloudReceivedMails/);
  assert.equal(relevant[1].variables.virtualEmailId, 'va-first');
  assert.equal(relevant[1].variables.primaryAccountId, 'vp-one');

  const unassigned = await request('mails', {
    parentId: 'one',
    unassignedOnly: true,
    refresh: false
  });
  assert.deepEqual(
    unassigned.body.items.map(({ id }) => id),
    ['pending-mail']
  );
  assert.equal((await request('mails', { parentId: 'two', aliasId: 'first' })).status, 400);
  assert.equal((await request('mails', { aliasId: 'first', unassignedOnly: true })).status, 400);
  assert.deepEqual(
    state.events.map(({ action, actor }) => [action, actor.id]),
    [
      ['test', 'relay-tester'],
      ['sync', 'relay-tester']
    ]
  );
});

test('buyer codes, primary codes and address queries preserve their own scope', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const query = (value) => request('query', { query: value });
  const buyer = await query('buy-first');
  assert.equal(buyer.status, 200, JSON.stringify(buyer.body));
  assert.equal(buyer.body.targetType, 'alias');
  assert.equal(buyer.body.expiresAt, future);
  assert.deepEqual(
    buyer.body.items.map(({ id }) => id),
    ['first-mail']
  );
  const publicOperation = state.upstream.calls.find(({ path }) => path === '/shop-api');
  assert.match(publicOperation.query, /icloudQueryMails/);
  assert.deepEqual(publicOperation.variables, { queryCode: 'BUY-FIRST' });

  const primaryResult = await query('MSTR-ONE');
  assert.equal(primaryResult.status, 200, JSON.stringify(primaryResult.body));
  assert.equal(primaryResult.body.targetType, 'parent');
  assert.deepEqual(
    primaryResult.body.items.map(({ id }) => id),
    ['first-mail', 'sibling-mail', 'pending-mail']
  );
  const email = await query('OTHER@example.test');
  assert.equal(email.status, 200);
  assert.deepEqual(
    email.body.items.map(({ id }) => id),
    ['other-mail']
  );

  for (const invalid of ['BUY-UNBOUND', 'BUY-EXPIRED', 'not-registered@example.test']) {
    const checkpoint = state.upstream.calls.length;
    assert.equal((await query(invalid)).status, 404);
    assert.equal(
      state.upstream.calls
        .slice(checkpoint)
        .some(({ query }) => /icloudQueryMails|syncIcloudAccount/.test(query)),
      false
    );
  }
  assert.equal(JSON.stringify(state.events).includes('BUY-FIRST'), false);
  assert.equal(JSON.stringify(state.events).includes('示例邮件正文'), false);
});

test('stale ownership, provider failure, and private configuration fail closed', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  state.upstream.aliases[0].primaryAccountId = 'vp-two';
  assert.equal((await request('mails', { aliasId: 'first' })).status, 409);
  state.upstream.aliases[0].primaryAccountId = 'vp-one';
  state.upstream.sync = () => ({ success: false, error: 'upstream secret' });
  const failed = await request('query', { query: 'first@example.test' });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /同步失败/);
  assert.equal(JSON.stringify(failed).includes('upstream secret'), false);
  state.upstream.sync = () => {
    state.inventory.mailboxes[0].relayStatus = 'DISABLED';
    return { success: true, syncedCount: 2 };
  };
  const stale = await request('query', { query: 'first@example.test' });
  assert.equal(stale.status, 409);
  assert.equal(Object.hasOwn(stale.body, 'items'), false);
  assert.throws(
    () =>
      createAppleRelayService({
        config: { ...state.config, adminUrl: 'https://mail.example.test/admin-api' },
        readInventory: () => state.inventory
      }),
    /回环地址/
  );

  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const scratch = await mkdtemp(resolve(runtime, 'relay-config-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = resolve(scratch, 'relay.json');
  assert.equal(await loadAppleRelayConfig(path), undefined);
  await writeFile(path, JSON.stringify(state.config), { mode: 0o600 });
  assert.deepEqual(await loadAppleRelayConfig(path), state.config);
  await chmod(path, 0o644);
  await assert.rejects(loadAppleRelayConfig(path), /私有文件/);
  const linked = resolve(scratch, 'linked.json');
  await symlink(path, linked);
  await assert.rejects(loadAppleRelayConfig(linked), /无法读取/);
});

test('public query returns only scoped verification results and uses a distinct audit source', async (t) => {
  const state = fixture();
  state.upstream.mailRows[2].subject = '同一主邮箱的其他子邮箱邮件';
  state.upstream.mailRows[3].subject = '另一主邮箱的邮件';
  state.upstream.mailRows[4].subject = '尚未绑定的子邮箱邮件';
  const request = await listen(t, state);
  const buyer = await request('public-query', { queryCode: ' buy-first ' });
  assert.equal(buyer.status, 200);
  assert.equal(buyer.headers.get('cache-control'), 'no-store');
  assert.deepEqual(buyer.body, {
    success: true,
    targetType: 'VIRTUAL',
    primaryEmail: null,
    aliasEmail: 'fir***@example.test',
    codeExpiresAt: future,
    items: [{ subject: '验证码：123456', receivedAt: '2026-11-05 18:15', extractedCode: '123456' }],
    truncated: true
  });
  const master = await request('public-query', { queryCode: 'MSTR-ONE' });
  assert.equal(master.status, 200);
  assert.equal(master.body.primaryEmail, 'one***@example.test');
  assert.equal(master.body.aliasEmail, null);
  assert.deepEqual(
    master.body.items.map(({ subject }) => subject),
    ['验证码：123456', '同一主邮箱的其他子邮箱邮件', '示例无验证码']
  );
  assert.deepEqual(
    state.events,
    Array(2).fill({
      action: 'public_query',
      actor: { id: 'public-mailbox-query', name: '公开查询' },
      parentId: '',
      aliasId: ''
    })
  );
});

test('public query rejects address lookup, nonlocal requests and absent or invalid codes', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const method = await request('public-query');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal(
    (await request('public-query', { queryCode: 'BUY-FIRST' }, 'http://other.example.test')).status,
    403
  );
  assert.equal((await request('public-query', { queryCode: 'first@example.test' })).status, 400);
  assert.equal(
    (await request('public-query', { queryCode: 'BUY-FIRST', aliasId: 'other' })).status,
    400
  );
  assert.equal(state.upstream.calls.length, 0);
  for (const queryCode of ['BUY-EXPIRED', 'BUY-UNBOUND', 'UNKNOWN']) {
    const response = await request('public-query', { queryCode });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      success: false,
      error: '查询码无效或已过期',
      message: '查询码无效或已过期'
    });
  }
  assert.ok(
    state.upstream.calls.every(({ query }) => !/icloudQueryMails|syncIcloudAccount/.test(query))
  );
  assert.equal(state.events.length, 0);
});

test('public query discards mail when the buyer code is reset during synchronization', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  state.upstream.sync = () => {
    state.upstream.aliases[0].buyerQueryCode = 'RESET-CODE';
    return { success: true, syncedCount: 1 };
  };
  const response = await request('public-query', { queryCode: 'BUY-FIRST' });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, '查询码无效或已过期');
  assert.equal(Object.hasOwn(response.body, 'items'), false);
  assert.equal(state.events.length, 0);
});

test('public query counts invalid attempts against a shared rolling limit', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal(
      (await request('public-query', { queryCode: 'invalid@example.test' })).status,
      400
    );
  }
  const limited = await request('public-query', { queryCode: 'BUY-FIRST' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(state.upstream.calls.length, 0);
});

test('public query rejects a third simultaneous request before contacting Vendure', async (t) => {
  const state = fixture();
  const request = await listen(t, state);
  const bothRunning = Promise.withResolvers();
  const releaseSync = Promise.withResolvers();
  let running = 0;
  state.upstream.sync = async () => {
    if (++running === 2) bothRunning.resolve();
    await releaseSync.promise;
    return { success: true, syncedCount: 1 };
  };
  const first = request('public-query', { queryCode: 'BUY-FIRST' });
  const second = request('public-query', { queryCode: 'BUY-OTHER' });
  try {
    await bothRunning.promise;
    const before = state.upstream.calls.length;
    assert.equal((await request('public-query', { queryCode: 'BUY-SIBLING' })).status, 429);
    assert.equal(state.upstream.calls.length, before);
  } finally {
    releaseSync.resolve();
    const completed = await Promise.all([first, second]);
    assert.deepEqual(
      completed.map(({ status }) => status),
      [200, 200]
    );
  }
});
