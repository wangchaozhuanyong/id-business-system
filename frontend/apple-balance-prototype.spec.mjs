import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const source = await readFile(new URL('./apple-balance-prototype.js', import.meta.url), 'utf8');
const units = (value) => {
  const text = String(value);
  assert.match(text, /^-?\d+(?:\.\d{1,4})?$/);
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  return (
    (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))) * (text.startsWith('-') ? -1n : 1n)
  );
};
const format = (value) =>
  `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 10000n}.${String((value < 0n ? -value : value) % 10000n).padStart(4, '0')}`;

function runtime(localData) {
  let sequence = 0;
  const assets = [
    {
      id: 'apple-funding-demo-1',
      email: 'apple.demo@example.test',
      status: '正常',
      health: 'normal',
      country: '美国'
    },
    {
      id: 'apple-b',
      email: 'another@example.test',
      status: '正常',
      health: 'normal',
      country: '美国'
    }
  ];
  const api = {
    readDraft: (form) => api.readForm(form),
    state: { drafts: new Map(), actor: { name: '演示测试员' } },
    esc: String,
    nowText: () => '2026-11-03 10:30',
    newId: (prefix) => `${prefix}-${++sequence}`,
    money: {
      units,
      formatUnits: format,
      add: (a, b) => format(units(a) + units(b)),
      subtract: (a, b) => format(units(a) - units(b)),
      compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0)
    },
    modules: { inventory: { getAppleIds: () => assets } }
  };
  runInNewContext(source, {
    window: { IDDesignAPI: api, IDDesignModules: [], IDLocalData: localData },
    document: {},
    crypto
  });
  return api.modules.appleBalance;
}
const order = (changes = {}) => ({
  id: 'order-1',
  orderNo: 'ORDER-001',
  product: 'Gemini', plan: 'Google AI Pro', businessType: '首次开通', customerId: 'customer-1',
  subscriptionSeries: 'google_ai', loginMethod: 'google', billingChannel: 'app_store', billingCycle: 'month',
  billingCountry: '美国', billingReceipt: 'fixture-receipt', appleGoogleVerified: true,
  entitlementStatus: 'pending', autoRenew: 'unknown', costBasis: 'standard',
  email: 'customer@example.test',
  payment: '苹果内购',
  appleIdId: 'apple-funding-demo-1',
  paidAmount: '20',
  paidCurrency: 'USD',
  paidConfirmed: true,
  saleAmount: '250',
  saleCurrency: 'CNY',
  receiptConfirmed: true,
  cancelled: false,
  ...changes
});

test('确认付款才扣减，250美元扣20为230；同一订单重复保存不重扣', () => {
  const ledger = runtime();
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  assert.equal(ledger.commitOrder(order({ paidConfirmed: false })).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  const preview = ledger.previewOrder(order());
  assert.equal(preview.balanceAfter, '230.0000');
  assert.equal(ledger.commitOrder(order(), { expectedPreview: preview }).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '230.0000');
  const count = ledger.entries('apple-funding-demo-1').length;
  assert.equal(ledger.commitOrder(order()).reused, true);
  assert.equal(ledger.entries('apple-funding-demo-1').length, count);
});

test('余额不足和陈旧预检都不写订单余额流水', () => {
  const ledger = runtime();
  const count = ledger.entries().length;
  assert.equal(ledger.commitOrder(order({ paidAmount: '251' })).ok, false);
  assert.equal(ledger.entries().length, count);
  assert.equal(ledger.getOrderLedger('order-1'), null);
  const preview = ledger.previewOrder(order());
  ledger.adjust('apple-funding-demo-1', '10', { reason: '演示充值到账' });
  assert.equal(ledger.commitOrder(order(), { expectedPreview: preview }).ok, false);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '260.0000');
});

