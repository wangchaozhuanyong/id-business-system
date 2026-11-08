import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./inventory-prototype.js', import.meta.url), 'utf8');
const core = await readFile(new URL('./prototype.js', import.meta.url), 'utf8');
const parseCsv = runInNewContext(
  `${core.slice(core.indexOf('function parseCsv('), core.indexOf('function validateImport('))}; parseCsv`
);
const encode = (value = '') =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const json = (value) => JSON.parse(JSON.stringify(value));
const original = {
  id: 'claude-legacy',
  type: 'claude',
  email: 'legacy@example.test',
  country: '美国',
  city: '旧城',
  source: '自己注册',
  emailType: 'google',
  status: '正常',
  health: 'normal',
  inventoryState: 'available',
  version: 1
};

function setup(snapshot) {
  const accounts = [{ ...original }];
  const state = {
    route: 'accounts/claude',
    page: 1,
    drafts: new Map(),
    actor: { id: 'operator', name: '测试管理员', role: 'admin' }
  };
  const editors = [],
    selections = [],
    tables = [],
    errors = new Map();
  let opened,
    activeForm,
    pending,
    saved,
    preview = '';
  const options = (choices, selected) =>
    choices
      .map((choice) => {
        const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
        return `<option value="${encode(value)}" ${value === selected ? 'selected' : ''}>${encode(label)}</option>`;
      })
      .join('');
  const api = {
    state,
    collections: { accounts, mailboxes: [] },
    modules: {},
    legacy: { parseCsv },
    esc: encode,
    icon: () => '',
    header: () => '',
    summary: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    button: () => '',
    textAction: () => '',
    empty: () => '',
    tag: String,
    table(_columns, rows) {
      tables.push(rows);
      return '';
    },
    getSelection: () => new Set(),
    newId: (prefix) => `${prefix}-one`,
    nowText: () => '2026-11-03 10:30',
    options,
    select(id, choices, selected) {
      selections.push({ id, choices, selected });
      return `<select id="${id}">${options(choices, selected)}</select>`;
    },
    field: (label, id, body) => `<label for="${id}">${label}</label>${body}`,
    input: (id, value) => `<input id="${id}" value="${encode(value)}" />`,
    optionListEditor(config) {
      editors.push(config);
      return `<section data-city-editor="${config.id}">${encode(config.label)}</section>`;
    },
    readOptionList(raw) {
      const values = typeof raw === 'string' ? JSON.parse(raw) : [];
      if (!Array.isArray(values)) throw new Error('格式错误');
      return values;
    },
    optionListPending: () => false,
    readDraft: (form) => api.readForm(form),
    readForm: (form) => ({ ...form.values }),
    setError: (key, value) => errors.set(key, value),
    notify() {},
    render() {},
    openDrawer(_title, _help, body, _footer, context) {
      opened = { body, context };
    },
    confirmAction(_title, _help, accept) {
      pending = accept;
    }
  };
  const controls = new Map();
  const document = {
    getElementById(id) {
      if (id === activeForm?.id) return activeForm;
      if (id === 'inventory-import-results') {
        return {
          get innerHTML() {
            return preview;
          },
          set innerHTML(value) {
            preview = value;
          }
        };
      }
      if (!controls.has(id)) controls.set(id, { value: '', innerHTML: '', focus() {} });
      return controls.get(id);
    },
    querySelector: (selector) => selector === '#drawer[open] form[data-inventory-draft]'
      ? activeForm
      : selector === '#main form[data-inventory-draft]' ? null : { close() {} },
    querySelectorAll: () => (activeForm ? [activeForm] : [])
  };
  const localData = snapshot
    ? {
        actor: () => state.actor,
        async load() {
          return structuredClone(snapshot);
        },
        async save(domain, version, data, options) {
          saved = { domain, version: version + 1, data, action: options.action };
          return structuredClone(saved);
        }
      }
    : undefined;
  const modules = [];
  runInNewContext(source, {
    window: { IDDesignAPI: api, IDDesignModules: modules, IDLocalData: localData },
    document,
    structuredClone,
    URL
  });
  const inventory = modules[0];
  if (!snapshot) inventory.render();
  return {
    inventory,
    api,
    accounts,
    editors,
    selections,
    tables,
    errors,
    controls,
    get pending() {
      return Boolean(pending);
    },
    get saved() {
      return saved;
    },
    get preview() {
      return preview;
    },
    click(action, dataset = {}) {
      inventory.onClick(action, { dataset });
      return opened;
    },
    form(id, values, querySelector) {
      activeForm = { id, values, querySelector, isConnected: true,
        dataset: { inventoryDraft: opened.context },
        removeAttribute(name) {
          if (name === 'data-inventory-draft') delete this.dataset.inventoryDraft;
        }
      };
      return activeForm;
    },
    confirm() {
      assert(pending);
      const callback = pending;
      pending = undefined;
      callback();
    }
  };
}

