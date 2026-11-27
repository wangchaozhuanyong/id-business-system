import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';

const operator = { id: 'test-operator-1', name: '测试管理员', role: 'admin', active: true };
const fixtureJson = JSON.stringify({
  sessionToken: 'fixture-token-abc',
  user: { email: 'worker@example.com', id: 'user-001' },
  account: { id: 'account-001', planType: 'free' },
  statsigContext: { deviceId: 'dev-001' }
});

test('store manages native workbench accounts with encryption and audit', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    // 1. Initial list is empty
    const initial = store.loadNativeWorkbenchAccounts({}, operator);
    assert.equal(initial.version, 0);
    assert.deepEqual(initial.items, []);
    assert.equal(initial.total, 0);

    // 2. Save account
    const saved = store.saveNativeWorkbenchAccount(
      { sessionJson: fixtureJson, proxySummary: '菲律宾·移动' },
      operator
    );
    assert.equal(saved.version, 1);
    assert.equal(saved.record.email, 'worker@example.com');
    assert.equal(saved.record.proxySummary, '菲律宾·移动');

    // 3. Query back
    const queried = store.loadNativeWorkbenchAccounts({ search: 'worker' }, operator);
    assert.equal(queried.version, 1);
    assert.equal(queried.total, 1);
    assert.equal(queried.items[0].email, 'worker@example.com');
    assert.equal(queried.items[0].hasToken, true);

    // 4. Update note and status
    const noteUpdated = store.updateNativeWorkbenchNote(
      { id: saved.record.id, status: 'active', renewalNotes: '已开通Plus' },
      operator
    );
    assert.equal(noteUpdated.version, 2);
    assert.equal(noteUpdated.record.status, 'active');
    assert.equal(noteUpdated.record.renewalNotes, '已开通Plus');

    // 5. Delete account
    const deleted = store.deleteNativeWorkbenchAccount({ id: saved.record.id }, operator);
    assert.equal(deleted.version, 3);
    assert.equal(deleted.ok, true);

    const afterDelete = store.loadNativeWorkbenchAccounts({}, operator);
    assert.equal(afterDelete.total, 0);
  } finally {
    store.close();
  }
});

const workbench = 'native-browser-workbench';
const formalOptions = { actor: operator, publicOrigin: 'https://workbench.example.test' };

test('旧工作台只接受有管理角色的有效登录身份', async t => {
  const loadNativeWorkbenchAccounts = t.mock.fn();
  const store = { loadNativeWorkbenchAccounts };
  for (const actor of [
    null, { id: operator.id }, { ...operator, role: 'finance' }, { ...operator, role: 'employee' },
    { ...operator, active: false }
  ]) {
    const result = await localBusinessRequest(store, workbench, { ...formalOptions, actor });
    assert.equal(result.status, actor ? 403 : 401);
  }
  assert.equal(loadNativeWorkbenchAccounts.mock.callCount(), 0);
});

test('正式工作台暂停云端浏览器操作，拒绝请求前未调用业务存储', async t => {
  const browserOperation = t.mock.fn();
  const store = {
    launchNativeWorkbenchBrowser: browserOperation,
    closeNativeWorkbenchBrowser: browserOperation,
    updateNativeWorkbenchJson: browserOperation
  };
  for (const [action, body] of [
    ['launch', { id: 'fixture' }],
    ['close', { id: 'fixture' }],
    ['update-json', { id: 'fixture', sessionJson: fixtureJson, autoLaunch: true }]
  ]) {
    const result = await localBusinessRequest(store, `${workbench}?action=${action}`, { ...formalOptions, body });
    assert.equal(result.status, 503, action);
    assert.equal(result.body.code, 'CLOUD_WORKBENCH_PAUSED', action);
    assert.equal(result['Cache-Control'], 'private, no-store', action);
  }
  assert.equal(browserOperation.mock.callCount(), 0);
});

test('正式工作台仍可保存账号和凭据、更新备注并读取结果', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const request = (action, body) => localBusinessRequest(
    store, action ? `${workbench}?action=${action}` : workbench, { ...formalOptions, body }
  );
  const saved = await request('', { sessionJson: fixtureJson });
  assert.equal(saved.status, 200);
  const { id } = saved.body.record;
  const updated = await request('update-json', { id, sessionJson: fixtureJson, autoLaunch: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.launch, null);
  const note = await request('note', { id, renewalNotes: '测试备注' });
  assert.equal(note.status, 200);
  const list = await request('');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, id);
  assert.equal(list.body.items[0].renewalNotes, '测试备注');
  assert.equal(list.body.items[0].hasToken, true);
});