test('客户退款不动Apple余额；确认Apple部分退回后保存原单不会重扣', () => {
  const ledger = runtime();
  const row = order();
  ledger.commitOrder(row);
  row.refunds = [{ amount: '5', currency: 'CNY' }];
  assert.equal(ledger.commitOrder(row).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '230.0000');
  assert.equal(ledger.refundToApple(row.id, '5', { reason: 'Apple已实际到账' }).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '235.0000');
  assert.equal(ledger.getOrderLedger(row.id).netAmount, '15.0000');
  assert.equal(ledger.commitOrder(row).reused, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '235.0000');
  assert.equal(ledger.refundToApple(row.id, '16', { reason: '超额退回' }).ok, false);
});

test('金额更正只记差额，减少需明确冲正；撤单不自动返钱', () => {
  const ledger = runtime();
  ledger.commitOrder(order());
  assert.equal(ledger.commitOrder(order({ paidAmount: '25' })).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '225.0000');
  assert.equal(ledger.commitOrder(order({ paidAmount: '10' })).ok, false);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '225.0000');
  assert.equal(
    ledger.commitOrder(order({ paidAmount: '10' }), {
      allowReversal: true,
      reason: '已核对原支出更正及余额返回'
    }).ok,
    true
  );
  assert.equal(ledger.get('apple-funding-demo-1').balance, '240.0000');
  assert.equal(ledger.commitOrder(order({ paidAmount: '10', cancelled: true })).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '240.0000');
  assert.equal(ledger.commitOrder(order({ paidAmount: '10', paidConfirmed: false })).ok, false);
});

test('更换苹果ID原子预检，目标余额不足时原账户不先退钱', () => {
  const ledger = runtime();
  ledger.commitOrder(order());
  const changed = order({ appleIdId: 'apple-b' });
  const options = { allowReversal: true, reason: '演示支付资料更正' };
  assert.equal(ledger.commitOrder(changed, options).ok, false);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '230.0000');
  ledger.adjust('apple-b', '50', { reason: '演示余额到账' });
  assert.equal(ledger.commitOrder(changed, options).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  assert.equal(ledger.get('apple-b').balance, '30.0000');
  assert.equal(ledger.refundToApple(changed.id, '5', { reason: 'Apple到账' }).ok, true);
  assert.equal(ledger.commitOrder(order(), options).ok, false);
});

test('人工变动撤回以反向流水补偿；后续订单发生后禁止覆盖', () => {
  const ledger = runtime();
  const first = ledger.adjust('apple-funding-demo-1', '0.0001', { reason: '精确余额更正' });
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0001');
  assert.equal(ledger.undoAdjustment(first.entry.id, '演示撤回').ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  assert.equal(
    ledger.entries('apple-funding-demo-1').find((row) => row.id === first.entry.id).undoneBy
      .length > 0,
    true
  );
  const later = ledger.adjust('apple-funding-demo-1', '5', { reason: '充值到账' });
  ledger.commitOrder(order());
  assert.equal(ledger.undoAdjustment(later.entry.id, '旧变动不能覆盖订单扣款').ok, false);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '235.0000');
});

test('不接受非美元、负数、超精度或零订阅金额', () => {
  const ledger = runtime();
  for (const changes of [
    { paidCurrency: 'CNY' },
    { paidAmount: '-1' },
    { paidAmount: '0.00001' },
    { paidAmount: '0' }
  ])
    assert.equal(ledger.commitOrder(order(changes)).ok, false);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
});

