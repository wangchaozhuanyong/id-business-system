import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./inventory-prototype.js', import.meta.url), 'utf8');
const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const unpack = (raw) => {
  if (typeof raw !== 'string') throw new TypeError('list value must be text');
  const values = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(/[\n,、]/);
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    throw new TypeError('list entries must be text');
  return values.map((value) => value.trim()).filter(Boolean);
};

// The real inventory module owns configuration, draft registration and submit
// protection. The editor stub captures its shared UI contract; the shared editor
// and actual close/reopen interaction are verified separately by the browser.
function runtime() {
  let sequence = 0,
    callback,
    currentForms = [];
  const drawers = [],
    editors = [],
    selects = [],
    tables = [],
    notices = [],
    inputs = [];
  const fixture = (type, index) => ({
    id: `${type}-${index}`,
    type,
    email: `${type}.${index}@example.test`,
    password: 'Fictional-Only',
    country: '美国',
    source: '线上购买',
    registered: '2026-10-01T10:30',
    status: '正常',
    health: 'normal',
    used: false,
    version: 1
  });
  const mailboxes = Array.from({ length: 15 }, (_, index) => fixture('google', index));
  const accounts = [fixture('gpt', 0), fixture('claude', 0)];
  const state = {
    route: 'mailboxes/google',
    drafts: new Map(),
    page: 1,
    actor: { id: 'demo-actor', name: '演示测试员', role: 'admin' }
  };
  const options = (choices, selected) =>
    choices
      .map((choice) => {
        const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
        return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
  const api = {
    state,
    collections: { mailboxes, accounts },
    modules: {},
    esc,
    icon: () => '',
    tag: String,
    button: () => '',
    textAction: String,
    options,
    select: (id, choices, selected) => {
      selects.push({ id, choices, selected });
      return `<select id="${id}" name="${id}">${options(choices, selected)}</select>`;
    },
    field: (label, id, control) =>
      `<div class="field"><label for="${id}">${label}</label>${control}</div>`,
    input: (id, value = '', attributes = '') => {
      inputs.push({ id, value });
      return `<input id="${id}" name="${id}" value="${esc(value)}" ${attributes} />`;
    },
    optionListEditor: (config) => {
      editors.push(config);
      return `<section data-list="${config.id}"><input type="hidden" name="${config.id}" value="${esc(config.draft?.[config.id] ?? JSON.stringify(config.values))}" /></section>`;
    },
    readOptionList: unpack,
    optionListPending: (form) =>
      Object.entries(form.values).some(([name, value]) =>
        name.endsWith('-pending')
          ? Boolean(String(value).trim())
          : name.endsWith('-editing') && value !== '' && value !== '-1'
      ),
    header: () => '',
    summary: () => '',
    empty: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    table: (columns, rows, scope, id) => {
      tables.push({ columns, rows, scope, id });
      return '';
    },
    getSelection: () => new Set(),
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => '2026-11-03 10:30',
    render: () => {},
    readDraft: (form) => api.readForm(form),
    readForm: (form) => ({ ...form.values }),
    setError: () => {},
    notify: (text) => notices.push(text),
    openDrawer: (title, description, body, footer, context) => {
      state.drawerContext = context;
      drawers.push({ title, description, body, footer, context });
    },
    confirmAction: (_title, _description, accept) => {
      callback = accept;
    }
  };
  const modules = [];
  runInNewContext(source, {
    window: { IDDesignAPI: api, IDDesignModules: modules },
    document: {
      querySelectorAll: () => currentForms,
      querySelector: () => ({ close() {} }),
      getElementById: () => null
    }
  });
  const inventory = modules[0];
  return {
    api,
    inventory,
    drawers,
    editors,
    selects,
    tables,
    notices,
    inputs,
    mailboxes,
    open(route = state.route) {
      state.route = route;
      inventory.onClick('inventory-settings', { dataset: {} });
      return drawers.at(-1);
    },
    form(type = 'google', overrides = {}) {
      const form = {
        id: 'inventory-settings-form',
        dataset: { inventoryDraft: `inventory-settings:${type}` },
        values: {
          'inventory-settings-type': type,
          'inventory-settings-countries': JSON.stringify(['日本']),
          'inventory-settings-sources': JSON.stringify(['自己注册']),
          'inventory-settings-hours': '72',
          ...overrides
        }
      };
      currentForms = [form];
      return form;
    },
    confirm() {
      const accept = callback;
      callback = undefined;
      accept?.();
    },
    pendingConfirmation() {
      return Boolean(callback);
    }
  };
}

test('本表设置使用两组完整项目编辑器，按资料表登记独立草稿', () => {
  const r = runtime();
  const drawer = r.open();
  assert.equal(drawer.context, 'inventory-settings:google');
  assert.match(drawer.body, /data-inventory-draft="inventory-settings:google"/);
  assert.doesNotMatch(drawer.body, /textarea/);
  assert.deepEqual(
    r.editors.map((editor) => editor.id),
    ['inventory-settings-countries', 'inventory-settings-sources']
  );
  assert.deepEqual(Array.from(r.editors[0].values), ['马来西亚', '美国', '日本', '新加坡']);
  assert(r.editors.every((editor) => editor.minItems === 1));
});

test('设置确认后生效且只清当前草稿，其他资料表的配置不受影响', () => {
  const r = runtime();
  r.open();
  const form = r.form();
  r.api.state.drafts.set('inventory-settings:claude', { marker: 'keep' });
  r.inventory.onSubmit(form);
  assert.equal(r.pendingConfirmation(), true);
  r.open();
  assert(Array.from(r.editors.at(-2).values).includes('美国'));
  r.confirm();
  assert.equal(r.api.state.drafts.has('inventory-settings:google'), false);
  assert.equal(r.api.state.drafts.get('inventory-settings:claude').marker, 'keep');
  r.open();
  assert.deepEqual(Array.from(r.editors.at(-2).values), ['日本']);
  r.open('accounts/claude');
  assert(Array.from(r.editors.at(-2).values).includes('美国'));
});

test('关闭前登记的项目列表、未添加输入和编辑状态在同表重开恢复，不污染其他表', () => {
  const r = runtime();
  r.open();
  const form = r.form('google', {
    'inventory-settings-countries': '["日本","德国"]',
    'inventory-settings-countries-pending': '法国',
    'inventory-settings-countries-editing': '1'
  });
  r.inventory.preserveDraft();
  assert.equal(
    r.api.state.drafts.get(form.dataset.inventoryDraft)['inventory-settings-countries-pending'],
    '法国'
  );
  r.open('accounts/apple-balances');
  assert.equal(r.drawers.at(-1).context, 'inventory-settings:apple');
  assert.equal(r.editors.at(-2).draft['inventory-settings-countries-pending'], undefined);
  r.open('mailboxes/google');
  assert.equal(r.editors.at(-2).draft['inventory-settings-countries'], '["日本","德国"]');
  assert.equal(r.editors.at(-2).draft['inventory-settings-countries-pending'], '法国');
  assert.equal(r.editors.at(-2).draft['inventory-settings-countries-editing'], '1');
});

test('尚未添加或尚未保存的单项编辑阻止整表确认，不会静默丢弃输入', () => {
  for (const pending of [
    { 'inventory-settings-countries-pending': '德国' },
    { 'inventory-settings-sources-editing': '0' }
  ]) {
    const r = runtime();
    r.inventory.onSubmit(r.form('google', pending));
    assert.equal(r.pendingConfirmation(), false);
    assert.match(r.notices.at(-1), /请先添加或保存/);
  }
});

test('无效列表、空配置和越界养号小时数不会写入配置', () => {
  for (const changes of [
    { 'inventory-settings-countries': '[invalid' },
    { 'inventory-settings-countries': '[]' },
    { 'inventory-settings-sources': '[]' },
    { 'inventory-settings-hours': '0' },
    { 'inventory-settings-hours': '8761' },
    { 'inventory-settings-hours': '1.5' }
  ]) {
    const r = runtime();
    r.inventory.onSubmit(r.form('claude', changes));
    assert.equal(r.pendingConfirmation(), false);
    assert(r.notices.length);
  }
});

test('移除国家或来源后，编辑旧资料仍保留原值，不静默改到首项', () => {
  const r = runtime();
  r.inventory.onSubmit(r.form());
  r.confirm();
  r.api.state.route = 'mailboxes/google';
  r.inventory.onClick('inventory-edit', { dataset: { id: 'google-12' } });
  const country = r.selects.findLast((entry) => entry.id === 'inventory-country-edit');
  const source = r.selects.findLast((entry) => entry.id === 'inventory-source');
  assert.equal(country.selected, '美国');
  assert.equal(source.selected, '线上购买');
  assert(
    country.choices.some(
      (choice) => Array.isArray(choice) && choice[0] === '美国' && choice[1].includes('已有值')
    )
  );
  assert(
    source.choices.some(
      (choice) => Array.isArray(choice) && choice[0] === '线上购买' && choice[1].includes('已有值')
    )
  );
  assert.equal(r.mailboxes.find((asset) => asset.id === 'google-12').country, '美国');
});

test('被移除的当前筛选国家仍在下拉显示，筛选条件与实际资料一致', () => {
  const r = runtime();
  r.inventory.render();
  r.inventory.onChange({ id: 'inventory-country', value: '美国' });
  r.inventory.onSubmit(r.form());
  r.confirm();
  const html = r.inventory.render();
  assert.match(html, /value="美国" selected>美国（已有值）/);
  assert(r.tables.at(-1).rows.length);
  assert(r.tables.at(-1).rows.every((row) => row.country === '美国'));
});

test('旧换行文本兼容且8760小时上限可保存，重新打开仍正确显示', () => {
  const r = runtime();
  r.api.state.route = 'accounts/claude';
  r.inventory.onSubmit(
    r.form('claude', {
      'inventory-settings-countries': '日本\n德国\n日本',
      'inventory-settings-sources': '自己注册\n线上购买',
      'inventory-settings-hours': '8760'
    })
  );
  r.confirm();
  const drawer = r.open();
  assert.deepEqual(Array.from(r.editors.at(-2).values), ['日本', '德国']);
  assert.match(drawer.body, /value="8760"/);
});

function purposeForm(values, extra = {}) {
  return {
    id: 'inventory-purpose-settings-form',
    dataset: { inventoryDraft: 'inventory-purpose-settings:mail' },
    values: { 'inventory-mail-purposes': JSON.stringify(values), ...extra }
  };
}

test('邮箱提取用途设置更新后续选项，保留历史批次并与账号提取隔离', () => {
  const r = runtime();
  r.api.state.route = 'workspace/mail-extract';
  r.inventory.render();
  const history = JSON.stringify(r.api.modules.inventory.getBatches());
  r.inventory.onClick('inventory-purpose-settings', { dataset: {} });
  assert.equal(r.drawers.at(-1).title, '邮箱提取用途设置');
  assert.deepEqual(Array.from(r.editors.at(-1).values), [
    '注册 Claude', '注册 GPT', '业务备用', '其他', '注册 Gemini', '注册 Grok'
  ]);
  r.inventory.onSubmit(purposeForm(['员工测试', '其他']));
  r.confirm();
  r.inventory.render();
  assert.deepEqual(Array.from(r.selects.findLast(s => s.id === 'inventory-purpose').choices), ['员工测试', '其他']);
  assert.equal(JSON.stringify(r.api.modules.inventory.getBatches()), history);
  r.api.state.route = 'workspace/account-extract';
  r.inventory.render();
  assert.deepEqual(Array.from(r.selects.findLast(s => s.id === 'inventory-purpose').choices), ['客户交付', '比特充值', '业务备用', '其他']);
});

test('用途设置拒绝空清单、重复、控制字符、过长用途及未完成编辑', () => {
  for (const [values, extra] of [[[], {}], [['测试', '测试'], {}], [['API', 'api'], {}], [['无效\n用途'], {}], [['长'.repeat(101)], {}], [['测试'], { 'inventory-mail-purposes-pending': '尚未添加' }]]) {
    const r = runtime();
    r.api.state.route = 'workspace/mail-extract';
    r.inventory.onSubmit(purposeForm(values, extra));
    assert.equal(r.pendingConfirmation(), false);
    assert(r.notices.length);
  }
});

test('已删除用途的提取草稿提示重选，不能静默换首项或继续提取', () => {
  const r = runtime(), errors = new Map();
  r.api.state.route = 'workspace/mail-extract';
  r.api.setError = (id, message) => errors.set(id, message);
  r.api.state.drafts.set('inventory-extract:mail', { 'inventory-purpose': '注册 Claude' });
  r.inventory.onSubmit(purposeForm(['业务备用']));
  r.confirm();
  const html = r.inventory.render();
  assert.match(html, /原用途已移除，请重新选择/);
  assert.equal(r.selects.findLast(s => s.id === 'inventory-purpose').selected, '');
  r.inventory.onSubmit({ id: 'inventory-extract-form', values: { 'inventory-kind': 'mail', 'inventory-extract-type': 'google', 'inventory-quantity': '1', 'inventory-purpose': '注册 Claude' } });
  assert.equal(r.pendingConfirmation(), false);
  assert.match(errors.get('inventory-purpose'), /当前有效/);
});
