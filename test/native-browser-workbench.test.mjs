import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionPayload,
  queryWorkbenchAccounts,
  upsertWorkbenchAccount,
  updateWorkbenchNote,
  updateAccountSessionJson,
  removeWorkbenchAccount,
  closeWorkbenchBrowser,
  NativeWorkbenchError
} from '../server/native-browser-workbench.mjs';

const fixtureJson = JSON.stringify({
  sessionToken: 'fixture-token-abc',
  user: { email: 'test@example.com', id: 'user-123' },
  account: { id: 'account-123', planType: 'free' },
  statsigContext: { deviceId: 'device-456' }
});

test('parseSessionPayload extracts email, token, deviceId, plan', () => {
  const result = parseSessionPayload(fixtureJson);
  assert.equal(result.email, 'test@example.com');
  assert.equal(result.token, 'fixture-token-abc');
  assert.equal(result.deviceId, 'device-456');
  assert.equal(result.plan, 'free');
});

test('parseSessionPayload throws on invalid JSON or missing email/token', () => {
  assert.throws(() => parseSessionPayload('not-json'), NativeWorkbenchError);
  assert.throws(() => parseSessionPayload(JSON.stringify({ sessionToken: 'abc' })), NativeWorkbenchError);
  assert.throws(() => parseSessionPayload(JSON.stringify({ user: { email: 'bad' } })), NativeWorkbenchError);
});

test('upsertWorkbenchAccount creates and updates records idempotently', () => {
  let records = [];
  const first = upsertWorkbenchAccount(records, { sessionJson: fixtureJson, proxySummary: '菲律宾·动态' });
  records = first.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].email, 'test@example.com');
  assert.equal(records[0].proxySummary, '菲律宾·动态');
  assert.equal(records[0].status, 'pending_renewal');

  // Updating the same account with new notes or plan
  const second = upsertWorkbenchAccount(records, { email: 'test@example.com', plan: 'plus', renewalNotes: '已开通Plus' });
  records = second.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].currentPlan, 'plus');
  assert.equal(records[0].renewalNotes, '已开通Plus');
});

test('queryWorkbenchAccounts supports searching and filtering', () => {
  const records = [
    { id: '1', email: 'alice@example.com', status: 'pending_renewal', lastOpenedAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-20T10:00:00Z' },
    { id: '2', email: 'bob@example.com', status: 'active', lastOpenedAt: '2026-11-23T10:00:00Z', createdAt: '2026-11-21T10:00:00Z' }
  ];
  const all = queryWorkbenchAccounts(records);
  assert.equal(all.length, 2);
  assert.equal(all[0].email, 'bob@example.com'); // sorted by lastOpenedAt desc

  const searchAlice = queryWorkbenchAccounts(records, { search: 'alice' });
  assert.equal(searchAlice.length, 1);
  assert.equal(searchAlice[0].email, 'alice@example.com');

  const filterActive = queryWorkbenchAccounts(records, { status: 'active' });
  assert.equal(filterActive.length, 1);
  assert.equal(filterActive[0].email, 'bob@example.com');
});

test('updateWorkbenchNote and removeWorkbenchAccount', () => {
  let records = [{ id: '1', email: 'alice@example.com', status: 'pending_renewal', renewalNotes: '' }];
  const updated = updateWorkbenchNote(records, { id: '1', status: 'active', renewalNotes: '扣费完成' });
  records = updated.records;
  assert.equal(records[0].status, 'active');
  assert.equal(records[0].renewalNotes, '扣费完成');

  const removed = removeWorkbenchAccount(records, '1');
  assert.equal(removed.records.length, 0);
  assert.throws(() => removeWorkbenchAccount(records, 'non-existent'), NativeWorkbenchError);
});

test('closeWorkbenchBrowser and isRunning status', () => {
  const records = [{ id: '1', email: 'alice@example.com', profileKey: 'chatgpt_test123' }];
  const query = queryWorkbenchAccounts(records);
  assert.equal(typeof query[0].isRunning, 'boolean');
  assert.equal(query[0].isRunning, false);

  const res = closeWorkbenchBrowser(records, '1');
  assert.equal(res.ok, true);
  assert.equal(res.id, '1');
  assert.throws(() => closeWorkbenchBrowser(records, 'unknown'), NativeWorkbenchError);
});

test('updateAccountSessionJson updates credentials in-place and rejects mismatched email', () => {
  const records = [
    {
      id: 'acc-1',
      email: 'test@example.com',
      token: 'old-token',
      deviceId: 'old-device',
      status: 'expired',
      currentPlan: 'free'
    }
  ];

  const newJson = JSON.stringify({
    sessionToken: 'fresh-token-xyz',
    user: { email: 'test@example.com', id: 'user-new' },
    account: { id: 'acc-new', planType: 'plus' },
    statsigContext: { deviceId: 'fresh-device-789' }
  });

  const { record, records: updatedRecords } = updateAccountSessionJson(records, 'acc-1', newJson);
  assert.equal(record.token, 'fresh-token-xyz');
  assert.equal(record.deviceId, 'fresh-device-789');
  assert.equal(record.currentPlan, 'plus');
  assert.equal(record.status, 'pending_renewal');
  assert.equal(updatedRecords[0].token, 'fresh-token-xyz');

  // Mismatched email should throw 400
  const mismatchJson = JSON.stringify({
    sessionToken: 'other-token',
    user: { email: 'wrong@example.com' }
  });
  assert.throws(
    () => updateAccountSessionJson(updatedRecords, 'acc-1', mismatchJson),
    (err) => err instanceof NativeWorkbenchError && err.status === 400
  );
});

test('store manages operator-isolated proxy preference and valid regions', async () => {
  const { createLocalBusinessStore } = await import('../server/local-business.mjs');
  const store = createLocalBusinessStore(':memory:');
  const actor1 = { id: 'emp_1', email: 'emp1@example.com' };
  const actor2 = { id: 'emp_2', email: 'emp2@example.com' };

  const initial = store.loadNativeWorkbenchPreferences(actor1);
  assert.equal(initial.defaultProxyRegion, 'auto');
  assert.deepEqual(initial.availableRegions, [
    { code: 'PH', label: '菲律宾 (PH · 自动代充 IP 池)' },
    { code: 'EG', label: '埃及 (EG · 自动代充 IP 池)' }
  ]);

  store.saveNativeWorkbenchPreferences({ defaultProxyRegion: 'EG' }, actor1);
  const updated1 = store.loadNativeWorkbenchPreferences(actor1);
  assert.equal(updated1.defaultProxyRegion, 'EG');

  // Verify actor2 is isolated and not influenced
  const updated2 = store.loadNativeWorkbenchPreferences(actor2);
  assert.equal(updated2.defaultProxyRegion, 'auto');
});

test('launchWorkbenchBrowser throws 404 for unknown id and supports owner/window options', async () => {
  const { launchWorkbenchBrowser } = await import('../server/native-browser-workbench.mjs');
  await assert.rejects(
    () => launchWorkbenchBrowser([], 'missing-id', { ownerId: 'emp_1' }),
    (err) => err instanceof NativeWorkbenchError && err.status === 404
  );
});