test('本机工作台仍可走原有浏览器操作入口', async t => {
  const launchNativeWorkbenchBrowser = t.mock.fn(() => ({ ok: true }));
  const body = { id: 'fixture' };
  const result = await localBusinessRequest(
    { launchNativeWorkbenchBrowser }, `${workbench}?action=launch`, { actor: operator, body }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(launchNativeWorkbenchBrowser.mock.calls[0].arguments, [body, operator]);
});

test('同一邮箱按操作员隔离记录，超级管理员也只能操作自己的记录', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const alice = { id: 'operator-a', role: 'admin' };
  const bob = { id: 'operator-b', role: 'super' };
  const request = (actor, action = '', body) => localBusinessRequest(
    store, action ? `${workbench}?action=${action}` : workbench, { actor, body }
  );
  const first = (await request(alice, '', { sessionJson: fixtureJson })).body.record;
  const second = (await request(bob, '', {
    sessionJson: fixtureJson,
    ownerId: alice.id,
    profileKey: first.profileKey
  })).body.record;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.profileKey, second.profileKey);
  assert.deepEqual((await request(alice)).body.items.map(item => item.id), [first.id]);
  assert.deepEqual((await request(bob)).body.items.map(item => item.id), [second.id]);
  assert.equal((await localBusinessRequest(store, workbench, { publicOrigin: formalOptions.publicOrigin })).status, 401);
  assert.equal((await localBusinessRequest(store, `${workbench}:${alice.id}`, { actor: bob })).status, 404);

  const launch = t.mock.method(store, '_launchWorkbenchSession', async () => ({
    launchRes: { account: { id: second.id, profileKey: second.profileKey, lastOpenedAt: new Date().toISOString() }, result: {} }
  }));
  for (const action of ['launch', 'close', 'note', 'delete', 'update-json']) {
    const result = await request(bob, action, {
      id: first.id, profileKey: first.profileKey, ownerId: alice.id, autoLaunch: true, sessionJson: fixtureJson
    });
    assert.equal(result.status, 404, action);
  }
  assert.equal(launch.mock.callCount(), 0);
  const allowed = await request(bob, 'launch', { id: second.id, ownerId: alice.id, profileKey: first.profileKey });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.profileKey, second.profileKey);
  assert.equal(launch.mock.calls[0].arguments[1].actor.id, bob.id);
  assert.equal((await request(alice)).body.items[0].lastOpenedAt, null);
});

test('云端浏览器启动回写保留并发备注和新增记录，删除后不会复活', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const { record } = store.saveNativeWorkbenchAccount({ sessionJson: fixtureJson }, operator);
  let pending = Promise.withResolvers();
  t.mock.method(store, '_launchWorkbenchSession', async () => {
    await pending.promise;
    return {
      launchRes: { account: { id: record.id, profileKey: record.profileKey, lastOpenedAt: '2026-11-27T00:00:00.000Z' }, result: {} }
    };
  });

  const launch = store.launchNativeWorkbenchBrowser({ id: record.id }, operator);
  store.updateNativeWorkbenchNote({ id: record.id, renewalNotes: '新增并发备注' }, operator);
  const extra = store.saveNativeWorkbenchAccount({ email: 'extra@example.test' }, operator).record;
  pending.resolve();
  await launch;
  const loaded = store.loadNativeWorkbenchAccounts({}, operator);
  assert.equal(loaded.total, 2);
  assert(loaded.items.some(item => item.id === extra.id));
  assert.equal(loaded.items.find(item => item.id === record.id).renewalNotes, '新增并发备注');

  pending = Promise.withResolvers();
  const removed = store.launchNativeWorkbenchBrowser({ id: record.id }, operator);
  store.deleteNativeWorkbenchAccount({ id: record.id }, operator);
  pending.resolve();
  await assert.rejects(removed, error => error.status === 404);
  assert.deepEqual(store.loadNativeWorkbenchAccounts({}, operator).items.map(item => item.id), [extra.id]);
});

test('更换授权并启动时遇到并发授权更新，不会覆盖已保存的授权', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const { record } = store.saveNativeWorkbenchAccount({ sessionJson: fixtureJson }, operator);
  let pending = Promise.withResolvers();
  t.mock.method(store, '_launchWorkbenchSession', async () => {
    await pending.promise;
    return { launchRes: { account: { profileKey: record.profileKey, lastOpenedAt: new Date().toISOString() }, result: {} } };
  });

  const oldJson = JSON.stringify({ ...JSON.parse(fixtureJson), sessionToken: 'test-finish-older' });
  const newJson = JSON.stringify({ ...JSON.parse(fixtureJson), sessionToken: 'test-save-latest', account: {
    id: 'account-001', planType: 'plus'
  } });
  const opening = store.updateNativeWorkbenchJson({ id: record.id, sessionJson: oldJson, autoLaunch: true }, operator);
  await store.updateNativeWorkbenchJson({ id: record.id, sessionJson: newJson }, operator);
  pending.resolve();
  await assert.rejects(opening, error => error.status === 409);
  assert.equal(store.loadNativeWorkbenchAccounts({}, operator).items[0].currentPlan, 'plus');

  pending = Promise.withResolvers();
  const reopening = store.updateNativeWorkbenchJson({ id: record.id, sessionJson: newJson, autoLaunch: true }, operator);
  store.updateNativeWorkbenchNote({ id: record.id, status: 'active' }, operator);
  pending.resolve();
  await assert.rejects(reopening, error => error.status === 409);
  assert.equal(store.loadNativeWorkbenchAccounts({}, operator).items[0].status, 'active');
});
