import assert from 'node:assert/strict';
import * as inventoryList from '../modules/inventory/list.mjs';
import * as listOrder from './list-order.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';

const inventorySource = await readFile(
  new URL('./inventory-prototype.js', import.meta.url),
  'utf8'
);
const appleSource = await readFile(
  new URL('./apple-balance-prototype.js', import.meta.url),
  'utf8'
);
const escape = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
const units = (value) => {
  const text = String(value);
  assert.match(text, /^-?\d+(?:\.\d{1,4})?$/);
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  return (
    (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))) * (text.startsWith('-') ? -1n : 1n)
  );
};
const format = (value) => {
  const positive = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${positive / 10000n}.${String(positive % 10000n).padStart(4, '0')}`;
};

// Exercise actual module renderers with fictional data. The table stub captures
// their public column contract; browser acceptance covers the shared core's
// column preferences and long-cell interactions separately.
function runtime() {
  let sequence = 0;
  const captures = [],
    drawers = [],
    relayCalls = [],
    notices = [],
    confirmations = [],
    errors = new Map();
  const fixture = (type, number) => ({
    id: `${type}-fixture-${number}`,
    type,
    email: `${type}.${number}@example.test`,
    password: 'Fictional-Password',
    totp: 'Fictional-TOTP-Only',
    auxiliary: 'recovery@example.test',
    phone: '演示电话',
    country: '美国',
    source: '自己注册',
    registered: '2026-10-01T10:30',
    createdAt: '2026-11-01 09:00',
    device: '演示设备',
    notes: '第一条备注',
    notes2: '第二条备注',
    appPassword: 'Fictional-App-Password',
    emailType: 'google',
    city: '纽约',
    proxyUrl: 'socks5://demo:demo@proxy.example.test:1080',
    proxyProtocol: 'socks5',
    proxyHost: 'proxy.example.test',
    proxyPort: '1080',
    proxyUser: 'demo-proxy-user',
    proxyPassword: 'Fictional-Proxy-Password',
    security1: '演示密保一',
    security2: '演示密保二',
    security3: '演示密保三',
    birthday: '1990-01-02',
    health: 'normal',
    status: '正常',
    used: false,
    version: 1
  });
  const mailboxes = [
    ...Array.from({ length: 12 }, (_, index) => fixture('google', index + 1)),
    fixture('relay', 1),
    fixture('apple', 1)
  ];
  const accounts = [fixture('gpt', 1), fixture('claude', 1)];
  const api = {
    state: {
      route: 'mailboxes/google',
      actor: { id: 'test-actor', name: '演示测试员', role: 'admin' },
      drafts: new Map(),
      columns: new Map(),
      page: 1,
      query: ''
    },
    collections: { mailboxes, accounts },
    modules: {},
    esc: escape,
    operatorIdProperty: (label, id) => `<div>${escape(label)} ${escape(id || '历史未记录')}</div>`,
    icon: () => '',
    button: (label, action, _kind, _icon, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${escape(label)}</button>`,
    textAction: (label, action, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${escape(label)}</button>`,
    tag: (label) => `<span>${escape(label)}</span>`,
    options: () => '',
    select: () => '',
    input: () => '',
    field: () => '',
    optionListEditor: ({ id, values, draft = {} }) =>
      `<input type="hidden" name="${id}" value="${escape(draft[id] ?? JSON.stringify(values))}" />`,
    readOptionList: (raw) => JSON.parse(raw),
    optionListPending: () => false,
    header: (title, _description, actions = '') => `<h1>${escape(title)}</h1>${actions}`,
    summary: () => '',
    empty: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    tableDate: escape,
    getSelection: () => new Set(),
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => '2026-11-03 10:30',
    render: () => {},
    readDraft: (form) => api.readForm(form),
    readForm: (form) => ({ ...form.raw }),
    setError: (name, message) => errors.set(name, message),
    notify: (message) => notices.push(message),
    confirmAction: (title, description, callback) =>
      confirmations.push({ title, description, callback }),
    go: (route) => {
      api.state.route = route;
    },
    openDrawer: (title, description, body, footer, context) =>
      drawers.push({ title, description, body, footer, context }),
    money: {
      units,
      formatUnits: format,
      add: (a, b) => format(units(a) + units(b)),
      subtract: (a, b) => format(units(a) - units(b)),
      compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0)
    },
    table: (columns, rows, scope, id) => {
      captures.push({ columns, rows, scope, id });
      return `<table data-table="${escape(id)}"><thead>${columns.map((column) => `<th>${escape(column.label)}</th>`).join('')}</thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(row) : escape(row[column.id] || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  };
  const modules = [];
  const context = {
    window: { IDInventoryList: inventoryList, IDDesignAPI: api, IDListOrder: listOrder, IDDesignModules: modules },
    document: { querySelector: () => null, querySelectorAll: () => [] }
  };
  runInNewContext(inventorySource, context);
  runInNewContext(appleSource, context);
  // Verify delegation at the inventory boundary. The dedicated module's own
  // tests exercise parent status, code expiry and alias fields without giving
  // every alias a separate password or unrelated account-inventory fields.
  api.modules.appleRelay = {
    isAvailable: () => false,
    listImports: () => [],
    ...Object.fromEntries(
      [
        'openAliasEditor',
        'openAliasImport',
        'openAliasDetail',
        'openMails',
        'openParentDetail',
        'openImportDetail'
      ].map((method) => [method, (...args) => relayCalls.push({ method, args })])
    )
  };
  return {
    api,
    captures,
    drawers,
    mailboxes,
    accounts,
    relayCalls,
    notices,
    confirmations,
    errors,
    inventory: modules.find((module) => module.id === 'inventory'),
    apple: modules.find((module) => module.id === 'apple-balance')
  };
}

function render(context, route) {
  context.api.state.route = route;
  const module = route === 'accounts/apple-balances' ? context.apple : context.inventory;
  const html = module.render();
  return { html, table: context.captures.at(-1) };
}

function expectColumns(context, route, expected, tableId) {
  const { html, table } = render(context, route);
  const ids = Array.from(table.columns, (column) => column.id);
  assert.equal(new Set(ids).size, ids.length, `${route}: column IDs must be unique`);
  for (const id of expected) {
    assert.ok(ids.includes(id), `${route}: missing column ${id}`);
    assert.match(
      html,
      new RegExp(`<th>${escape(table.columns.find((column) => column.id === id).label)}</th>`)
    );
  }
  assert.equal(table.id, tableId);
  assert.ok(
    html.includes(`data-action="column-settings" data-table-id="${tableId}"`),
    `${route}: visible column settings must use the actual shared action contract`
  );
  assert.equal(
    context.api.state.columns.size,
    0,
    `${route}: module must not add default hidden fields`
  );
  assert.ok(
    table.columns.every((column) => !column.hidden),
    `${route}: no column defaults to hidden`
  );
  return table;
}

test('谷歌邮箱原需求字段全部进入列表，2FA等字段不是只留在编辑表单', () => {
  const context = runtime();
  const table = expectColumns(
    context,
    'mailboxes/google',
    [
      'email',
      'password',
      'totp',
      'auxiliary',
      'phone',
      'country',
      'appPassword',
      'status',
      'source',
      'registered',
      'createdAt',
      'device',
      'notes',
      'notes2',
      'actions'
    ],
    '谷歌邮箱库存'
  );
  for (const id of ['password', 'totp', 'auxiliary', 'appPassword', 'notes', 'notes2'])
    assert.equal(table.columns.find((column) => column.id === id).long, true);
});

test('GPT列表包含邮箱类型、2FA、设备和两条独立备注', () => {
  expectColumns(
    runtime(),
    'accounts/gpt',
    [
      'emailType',
      'email',
      'password',
      'totp',
      'registered',
      'country',
      'device',
      'status',
      'source',
      'notes',
      'notes2',
      'actions'
    ],
    'GPT 账号库存'
  );
});

test('Claude列表包含注册与代理各字段，KYC未知不按订单邮箱猜测', () => {
  const context = runtime();
  const table = expectColumns(
    context,
    'accounts/claude',
    [
      'emailType',
      'email',
      'country',
      'city',
      'proxyUrl',
      'proxyProtocol',
      'proxyHost',
      'proxyPort',
      'proxyUser',
      'proxyPassword',
      'registered',
      'age',
      'ready',
      'kyc',
      'status',
      'device',
      'notes',
      'notes2',
      'actions'
    ],
    'Claude 账号库存'
  );
  const kyc = table.columns.find((column) => column.id === 'kyc');
  assert.equal(kyc.render(context.accounts[1]), '未记录');
  assert.equal(kyc.render({ ...context.accounts[1], kyc: 'KYC 认证' }), 'KYC 认证');
  assert.equal(kyc.render({ ...context.accounts[1], kyc: false }), '未认证');
  const type = table.columns.find((column) => column.id === 'emailType');
  assert.equal(type.render(context.accounts[1]), '谷歌邮箱');
  assert.equal(type.render({ ...context.accounts[1], emailType: '' }), '未记录');
});

test('隐藏邮箱页面由专用主邮箱模块接管，工作台及库存快捷入口不再套普通账号表单', () => {
  const context = runtime();
  assert.equal(context.inventory.matches('mailboxes/relay'), false);
  assert.equal(context.inventory.matches('mailboxes/google'), true);
  const entries = [
    ['inventory-add-type', { type: 'relay' }, 'openAliasEditor', ['']],
    ['inventory-edit', { id: 'relay-fixture-1' }, 'openAliasEditor', ['relay-fixture-1']],
    ['inventory-import', { type: 'relay' }, 'openAliasImport', []],
    ['inventory-detail', { id: 'relay-fixture-1' }, 'openAliasDetail', ['relay-fixture-1']],
    ['inventory-mail-read', { id: 'relay-fixture-1' }, 'openMails', ['relay-fixture-1']],
    ['inventory-parent-detail', { id: 'parent-demo-1' }, 'openParentDetail', ['parent-demo-1']]
  ];
  for (const [action, dataset, method, args] of entries) {
    assert.equal(context.inventory.onClick(action, { dataset }), true);
    assert.deepEqual(context.relayCalls.at(-1), { method, args });
  }
  assert.equal(context.drawers.length, 0, '隐藏邮箱入口不能打开普通密码、2FA或生日库存表单');
});

test('未绑定主邮箱的旧隐藏邮箱保持待核对，不按数组位置猜主邮箱', () => {
  const context = runtime();
  render(context, 'mailboxes/google');
  const alias = context.mailboxes.find((row) => row.id === 'relay-fixture-1');
  assert.equal(alias.parentMailboxId, undefined);
  assert.equal(alias.queryCode, undefined);
  assert.equal(alias.queryExpiry, undefined);
  assert.equal(alias.inventoryState, 'available');
  const { html } = render(context, 'workspace/mail-extract');
  assert.match(html.replace(/<[^>]*>/g, ''), /苹果隐藏邮箱 0/);
});

test('专用模块拒绝可用性时不能提取，确认期间主邮箱或查询码失效仍重新检查', () => {
  const context = runtime();
  context.api.state.route = 'workspace/mail-extract';
  const form = {
    id: 'inventory-extract-form',
    dataset: {},
    raw: {
      'inventory-kind': 'mail',
      'inventory-extract-type': 'relay',
      'inventory-quantity': '1',
      'inventory-purpose': '注册 GPT',
      'inventory-extract-notes': ''
    }
  };
  context.inventory.onSubmit(form);
  assert.match(context.errors.get('inventory-quantity'), /库存不足.*0/);
  assert.equal(context.confirmations.length, 0);
  context.api.modules.appleRelay.isAvailable = () => true;
  context.inventory.onSubmit(form);
  assert.equal(context.confirmations.length, 1);
  const before = context.api.modules.inventory.getBatches().length;
  context.api.modules.appleRelay.isAvailable = () => false;
  context.confirmations[0].callback();
  assert.equal(context.api.modules.inventory.getBatches().length, before);
  assert.match(context.notices.at(-1), /库存已变化/);
  assert.equal(
    context.mailboxes.find((row) => row.id === 'relay-fixture-1').inventoryState,
    'available'
  );
});

test('伪造普通库存单条或批导类型不能绕过所属主邮箱检查', () => {
  const context = runtime();
  const before = context.mailboxes.length;
  context.inventory.onSubmit({
    id: 'inventory-asset-form',
    dataset: {},
    raw: {
      'inventory-asset-type': 'relay',
      'inventory-email': 'injected.alias@icloud.com'
    }
  });
  assert.match(context.notices.at(-1), /所属 Apple 主邮箱/);
  context.inventory.onSubmit({
    id: 'inventory-import-form',
    dataset: {},
    raw: {
      'inventory-import-type': 'relay',
      'inventory-import-content': 'injected.alias@icloud.com'
    }
  });
  assert.match(context.errors.get('inventory-import-type'), /所属主邮箱/);
  assert.equal(context.mailboxes.length, before);
  assert.equal(context.confirmations.length, 0);
});

test('工作台回读隐藏邮箱导入批次，详情交给原导入模块', () => {
  const context = runtime();
  context.api.modules.appleRelay.listImports = () => [
    {
      id: 'alias-import-fixture',
      type: 'relay',
      types: ['relay'],
      time: '2026-11-03 10:30',
      actor: '演示导入人',
      total: 2,
      success: 2,
      failed: 0,
      status: '已导入'
    }
  ];
  const { html } = render(context, 'workspace/mail-extract');
  assert.match(html, /data-id="alias-import-fixture"/, '工作台近期导入必须包含专用隐藏邮箱批次');
  assert.match(html, /演示导入人/);
  context.inventory.onClick('inventory-import-detail', {
    dataset: { id: 'alias-import-fixture' }
  });
  assert.deepEqual(context.relayCalls.at(-1), {
    method: 'openImportDetail',
    args: ['alias-import-fixture']
  });
});

test('隐藏邮箱复制提供地址和查询码，库存删除不能绕过专用引用检查', () => {
  const context = runtime();
  const row = context.mailboxes.find((entry) => entry.type === 'relay');
  row.queryCode = 'DEMO-QUERY-COPY';
  const copied = [];
  context.api.copyText = (text) => copied.push(text);
  context.api.getSelection = () => new Set([row.id]);
  context.inventory.onClick('inventory-copy-selected', { dataset: {} });
  assert.equal(copied[0], `${row.email}\tDEMO-QUERY-COPY`);
  assert(!copied[0].includes(row.password));
  const before = context.confirmations.length;
  context.inventory.onClick('inventory-delete', { dataset: { id: row.id } });
  assert.equal(context.confirmations.length, before);
  assert(context.mailboxes.includes(row));
  assert.deepEqual(context.relayCalls.at(-1), { method: 'openAliasDetail', args: [row.id] });
});

test('苹果ID余额列包含密保1/2/3、生日、电话及全部原有资料', () => {
  const context = runtime();
  const table = expectColumns(
    context,
    'accounts/apple-balances',
    [
      'email',
      'password',
      'security1',
      'security2',
      'security3',
      'birthday',
      'phone',
      'country',
      'device',
      'appPassword',
      'status',
      'source',
      'registered',
      'createdAt',
      'notes',
      'notes2',
      'balance',
      'actions'
    ],
    '苹果ID余额'
  );
  const row = table.rows.find((item) => item.id === 'apple-fixture-1');
  assert.equal(table.columns.find((column) => column.id === 'birthday').render(row), '1990-01-02');
  assert.equal(table.columns.find((column) => column.id === 'security2').render(row), '演示密保二');
});

test('已提取与异常视图保留原字段、提取备注和状态时间列', () => {
  const context = runtime();
  context.api.state.route = 'mailboxes/google';
  context.inventory.render();
  context.inventory.onClick('inventory-tab', { dataset: { tab: 'claimed' } });
  let table = render(context, 'mailboxes/google').table;
  for (const id of ['totp', 'appPassword', 'purpose', 'usedAt', 'extractionNotes'])
    assert.ok(table.columns.some((column) => column.id === id));
  for (const tab of ['dead', 'unlocking']) {
    context.inventory.onClick('inventory-tab', { dataset: { tab } });
    table = render(context, 'mailboxes/google').table;
    const change = table.columns.find((column) => column.id === 'healthChangedAt');
    assert.ok(change);
    assert.equal(change.render({ health: tab, inventoryHistory: [] }), '历史未记录');
    assert.equal(
      change.render({
        health: tab,
        inventoryHistory: [{ action: '健康状态变化', detail: tab, time: '2026-11-02 12:00' }]
      }),
      '2026-11-02 12:00'
    );
  }
});

test('Google/GPT/Claude详情展示列表对应资料而非只显示摘要', () => {
  const context = runtime();
  render(context, 'mailboxes/google');
  const expectations = [
    [
      'google-fixture-12',
      [
        '2FA 密钥',
        'Fictional-TOTP-Only',
        '辅助邮箱',
        'recovery@example.test',
        '绑定电话',
        '应用专用密码',
        '来源渠道',
        '登录设备',
        '备注 1',
        '备注 2'
      ]
    ],
    ['gpt-fixture-1', ['邮箱类型', '谷歌邮箱', '2FA 密钥', 'Fictional-TOTP-Only', '登录设备']],
    [
      'claude-fixture-1',
      [
        '邮箱类型',
        '注册城市',
        '纽约',
        '注册 IP 链接',
        '代理类型',
        'SOCKS5',
        '代理主机',
        '代理端口',
        '代理账号',
        '代理密码',
        'KYC 状态',
        '未记录'
      ]
    ]
  ];
  for (const [id, expected] of expectations) {
    context.inventory.onClick('inventory-detail', { dataset: { id } });
    const body = context.drawers.at(-1).body;
    for (const text of expected) assert.ok(body.includes(text), `${id}: missing detail ${text}`);
  }
});

test('苹果ID详情委托库存详情，密保生日和一般资料均完整', () => {
  const context = runtime();
  render(context, 'accounts/apple-balances');
  context.apple.onClick('apple-details', { dataset: { id: 'apple-fixture-1' } });
  const body = context.drawers.at(-1).body;
  for (const text of [
    '密保 1',
    '密保 2',
    '密保 3',
    '密保生日',
    '1990-01-02',
    '绑定电话',
    '注册地区',
    '来源渠道',
    '登录设备',
    '应用专用密码',
    '备注 1',
    '备注 2'
  ])
    assert.ok(body.includes(text), `Apple detail missing ${text}`);
});

test('苹果ID本表设置读取apple配置，不错误创建apple-balances配置', () => {
  const context = runtime();
  context.api.state.route = 'accounts/apple-balances';
  context.inventory.onClick('inventory-settings', { dataset: {} });
  assert.match(context.drawers.at(-1).body, /name="inventory-settings-type" value="apple"/);
  assert.doesNotMatch(context.drawers.at(-1).body, /value="apple-balances"/);
});
