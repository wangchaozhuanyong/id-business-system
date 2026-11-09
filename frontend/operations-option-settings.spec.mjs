import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./operations-prototype.js', import.meta.url), 'utf8');
const escape = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const readOptions = (raw) => {
  let values = raw;
  if (!Array.isArray(values)) {
    try {
      values = JSON.parse(String(raw));
    } catch {
      values = String(raw || '').split(/[、,\r\n]+/);
    }
  }
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(String)
        .map((v) => v.trim())
        .filter(Boolean)
    )
  ];
};

// Exercise the real operations module with fictional data. Shared option-list
// rendering is captured as an API contract, not represented as browser proof.
function runtime() {
  let seq = 0,
    pendingConfirm,
    mainForm = null;
  const editors = [],
    drawers = [],
    notices = [],
    errors = new Map(),
    focused = [];
  const state = { route: 'settings/accounts', drafts: new Map(), tasks: [], query: '', page: 1 };
  const api = {
    state,
    modules: {},
    collections: { mailboxes: [], accounts: [] },
    money: {},
    esc: escape,
    icon: () => '',
    tag: String,
    textAction: String,
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    field: (label, id, control) => `<div><label for="${id}">${label}</label>${control}</div>`,
    input: (id, value = '', attrs = '') =>
      `<input id="${id}" name="${id}" value="${escape(value)}" ${attrs} />`,
    select: (id, choices, value = '') =>
      `<select id="${id}" name="${id}" data-value="${escape(value)}">${choices.map((v) => `<option>${escape(Array.isArray(v) ? v[1] : v)}</option>`).join('')}</select>`,
    header: (title, _desc, actions = '') => `<h1>${title}</h1>${actions}`,
    titleInfo: () => '',
    empty: () => '',
    table: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    getSelection: () => new Set(),
    notify: (message) => notices.push(message),
    setError: (id, message) => errors.set(id, message),
    newId: (prefix) => `${prefix}-${++seq}`,
    nowText: () => '2026-11-04 10:30',
    readForm: (form) => ({ ...form.values }),
    optionListPending: (form) => Boolean(form.pending),
    readOptionList: readOptions,
    optionListEditor: (config) => {
      editors.push(config);
      return `<section data-option-editor="${config.id}"></section>`;
    },
    openDrawer: (title, description, body, footer, context) => {
      state.drawerContext = context;
      drawers.push({ title, description, body, footer, context });
    },
    closeDrawer: () => {
      state.drawerContext = '';
    },
    confirmAction: (title, message, callback) => {
      pendingConfirm = { title, message, callback };
    },
    render: () => {},
    go: () => {},
    copyText: () => {}
  };
  const modules = [];
  runInNewContext(source, {
    window: { IDDesignAPI: api, IDDesignModules: modules },
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: (selector) => (selector === '#main form' ? mainForm : null),
      getElementById: (id) => ({ focus: () => focused.push(id) })
    },
    URL
  });
  const module = modules.find((entry) => entry.id === 'operations');
  const form = (id, values, pending = false) => ({
    id,
    values,
    pending,
    querySelectorAll: () => []
  });
  return {
    api,
    state,
    module,
    editors,
    drawers,
    notices,
    errors,
    focused,
    form,
    setMain: (value) => {
      mainForm = value;
    },
    confirmation: () => pendingConfirm,
    accept: () => {
      const pending = pendingConfirm;
      pendingConfirm = null;
      pending?.callback();
    },
    security: () => {
      state.route = 'settings/accounts';
      module.onClick('ops-staff-tab', { dataset: { tab: 'security' } });
      module.render();
    }
  };
}

test('安全中心使用受保护IP列表，切页签后保留已添加项与输入编辑草稿', () => {
  const c = runtime();
  c.security();
  assert.equal(c.editors.at(-1).id, 'ops-security-ip');
  assert.deepEqual(Array.from(c.editors.at(-1).protectedValues), ['127.0.0.1']);
  const values = {
    'ops-security-mfa': '保持原策略',
    'ops-security-ip': '["127.0.0.1","192.0.2.1"]',
    'ops-security-ip-pending': '192.0.2.2',
    'ops-security-ip-editing': ''
  };
  c.setMain(c.form('ops-security-form', values));
  c.module.onClick('ops-staff-tab', { dataset: { tab: 'staff' } });
  c.setMain(null);
  c.module.onClick('ops-staff-tab', { dataset: { tab: 'security' } });
  c.module.render();
  const restored = c.editors.at(-1);
  assert.deepEqual(Array.from(restored.values), ['127.0.0.1', '192.0.2.1']);
  assert.equal(restored.draft['ops-security-ip-pending'], '192.0.2.2');
});

test('安全设置拒绝未添加项和移除当前IP，非超级管理员仍无保存权限', () => {
  for (const [ips, pending] of [
    ['["192.0.2.1"]', false],
    ['["127.0.0.1"]', true]
  ]) {
    const c = runtime(),
      form = c.form(
        'ops-security-form',
        { 'ops-security-ip': ips, 'ops-security-mfa': '保持原策略' },
        pending
      );
    c.setMain(form);
    c.module.onSubmit(form);
    assert.equal(c.confirmation(), undefined);
    if (pending) assert.match(c.notices.at(-1), /先添加或取消/);
    else assert.match(c.errors.get('ops-security-ip'), /127\.0\.0\.1/);
  }
  const c = runtime();
  c.module.onChange({ id: 'ops-role-preview', value: 'admin' });
  c.module.onSubmit(c.form('ops-security-form', { 'ops-security-ip': '["127.0.0.1"]' }));
  assert.equal(c.confirmation(), undefined);
  assert.match(c.notices.at(-1), /无修改权限/);
});

test('安全IP保存兼容逗号列表，只清提交快照而保留后来编辑和其他草稿', () => {
  const c = runtime(),
    values = { 'ops-security-mfa': '保持原策略', 'ops-security-ip': '["127.0.0.1","192.0.2.1"]' };
  c.state.drafts.set('operations:resource:cards:card-demo-2', { marker: 'keep' });
  const form = c.form('ops-security-form', values);
  c.setMain(form);
  c.module.onSubmit(form);
  assert(c.confirmation());
  c.accept();
  assert.equal(c.state.drafts.has('operations:security'), false);
  assert.equal(c.state.drafts.get('operations:resource:cards:card-demo-2').marker, 'keep');
  c.setMain(null);
  c.security();
  assert.deepEqual(Array.from(c.editors.at(-1).values), ['127.0.0.1', '192.0.2.1']);
  c.setMain(form);
  c.module.onSubmit(form);
  c.state.drafts.set('operations:security', { ...values, 'ops-security-ip-pending': '192.0.2.2' });
  c.accept();
  assert.equal(c.state.drafts.get('operations:security')['ops-security-ip-pending'], '192.0.2.2');
});
