import assert from 'node:assert/strict';
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
      route: 'workspace/account-extract',
      drafts: new Map(),
      actor: { id: 'test-actor', name: '演示测试员', role: 'admin' }
    },
    collections: { accounts, mailboxes },
    modules: {},
    legacy: { parseCsv },
    esc: escape,
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
  const context = { window: { IDDesignAPI: api, IDDesignModules: modules }, document, URL };
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

const gptCsv =
  '邮箱,密码,邮箱类型,2FA密钥,国家地区,地区,注册时间,登录设备,备注1,备注2\nnew.gpt@example.test,Demo-Only,谷歌邮箱,DEMO-TOTP,美国,纽约,2026-10-01T10:30,测试设备,第一条,第二条';

test('账号提交页面包含五个已启用类型，复用账号库存且不提供邮箱入库', () => {
  const r = runtime();
  assert.equal(r.inventory.matches('workspace/account-submit'), true);
  assert.equal(r.inventory.matches('workspace/account-extract'), true);
  const html = r.inventory.render();
  for (const type of ['gpt', 'claude', 'apple', 'gemini', 'grok'])
    assert.match(html, new RegExp(`data-type="${type}"`));
  assert.doesNotMatch(html, /data-type="(?:google|relay|microsoft)"/);
  assert.doesNotMatch(html, /IMPORT-DEMO-001/);
});

for (const type of ['gpt', 'claude', 'apple'])
  test(`${type} 示例按钮填入可预检的CSV，不会点击即保存`, () => {
    const r = runtime();
    r.open(type);
    const before = r.accounts.length + r.mailboxes.length;
    r.inventory.onClick('inventory-import-example', { dataset: {} });
    assert.match(r.form.raw['inventory-import-content'], /账号邮箱/);
    assert.match(r.form.raw['inventory-import-content'], /@example\.test/);
    assert.equal(r.pending, false);
    assert.equal(r.accounts.length + r.mailboxes.length, before);
    r.preview();
    r.requestImport();
    r.confirm();
    assert.equal(r.accounts.length + r.mailboxes.length, before + 1);
  });

test('三类单条表单保留各自字段，苹果资料入口不提供余额录入', () => {
  const r = runtime();
  for (const [type, fields] of [
    ['gpt', ['inventory-emailType', 'inventory-city', 'inventory-totp', 'inventory-device', 'inventory-notes2']],
    ['claude', ['inventory-city', 'inventory-proxy-url', 'inventory-proxy-host']],
    [
      'apple',
      ['inventory-security1', 'inventory-security3', 'inventory-birthday', 'inventory-phone']
    ]
  ]) {
    r.open(type, 'inventory-add-type');
    assert.equal(r.form.raw['inventory-asset-type'], type);
    assert.equal(r.form.raw['inventory-entry-scope'], 'account-submit');
    for (const field of fields) assert.match(r.opened.body, new RegExp(`id="${field}"`));
    assert.doesNotMatch(r.opened.body, /name="[^"\s]*(?:balance|余额)[^"\s]*"/);
  }
});

test('单条 GPT 直接进入账号库存，空白注册时间采用录入时间', () => {
  const r = runtime(),
    before = r.mailboxes.length;
  r.open('gpt', 'inventory-add-type');
  Object.assign(r.form.raw, {
    'inventory-email': 'single.gpt@example.test',
    'inventory-password': 'Demo-Only',
    'inventory-country-edit': '美国',
    'inventory-city': '纽约',
    'inventory-registered': ''
  });
  r.inventory.onSubmit(r.form);
  r.confirm();
  const row = r.accounts.find((asset) => asset.email === 'single.gpt@example.test');
  assert(row);
  assert.equal(row.type, 'gpt');
  assert.equal(row.registered, row.createdAt);
  assert.equal(row.createdAt, '2026-11-03 10:30');
  assert.equal(row.inventoryState, 'available');
  assert.equal(r.mailboxes.length, before);
});