test('显式期初关联不重复扣旧订阅，旧单Apple到账可独立退回', () => {
  const ledger = runtime();
  const historical = order({ id: 'old-1', orderNo: 'OLD-001' });
  assert.equal(ledger.registerOpeningOrder(historical).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  assert.equal(ledger.registerOpeningOrder(historical).reused, true);
  assert.equal(ledger.commitOrder(historical).reused, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '250.0000');
  assert.equal(ledger.getOrderLedger(historical.id).openingIncluded, true);
  assert.equal(
    ledger.refundToApple(historical.id, '5', { reason: '期初订阅的Apple返还已到账' }).ok,
    true
  );
  assert.equal(ledger.get('apple-funding-demo-1').balance, '255.0000');
  assert.equal(ledger.commitOrder(historical).reused, true);
  assert.equal(ledger.commitOrder(order()).ok, true);
  assert.equal(ledger.get('apple-funding-demo-1').balance, '235.0000');
});

function localLedger(t) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  store.saveBatch([
    {
      domain: 'inventory',
      version: 0,
      data: {
        mailboxes: ['apple-funding-demo-1', 'apple-b'].map((id) => ({ id, type: 'apple', status: '正常', appStoreRegion: 'US' })),
        accounts: [],
        batches: [],
        returnRecords: [],
        importRecords: [],
        registrationRecords: [],
        tableSettings: [],
        undo: []
      }
    }
  ]);
  store.saveBatch([{ domain: 'settings', version: 0, data: {
    mailboxTypes: [], costSettings: {}, applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } }
  }}]);
  const start = () =>
    runtime({
      load: async (domain) => store.load(domain),
      save: async (domain, version, data, { action }) =>
        store.saveBatch([{ domain, version, data, action }])[0]
    });
  const saveOrder = (order, prepared) => {
    const { version, data } = store.load('commerce');
    const commerce = data || {
      customers: [{ id: 'customer-1', name: '合成客户' }],
      tenants: [],
      orders: [],
      operating: [],
      rentBatches: [],
      logs: []
    };
    commerce.orders = [...commerce.orders.filter((row) => row.id !== order.id), order];
    const saved = store.saveBatch([
      { domain: 'commerce', version, data: commerce },
      ...(prepared?.entry ? [prepared.entry] : [])
    ]);
    if (prepared?.entry) prepared.apply(saved[1]);
  };
  return { start, saveOrder, store };
}

const versions = (ledger, row, id) => ({
  version: ledger.listRefunds(row.id).find((refund) => refund.id === id).version,
  ledgerVersion: ledger.getOrderLedger(row.id).version,
  walletVersion: ledger.get(row.appleIdId).version
});

test('本机 Apple 台账保存已付扣款与独立回款，重开后只对已登记金额入账一次', async (t) => {
  const { start, saveOrder, store } = localLedger(t);
  const ledger = start();
  const row = order({ refunds: [] });
  assert.equal(await ledger.ensureReady(), true);
  assert.equal(ledger.get(row.appleIdId).balance, '0.0000');
  assert.equal(ledger.entries().length, 0);
  assert.equal((await ledger.adjust(row.appleIdId, '250', { reason: '核对期初余额' })).ok, true);
  const charge = ledger.prepareOrder(row, { expectedPreview: ledger.previewOrder(row) });
  assert.equal(charge.ok, true);
  assert.equal(ledger.get(row.appleIdId).balance, '250.0000');
  saveOrder(row, charge);
  assert.equal(ledger.get(row.appleIdId).balance, '230.0000');
  assert.equal(ledger.prepareOrder(row).changed, false);

  const scheduled = ledger.prepareRefund(row, { refundId: 'refund-1', amount: '7' });
  assert.equal(scheduled.ok, true);
  row.refunds.push({ id: 'refund-1', amount: '100.0000', currency: 'CNY', payment: row.payment });
  saveOrder(row, scheduled);
  assert.equal(ledger.listRefunds(row.id)[0].status, 'pending');
  assert.equal(ledger.get(row.appleIdId).balance, '230.0000');
  const restarted = start();
  await restarted.ensureReady();
  const receipt = {
    ...versions(restarted, row, 'refund-1'),
    confirmed: true,
    reason: '核对 Apple 实际到账'
  };
  assert.equal((await restarted.receiveRefund('refund-1', receipt)).ok, true);
  assert.equal((await restarted.receiveRefund('refund-1', receipt)).ok, false);
  assert.equal((await ledger.receiveRefund('refund-1', receipt)).ok, false);
  assert.equal(ledger.get(row.appleIdId).balance, '237.0000');
  assert.equal(ledger.listRefunds(row.id)[0].status, 'received');
  assert.equal(ledger.entries().filter((item) => item.refundId === 'refund-1').length, 1);
  assert.equal(store.load('commerce').data.orders[0].refunds[0].amount, '100.0000');
});

