import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';

const operator = { id: 'test-operator-1', name: '测试员' };
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
