import assert from 'node:assert/strict';
import * as inventoryList from '../modules/inventory/list.mjs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./inventory-prototype.js', import.meta.url), 'utf8');
const instrumented = source.replace(
  '  api.modules.inventory = {',
  '  api.modules.inventoryConflictTest = { persistInventory, readLocalInventory };\n  api.modules.inventory = {'
);
assert.notEqual(instrumented, source, 'test-only export point must exist');

const clone = value => structuredClone(value);
const conflict = message => Object.assign(new Error(message), { status: 409 });
const staleInventory = () => conflict('库存资料已在其他页面更新，请刷新后重试');
const mailbox = (id, email) => ({ id, email, type: 'google', version: 1 });
const documentData = () => ({
  mailboxes: [mailbox('original', 'existing@example.test')], accounts: [], batches: [],
  returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [],
  appleRelay: { parents: [], imports: [], events: [] }
});

async function fixture() {
  let stored = { version: 1, data: documentData() };
  let actor = { id: 'actor-a', name: '合成操作员', role: 'admin' };
  let onSave, confirmation, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const attempts = [], notices = [];
  const collections = { mailboxes: [], accounts: [] };
  const form = {
    id: 'inventory-asset-form', isConnected: true,
    dataset: { inventoryDraft: 'inventory-edit:new:google' },
    values: {
      'inventory-asset-id': '', 'inventory-asset-type': 'google',
      'inventory-email': 'new@example.test', 'inventory-password': 'TEST-ONLY',
      'inventory-country-edit': '马来西亚', 'inventory-status-edit': '正常',
      'inventory-source': '自己注册', 'inventory-no-phone': 'on'
    },
    removeAttribute() {}
  };
  const content = {};
  const drawer = { open: true, firstElementChild: content, addEventListener() {}, close() { this.open = false; } };
  const api = {
    state: { route: 'mailboxes/google', drafts: new Map(), actor }, collections, modules: {},
    esc: String, readForm: node => ({ ...node.values }), readDraft: node => ({ ...node.values }),
    setError() {}, notify: message => notices.push(message), render() {},
    confirmAction: (_title, _detail, callback) => { confirmation = callback; },
    completeAction: finish => { finish(); resolveDone(); }
  };
  const localData = {
    actor: () => actor,
    load: async () => clone(stored),
    async save(domain, version, data, options) {
      assert.equal(domain, 'inventory');
      attempts.push({ version, data: clone(data), action: options.action });
      if (onSave) await onSave(attempts.length);
      if (version !== stored.version) throw staleInventory();
      stored = { version: version + 1, data: clone(data) };
      return clone(stored);
    }
  };
  const document = {
    querySelector(selector) {
      if (selector === '#drawer') return drawer;
      if (selector === '#drawer[open]') return drawer.open ? drawer : null;
      if (selector === '#drawer[open] form[data-inventory-draft]')
        return drawer.open && form.isConnected ? form : null;
      return null;
    },
    querySelectorAll: () => drawer.open && form.isConnected ? [form] : []
  };
  const window = { IDInventoryList: inventoryList, IDDesignAPI: api, IDDesignModules: [], IDLocalData: localData };
  runInNewContext(instrumented, { window, document, structuredClone, crypto: globalThis.crypto });
  await api.modules.inventoryConflictTest.readLocalInventory();
  let completed = 0;
  const create = () => api.modules.inventoryConflictTest.persistInventory('inventory_create', () => {
    collections.mailboxes.unshift(mailbox('new-id', 'new@example.test'));
    return () => { completed++; };
  });
  return {
    api, form, drawer, localData, create, notices, attempts, done,
    publicSubmit() { window.IDDesignModules[0].onSubmit(form); },
    confirm() { assert.equal(typeof confirmation, 'function'); confirmation(); },
    get stored() { return clone(stored); },
    get completed() { return completed; },
    external(mutate) { const data = clone(stored.data); mutate(data); stored = { version: stored.version + 1, data }; },
    setActor(value) { actor = value; },
    setOnSave(value) { onSave = value; }
  };
}

test('the real Google form saves once after an unrelated concurrent update', { timeout: 2000 }, async () => {
  const f = await fixture();
  f.external(data => data.accounts.push({ id: 'concurrent-account', type: 'gpt' }));
  f.publicSubmit();
  await f.done;
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stored.data.accounts[0].id, 'concurrent-account');
  assert.equal(f.stored.data.mailboxes.filter(item => item.email === 'new@example.test').length, 1);
  assert.equal(f.stored.data.mailboxes[0].country, '马来西亚');
  assert.equal(f.stored.data.mailboxes[0].inventoryHistory[0].action, '新增资料');
});

test('typing after submit leaves a newer draft in place when the original request conflicts', async () => {
  const f = await fixture();
  const hold = Promise.withResolvers();
  f.setOnSave(() => hold.promise);
  f.publicSubmit();
  f.form.values['inventory-password'] = 'NEW-TEST-VALUE';
  f.external(data => data.accounts.push({ id: 'concurrent-account', type: 'gpt' }));
  hold.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts.length, 1);
  assert.equal(f.stored.data.mailboxes.some(item => item.email === 'new@example.test'), false);
  assert.equal(f.form.values['inventory-password'], 'NEW-TEST-VALUE');
});