test('已占用的待回款限制新退款和扣款更正，改为零保留依据且不增余额', async (t) => {
  const { start, saveOrder } = localLedger(t);
  const ledger = start();
  const row = order({ refunds: [] });
  await ledger.ensureReady();
  await ledger.adjust(row.appleIdId, '250', { reason: '核对期初余额' });
  saveOrder(row, ledger.prepareOrder(row));
  const first = ledger.prepareRefund(row, { refundId: 'refund-1', amount: '14' });
  row.refunds.push({ id: 'refund-1', amount: '100.0000', currency: 'CNY', payment: row.payment });
  saveOrder(row, first);
  assert.equal(ledger.prepareRefund(row, { refundId: 'refund-2', amount: '7' }).ok, false);
  assert.equal(
    ledger.prepareOrder({ ...row, paidAmount: '13' }, { allowReversal: true, reason: '更正扣款' })
      .ok,
    false
  );
  const corrected = await ledger.correctRefund('refund-1', '0', {
    ...versions(ledger, row, 'refund-1'),
    reason: 'Apple 确认无需回款'
  });
  assert.equal(corrected.ok, true);
  assert.equal(ledger.listRefunds(row.id)[0].status, 'none');
  assert.equal(ledger.listRefunds(row.id)[0].corrections[0].from, '14.0000');
  assert.equal(ledger.get(row.appleIdId).balance, '230.0000');
  const zero = ledger.prepareRefund(row, { refundId: 'refund-2', amount: '0' });
  row.refunds.push({ id: 'refund-2', amount: '50.0000', currency: 'CNY', payment: row.payment });
  saveOrder(row, zero);
  assert.equal(ledger.listRefunds(row.id)[1].amount, '0.0000');
});