test('完整表头GPT导入保留邮箱类型、2FA、时间、设备和备注，入库后可回读', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': gptCsv });
  assert.equal(r.accounts.length, 0);
  r.requestImport();
  r.confirm();
  const row = r.accounts.find((asset) => asset.email === 'new.gpt@example.test');
  assert(row);
  assert.equal(row.totp, 'DEMO-TOTP');
  assert.equal(row.emailType, 'google');
  assert.equal(row.device, '测试设备');
  assert.equal(row.city, '纽约');
  assert.equal(row.notes2, '第二条');
  assert.equal(row.registered, '2026-10-01T10:30');
  assert.equal(row.createdAt, '2026-11-03 10:30');
  const history = r.inventory.render();
  assert.match(history, /已导入/);
  r.api.state.route = 'workspace/mail-submit';
  assert.doesNotMatch(r.inventory.render(), /new.gpt@example.test/);
});

test('导入预览中的邮箱类型使用中文，不直接显示内部类型编号', () => {
  const r = runtime();
  r.open('gpt');
  const preview = r.preview({ 'inventory-import-content': gptCsv });
  const column = preview.columns.find((item) => item.id === 'emailType');
  assert(column);
  assert.equal(column.render(preview.rows[0]), '谷歌邮箱');
});

test('Apple资料批导保留密保生日且新ID余额为零，不修改演示期初余额', () => {
  const r = runtime();
  r.open('apple');
  r.preview({
    'inventory-import-no-phone': 'on',
    'inventory-import-content':
      '邮箱,密码,国家地区,密保1,密保2,密保3,密保生日,应用专用密码\nnew.apple@example.test,Demo-Only,美国,一,二,三,1990-02-01,APP-DEMO'
  });
  r.requestImport();
  r.confirm();
  const asset = r.mailboxes.find((row) => row.email === 'new.apple@example.test');
  assert(asset);
  assert.equal(asset.security2, '二');
  assert.equal(asset.birthday, '1990-02-01');
  assert.equal(asset.appPassword, 'APP-DEMO');
  assert.equal(r.api.modules.appleBalance.get(asset.id).balance, '0.0000');
  assert.equal(r.api.modules.appleBalance.get('apple-funding-demo-1').balance, '250.0000');
});

test('Claude批导保留国家城市和代理资料，注册时间与录入时间独立', () => {
  const r = runtime();
  r.open('claude');
  r.preview({
    'inventory-import-content':
      '邮箱,邮箱类型,注册国家,注册城市,注册时间,代理类型,代理主机,代理端口,代理账号,代理密码,登录设备,注册代理链接\nnew.claude@example.test,苹果隐藏邮箱,美国,纽约,2026-10-01T10:30,socks5,proxy.example.test,1080,demo,DEMO-PROXY,合成设备,socks5://demo:DEMO-PROXY@proxy.example.test:1080'
  });
  r.requestImport();
  r.confirm();
  const row = r.accounts.find((asset) => asset.type === 'claude');
  assert(row);
  assert.equal(row.city, '纽约');
  assert.equal(row.emailType, 'relay');
  assert.equal(row.proxyHost, 'proxy.example.test');
  assert.equal(row.proxyPort, '1080');
  assert.notEqual(row.registered, row.createdAt);
});

test('格式或重复错误阻止整批写入，不只导入其中正确的账号', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({
    'inventory-import-content': '邮箱,密码,国家,城市\nvalid@example.test,Demo,美国,纽约\ninvalid,Demo,美国,纽约'
  });
  r.requestImport();
  assert.equal(r.pending, false);
  assert.equal(r.accounts.length, 0);
  assert([...r.errors.values()].some(Boolean));
});