test('new Google mailbox retries a stale inventory version without overwriting concurrent data', async () => {
  const f = await fixture();
  f.external(data => data.accounts.push({ id: 'concurrent-account', type: 'gpt' }));
  await f.create();
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stored.version, 3);
  assert.equal(f.stored.data.mailboxes.filter(item => item.email === 'new@example.test').length, 1);
  assert.equal(f.stored.data.accounts[0].id, 'concurrent-account');
  assert.equal(f.completed, 1);
});

test('a concurrently created duplicate is not overwritten or retried', async () => {
  const f = await fixture();
  f.external(data => data.mailboxes.unshift(mailbox('concurrent-id', 'NEW@example.test')));
  await f.create();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.stored.data.mailboxes[0].id, 'concurrent-id');
  assert.equal(f.completed, 0);
  assert.equal(f.api.state.drafts.get(f.form.dataset.inventoryDraft)?.['inventory-email'], 'new@example.test');
  assert(f.notices.some(message => /相同|已存在|重复/.test(message)));
});

test('a changed draft is preserved and is not saved after the original request conflicts', async () => {
  const f = await fixture();
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  f.setOnSave(number => number === 1 ? waiting : undefined);
  const saving = f.create();
  f.external(data => data.accounts.push({ id: 'concurrent-account' }));
  f.form.values['inventory-email'] = 'newer-input@example.test';
  resume();
  await saving;
  assert.equal(f.attempts.length, 1);
  assert.equal(f.stored.data.mailboxes.some(item => item.id === 'new-id'), false);
  assert.equal(f.api.state.drafts.get(f.form.dataset.inventoryDraft)?.['inventory-email'], 'newer-input@example.test');
});

test('a changed identity or closed drawer cannot cause a late automatic save', async () => {
  for (const changed of ['actor', 'view-actor', 'drawer']) {
    const f = await fixture();
    let resume;
    const waiting = new Promise(resolve => { resume = resolve; });
    f.setOnSave(number => number === 1 ? waiting : undefined);
    const saving = f.create();
    f.external(data => data.accounts.push({ id: 'concurrent-account' }));
    if (changed === 'actor') f.setActor({ id: 'actor-b', role: 'admin' });
    else if (changed === 'view-actor') f.api.state.actor = { id: 'actor-b', role: 'admin' };
    else { f.drawer.open = false; f.form.isConnected = false; }
    resume();
    await saving;
    assert.equal(f.attempts.length, 1, changed);
    assert.equal(f.stored.data.mailboxes.some(item => item.id === 'new-id'), false, changed);
  }
});

test('a create operation that also changes existing data is not automatically rebased', async () => {
  const f = await fixture();
  f.external(data => data.accounts.push({ id: 'concurrent-account' }));
  await f.api.modules.inventoryConflictTest.persistInventory('inventory_create', () => {
    f.api.collections.mailboxes[0].email = 'changed@example.test';
    f.api.collections.mailboxes.unshift(mailbox('new-id', 'new@example.test'));
    return () => {};
  });
  assert.equal(f.attempts.length, 1);
  assert.equal(f.stored.data.mailboxes[0].email, 'existing@example.test');
});

test('a second race is not retried indefinitely and leaves the draft available', async () => {
  const f = await fixture();
  f.external(data => data.accounts.push({ id: 'first-change' }));
  f.setOnSave(number => {
    if (number === 2) f.external(data => data.accounts.push({ id: 'second-change' }));
  });
  await f.create();
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stored.data.mailboxes.some(item => item.id === 'new-id'), false);
  assert.equal(f.stored.data.accounts.length, 2);
  assert.equal(f.api.state.drafts.get(f.form.dataset.inventoryDraft)?.['inventory-email'], 'new@example.test');
});

test('an unconfirmed retry result refreshes the list without repeating a committed create', async () => {
  const f = await fixture();
  f.external(data => data.accounts.push({ id: 'concurrent-account' }));
  const save = f.localData.save;
  f.localData.save = async (...args) => {
    const result = await save(...args);
    if (f.attempts.length === 2) throw new Error('connection lost after commit');
    return result;
  };
  await f.create();
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stored.data.mailboxes.filter(item => item.id === 'new-id').length, 1);
  assert.equal(f.api.collections.mailboxes.filter(item => item.id === 'new-id').length, 1);
  assert.equal(f.completed, 0);
  assert(f.notices.some(message => /结果尚未确认/.test(message)));
  assert.equal(f.api.state.drafts.get(f.form.dataset.inventoryDraft)?.['inventory-email'], 'new@example.test');
});

test('other validation conflicts and edits do not auto-retry', async () => {
  const f = await fixture();
  f.setOnSave(() => { throw conflict('资料校验失败'); });
  await f.create();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.completed, 0);

  const edited = await fixture();
  edited.external(data => data.accounts.push({ id: 'other' }));
  edited.form.values['inventory-asset-id'] = 'original';
  await edited.api.modules.inventoryConflictTest.persistInventory('inventory_edit', () => {
    edited.api.collections.mailboxes[0].version++;
    return () => {};
  });
  assert.equal(edited.attempts.length, 1);
});
