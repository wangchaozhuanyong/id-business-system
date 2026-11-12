import assert from 'node:assert/strict';
import * as listOrder from './list-order.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./inventory-prototype.js', import.meta.url), 'utf8');
const core = await readFile(new URL('./prototype.js', import.meta.url), 'utf8');
const apple = await readFile(new URL('./apple-balance-prototype.js', import.meta.url), 'utf8');
const parseCsv = runInNewContext(
  `${core.slice(core.indexOf('function parseCsv('), core.indexOf('function validateImport('))}; parseCsv`
);
const escape = (value = '') =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const decode = (value = '') =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const attrs = (value) =>
  Object.fromEntries(
    [...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((match) => [
      match[1],
      decode(match[2] ?? '')
    ])
  );
function defaults(html) {
  const values = {};
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const item = attrs(match[1]);
    if (item.name && item.type !== 'file' && (item.type !== 'checkbox' || 'checked' in item))
      values[item.name] = item.type === 'checkbox' ? 'on' : item.value || '';
  }
  for (const match of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const item = attrs(match[1]);
    if (item.name) values[item.name] = decode(match[2]);
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const item = attrs(match[1]);
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)].map((row) => attrs(row[1]));
    const selected = options.find((option) => 'selected' in option) || options[0];
    if (item.name && selected) values[item.name] = selected.value;
  }
  return values;
}