test('错误CSV修正并减少行数后可生成新预览，不被旧逐行控件卡住', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({
    'inventory-import-content': '邮箱,密码,国家,城市\nvalid@example.test,Demo,美国,纽约\ninvalid,Demo,美国,纽约'
  });
  assert.equal(r.pending, false);
  const preview = r.preview({ 'inventory-import-content': gptCsv });
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].email, 'new.gpt@example.test');
  assert.equal(preview.rows[0].error, '');
  r.requestImport();
  r.confirm();
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].email, 'new.gpt@example.test');
});

for (const [name, csv] of [
  ['重复表头', '邮箱,密码,邮箱\nheader@example.test,Demo,other@example.test'],
  ['多余列', '邮箱,密码\nextra@example.test,Demo,不应丢弃'],
  ['未来注册时间', '邮箱,密码,国家,城市,注册时间\nfuture@example.test,Demo,美国,纽约,2099-01-01T10:30']
])
  test(`${name}必须在预检时阻止整批写入`, () => {
    const r = runtime();
    r.open('gpt');
    r.preview({ 'inventory-import-content': csv });
    r.requestImport();
    assert.equal(r.pending, false);
    assert.equal(r.accounts.length, 0);
    assert([...r.errors.values()].some(Boolean));
  });

test('Apple生日无效或没有确认空电话时均不能批量入库', () => {
  for (const [birthday, noPhone] of [
    ['1990-02-30', 'on'],
    ['1990-02-01', '']
  ]) {
    const r = runtime();
    r.open('apple');
    const before = r.mailboxes.length;
    r.preview({
      'inventory-import-no-phone': noPhone,
      'inventory-import-content': `邮箱,密码,国家地区,生日\ninvalid.apple@example.test,Demo,美国,${birthday}`
    });
    r.requestImport();
    assert.equal(r.pending, false);
    assert.equal(r.mailboxes.length, before);
  }
});

test('GPT 保留旧七列导入；Claude 旧模板缺设备和代理时明确拒绝', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': 'legacy.gpt@example.test,Demo,,美国,纽约,2026-10-01T10:30,GPT账号' });
  r.requestImport(); r.confirm();
  assert.equal(r.accounts[0].type, 'gpt');
  assert.equal(r.accounts[0].registered, '2026-10-01T10:30');
  r.open('claude');
  r.preview({ 'inventory-import-content': 'legacy.claude@example.test,Demo,,美国,纽约,2026-10-01T10:30,Claude账号' });
  r.requestImport();
  assert.equal(r.pending, false);
  assert.equal(r.accounts.length, 1);
  assert([...r.errors.values()].some(Boolean));
});

for (const header of ['余额', '使用状态', '养号时长', 'KYC', '录入时间', '未知字段'])
  test(`拒绝导入资金、派生或未知字段：${header}`, () => {
    const r = runtime();
    r.open('gpt');
    r.preview({ 'inventory-import-content': `邮箱,密码,${header}\nblocked@example.test,Demo,999` });
    r.requestImport();
    assert.equal(r.pending, false);
    assert.equal(r.accounts.length, 0);
    assert([...r.errors.values()].some(Boolean));
  });

for (const [key, value] of [
  ['inventory-import-scope', 'mail'],
  ['inventory-import-locked-type', 'google'],
  ['inventory-import-type', 'google']
])
  test(`篡改账号提交导入边界 ${key} 不可写入邮箱库存`, () => {
    const r = runtime(),
      before = r.mailboxes.length;
    r.open('gpt');
    r.preview({ 'inventory-import-content': gptCsv, [key]: value });
    r.requestImport();
    assert.equal(r.pending, false);
    assert.equal(r.accounts.length, 0);
    assert.equal(r.mailboxes.length, before);
  });

test('确认窗口打开后修改内容，旧确认不能导入后来输入的账号', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': gptCsv });
  r.requestImport();
  assert(r.pending);
  r.form.raw['inventory-import-content'] = gptCsv.replace('new.gpt@', 'changed@');
  r.confirm();
  assert.equal(r.accounts.length, 0);
});

