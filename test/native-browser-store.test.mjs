import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBusinessStore } from '../server/local-business.mjs';

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