// Exercise the public module handlers with fictional assets and the real CSV
// parser. The DOM shim models form-associated preview controls and snapshots.
function runtime() {
  let sequence = 0,
    form = null,
    opened = null,
    callback = null,
    preview = '';
  const captures = [],
    notices = [],
    errors = new Map();
  const accounts = [],
    mailboxes = [];
  const decimal = (amount) => {
    const [whole, fraction = ''] = String(amount).split('.');
    return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  };
  const format = (amount) => `${amount / 10000n}.${String(amount % 10000n).padStart(4, '0')}`;
  const output = {
    get innerHTML() {
      return preview;
    },
    set innerHTML(html) {
      preview = html;
      if (form) {
        for (const key of Object.keys(form.raw))
          if (key.startsWith('inventory-import-row-type-')) delete form.raw[key];
        Object.assign(form.raw, defaults(html));
      }
    }
  };
  const drawer = {
    close() {
      form = null;
    }
  };
  const document = {
    querySelector: (selector) => (selector === '#drawer' ? drawer : null),
    querySelectorAll: () => (form ? [form] : []),
    getElementById: (id) => {
      if (id === 'inventory-import-results') return output;
      if (id === form?.id) return form;
      return {
        focus() {},
        get value() {
          return form?.raw[id] ?? '';
        },
        set value(value) {
          if (form) form.raw[id] = value;
        }
      };
    }
  };
  const api = {
    state: {
      route: 'workspace/account-submit',
      drafts: new Map(),
      actor: { id: 'test-actor', name: '演示测试员', role: 'admin' }
    },
    collections: { accounts, mailboxes },
    modules: {},
    legacy: { parseCsv },
    esc: escape,
    operatorIdProperty: (label, id) => `<div>${escape(label)} ${escape(id || '历史未记录')}</div>`,
    icon: () => '',
    options: (choices, selected) =>
      choices
        .map((choice) => {
          const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
          return `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`;
        })
        .join(''),
    select: (id, choices, selected) =>
      `<select id="${id}" name="${id}">${api.options(choices, selected)}</select>`,
    input: (id, value = '', extra = '') =>
      `<input id="${id}" name="${id}" value="${escape(value)}" ${extra} />`,
    field: (label, id, control) =>
      `<div class="field"><label for="${id}">${label}</label>${control}</div>`,
    button: (label, action, _kind, _icon, extra = '') =>
      `<button data-action="${action}" ${extra}>${escape(label)}</button>`,
    textAction: (label) => label,
    tag: (label) => `<span>${escape(label)}</span>`,
    header: (title, description, actions = '') => `<h1>${title}</h1>${description}${actions}`,
    summary: () => '',
    empty: (title) => title,
    pagination: () => '',
    pageRows: (rows) => rows,
    table: (columns, rows, scope, id) => {
      captures.push({ columns, rows, scope, id });
      return `<table>${rows.map((row) => `<tr>${columns.map((col) => `<td>${col.render ? col.render(row) : escape(row[col.id] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
    },
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => '2026-11-03 10:30',
    readDraft: (form) => api.readForm(form),
    readForm: (target) => ({ ...target.raw }),
    setError: (name, error) => errors.set(name, error),
    notify: (text) => notices.push(text),
    render() {},
    go(route) {
      api.state.route = route;
    },
    getSelection: () => new Set(),
    confirmAction: (_title, _description, action) => {
      callback = action;
    },
    openDrawer: (title, description, body, footer, context) => {
      opened = { title, description, body, footer, context };
      const node = attrs(body.match(/<form\b([^>]*)>/)?.[1] || '');
      form = node.id
        ? {
            id: node.id,
            raw: defaults(body),
            dataset: { inventoryDraft: node['data-inventory-draft'] || context },
            querySelectorAll: () => []
          }
        : null;
    },
    closeDrawer: () => {
      inventory.preserveDraft();
      form = null;
    },
    money: {
      units: decimal,
      formatUnits: format,
      add: (a, b) => format(decimal(a) + decimal(b)),
      subtract: (a, b) => format(decimal(a) - decimal(b)),
      compare: (a, b) => (decimal(a) < decimal(b) ? -1 : decimal(a) > decimal(b) ? 1 : 0)
    }
  };
  const modules = [];
  const context = { window: { IDDesignAPI: api, IDListOrder: listOrder, IDDesignModules: modules }, document, URL };
  runInNewContext(source, context);
  runInNewContext(apple, context);
  const inventory = modules.find((module) => module.id === 'inventory');
  inventory.render();
  return {
    api,
    inventory,
    accounts,
    mailboxes,
    captures,
    errors,
    notices,
    get form() {
      return form;
    },
    get opened() {
      return opened;
    },
    get pending() {
      return Boolean(callback);
    },
    open(type, action = 'inventory-import') {
      callback = null;
      inventory.onClick(action, { dataset: { type } });
      return form;
    },
    preview(changes = {}) {
      Object.assign(form.raw, changes);
      inventory.onSubmit(form);
      return captures.at(-1);
    },
    requestImport() {
      inventory.onClick('inventory-import-confirm', { dataset: {} });
    },
    confirm() {
      assert(callback, notices.at(-1) || JSON.stringify([...errors]));
      const action = callback;
      callback = null;
      action();
      return action;
    }
  };
}

function addGpt(r, email = 'provenance@example.test') {
  r.open('gpt', 'inventory-add-type');
  Object.assign(r.form.raw, {
    'inventory-email': email,
    'inventory-password': 'Demo-Only',
    'inventory-country-edit': '美国',
    'inventory-city': '纽约',
    'inventory-createdBy': '伪造人',
    'inventory-createdById': 'forged-id',
    'inventory-lastOperatedBy': '伪造最近操作人'
  });
  r.inventory.onSubmit(r.form);
  r.confirm();
  return r.accounts.find((row) => row.email === email);
}

test('新增资产自动记录登录操作人和稳定编号，不能从表单伪造录入人', () => {
  const r = runtime(),
    row = addGpt(r);
  assert.equal(row.createdById, 'test-actor');
  assert.equal(row.createdBy, '演示测试员');
  assert.equal(row.createdAt, '2026-11-03 10:30');
  assert.equal(row.lastOperatedById, 'test-actor');
  assert.equal(row.lastOperatedBy, '演示测试员');
  assert.equal(row.lastOperatedAt, row.createdAt);
  assert.equal(row.inventoryHistory.at(-1).actorId, 'test-actor');
});

test('换操作人编辑保留原录入人，只更新最近操作和事件来源', () => {
  const r = runtime(),
    row = addGpt(r);
  r.api.state.actor = { id: 'editor-2', name: '第二位编辑员', role: 'admin' };
  r.api.nowText = () => '2026-11-03 11:15';
  r.api.state.route = 'accounts/gpt';
  r.inventory.onClick('inventory-edit', { dataset: { id: row.id } });
  r.form.raw['inventory-notes'] = '第二位编辑';
  r.form.raw['inventory-createdBy'] = '篡改录入人';
  r.inventory.onSubmit(r.form);
  r.confirm();
  assert.equal(row.createdById, 'test-actor');
  assert.equal(row.createdBy, '演示测试员');
  assert.equal(row.createdAt, '2026-11-03 10:30');
  assert.equal(row.lastOperatedById, 'editor-2');
  assert.equal(row.lastOperatedBy, '第二位编辑员');
  assert.equal(row.lastOperatedAt, '2026-11-03 11:15');
  assert.equal(row.inventoryHistory.at(-1).actorId, 'editor-2');
  assert.equal(row.notes, '第二位编辑');
});

test('账号状态操作单独留痕，不覆盖录入人且最近操作含状态操作', () => {
  const r = runtime(),
    row = addGpt(r);
  r.api.state.actor = { id: 'status-actor', name: '状态操作员', role: 'admin' };
  r.inventory.onClick('inventory-health', { dataset: { id: row.id, health: 'dead' } });
  r.confirm();
  assert.equal(row.health, 'dead');
  assert.equal(row.createdBy, '演示测试员');
  assert.equal(row.lastOperatedBy, '状态操作员');
  assert.equal(row.inventoryHistory.at(-1).actorId, 'status-actor');
});

test('批量导入同时记录每条资产来源和批次操作人，不从CSV读取人员', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': '邮箱,密码,国家,城市\nimport.actor@example.test,Demo,美国,纽约' });
  r.requestImport();
  r.confirm();
  const row = r.accounts.find((entry) => entry.email === 'import.actor@example.test');
  assert.equal(row.createdBy, '演示测试员');
  assert.equal(row.createdById, 'test-actor');
  assert.equal(row.inventoryHistory.at(-1).actorId, 'test-actor');
  r.api.state.route = 'accounts/gpt';
  r.inventory.onClick('inventory-tab', { dataset: { tab: 'imports' } });
  r.inventory.render();
  const table = r.captures.findLast((entry) => entry.rows.some((item) => item.id === row.importId));
  assert(table);
  const batch = table.rows.find((entry) => entry.id === row.importId);
  assert.equal(batch.actorId, 'test-actor');
  assert.equal(batch.actor, '演示测试员');
});

test('CSV人员列被拒绝，不导入伪造来源', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': '邮箱,密码,录入人\nforged@example.test,Demo,伪造人' });
  r.requestImport();
  assert.equal(r.pending, false);
  assert.equal(r.accounts.length, 0);
});

test('旧资产缺历史来源明确显示历史未记录，当前管理员不被补为录入人', () => {
  const r = runtime();
  const row = {
    id: 'legacy-gpt',
    type: 'gpt',
    email: 'legacy@example.test',
    country: '美国',
    status: '正常'
  };
  r.accounts.push(row);
  r.api.state.route = 'accounts/gpt';
  r.inventory.render();
  const table = r.captures.findLast((entry) => entry.rows.includes(row));
  assert(table);
  for (const id of ['createdBy', 'createdAt', 'lastOperatedBy', 'lastOperatedAt']) {
    const col = table.columns.find((entry) => entry.id === id);
    assert(col, `缺少 ${id}`);
    assert.equal(col.render(row), '历史未记录');
  }
  assert.equal(row.createdBy, undefined);
  assert.equal(row.createdById, undefined);
  r.inventory.onClick('inventory-detail', { dataset: { id: row.id } });
  assert.match(r.opened.body, /录入人<\/span><strong>历史未记录/);
});

test('注册结果首次登记与再次核对分别记录实际人员，不覆盖首次登记人', () => {
  const r = runtime();
  const row = {
    id: 'registration-mail',
    type: 'google',
    email: 'registration@example.test',
    status: '正常'
  };
  r.mailboxes.push(row);
  r.inventory.onClick('inventory-register', { dataset: { id: row.id } });
  Object.assign(r.form.raw, {
    'inventory-registration-product': 'gpt',
    'inventory-registration-result': '待核对'
  });
  r.inventory.onSubmit(r.form);
  r.confirm();
  r.api.state.actor = { id: 'reviewer', name: '结果核对员', role: 'admin' };
  r.api.nowText = () => '2026-11-03 12:00';
  r.inventory.onClick('inventory-register', { dataset: { id: row.id } });
  r.form.raw['inventory-registration-result'] = '成功';
  r.inventory.onSubmit(r.form);
  r.confirm();
  r.api.state.route = 'mailboxes/google';
  r.inventory.onClick('inventory-tab', { dataset: { tab: 'registrations' } });
  r.inventory.render();
  const table = r.captures.findLast((entry) => entry.id === '注册记录');
  assert(table);
  assert.equal(table.rows.length, 1);
  const record = table.rows[0];
  assert.equal(record.createdById, 'test-actor');
  assert.equal(record.createdBy, '演示测试员');
  assert.equal(record.createdAt, '2026-11-03 10:30');
  assert.equal(record.actorId, 'reviewer');
  assert.equal(record.actor, '结果核对员');
  assert.equal(record.time, '2026-11-03 12:00');
  assert.equal(record.state, '成功');
});
