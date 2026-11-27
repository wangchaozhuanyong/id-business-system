import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { editRenewalRecord, listRenewalPage, manualRenewalRecords } from '../server/manual-renewal-records.mjs';

const actor = { id: 'operator-a', name: '管理员甲', role: 'admin' };
const second = { id: 'operator-b', name: '管理员乙', role: 'admin' };
const query = (value = '') => new URLSearchParams(value);
const form = { email: 'member@example.test', currentPlan: '', status: 'pending_renewal', renewalNotes: '' };

test('statistical totals cover every account before search, filters and pagination, and project display fields only', () => {
  const legacy = Array.from({ length: 73 }, (_, i) => ({
    id: String(i), email: 'user' + i + '@example.test', status: i < 20 ? 'active' : 'pending_renewal',
    currentPlan: i < 20 ? 'Plus' : i < 60 ? 'prolite' : '',
    proxyRegion: 'auto', proxySummary: 'http://private.invalid',
    updatedAt: '2026-11-26T00:00:00.000Z', someInternalField: 'internal'
  }));
  legacy[72].status = 'unrecognised';
  const rows = manualRenewalRecords(legacy, []);
  const page = listRenewalPage(rows, query('status=pending_renewal&search=智能&page=4&pageSize=10'));
  assert.equal(page.items.length, 10);
  assert.deepEqual([page.total, page.summary.total], [52, 73]);
  assert.deepEqual(page.summary.statuses, { pending_renewal: 52, active: 20, expired: 0, unknown: 1 });
  assert.deepEqual(page.summary.plans, [{ name: 'prolite', count: 40 }, { name: 'plus', count: 20 }, { name: '', count: 13 }]);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['id', 'email', 'status', 'currentPlan', 'renewalNotes',
    'lastOpenedAt', 'proxySummary', 'updatedAt', 'revision'].sort());
  assert.equal(listRenewalPage(rows, query('page=500&pageSize=10')).items.length, 3);
  assert.equal(listRenewalPage(rows, query('search=not-present')).summary.total, 73);
  assert.throws(() => listRenewalPage(rows, query('pageSize=20000')), { status: 400 });
  const unknown = rows.find(row => row.status === 'unknown');
  const edit = { id: unknown.id, expectedRevision: unknown.revision, status: 'unknown', currentPlan: '', renewalNotes: '仅更新备注' };
  assert.equal(editRenewalRecord(rows, [], edit, '2026-11-27').status, 'unknown');
  assert.throws(() => editRenewalRecord(rows, [], { ...edit, id: rows[0].id, expectedRevision: rows[0].revision }, '2026-11-27'), { status: 400 });
});

test('manual records permit independent concurrent edits, exact retries and actor-bound reopens', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const first = store.saveManualRenewalRecord(form, actor);
  assert.equal(first.version, 1);
  assert.equal(store.changeVersions(actor)['manual-renewal-records'], '1');
  assert.equal(store.changeVersions(second)['manual-renewal-records'], '0');
  assert.equal(store.changeVersions({ ...actor, role: 'employee' })['manual-renewal-records'], undefined);
  assert.deepEqual(store.saveManualRenewalRecord(form, actor), first);
  assert.equal(store.loadNativeWorkbenchAccounts({}, actor).total, 0);
  assert.equal(store.listManualRenewals(query(), second).total, 0);
  assert.throws(() => store.getManualRenewalRecord(first.record.id, second), { status: 404 });
  assert.throws(() => store.markManualRenewalOpened(first.record.id, second), { status: 404 });
  const opened = store.markManualRenewalOpened(first.record.id, actor).record;
  assert(opened.lastOpenedAt);
  assert.equal(opened.revision, first.record.revision);
  const other = store.saveManualRenewalRecord({ ...form, email: 'next@example.test' }, actor);
  const edit = { id: first.record.id, expectedRevision: first.record.revision, currentPlan: 'ProLite', status: 'active', renewalNotes: '已复核' };
  const changed = store.saveManualRenewalRecord(edit, actor);
  assert.equal(changed.record.currentPlan, 'prolite');
  assert.equal(changed.record.lastOpenedAt, opened.lastOpenedAt);
  assert.deepEqual(store.saveManualRenewalRecord(edit, actor), changed);
  assert.throws(() => store.saveManualRenewalRecord({ ...edit, status: 'expired' }, actor), { status: 409 });
  assert.equal(store.saveManualRenewalRecord({ ...edit, id: other.record.id, expectedRevision: other.record.revision }, actor).record.status, 'active');
  const reverted = store.saveManualRenewalRecord({ id: edit.id, expectedRevision: changed.record.revision, currentPlan: '', status: 'pending_renewal', renewalNotes: '' }, actor);
  assert.notEqual(reverted.record.revision, first.record.revision);
  assert.throws(() => store.saveManualRenewalRecord(edit, actor), { status: 409 });
  assert.deepEqual(store.saveManualRenewalRecord(form, second).record.email, form.email);
  assert.throws(() => store.saveManualRenewalRecord({ ...form, sessionJson: '{}' }, actor), { status: 400 });
});

test('manual updates of a legacy account preserve its existing document and manual accounts stay outside legacy actions', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const legacy = store.saveNativeWorkbenchAccount({ email: 'legacy@example.test', status: 'pending_renewal', plan: 'free' }, actor);
  const before = store.loadNativeWorkbenchAccounts({}, actor);
  const row = store.getManualRenewalRecord(legacy.record.id, actor);
  const saved = store.saveManualRenewalRecord({ id: row.id, expectedRevision: row.revision, status: 'active', currentPlan: 'plus', renewalNotes: '手动确认' }, actor);
  assert.equal(saved.record.status, 'active');
  assert.deepEqual(store.loadNativeWorkbenchAccounts({}, actor), before);
  const manual = store.saveManualRenewalRecord(form, actor);
  await assert.rejects(store.updateNativeWorkbenchJson({ id: manual.record.id, sessionJson: '{}' }, actor), { status: 404 });
  store.saveNativeWorkbenchAccount({ email: form.email, plan: 'pro' }, actor);
  const visible = store.listManualRenewals(query(), actor);
  assert.equal(visible.total, 2);
  assert.equal(visible.items.find(item => item.email === form.email).id, manual.record.id);
});

test('renewal routes enforce actor, same origin, accepted method and input whitelist', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const origin = 'https://renewals.invalid';
  const route = '/api/local/native-browser-workbench';
  async function call(action, method, body, user, requestOrigin = origin) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url: route + '?action=' + action,
      headers: { origin: requestOrigin, 'content-type': 'application/json' }
    });
    const result = {};
    await handleLocalBusiness(req, { setHeader() {}, writeHead(code) { result.status = code; },
      end(data) { result.body = JSON.parse(data); } }, route, store, user, { publicOrigin: origin });
    return result;
  }
  assert.equal((await call('renewals', 'GET', null, null)).status, 401);
  assert.equal((await call('renewals', 'GET', null, { ...actor, role: 'employee' })).status, 403);
  assert.equal((await call('renewal-record', 'POST', form, actor, '')).status, 403);
  assert.equal((await call('renewal-record', 'PUT', form, actor)).status, 405);
  assert.equal((await call('renewal-record', 'POST', { ...form, extra: 1 }, actor)).status, 400);
  assert.equal((await call('renewal-record', 'POST', form, actor)).status, 200);
  assert.equal((await call('renewals', 'GET', null, actor)).body.summary.total, 1);
});
