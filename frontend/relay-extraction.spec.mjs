import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const [dataSource, inventorySource] = await Promise.all(
  ['./local-data.js', './inventory-prototype.js'].map((path) =>
    readFile(new URL(path, import.meta.url), 'utf8')
  )
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const relay = (id, parentMailboxId, values = {}) => ({
  id,
  parentMailboxId,
  email: `${id}@example.test`,
  type: 'relay',
  relayStatus: 'ACTIVE',
  inventoryState: 'available',
  health: 'normal',
  status: '正常',
  ...values
});
const primary = 'test-primary';
const exampleCode = 'BUY-TEST-RELAY-ONLY';

async function fixture({ auth = true, role = 'admin', configured = true } = {}) {
  const expired = relay('relay-expired', primary);
  const eligible = relay('relay-eligible', primary);
  const disabled = relay('relay-disabled', primary, { relayStatus: 'DISABLED' });
  const unbound = relay('relay-unbound', primary);
  let committed = {
    version: 1,
    data: {
      mailboxes: [expired, eligible, disabled, unbound],
      accounts: [],
      batches: [],
      returnRecords: [],
      importRecords: [],
      registrationRecords: [],
      tableSettings: [],
      undo: []
    }
  };
  let confirm;
  let drawerContent;
  let deferredCopy;
  const actor = { id: 'relay-admin-fixture', name: '提取测试员', role };
  const calls = [];
  const copies = [];
  const notices = [];
  const errors = new Map();
  const selections = new Map();
  const state = { route: 'workspace/mail-extract', drafts: new Map() };
  const drawer = {
    close() {
      drawerContent = undefined;
    }
  };
  const window = {
    IDDesignModules: [],
    async fetch(path, options) {
      const method = options.method || 'GET';
      const body = options.body && JSON.parse(options.body);
      calls.push({ path, method, body });
      if (path === '/api/local/inventory' && method === 'GET') return Response.json(committed);
      if (path === '/api/local/apple-relay/status' && method === 'GET') {
        return Response.json({
          configured,
          codeQueryConfigured: configured,
          parentIds: [primary],
          aliasIds: [expired.id, eligible.id]
        });
      }
      if (path === '/api/local/apple-relay/extraction-eligibility' && method === 'POST') {
        return Response.json({
          items: body.aliasIds.map((id) => ({
            id,
            eligible: id === eligible.id,
            reason: id === eligible.id ? null : '买家查询码已过期'
          }))
        });
      }
      if (path === '/api/local/apple-relay/extraction-codes' && method === 'POST') {
        const items = body.claimIds.map((id) => ({
          id,
          email: eligible.email,
          queryCode: exampleCode
        }));
        const pending = deferredCopy;
        deferredCopy = undefined;
        await pending?.promise;
        return Response.json({ items });
      }
      if (path === '/api/local/inventory' && method === 'PUT') {
        assert.equal(body.version, committed.version);
        committed = { version: body.version + 1, data: body.data };
        return Response.json(committed);
      }
      assert.fail(`未预期接口 ${method} ${path}`);
    }
  };
  const esc = (value = '') =>
    String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const api = {
    state,
    collections: { mailboxes: [], accounts: [] },
    modules: {},
    esc,
    icon: () => '',
    button: (label) => label,
    tag: (label) => label,
    textAction: (label) => label,
    field: (_label, _id, control) => control,
    options: (choices) =>
      choices
        .map((choice) => {
          const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
          return `<option value="${esc(value)}">${esc(label)}</option>`;
        })
        .join(''),
    input: (id) => `<input name="${id}">`,
    select: (id, choices) => `<select name="${id}">${api.options(choices)}</select>`,
    header: (title) => title,
    summary: () => '',
    empty: (title) => title,
    table: (columns, rows) =>
      rows
        .map((row) => columns.map((column) => (column.render ? column.render(row) : '')).join(''))
        .join(''),
    pagination: () => '',
    pageRows: (rows) => rows,
    getSelection(key) {
      if (!selections.has(key)) selections.set(key, new Set());
      return selections.get(key);
    },
    readDraft: (form) => api.readForm(form),
    readForm: (form) => ({ ...form.raw }),
    setError: (name, message) => errors.set(name, message),
    notify: (message) => notices.push(message),
    render() {},
    go: (route) => {
      state.route = route;
    },
    confirmAction: (title, description, action) => {
      confirm = { title, description, action };
    },
    openDrawer: (_title, _description, body, _footer, context) => {
      drawerContent = { body, context };
    },
    copyText: async (value) => {
      copies.push(value);
    }
  };
  window.IDDesignAPI = api;
  const document = {
    querySelector(selector) {
      if (selector === 'meta[name="id-local-auth"]') return auth ? { content: 'required' } : null;
      if (selector === 'meta[name="id-local-actor"]')
        return auth ? { content: encodeURIComponent(JSON.stringify(actor)) } : null;
      if (selector === '#drawer') return drawer;
      if (selector === '#drawer[open]')
        return drawerContent ? { firstElementChild: drawerContent } : null;
      return null;
    },
    querySelectorAll: () => []
  };
  const context = { window, document, structuredClone, crypto };
  const sandbox = runInNewContext(dataSource + '\nwindow.IDLocalData;', context);
  assert.equal(sandbox.authRequired, auth);
  runInNewContext(inventorySource, context);
  const inventory = window.IDDesignModules.find((module) => module.id === 'inventory');
  inventory.render();
  await flush();
  assert.equal(api.modules.inventory.getLocalInventoryState(), 'ready');

  return {
    eligible,
    expired,
    state,
    inventory,
    calls,
    copies,
    notices,
    errors,
    get snapshot() {
      return committed;
    },
    get confirmation() {
      return confirm;
    },
    async accept() {
      const action = confirm?.action;
      assert(action, '操作应先进入确认步骤');
      confirm = undefined;
      action();
      await flush();
    },
    async extract(quantity) {
      const submit = { disabled: false, textContent: '确认提取' };
      const form = {
        id: 'inventory-extract-form',
        isConnected: true,
        dataset: { inventoryDraft: 'inventory-extract:mail' },
        querySelector: () => submit,
        raw: {
          'inventory-kind': 'mail',
          'inventory-extract-type': 'relay',
          'inventory-quantity': String(quantity),
          'inventory-purpose': '注册 GPT',
          'inventory-extract-notes': '独立试提'
        }
      };
      inventory.onSubmit(form);
      await flush();
    },
    copy(id) {
      inventory.onClick('inventory-item-copy', { dataset: { id } });
    },
    pauseNextCopy() {
      deferredCopy = Promise.withResolvers();
      return deferredCopy.resolve;
    },
    async requestReturn(id) {
      inventory.onClick('inventory-item-return', { dataset: { id } });
      await flush();
      assert.match(
        drawerContent?.body || '',
        new RegExp('name="inventory-return-choice-' + id + '"')
      );
      inventory.onSubmit({
        id: 'inventory-return-form',
        dataset: { inventoryDraft: drawerContent.context },
        raw: {
          ['inventory-return-choice-' + id]: id,
          'inventory-return-reason': '未使用',
          'inventory-return-notes': '本次未使用'
        }
      });
    }
  };
}

test('only an authenticated administrator can select Apple Relay in mailbox extraction', async () => {
  const admin = await fixture();
  assert.match(admin.inventory.render(), /value="relay"/);
  for (const options of [{ auth: false }, { role: 'employee' }]) {
    const runtime = await fixture(options);
    assert.doesNotMatch(runtime.inventory.render(), /value="relay"/);
    await runtime.extract(1);
    assert.equal(runtime.confirmation, undefined);
    assert.equal(runtime.calls.length, 1, '无权提取时仅加载库存');
  }
});

test('Apple Relay extraction checks bindings and availability before saving, then copies only the pending claim', async () => {
  const runtime = await fixture();
  await runtime.extract(2);
  assert.equal(runtime.confirmation, undefined);
  assert.match(runtime.errors.get('inventory-quantity'), /可提取 1 条/);
  assert.equal(runtime.snapshot.version, 1);
  assert.deepEqual(runtime.calls.slice(1), [
    { path: '/api/local/apple-relay/status', method: 'GET', body: undefined },
    {
      path: '/api/local/apple-relay/extraction-eligibility',
      method: 'POST',
      body: { aliasIds: [runtime.expired.id, runtime.eligible.id] }
    }
  ]);

  await runtime.extract(1);
  assert.equal(runtime.confirmation.title, '确认提取');
  assert.equal(runtime.snapshot.version, 1);
  await runtime.accept();
  assert.equal(runtime.snapshot.version, 2);
  const [batch] = runtime.snapshot.data.batches;
  const [claim] = batch.items;
  assert.equal(runtime.state.route, 'workspace/extractions/' + batch.id);
  assert.equal(claim.assetId, runtime.eligible.id);
  assert.equal(claim.parentMailboxId, primary);
  assert.equal(claim.status, 'pending');
  assert.equal(runtime.calls.at(-1).body.action, 'inventory_extract');
  assert.doesNotMatch(JSON.stringify(runtime.snapshot), /BUY-TEST-RELAY-ONLY/);

  runtime.copy(claim.id);
  await flush();
  assert.deepEqual(runtime.calls.at(-1), {
    path: '/api/local/apple-relay/extraction-codes',
    method: 'POST',
    body: { claimIds: [claim.id] }
  });
  assert.deepEqual(runtime.copies, [`${runtime.eligible.email}\t${exampleCode}`]);

  const resolve = runtime.pauseNextCopy();
  runtime.copy(claim.id);
  await flush();
  await runtime.requestReturn(claim.id);
  await runtime.accept();
  resolve();
  await flush();
  assert.equal(runtime.copies.length, 1, '迟到的取码响应不可复制已归还资料');
  assert.equal(runtime.snapshot.data.batches[0].items[0].status, 'returned');
  assert.equal(runtime.snapshot.data.returnRecords[0].assetId, runtime.eligible.id);
  assert.doesNotMatch(JSON.stringify(runtime.snapshot), /BUY-TEST-RELAY-ONLY/);

  const requests = runtime.calls.length;
  runtime.copy(claim.id);
  await flush();
  assert.equal(runtime.calls.length, requests);
  assert.equal(runtime.copies.length, 1);
});

test('an unconfigured Apple Relay service cannot create an extraction batch', async () => {
  const runtime = await fixture({ configured: false });
  await runtime.extract(1);
  assert.equal(runtime.confirmation, undefined);
  assert.match(runtime.errors.get('inventory-quantity'), /请先接入独立 Vendure/);
  assert.equal(runtime.calls.length, 2, '未配置时只检查状态');
  assert.equal(runtime.snapshot.data.batches.length, 0);
});