const inventorySource = await readFile(
  new URL('./inventory-prototype.js', import.meta.url),
  'utf8'
);
const coreSource = await readFile(new URL('./prototype.js', import.meta.url), 'utf8');
function inventoryRuntime() {
  let sequence = 0;
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const drawers = [];
  const errors = new Map();
  const nodes = new Map([['inventory-import-results', { innerHTML: '' }]]);
  const accounts = [
    {
      id: 'gpt-stock',
      type: 'gpt',
      email: 'gpt-stock@example.test',
      status: '正常',
      health: 'normal',
      used: false,
      version: 1
    },
    {
      id: 'claude-stock',
      type: 'claude',
      email: 'claude-stock@example.test',
      status: '正常',
      health: 'normal',
      used: false,
      registered: '2026-10-01T10:30',
      version: 1
    }
  ];
  const mailboxes = [];
  const notices = [];
  const api = {
    readDraft: (form) => api.readForm(form),
    icon: () => '',
    tag: value => escape(value),
    esc: escape,
    icon: () => '',
    tag: (label) => `<span>${escape(label)}</span>`,
    button: (label, action, _kind, _icon, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${label}</button>`,
    textAction: (label, action, attributes = '') =>
      `<button data-action="${action}" ${attributes}>${label}</button>`,
    field: (label, id, control) =>
      `<div class="field"><label for="${id}">${label}</label>${control}</div>`,
    input: (id, initial = '', attributes = '') =>
      `<input name="${id}" value="${escape(initial)}" ${attributes} />`,
    options: (values) =>
      values
        .map((item) => {
          const [id, label] = Array.isArray(item) ? item : [item, item];
          return `<option value="${id}">${label}</option>`;
        })
        .join(''),
    select: (id, choices) => `<select name="${id}">${api.options(choices)}</select>`,
    header: (title) => `<h1>${title}</h1>`,
    table: (_columns, rows) => `<table>${JSON.stringify(rows)}</table>`,
    pageRows: (rows) => rows,
    pagination: () => '',
    empty: (title) => `<p>${title}</p>`,
    openDrawer: (title, description, body) => drawers.push({ title, description, body }),
    legacy: { parseCsv: (text) => text.split('\n').map((line) => line.split(',')) },
    collections: { accounts, mailboxes },
    state: {
      drafts: new Map(),
      selections: new Map(),
      actor: { id: 'actor-1', name: '演示测试员', role: 'admin' }
    },
    modules: {},
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => '2026-11-03 10:30',
    money: { compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0) },
    notify: (notice) => notices.push(notice),
    render: () => {},
    setError: (id, message) => errors.set(id, message),
    confirmAction: (_title, _message, callback) => callback()
  };
  const modules = [];
  runInNewContext(inventorySource, {
    window: { IDDesignAPI: api, IDDesignModules: modules },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: (id) => nodes.get(id) || null
    }
  });
  return {
    api,
    inventory: api.modules.inventory,
    module: modules[0],
    accounts,
    mailboxes,
    notices,
    drawers,
    errors,
    nodes
  };
}

test('成品销售仅领取一次；同订单重复提交幂等，其他订单不能重领', () => {
  const { inventory, accounts } = inventoryRuntime();
  assert.equal(inventory.listAvailableAccounts('GPT').length, 1);
  assert.equal(inventory.listAvailableAccounts('Claude Max').length, 1);
  assert.equal(inventory.commitAccountSale('gpt-stock', { orderId: 'stock-sale' }).ok, true);
  assert.equal(accounts[0].inventoryState, 'used');
  assert.equal(inventory.commitAccountSale('gpt-stock', { orderId: 'stock-sale' }).reused, true);
  assert.equal(accounts[0].usageLinks.length, 1);
  assert.equal(inventory.commitAccountSale('gpt-stock', { orderId: 'other-sale' }).ok, false);
  assert.equal(inventory.listAvailableAccounts('GPT').length, 0);
});

test('登记邮箱外部注册成功只消耗邮箱，不自动创建账号主档', () => {
  const context = inventoryRuntime();
  context.inventory.getAppleIds();
  const email = {
    id: 'mail-new',
    type: 'google',
    email: 'external-registration@example.test',
    status: '正常',
    health: 'normal',
    used: false,
    version: 1
  };
  context.mailboxes.push(email);
  const data = {
    'inventory-registration-asset': email.id,
    'inventory-registration-product': 'gpt',
    'inventory-registration-result': '成功'
  };
  context.api.readForm = () => data;
  const count = context.accounts.length;
  context.module.onSubmit({ id: 'inventory-registration-form',
    dataset: { inventoryDraft: 'inventory-registration:mail-new:new' } });
  assert.equal(context.accounts.length, count);
  assert.equal(email.inventoryState, 'used');
  assert.equal(email.usageLinks[0].kind, 'registration');
  assert.equal(email.usageLinks[0].accountId, undefined);
  assert.match(context.notices.at(-1), /单独录入/);
});

test('已有苹果余额台账的资产不能经旧库存删除入口移除', () => {
  const context = inventoryRuntime();
  context.inventory.getAppleIds();
  context.api.modules.appleBalance = {
    entries: () => [{ kind: 'opening', amount: '250' }],
    get: () => ({ balance: '250' })
  };
  const count = context.mailboxes.length;
  context.module.onClick('inventory-delete', { dataset: { id: 'apple-funding-demo-1' } });
  assert.equal(context.mailboxes.length, count);
  assert.match(context.notices.at(-1), /余额台账/);
});

test('普通邮箱提交和提取不展示资金AppleID，命令层也拒绝提取', () => {
  const context = inventoryRuntime();
  context.api.state.route = 'workspace/mail-submit';
  const html = context.module.render();
  assert.equal(html.includes('data-type="apple"'), false);
  assert.equal(html.includes('data-type="google"'), true);
  assert.equal(html.includes('data-type="relay"'), true);
  context.api.state.route = 'workspace/mail-extract';
  assert.equal(context.module.render().includes('<option value="apple">'), false);
  context.api.readForm = () => ({
    'inventory-kind': 'mail',
    'inventory-extract-type': 'apple',
    'inventory-quantity': '1',
    'inventory-purpose': '业务备用'
  });
  context.module.onSubmit({ id: 'inventory-extract-form' });
  assert.match(context.errors.get('inventory-extract-type'), /资金苹果 ID/);
  assert.equal(context.inventory.getBatches().length, 0);
});

test('资金页强制Apple导入不误入GPT账号表，普通邮箱分类开关不影响该入口', () => {
  const context = inventoryRuntime();
  context.api.state.route = 'accounts/apple-balances';
  context.api.modules.operations = {
    getMailboxTypes: () => [
      { id: 'google', label: '谷歌邮箱', enabled: true },
      { id: 'relay', label: '苹果隐藏邮箱', enabled: true }
    ]
  };
  context.inventory.importAppleIds();
  const body = context.drawers.at(-1).body;
  assert.match(body, /<option value="apple">苹果 ID<\/option>/);
  assert.doesNotMatch(body, /<option value="gpt">/);
  assert.match(body, /inventory-import:apple-balance/);
  const form = {
    id: 'inventory-import-form',
    dataset: { inventoryDraft: 'inventory-import:apple-balance' }
  };
  context.nodes.set(form.id, form);
  const data = {
    'inventory-import-type': 'apple',
    'inventory-import-content': 'new.apple@example.test,Demo-Only!,,美国,,,apple',
    'inventory-import-no-phone': 'on',
    'inventory-import-source': '线上购买'
  };
  context.api.readForm = () => data;
  context.module.onSubmit(form);
  const preview = context.nodes
    .get('inventory-import-results')
    .innerHTML.match(/name="inventory-import-preview-source" value="([^"]*)"/)[1];
  data['inventory-import-preview-source'] = preview
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
  const count = context.accounts.length;
  context.module.onClick('inventory-import-confirm', { dataset: {} });
  const added = context.inventory
    .getAppleIds()
    .find((asset) => asset.email === 'new.apple@example.test');
  assert.equal(added.type, 'apple');
  assert.equal(added.registered, added.createdAt);
  assert.equal(context.accounts.length, count);
});

function appleListRuntime() {
  const context = inventoryRuntime(),
    { api } = context,
    captures = [];
  Object.assign(api.state, { route: 'accounts/apple-balances', columns: new Map(), pageSize: 16 });
  Object.assign(api, {
    icon: () => '',
    tag: String,
    summary: () => '',
    header: (title, _description, actions = '') => `<h1>${title}</h1>${actions}`,
    money: {
      units,
      formatUnits: format,
      add: (a, b) => format(units(a) + units(b)),
      subtract: (a, b) => format(units(a) - units(b)),
      compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0)
    }
  });
  // Use the real shared table and column picker: the new cells must survive
  // the same visibility contract as the original Apple ID columns.
  const shared = runInNewContext(
    `${coreSource.slice(coreSource.indexOf('function table('), coreSource.indexOf('function pagination('))}
${coreSource.slice(coreSource.indexOf('function showColumns('), coreSource.indexOf('function updateColumnCount('))}
({ table, showColumns })`,
    {
      columnDefinitions: {},
      tableRecords: new Map(),
      state: api.state,
      escapeHtml: api.esc,
      icon: api.icon,
      getSelection: () => new Set(),
      empty: api.empty,
      openDrawer: api.openDrawer,
      button: api.button,
      notify: api.notify
    }
  );
  api.table = (columns, rows, scope, id) => {
    captures.push({ columns, rows, scope, id });
    return shared.table(columns, rows, scope, id);
  };
  const modules = [];
  runInNewContext(source, { window: { IDDesignAPI: api, IDDesignModules: modules }, document: {} });
  return {
    ...context,
    ledger: api.modules.appleBalance,
    shared,
    render() {
      const html = modules[0].render();
      return { html, ...captures.at(-1) };
    }
  };
}

function renderedCellText(html, key) {
  const content = html.match(new RegExp(`<td[^>]*data-column="${key}"[^>]*>([\\s\\S]*?)</td>`))?.[1];
  return content?.replace(/<[^>]+>/g, '');
}

test('Apple专表从库存主档显示人员出处，默认列与真实列设置均包含新增三列', () => {
  const context = appleListRuntime(),
    asset = context.inventory.getAppleIds()[0];
  Object.assign(asset, {
    createdById: 'original-creator',
    createdBy: '原始录入员',
    lastOperatedById: 'last-editor',
    lastOperatedBy: '最近编辑员',
    lastOperatedAt: '2026-11-04 18:05'
  });
  const result = context.render();
  assert.equal(result.columns.length, 24);
  assert.equal(new Set(result.columns.map((column) => column.id)).size, 24);
  for (const [id, label, value] of [
    ['createdBy', '录入人', '原始录入员'],
    ['lastOperatedBy', '最近操作人', '最近编辑员'],
    ['lastOperatedAt', '最近操作时间', '2026-11-04 18:05']
  ]) {
    assert.equal(renderedCellText(result.html, id), value);
    assert.ok(result.columns.some((column) => column.id === id && column.label === label));
  }
  assert.match(result.html, /data-action="column-settings" data-table-id="苹果ID余额"/);
  assert.match(result.html, /data-action="apple-edit"/);
  assert.match(result.html, /data-action="apple-details"/);
  assert.match(result.html, /data-action="apple-ledger"/);
  assert.equal(context.api.state.columns.size, 0);
  context.shared.showColumns('苹果ID余额');
  const picker = context.drawers.at(-1).body;
  for (const id of ['createdBy', 'lastOperatedBy', 'lastOperatedAt'])
    assert.match(picker, new RegExp(`id="column-${id}"[^>]* checked`));
  context.api.state.columns.set('苹果ID余额', new Set(['lastOperatedBy']));
  assert.doesNotMatch(context.render().html, /data-column="lastOperatedBy"/);
  context.api.state.columns.delete('苹果ID余额');
  assert.equal(renderedCellText(context.render().html, 'lastOperatedBy'), '最近编辑员');
});

test('Apple历史人员缺失显示未记录，不拿当前操作者或期初余额登记人补造', () => {
  const context = appleListRuntime(),
    asset = context.inventory.getAppleIds()[0];
  for (const key of ['createdBy', 'lastOperatedBy', 'lastOperatedAt']) delete asset[key];
  const result = context.render(),
    row = result.rows.find((item) => item.id === asset.id);
  for (const id of ['createdBy', 'lastOperatedBy', 'lastOperatedAt']) {
    assert.equal(result.columns.find((column) => column.id === id).render(row), '历史未记录');
    assert.equal(renderedCellText(result.html, id), '历史未记录');
  }
  assert.doesNotMatch(result.html, /演示测试员|演示初始化/);
});

test('实际库存状态事件更新Apple专表最近人员与北京时间，原录入出处和余额保持', () => {
  const context = appleListRuntime(),
    asset = context.inventory.getAppleIds()[0];
  Object.assign(asset, {
    createdById: 'original-creator',
    createdBy: '原始录入员',
    createdAt: '2026-10-01 09:00',
    lastOperatedBy: '旧操作员',
    lastOperatedAt: '2026-11-03 10:30'
  });
  context.render();
  const balance = context.ledger.get(asset.id).balance;
  context.api.state.actor = { id: 'state-operator', name: '状态操作员', role: 'admin' };
  context.api.nowText = () => '2026-11-04 19:45';
  context.module.onClick('inventory-health', { dataset: { id: asset.id, health: 'unlocking' } });
  const result = context.render();
  assert.equal(asset.inventoryHistory.at(-1).actorId, 'state-operator');
  assert.equal(asset.inventoryHistory.at(-1).time, '2026-11-04 19:45');
  assert.equal(renderedCellText(result.html, 'createdBy'), '原始录入员');
  assert.equal(renderedCellText(result.html, 'createdAt'), '2026-10-01 09:00');
  assert.equal(renderedCellText(result.html, 'lastOperatedBy'), '状态操作员');
  assert.equal(renderedCellText(result.html, 'lastOperatedAt'), '2026-11-04 19:45');
  assert.doesNotMatch(result.html, /旧操作员/);
  assert.equal(context.ledger.get(asset.id).balance, balance);
});