const settingsFields = (countries) => ({
  'inventory-settings-type': 'claude',
  'inventory-settings-countries': JSON.stringify(countries),
  'inventory-settings-sources': '["自己注册"]',
  'inventory-settings-hours': '72'
});
const assetFields = (country, city, row = null) => ({
  'inventory-asset-id': row?.id || '',
  'inventory-version': row ? String(row.version) : '',
  'inventory-asset-type': 'claude',
  'inventory-email': row?.email || 'new@example.test',
  'inventory-country-edit': country,
  'inventory-city': city,
  'inventory-source': '自己注册',
  'inventory-status-edit': '正常',
  'inventory-device': '隔离测试设备',
  'inventory-proxy-url': 'socks5://proxy.example.test:1080',
  'inventory-proxy-protocol': 'socks5',
  'inventory-emailType': 'google'
});
const editorFor = (app, country) =>
  app.editors.findLast(({ label }) => label === `${country} · 注册城市`);
const citySelect = (app) => app.selections.findLast(({ id }) => id === 'inventory-city');
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('旧版配置读出默认城市，同一抽屉添加国家后立即出现独立城市编辑器并保存', async () => {
  const initial = {
    version: 2,
    data: {
      accounts: [original],
      tableSettings: [['claude', { countries: ['日本'], sources: ['自己注册'], hours: 72 }]]
    }
  };
  const app = setup(initial);
  await flush();
  app.click('inventory-settings');
  assert.deepEqual(json(editorFor(app, '日本').values), ['东京', '大阪']);
  const raw = settingsFields(['日本', '加拿大']);
  const japan = editorFor(app, '日本');
  raw[japan.id] = '["札幌"]';
  raw[`${japan.id}-pending`] = '横滨';
  const groups = { dataset: { countries: '["日本"]' }, innerHTML: '' };
  const form = app.form('inventory-settings-form', raw, () => groups);
  app.inventory.preserveDraft();
  const canada = editorFor(app, '加拿大');
  assert(canada && groups.innerHTML.includes(canada.id));
  assert.equal(editorFor(app, '日本').draft[`${japan.id}-pending`], '横滨');
  assert.equal(editorFor(app, '日本').draft[japan.id], '["札幌"]');
  delete raw[`${japan.id}-pending`];
  raw[canada.id] = '["多伦多","温哥华"]';
  app.inventory.onSubmit(form);
  app.confirm();
  await flush();
  assert.equal(app.saved.action, 'inventory_table_settings');
  assert.deepEqual(json(app.saved.data.tableSettings[0][1].cities), [
    ['日本', ['札幌']],
    ['加拿大', ['多伦多', '温哥华']]
  ]);
  const reloaded = setup(app.saved);
  await flush();
  reloaded.click('inventory-settings');
  assert.deepEqual(json(editorFor(reloaded, '加拿大').values), ['多伦多', '温哥华']);
  assert.deepEqual(json(editorFor(reloaded, '日本').values), ['札幌']);
});

test('切换注册国家不代选，移除选项后只允许原账号保留原国家城市', () => {
  const app = setup();
  app.click('inventory-settings');
  const raw = settingsFields(['日本']);
  raw[editorFor(app, '日本').id] = '["札幌"]';
  app.inventory.onSubmit(app.form('inventory-settings-form', raw));
  app.confirm();

  const saved = app.click('inventory-edit', { id: original.id });
  assert.match(saved.body, /旧城（已有值）/);
  const edit = app.form('inventory-asset-form', assetFields('美国', '旧城', original));
  app.inventory.onSubmit(edit);
  app.confirm();
  assert.equal(app.accounts.find((row) => row.id === original.id).city, '旧城');

  app.click('inventory-add-type', { type: 'claude' });
  assert.deepEqual(json(citySelect(app).choices), [['', '请先选择注册国家']]);
  const form = app.form('inventory-asset-form', assetFields('日本', '纽约'));
  app.inventory.onChange({ id: 'inventory-country-edit', value: '日本', form });
  const cityControl = app.controls.get('inventory-city');
  assert.match(cityControl.innerHTML, /value="" selected/);
  assert.match(cityControl.innerHTML, /札幌/);
  assert.doesNotMatch(cityControl.innerHTML, /旧城|纽约/);
  app.inventory.onSubmit(form);
  assert.equal(app.pending, false);
  assert.match(app.errors.get('inventory-city'), /不在所选国家/);
  form.values['inventory-city'] = '札幌';
  app.inventory.onSubmit(form);
  app.confirm();
  assert.equal(app.accounts.find((row) => row.email === 'new@example.test').city, '札幌');
});

