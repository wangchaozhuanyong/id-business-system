import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const source = await readFile(new URL('./apple-relay-prototype.js', import.meta.url), 'utf8');
const core = await readFile(new URL('./prototype.js', import.meta.url), 'utf8');
const parseCsv = runInNewContext(
  `${core.slice(core.indexOf('function parseCsv('), core.indexOf('function validateImport('))}; parseCsv`
);
const esc = (value = '') =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const decode = (value = '') =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const attrs = (text) =>
  Object.fromEntries(
    [...text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], decode(m[2] || '')])
  );
function defaults(html) {
  const values = {};
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const item = attrs(match[1]);
    if (item.name && item.type !== 'file') values[item.name] = item.value || '';
  }
  for (const match of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const item = attrs(match[1]);
    if (item.name) values[item.name] = decode(match[2]);
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const item = attrs(match[1]);
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)].map((m) => attrs(m[1]));
    if (item.name)
      values[item.name] = (options.find((o) => 'selected' in o) || options[0])?.value || '';
  }
  return values;
}
// Exercise real public handlers against fictional main mailboxes and aliases.
// The DOM shim models form snapshots, disabled selects, confirmation and drafts.
function runtime(store, { relayConfigured = true } = {}) {
  let form = null,
    callback = null,
    sequence = 0,
    opened = null,
    html = '',
    clock = '2026-11-03 10:30';
  const tables = [],
    notices = [],
    errors = new Map();
  const assets = [
    {
      id: 'mail-27',
      type: 'relay',
      email: 'first@icloud.example.test',
      inventoryState: 'available',
      status: '正常'
    },
    {
      id: 'mail-28',
      type: 'relay',
      email: 'second@icloud.example.test',
      inventoryState: 'available',
      status: '正常'
    },
    {
      id: 'legacy-no-parent',
      type: 'relay',
      email: 'unknown@example.test',
      inventoryState: 'available',
      status: '正常'
    }
  ];
  const controls = new Map();
  const drawer = {
    open: false,
    close() {
      this.open = false;
    }
  };
  const api = {
    state: {
      route: 'mailboxes/relay',
      page: 1,
      pageSize: 8,
      drafts: new Map(),
      actor: { id: 'actor-a', name: '演示管理员甲' }
    },
    collections: { mailboxes: assets },
    modules: {},
    legacy: { parseCsv },
    esc,
    icon: () => '',
    titleInfo: () => '',
    tag: esc,
    header: (_title, _help, actions = '') => actions,
    summary: () => '',
    empty: (title, description = '') => `${title} ${description}`,
    button: (label, action, _kind, _icon, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${esc(label)}</button>`,
    textAction: (label, action, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${esc(label)}</button>`,
    input: (id, value = '', extra = '') =>
      `<input id="${id}" name="${id}" value="${esc(value)}" ${extra} />`,
    options: (choices, selected = '') =>
      choices
        .map((c) => {
          const [value, label] = Array.isArray(c) ? c : [c, c];
          return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
        })
        .join(''),
    select: (id, choices, selected = '') =>
      `<select id="${id}" name="${id}">${api.options(choices, selected)}</select>`,
    field: (label, id, control) =>
      `<div class="field"><label for="${id}">${esc(label)}</label>${control}</div>`,
    table: (columns, rows, scope, id) => {
      tables.push({ columns, rows, scope, id });
      return `<table data-table="${id}">${rows.map((r) => `<tr>${columns.map((c) => `<td>${c.render ? c.render(r) : esc(r[c.id] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
    },
    pagination: () => '',
    pageRows: (rows) => rows,
    nowText: () => clock,
    newId: (kind) => `${kind}-${++sequence}`,
    readDraft: (target) => Object.fromEntries(Object.entries(api.readForm(target)).filter(
      ([key]) => !['relay-appPassword', 'relay-file'].includes(key) &&
        !/(?:^|-)(?:session|cvv|cvc|otp|payment-authorization)(?:$|-)/i.test(key)
    )),
    readForm: (target) =>
      Object.fromEntries(
        Object.entries(target.raw).filter(([key]) => !controls.get(key)?.disabled)
      ),
    setError: (key, message) => errors.set(key, message),
    notify: (message) => notices.push(message),
    render: () => {
      tables.length = 0;
      html = module.render();
    },
    go: (route) => {
      api.state.route = route;
    },
    openDrawer: (title, description, body, footer, key) => {
      opened = { title, description, body, footer, key };
      drawer.open = true;
      const definition = attrs(body.match(/<form\b([^>]*)>/)?.[1] || '');
      controls.clear();
      form = definition.id
        ? {
            id: definition.id,
            dataset: { relayDraft: definition['data-relay-draft'] || key },
            raw: defaults(body),
            removeAttribute(name) {
              if (name === 'data-relay-draft') delete this.dataset.relayDraft;
            }
          }
        : null;
    },
    closeDrawer: () => {
      drawer.close();
    },
    confirmAction: (_title, _description, next) => {
      callback = next;
    }
  };
  if (store) {
    const loaded = store.load('inventory');
    let committed = loaded.data || {
      mailboxes: [],
      accounts: [],
      batches: [],
      returnRecords: [],
      importRecords: [],
      registrationRecords: [],
      tableSettings: [],
      undo: [],
      appleRelay: { parents: [], imports: [], events: [] }
    };
    let version = loaded.version;
    const refreshRows = () =>
      assets.splice(0, assets.length, ...structuredClone(committed.mailboxes));
    refreshRows();
    api.modules.inventory = {
      getAppleRelayState: () => structuredClone(committed.appleRelay),
      getLocalInventoryState: () => 'ready',
      applyCommittedInventory(saved) {
        version = saved.version;
        committed = saved.data;
        refreshRows();
      },
      async saveAppleRelay(mutate, action) {
        const staged = structuredClone(committed);
        mutate(staged.appleRelay);
        staged.mailboxes = structuredClone(assets);
        refreshRows();
        await setImmediate();
        try {
          const [saved] = store.saveBatch([{ domain: 'inventory', version, data: staged, action }]);
          version = saved.version;
          committed = saved.data;
          refreshRows();
          return true;
        } catch (error) {
          if (error.status !== 409) throw error;
          const fresh = store.load('inventory');
          version = fresh.version;
          committed = fresh.data;
          refreshRows();
          return false;
        }
      }
    };
  }
  const document = {
    querySelector: (selector) => (selector === '#drawer' ? drawer : null),
    querySelectorAll: () => (form && drawer.open && form.dataset.relayDraft ? [form] : []),
    getElementById: (id) => {
      if (id === form?.id) return form;
      if (!controls.has(id))
        controls.set(id, {
          disabled: false,
          innerHTML: '',
          focus() {},
          setSelectionRange() {},
          get value() {
            return form?.raw[id] || '';
          },
          set value(value) {
            if (form) form.raw[id] = value;
          }
        });
      return controls.get(id);
    }
  };
  const modules = [];
  runInNewContext(source, {
    window: { IDDesignAPI: api, IDDesignModules: modules, IDLocalData: store && {
      async relay(action, input) {
        if (action === 'status') return {
          configured: relayConfigured,
          parentIds: (store.load('inventory').data?.appleRelay?.parents ?? []).map(({ id }) => id)
        };
        assert.equal(action, 'primary-save');
        assert.equal(typeof input.appPassword, 'string');
        assert(relayConfigured);
        await setImmediate();
        const row = {
          id: 'fixture-' + webcrypto.randomUUID(), expectedVersion: null, remotePrimaryId: 'fixture-upstream',
          email: input.email, days: input.days, note: input.note, status: 'ACTIVE'
        };
        const inventory = store.saveAppleRelayPrimaries([row], { id: 'local-operator', name: '本机操作员' });
        return { inventory, parentId: row.id };
      }
    } },
    document,
    crypto: webcrypto,
    Date,
    Map,
    Set,
    structuredClone: globalThis.structuredClone
  });
  const module = modules[0];
  module.render();
  const output = {
    api,
    module,
    tables,
    notices,
    errors,
    assets,
    drawer,
    controls,
    get form() {
      return form;
    },
    get opened() {
      return opened;
    },
    get html() {
      return html;
    },
    set(values) {
      Object.assign(
        form.raw,
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [`relay-${key}`, String(value)])
        )
      );
    },
    click(action, dataset = {}) {
      return module.onClick(action, { dataset });
    },
    submit() {
      return module.onSubmit(form);
    },
    confirm() {
      assert(callback, '缺少确认回调');
      const next = callback;
      callback = null;
      return next();
    },
    hasConfirm: () => Boolean(callback),
    parent(id = 'parent-demo-1') {
      return api.modules.appleRelay.getParent(id);
    },
    parents() {
      return api.modules.appleRelay.listParents();
    },
    newParent(values = {}) {
      output.click('relay-parent-add');
      output.set({
        email: 'new-main@example.test',
        appPassword: 'Fictional-App-Pass',
        days: '30',
        note: '演示备注',
        ...values
      });
      output.submit();
    },
    newAlias(values = {}, parentId = 'parent-demo-1') {
      output.click('relay-alias-add', { parentId });
      output.set({
        email: 'new-hidden@icloud.example.test',
        days: '30',
        note: '演示隐藏地址',
        ...values
      });
      output.submit();
    },
    preview(content, parentId = 'parent-demo-1') {
      output.click('relay-import', { parentId });
      output.set({ parentId, content, days: '30' });
      output.click('relay-import-preview');
    },
    tab(tab) {
      output.click('relay-tab', { tab });
    },
    table(id) {
      tables.length = 0;
      html = module.render();
      return tables.find((t) => t.id === id);
    },
    query(value) {
      module.onSubmit({ id: 'relay-query-form', raw: { 'relay-query': value } });
    },
    time(value) {
      clock = value;
    }
  };
  return output;
}

test('本机主邮箱与批量登记归属于同一库存版本，重开后读取且无模拟凭据', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const browser = runtime(store);
  assert.equal(browser.parents().length, 0);
  browser.newParent({ email: 'local-main@example.test', appPassword: 'not-a-real-secret' });
  const pendingParent = browser.confirm();
  assert.equal(browser.parents().length, 0);
  await pendingParent;
  const parent = browser.parents()[0];
  assert.equal(parent.remotePrimaryId, 'fixture-upstream');
  assert.equal(parent.queryCode, undefined);
  assert.equal(JSON.stringify(store.load('inventory')).includes('not-a-real-secret'), false);

  browser.preview('hidden1@example.test,备注\nhidden2@example.test', parent.id);
  browser.submit();
  await browser.confirm();
  const reopened = runtime(store, { relayConfigured: false });
  assert.deepEqual(
    reopened.assets.map((row) => row.parentMailboxId),
    [parent.id, parent.id]
  );
  assert(
    reopened.assets.every(
      (row) => !row.queryCode && !reopened.api.modules.appleRelay.isAvailable(row)
    )
  );
  assert.equal(reopened.api.modules.appleRelay.listImports()[0].success, 2);
  assert.equal(store.load('inventory').version, 2);
  reopened.tab('mails');
  assert.match(reopened.html, /收件服务待接入/);
  reopened.tab('query');
  assert.match(reopened.html, /查询服务待接入/);
});

test('本机隐藏邮箱的账号状态独立于使用状态，重新打开后仍可筛选及恢复', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  let browser = runtime(store);
  browser.newParent();
  await browser.confirm();
  const [parent] = browser.parents();
  browser.newAlias({}, parent.id);
  await browser.confirm();
  const [initial] = browser.assets;

  browser.click('relay-alias-more', { id: initial.id });
  assert.match(browser.opened.body, /移入死号/);
  browser.click('relay-health', { id: initial.id, health: 'dead' });
  await browser.confirm();
  browser = runtime(store);
  const [dead] = browser.assets;
  assert.equal(dead.health, 'dead');
  assert.match(dead.healthChangedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(dead.relayStatus, initial.relayStatus);
  assert.equal(dead.inventoryState, initial.inventoryState);
  assert.equal(dead.updatedAt, initial.updatedAt);
  assert.equal(dead.updatedById, initial.updatedById);
  assert.equal(dead.lastOperatedById, 'local-operator');
  assert.equal(dead.inventoryHistory.at(-1).detail, '正常 → 死号');
  browser.tab('aliases');
  browser.click('relay-inventory-status', { filter: 'health', value: 'dead' });
  browser.click('relay-inventory-status', { filter: 'inventory', value: 'available' });
  assert.equal(browser.table('relay-aliases').rows.length, 1);
  browser.click('relay-inventory-status', { filter: 'inventory', value: 'used' });
  assert.equal(browser.table('relay-aliases').rows.length, 0);

  for (const health of ['unlocking', 'normal']) {
    browser.click('relay-alias-more', { id: initial.id });
    browser.click('relay-health', { id: initial.id, health });
    await browser.confirm();
    assert.equal(store.load('inventory').data.mailboxes[0].health, health);
  }
  const current = store.load('inventory').data;
  assert.equal(current.batches.length, 0);
  assert.deepEqual(
    current.appleRelay.events
      .filter((entry) => entry.kind === '账号状态变化')
      .map((entry) => entry.note),
    ['解封中 → 正常', '死号 → 解封中', '正常 → 死号']
  );
});

test('旧窗口登记隐藏邮箱遇到库存冲突时保留草稿且不报告保存成功', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const first = runtime(store);
  first.newParent();
  await first.confirm();
  const id = first.parents()[0].id;
  const second = runtime(store);
  second.newAlias({ email: 'collision@example.test' }, id);
  first.newAlias({ email: 'collision@example.test' }, id);
  await first.confirm();
  await second.confirm();

  assert.equal(store.load('inventory').data.mailboxes.length, 1);
  assert.equal(second.drawer.open, true);
  assert.equal(second.form.raw['relay-email'], 'collision@example.test');
  assert(!second.notices.some((notice) => notice.includes('已保存到本机')));
  second.submit();
  assert.equal(second.hasConfirm(), false);
  assert.match(second.errors.get('relay-email'), /重复/);
});

test('新增 Apple 主邮箱需要有效地址、应用专用密码与有效天数', () => {
  for (const bad of [
    { appPassword: '' },
    { email: 'invalid' },
    { days: '0' },
    { days: '3651' },
    { days: '1.5' }
  ]) {
    const r = runtime();
    r.newParent(bad);
    assert.equal(r.parents().length, 2);
    assert.equal(r.hasConfirm(), false);
    assert(r.errors.size);
  }
});

test('主邮箱创建自动生成稳定编号与主查询码，专用密码不持久化或保留草稿', () => {
  const r = runtime();
  r.click('relay-parent-add');
  r.set({ email: 'new-main@example.test', appPassword: 'Fictional-App-Pass', days: '30' });
  assert.equal(r.api.readDraft(r.form)['relay-appPassword'], undefined);
  r.module.preserveDraft();
  assert(!JSON.stringify([...r.api.state.drafts]).includes('Fictional-App-Pass'));
  r.submit();
  r.confirm();
  const p = r.parents().find((entry) => entry.email === 'new-main@example.test');
  assert(p.id);
  assert(p.queryCode.startsWith('DEMO-MAIN-'));
  assert.equal(p.queryExpiry, '2026-12-03 10:30');
  assert.equal(p.hasCredential, true);
  assert.equal(p.createdById, 'actor-a');
  assert(!JSON.stringify(p).includes('Fictional-App-Pass'));
  assert.equal(r.api.state.drafts.size, 0);
});

test('隐藏邮箱只登记在明确正常主邮箱下，未知旧父级不猜测', () => {
  const r = runtime();
  assert.equal(r.assets.find((a) => a.id === 'legacy-no-parent').parentMailboxId, undefined);
  assert.equal(r.api.modules.appleRelay.isAvailable(r.assets[2]), false);
  r.newAlias({ parentId: 'missing' });
  assert.equal(r.hasConfirm(), false);
  r.parent().status = 'DISABLED';
  r.newAlias();
  assert.equal(r.hasConfirm(), false);
  assert.equal(r.assets.length, 3);
});

test('登记隐藏地址无需独立密码，查询码与人员不能由表单注入', () => {
  const r = runtime();
  r.newAlias({
    queryCode: 'FORGED-CODE',
    queryExpiry: '2099-01-01',
    createdBy: '伪造人',
    createdById: 'fake'
  });
  r.confirm();
  const a = r.assets.find((row) => row.email === 'new-hidden@icloud.example.test');
  assert.equal(a.parentMailboxId, 'parent-demo-1');
  assert.equal(a.id, a.aliasId);
  assert(a.queryCode.startsWith('DEMO-ALIAS-'));
  assert.notEqual(a.queryCode, 'FORGED-CODE');
  assert.equal(a.queryExpiry, '2026-12-03 10:30');
  assert.equal(a.password, undefined);
  assert.equal(a.createdById, 'actor-a');
  assert.equal(a.inventoryState, 'available');
  assert.equal(a.used, false);
});

test('隐藏地址全局去重，不能再次绑定到其他 Apple 主邮箱', () => {
  const r = runtime();
  r.newAlias({ email: 'first@icloud.example.test' }, 'parent-demo-2');
  assert.equal(r.hasConfirm(), false);
  assert.match(r.notices.at(-1), /已登记/);
  assert.equal(r.assets.length, 3);
});

test('编辑保留稳定主邮箱关联，已提取或使用的地址不可替换', () => {
  const r = runtime();
  r.api.modules.appleRelay.openAliasEditor('mail-27');
  r.set({ parentId: 'parent-demo-2' });
  // Browser-disabled selector is immutable; injected submitted parent must still be rejected.
  r.controls.get('relay-parentId').disabled = false;
  r.submit();
  assert.equal(r.hasConfirm(), false);
  assert.match(r.notices.at(-1), /不能更换/);
  r.assets[0].inventoryState = 'claimed';
  r.api.modules.appleRelay.openAliasEditor('mail-27');
  r.set({ email: 'replacement@example.test' });
  r.submit();
  assert.equal(r.hasConfirm(), false);
  assert.match(r.notices.at(-1), /不能替换/);
});

test('编辑只更新最近操作人，录入人、时间与隐藏编号不覆盖', () => {
  const r = runtime();
  r.newAlias();
  r.confirm();
  const a = r.assets.find((entry) => entry.email === 'new-hidden@icloud.example.test'),
    id = a.id,
    time = a.createdAt;
  r.api.state.actor = { id: 'actor-b', name: '演示编辑员乙' };
  r.time('2026-11-04 11:30');
  r.api.modules.appleRelay.openAliasEditor(id);
  r.set({ note: '修改后', status: 'ACTIVE' });
  r.submit();
  r.confirm();
  assert.equal(a.id, id);
  assert.equal(a.aliasId, id);
  assert.equal(a.createdById, 'actor-a');
  assert.equal(a.createdAt, time);
  assert.equal(a.updatedById, 'actor-b');
  assert.equal(a.notes, '修改后');
  assert.equal(a.inventoryHistory.at(-1).actorId, 'actor-b');
});

test('隐藏邮箱列表与详情读取共享库存最近操作人，不能停留在上次编辑者', () => {
  const r = runtime();
  r.newAlias();
  r.confirm();
  const row = r.assets.find((item) => item.email === 'new-hidden@icloud.example.test');
  row.lastOperatedBy = '演示提取员';
  row.lastOperatedById = 'inventory-actor';
  row.lastOperatedAt = '2026-11-04 15:30';
  r.tab('aliases');
  const columns = r.table('relay-aliases').columns;
  assert.equal(columns.find((column) => column.label === '最近操作人').render(row), '演示提取员');
  assert.equal(
    columns.find((column) => column.label === '最近操作时间').render(row),
    '2026-11-04 15:30'
  );
  r.api.modules.appleRelay.openAliasDetail(row.id);
  assert(r.opened.body.includes('inventory-actor'));
  assert(r.opened.body.includes('演示提取员'));
});

test('隐藏邮箱详情保留共享库存的提取归还历史，不另建割裂操作记录', () => {
  const r = runtime();
  r.newAlias();
  r.confirm();
  const row = r.assets.find((item) => item.email === 'new-hidden@icloud.example.test');
  row.inventoryHistory.push({
    id: 'returned-fixture',
    action: '归还',
    actorId: 'return-actor',
    actor: '演示归还员',
    time: '2026-11-04 15:30',
    detail: '未使用'
  });
  r.api.modules.appleRelay.openAliasDetail(row.id);
  const history = r.tables.filter((table) => table.id === 'relay-events').at(-1);
  assert.equal(history.rows.length, 2);
  assert(history.rows.some((entry) => entry.kind === '登记隐藏邮箱'));
  assert(history.rows.some((entry) => entry.kind === '归还' && entry.actorId === 'return-actor'));
});

test('主邮箱与隐藏邮箱表单字段均有独立列，凭据仅显示配置状态', () => {
  const r = runtime();
  r.newParent({ days: '90' });
  r.confirm();
  r.tab('parents');
  const parentTable = r.table('relay-parents');
  assert(parentTable.columns.some((column) => column.id === 'days'));
  assert(parentTable.columns.some((column) => column.id === 'hasCredential'));
  const savedParent = r.parents().find((row) => row.email === 'new-main@example.test');
  assert.equal(savedParent.days, 90);
  assert.equal(savedParent.appPassword, undefined);
  r.preview('visible.fields@example.test,fixture');
  r.submit();
  r.confirm();
  r.tab('aliases');
  const table = r.table('relay-aliases');
  for (const id of [
    'aliasId',
    'parentMailboxId',
    'email',
    'relayStatus',
    'codeResetIntervalDays',
    'lastMailReceivedAt',
    'importId',
    'notes'
  ])
    assert(
      table.columns.some((column) => column.id === id),
      `missing ${id}`
    );
  assert(!table.columns.some((column) => ['password', 'totp', 'birthday'].includes(column.id)));
  const row = r.assets.find((item) => item.email === 'visible.fields@example.test');
  assert.equal(row.codeResetIntervalDays, 30);
  assert(row.importId);
  r.api.modules.appleRelay.openAliasDetail(row.id);
  assert(r.opened.body.includes(row.importId));
  assert(r.opened.body.includes('有效天数'));
});

test('批量先预检，正确两列 CSV 全部登记并继承主邮箱、批次和操作人', () => {
  const r = runtime();
  r.preview('邮箱,备注\nimport.a@icloud.example.test,一号\nimport.b@icloud.example.test,二号');
  assert.equal(r.assets.length, 3);
  r.submit();
  assert.equal(r.assets.length, 3);
  r.confirm();
  const list = r.assets.filter((a) => a.importId);
  assert.equal(list.length, 2);
  assert(list.every((a) => a.parentMailboxId === 'parent-demo-1' && a.createdById === 'actor-a'));
  assert.equal(new Set(list.map((a) => a.importId)).size, 1);
  const batch = r.api.modules.appleRelay.listImports()[0];
  assert.equal(batch.success, 2);
  assert.equal(batch.actorId, 'actor-a');
  assert.equal(new Set(list.map((a) => a.queryCode)).size, 2);
});

test('错误行、文件内重复、库存重复或伪造列阻止整批登记', () => {
  for (const input of [
    'good@example.test\ninvalid',
    'same@example.test\nsame@example.test',
    'first@icloud.example.test\nother@example.test',
    '邮箱,备注,查询码\ngood@example.test,备注,FORGED'
  ]) {
    const r = runtime();
    r.preview(input);
    r.submit();
    assert.equal(r.hasConfirm(), false);
    assert.equal(r.assets.length, 3);
    assert.equal(r.api.modules.appleRelay.listImports().length, 0);
  }
});

test('批量内容在预检后或确认期间变化、父级变化均零写入', () => {
  const changed = runtime();
  changed.preview('a@example.test');
  changed.set({ content: 'b@example.test' });
  changed.submit();
  assert.equal(changed.hasConfirm(), false);
  assert.equal(changed.assets.length, 3);
  const late = runtime();
  late.preview('a@example.test');
  late.submit();
  late.set({ content: 'b@example.test' });
  late.confirm();
  assert.equal(late.assets.length, 3);
  const parentChanged = runtime();
  parentChanged.preview('a@example.test');
  parentChanged.submit();
  parentChanged.parent().version++;
  parentChanged.confirm();
  assert.equal(parentChanged.assets.length, 3);
});

test('单条确认期间身份、主邮箱状态或库存重复变化阻止写入', () => {
  const identity = runtime();
  identity.newAlias();
  identity.api.state.actor = { id: 'actor-b', name: '乙' };
  identity.confirm();
  assert.equal(identity.assets.length, 3);
  const parentChanged = runtime();
  parentChanged.newAlias();
  parentChanged.parent().status = 'DISABLED';
  parentChanged.confirm();
  assert.equal(parentChanged.assets.length, 3);
  const duplicate = runtime();
  duplicate.newAlias();
  duplicate.assets.push({ id: 'other', type: 'relay', email: 'new-hidden@icloud.example.test' });
  duplicate.confirm();
  assert.equal(duplicate.assets.length, 4);
});

test('禁用父级、禁用隐藏邮箱、缺失专用密码或过期查询码都不能进入可提取库存', () => {
  const r = runtime(),
    a = r.assets[0],
    p = r.parent();
  assert.equal(r.api.modules.appleRelay.isAvailable(a), true);
  p.status = 'DISABLED';
  assert.equal(r.api.modules.appleRelay.isAvailable(a), false);
  p.status = 'ACTIVE';
  a.relayStatus = 'DISABLED';
  assert.equal(r.api.modules.appleRelay.isAvailable(a), false);
  a.relayStatus = 'ACTIVE';
  p.hasCredential = false;
  assert.equal(r.api.modules.appleRelay.isAvailable(a), false);
  p.hasCredential = true;
  a.queryExpiry = '2026-11-03 10:30';
  assert.equal(r.api.modules.appleRelay.isAvailable(a), false);
});

test('查询先同步所属主邮箱且不生成新的 Apple 地址', () => {
  const r = runtime(),
    original = r.assets.length;
  r.tab('query');
  r.query('DEMO-QUERY-1');
  assert.equal(r.parent().lastSyncedAt, '2026-11-03 10:30');
  assert.equal(r.assets.length, original);
  const result = r.tables.find((t) => t.id === 'relay-query-results');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].parentId, 'parent-demo-1');
  r.assets[0].queryExpiry = '2026-01-01 00:00';
  r.query('DEMO-QUERY-1');
  assert.match(r.html, /查询码已到期/);
  assert(!r.tables.some((t) => t.id === 'relay-query-results'));
});

test('同目标同步失败保留上次结果，换查询内容立即清除旧目标数据', () => {
  const r = runtime();
  r.tab('query');
  r.query('DEMO-QUERY-1');
  r.parent().simulateSyncFailure = true;
  r.query('DEMO-QUERY-1');
  assert.match(r.html, /同步失败/);
  const retained = r.tables.find((t) => t.id === 'relay-query-results');
  assert(retained, '失败后必须保留同目标上次结果');
  assert.equal(retained.rows.length, 1);
  r.module.onInput({ id: 'relay-query', value: 'DEMO-QUERY-2' });
  r.table('relay-query-results');
  assert(!r.tables.some((t) => t.id === 'relay-query-results'));
});

test('邮件归属只能分配到同一主邮箱下的隐藏地址', () => {
  const r = runtime();
  r.click('relay-mail-reassign', { id: 'unassigned-parent-demo-1' });
  r.set({ aliasId: 'mail-28' });
  r.submit();
  assert.equal(r.hasConfirm(), false);
  assert.match(r.notices.at(-1), /同一主邮箱/);
  r.set({ aliasId: 'mail-27' });
  r.submit();
  r.confirm();
  r.tab('mails');
  const row = r.tables
    .find((t) => t.id === 'relay-mails')
    .rows.find((m) => m.id === 'unassigned-parent-demo-1');
  assert.equal(row.aliasId, 'mail-27');
  assert.equal(row.parentId, 'parent-demo-1');
});

test('主邮箱或隐藏邮箱存在邮件、领用、注册等引用时拒绝删除', () => {
  const r = runtime();
  for (const [kind, id] of [
    ['parent', 'parent-demo-1'],
    ['alias', 'mail-27']
  ]) {
    r.click('relay-delete', { kind, id });
    r.confirm();
    assert.match(r.notices.at(-1), /不能删除/);
  }
  assert(r.parent());
  assert(!r.assets[0].relayDeleted);
});

test('查询码重置产生新码、旧码失效并保留同一隐藏邮箱编号', () => {
  const r = runtime(),
    a = r.assets[0],
    old = a.queryCode;
  r.click('relay-code-reset', { kind: 'alias', id: a.id });
  r.confirm();
  assert.notEqual(a.queryCode, old);
  assert.equal(a.id, 'mail-27');
  r.tab('query');
  r.query(old);
  assert.match(r.html, /未找到/);
  r.query(a.queryCode);
  assert(r.tables.some((t) => t.id === 'relay-query-results'));
});

test('关闭重开保留旧草稿及原版本，不能用最新版本静默覆盖他人修改', () => {
  const r = runtime(),
    p = r.parent();
  r.click('relay-parent-edit', { id: p.id });
  const originalVersion = r.form.raw['relay-version'];
  r.set({ note: '甲尚未保存的草稿' });
  r.module.preserveDraft();
  r.drawer.close();
  p.note = '乙已保存的更新';
  p.version++;
  r.click('relay-parent-edit', { id: p.id });
  assert.equal(r.form.raw['relay-note'], '甲尚未保存的草稿');
  assert.equal(r.form.raw['relay-version'], originalVersion);
  r.submit();
  assert.equal(r.hasConfirm(), false);
  assert.equal(p.note, '乙已保存的更新');
  assert.match(r.notices.at(-1), /原始资料版本已变化/);
  r.click('relay-reload', { kind: 'parent', id: p.id });
  r.confirm();
  assert.equal(r.form.raw['relay-note'], '乙已保存的更新');
  assert.equal(r.form.raw['relay-version'], String(p.version));
});

test('邮件归属草稿保留原版本和选择，冲突后明确重载才能继续', () => {
  const r = runtime();
  r.tab('mails');
  const row = r.table('relay-mails').rows.find((item) => item.id === 'unassigned-parent-demo-1');
  r.click('relay-mail-reassign', { id: row.id });
  const originalVersion = r.form.raw['relay-version'];
  r.set({ aliasId: 'mail-27' });
  r.module.preserveDraft();
  r.drawer.close();
  row.aliasId = 'mail-27';
  row.version = (row.version || 1) + 1;
  r.click('relay-mail-reassign', { id: row.id });
  assert.equal(r.form.raw['relay-aliasId'], 'mail-27');
  assert.equal(r.form.raw['relay-version'], originalVersion);
  r.submit();
  assert.equal(r.hasConfirm(), false);
  assert.match(r.notices.at(-1), /原始资料版本已变化/);
  r.click('relay-reload', { kind: 'reassign', id: row.id });
  r.confirm();
  assert.equal(r.form.raw['relay-version'], String(row.version));
  assert.equal(r.form.raw['relay-aliasId'], 'mail-27');
  r.submit();
  r.confirm();
  assert.equal(row.aliasId, 'mail-27');
});

test('隐藏邮箱关闭重开恢复有效天数和状态草稿，父级不被改成默认值', () => {
  const r = runtime();
  r.api.modules.appleRelay.openAliasEditor('mail-27');
  r.set({ days: '90', status: 'DISABLED', note: '未保存备注' });
  r.module.preserveDraft();
  r.drawer.close();
  r.api.modules.appleRelay.openAliasEditor('mail-27');
  assert.equal(r.form.raw['relay-days'], '90');
  assert.equal(r.form.raw['relay-status'], 'DISABLED');
  assert.equal(r.form.raw['relay-note'], '未保存备注');
  assert.equal(r.form.raw['relay-parentId'], 'parent-demo-1');
});

test('历史邮件先预览不写入，确认后只修复同父唯一且有明确收件地址的邮件', () => {
  const r = runtime();
  r.tab('mails');
  const rows = r.tables.find((t) => t.id === 'relay-mails').rows;
  const first = rows.find((m) => m.id === 'unassigned-parent-demo-1');
  const second = rows.find((m) => m.id === 'unassigned-parent-demo-2');
  second.recipientAddress = '';
  r.click('relay-history-preview', { id: 'parent-demo-1' });
  assert.equal(first.aliasId, '');
  const candidates = r.tables.find((t) => t.id === 'relay-history-preview').rows;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, 'mail-27');
  r.click('relay-history-apply');
  assert.equal(first.aliasId, '');
  r.confirm();
  assert.equal(first.aliasId, 'mail-27');
  assert.equal(first.parentId, 'parent-demo-1');
  assert.equal(second.aliasId, '');
  r.click('relay-history-preview', { id: 'parent-demo-2' });
  const noEvidence = r.tables.findLast((t) => t.id === 'relay-history-preview').rows;
  assert.equal(noEvidence[0].candidateId, '');
  r.click('relay-history-apply');
  r.confirm();
  assert.equal(second.aliasId, '');
});

test('历史邮件候选或主邮箱在确认期间变化时整批修复停止', () => {
  const r = runtime();
  r.tab('mails');
  const row = r.tables
    .find((t) => t.id === 'relay-mails')
    .rows.find((m) => m.id === 'unassigned-parent-demo-1');
  r.click('relay-history-preview', { id: 'parent-demo-1' });
  r.click('relay-history-apply');
  r.parent().version++;
  r.confirm();
  assert.equal(row.aliasId, '');
  assert.match(r.notices.at(-1), /已变化/);
  r.click('relay-history-preview', { id: 'parent-demo-1' });
  r.click('relay-history-apply');
  row.recipientAddress = 'no-match@example.test';
  r.confirm();
  assert.equal(row.aliasId, '');
  assert.match(r.notices.at(-1), /已变化/);
});

test('邮件搜索先同步，模拟失败可恢复后重试且不生成隐藏邮箱', () => {
  const r = runtime();
  r.tab('mails');
  const count = r.assets.length;
  r.time('2026-11-03 11:00');
  r.module.onInput({ id: 'relay-search', value: '验证码', selectionStart: 3 });
  assert.equal(r.parent().lastSyncedAt, '2026-11-03 11:00');
  assert.equal(r.assets.length, count);
  r.click('relay-sync-failure', { id: 'parent-demo-1' });
  assert.equal(r.parent().simulateSyncFailure, true);
  r.time('2026-11-03 12:00');
  r.click('relay-parent-sync', { id: 'parent-demo-1' });
  assert.equal(r.parent().lastSyncedAt, '2026-11-03 11:00');
  assert.match(r.notices.at(-1), /同步失败/);
  r.click('relay-sync-failure', { id: 'parent-demo-1' });
  r.click('relay-parent-sync', { id: 'parent-demo-1' });
  assert.equal(r.parent().lastSyncedAt, '2026-11-03 12:00');
  assert.equal(r.assets.length, count);
});

test('平台注册状态读取实际登记事件，不把邮箱注册日期或已使用当成平台注册成功', () => {
  const r = runtime(),
    a = r.assets[0];
  a.registered = '2020-01-01';
  a.inventoryState = 'used';
  r.tab('aliases');
  let table = r.tables.find((t) => t.id === 'relay-aliases');
  let column = table.columns.find((c) => c.id === 'registration');
  assert.equal(column.render(a), '未登记注册结果');
  r.api.modules.inventory = {
    registrationRecordsFor: () => [{ state: '待核对', time: '2026-11-03 10:00' }]
  };
  table = r.table('relay-aliases');
  column = table.columns.find((c) => c.id === 'registration');
  assert.equal(column.render(a), '注册结果待核对');
  r.api.modules.inventory.registrationRecordsFor = () => [
    { state: '待核对', time: '2026-11-03 10:00' },
    { state: '成功', time: '2026-11-03 10:30' }
  ];
  assert.equal(column.render(a), '已登记注册');
});

test('导入记录或已归还领用历史仍是引用，不能删除别名后绕过历史关系', () => {
  const imported = runtime();
  imported.preview('history.alias@example.test');
  imported.submit();
  imported.confirm();
  const a = imported.assets.find((row) => row.email === 'history.alias@example.test');
  imported.click('relay-delete', { kind: 'alias', id: a.id });
  imported.confirm();
  assert(!a.relayDeleted);
  assert.match(imported.notices.at(-1), /不能删除/);
  const history = runtime();
  history.newAlias();
  history.confirm();
  const b = history.assets.find((row) => row.email === 'new-hidden@icloud.example.test');
  history.api.modules.inventory = { hasMailboxHistory: (id) => id === b.id };
  history.click('relay-delete', { kind: 'alias', id: b.id });
  history.confirm();
  assert(!b.relayDeleted);
  history.parent().status = 'AUTH_ERROR';
  history.tab('parents');
  const table = history.table('relay-parents');
  assert.equal(table.columns.find((c) => c.id === 'status').render(history.parent()), '授权异常');
});

test('CSV 文件读取后仍需预检，文件名与人员不会进入导入草稿', async () => {
  const r = runtime();
  r.click('relay-import', { parentId: 'parent-demo-1' });
  r.module.onChange({
    id: 'relay-file',
    files: [
      {
        name: 'fictional.csv',
        size: 64,
        text: async () => '邮箱,备注\nfile.hidden@icloud.example.test,演示'
      }
    ]
  });
  await setImmediate();
  assert.match(r.form.raw['relay-content'], /file.hidden/);
  assert(!r.api.state.drafts.get(r.form.dataset.relayDraft)['relay-file']);
  r.submit();
  assert(!r.hasConfirm(), '文件读取不代替预检');
  r.click('relay-import-preview');
  r.submit();
  r.confirm();
  assert(r.assets.some((row) => row.email === 'file.hidden@icloud.example.test'));
});

test('CSV 读取失败、超限或迟到响应保留当前输入，不写另一主邮箱草稿', async () => {
  const r = runtime();
  r.click('relay-import', { parentId: 'parent-demo-1' });
  r.set({ content: 'keep@icloud.example.test' });
  r.module.onChange({
    id: 'relay-file',
    files: [
      {
        name: 'failed.csv',
        size: 32,
        text: async () => {
          throw new Error('fixture');
        }
      }
    ]
  });
  await setImmediate();
  assert.equal(r.form.raw['relay-content'], 'keep@icloud.example.test');
  assert.match(r.notices.at(-1), /读取失败/);
  r.module.onChange({
    id: 'relay-file',
    files: [{ name: 'large.csv', size: 1048577, text: async () => 'wrong' }]
  });
  assert.match(r.notices.at(-1), /1MB/);
  let resolve;
  r.module.onChange({
    id: 'relay-file',
    files: [
      {
        name: 'old.csv',
        size: 32,
        text: () =>
          new Promise((done) => {
            resolve = done;
          })
      }
    ]
  });
  r.set({ parentId: 'parent-demo-2', content: 'manual@icloud.example.test' });
  resolve('old@icloud.example.test');
  await setImmediate();
  assert.equal(r.form.raw['relay-content'], 'manual@icloud.example.test');
});