test('默认来源或无电话确认发生变化后，之前的预览必须重新核对', () => {
  for (const changes of [
    { 'inventory-import-source': '线上购买' },
    { 'inventory-import-no-phone': 'on' }
  ]) {
    const r = runtime();
    r.open('gpt');
    r.preview({ 'inventory-import-content': gptCsv });
    Object.assign(r.form.raw, changes);
    r.requestImport();
    assert.equal(r.pending, false);
    assert.equal(r.accounts.length, 0);
  }
});

test('确认窗口打开后出现重复账号，不覆盖现有资料也不追加重复记录', () => {
  const r = runtime();
  r.open('gpt');
  r.preview({ 'inventory-import-content': gptCsv });
  r.requestImport();
  r.accounts.push({ type: 'gpt', email: 'new.gpt@example.test', password: 'Keep-Original' });
  r.confirm();
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].password, 'Keep-Original');
});

test('账号导入草稿按类型隔离，关闭重开恢复内容且不污染邮箱提交', () => {
  const r = runtime();
  r.open('gpt');
  r.form.raw['inventory-import-content'] = gptCsv;
  r.inventory.preserveDraft();
  r.open('apple');
  assert.equal(r.form.raw['inventory-import-content'], '');
  r.open('gpt');
  assert.equal(r.form.raw['inventory-import-content'], gptCsv);
  r.api.state.route = 'workspace/mail-submit';
  r.open('google');
  assert.notEqual(r.form.raw['inventory-import-content'], gptCsv);
});

test('单条表单切换类型时恢复目标草稿，不用当前内容覆盖另一产品', () => {
  const r = runtime();
  r.open('claude', 'inventory-add-type');
  r.form.raw['inventory-notes'] = 'Claude原草稿';
  r.inventory.preserveDraft();
  r.open('gpt', 'inventory-add-type');
  r.form.raw['inventory-notes'] = 'GPT原草稿';
  r.form.raw['inventory-asset-type'] = 'claude';
  r.inventory.onChange({ id: 'inventory-asset-type', value: 'claude', form: r.form });
  assert.equal(r.form.raw['inventory-notes'], 'Claude原草稿');
  r.form.raw['inventory-asset-type'] = 'gpt';
  r.inventory.onChange({ id: 'inventory-asset-type', value: 'gpt', form: r.form });
  assert.equal(r.form.raw['inventory-notes'], 'GPT原草稿');
});

test('文件读取的迟到结果不能覆盖另一类型导入草稿', async () => {
  const r = runtime();
  r.open('gpt');
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  r.inventory.onChange({
    id: 'inventory-import-file',
    form: r.form,
    files: [{ size: 100, text: () => pending }]
  });
  r.open('apple');
  r.form.raw['inventory-import-content'] = 'Apple草稿';
  finish(gptCsv);
  await pending;
  await Promise.resolve();
  assert.equal(r.form.raw['inventory-import-content'], 'Apple草稿');
});

test('文件读取等待期间手工改动内容时保留手工输入', async () => {
  const r = runtime();
  r.open('gpt');
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  r.inventory.onChange({
    id: 'inventory-import-file',
    form: r.form,
    files: [{ size: 100, text: () => pending }]
  });
  r.form.raw['inventory-import-content'] = '手工修正';
  finish(gptCsv);
  await pending;
  await Promise.resolve();
  assert.equal(r.form.raw['inventory-import-content'], '手工修正');
});

test('CSV文件读取失败显示错误并保留原输入', async () => {
  const r = runtime();
  r.open('gpt');
  r.form.raw['inventory-import-content'] = '原草稿';
  r.inventory.onChange({
    id: 'inventory-import-file',
    form: r.form,
    files: [{ size: 100, text: () => Promise.reject(new Error('fictional read failure')) }]
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(r.errors.get('inventory-import-content'), /读取失败/);
  assert.equal(r.form.raw['inventory-import-content'], '原草稿');
});