test('工作台和 Claude 本表批导共用城市配置，代理拆分不更改注册地点', () => {
  const app = setup();
  app.click('inventory-settings');
  const settings = settingsFields(['美国']);
  settings[editorFor(app, '美国').id] = '["Washington, D.C.","芝加哥"]';
  app.inventory.onSubmit(app.form('inventory-settings-form', settings));
  app.confirm();

  const fromTable = app.click('inventory-import', { type: 'claude' });
  assert.match(fromTable.body, /inventory-import-form/);
  const tableForm = app.form('inventory-import-form', {
    'inventory-import-type': 'claude',
    'inventory-import-content': 'table@example.test,,,美国,纽约,,claude,合成设备,socks5://proxy.example.test:1080'
  });
  app.inventory.onSubmit(tableForm);
  assert.match(app.tables.at(-1)[0].error, /不在所选国家/);
  tableForm.values['inventory-import-content'] = 'table@example.test,,,美国,芝加哥,,claude,合成设备,socks5://proxy.example.test:1080';
  app.inventory.onSubmit(tableForm);
  assert.equal(app.tables.at(-1)[0].error, '');

  app.api.state.route = 'workspace/account-submit';
  const drawer = app.click('inventory-import', { type: 'claude' });
  assert.match(drawer.body, /&quot;Washington, D\.C\.&quot;/);
  const form = app.form('inventory-import-form', {
    'inventory-import-scope': 'account-submit',
    'inventory-import-locked-type': 'claude',
    'inventory-import-type': 'claude',
    'inventory-import-email-type': 'google',
    'inventory-import-content':
      '邮箱,注册国家,注册城市,注册代理链接,登录设备\nimport@example.test,美国,纽约,socks5://user:secret@proxy.example.test:1080,合成设备'
  });
  app.inventory.onSubmit(form);
  assert.match(app.tables.at(-1)[0].error, /不在所选国家/);
  form.values['inventory-import-content'] = form.values['inventory-import-content'].replace(
    '纽约',
    '芝加哥'
  );
  app.inventory.onSubmit(form);
  const record = app.tables.at(-1)[0];
  assert.equal(record.error, '');
  assert.equal(record.city, '芝加哥');
  assert.equal(record.fields.proxyHost, 'proxy.example.test');
  assert.equal(record.fields.proxyPort, '1080');
});

test('新增 Claude 默认 SOCKS5，编辑和草稿保留已选协议', () => {
  const app = setup();
  app.click('inventory-add-type', { type: 'claude' });
  assert.equal(app.selections.findLast(row => row.id === 'inventory-proxy-protocol').selected, 'socks5');
  app.api.state.drafts.set('inventory-edit:new:claude', { 'inventory-proxy-protocol': '' });
  app.click('inventory-add-type', { type: 'claude' });
  assert.equal(app.selections.findLast(row => row.id === 'inventory-proxy-protocol').selected, 'socks5');
  app.api.state.drafts.set('inventory-edit:new:claude', { 'inventory-proxy-protocol': 'https' });
  app.click('inventory-add-type', { type: 'claude' });
  assert.equal(app.selections.findLast(row => row.id === 'inventory-proxy-protocol').selected, 'https');
  app.accounts[0].proxyProtocol = 'http';
  app.click('inventory-edit', { id: app.accounts[0].id });
  assert.equal(app.selections.findLast(row => row.id === 'inventory-proxy-protocol').selected, 'http');
});

test('代理链接自动拆分四项，识别协议和编码凭据，支持四段格式', () => {
  const app = setup();
  const control = (name, value = '') => {
    const node = { id: `inventory-proxy-${name}`, value };
    app.controls.set(node.id, node);
    return node;
  };
  const protocol = control('protocol', 'socks5');
  const link = control('url');
  for (const name of ['host', 'port', 'user', 'pass']) control(name);
  const cases = [
    ['socks5://demo:sample%40value@proxy.example.test:1088', 'socks5', 'proxy.example.test', '1088', 'demo', 'sample@value'],
    ['https://demo:sample@proxy.example.test:8443', 'https', 'proxy.example.test', '8443', 'demo', 'sample'],
    ['proxy.example.test:1090:demo:sample:with:colon', 'https', 'proxy.example.test', '1090', 'demo', 'sample:with:colon'],
    ['socks5://[2001:db8::1]:1080', 'socks5', '[2001:db8::1]', '1080', '', ''],
    ['proxy.example.test:1080', 'socks5', 'proxy.example.test', '1080', '', '']
  ];
  for (const [url, scheme, ...values] of cases) {
    link.value = url;
    app.inventory.onInput(link);
    assert.equal(app.errors.get(link.id), '');
    assert.equal(protocol.value, scheme);
    assert.deepEqual(['host', 'port', 'user', 'pass'].map(name => app.controls.get(`inventory-proxy-${name}`).value), values);
  }
  const before = ['host', 'port', 'user', 'pass'].map(name => app.controls.get(`inventory-proxy-${name}`).value);
  for (const invalid of ['proxy.example.test:70000', 'ftp://proxy.example.test:1080', 'socks5://bad host:1080']) {
    link.value = invalid;
    app.inventory.onInput(link);
    assert.ok(app.errors.get(link.id));
    assert.deepEqual(['host', 'port', 'user', 'pass'].map(name => app.controls.get(`inventory-proxy-${name}`).value), before);
  }
  link.value = '';
  app.inventory.onInput(link);
  assert.deepEqual(['host', 'port', 'user', 'pass'].map(name => app.controls.get(`inventory-proxy-${name}`).value), ['', '', '', '']);
});
