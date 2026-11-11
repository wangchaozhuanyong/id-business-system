import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as orderOpening from './order-opening.mjs';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./commerce-prototype.js', import.meta.url), 'utf8');
const escape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;');
const units = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
};

// Capture column definitions from the real module's public render path. No
// private exports, website, database, or production data are used by this test.
function runtime() {
  let sequence = 0;
  const tables = [],
    buttons = [],
    drawers = [],
    modules = [];
  const api = {
    state: {
      route: 'orders/gpt',
      query: '',
      demoOrders: [],
      drafts: new Map(),
      actor: { id: 'demo', name: '演示测试员' }
    },
    modules: {},
    money: {
      compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0)
    },
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => '2026-11-03 10:30',
    esc: escape,
    icon: () => '',
    button: (label, action, _kind, _icon, attributes = '') => {
      buttons.push({ label, action, attributes });
      return `<button data-action="${action}" ${attributes}>${label}</button>`;
    },
    textAction: (label) => label,
    tag: (label) => `<span>${label}</span>`,
    header: (_title, _description, actions = '') => actions,
    summary: () => '',
    empty: () => '',
    titleInfo: () => '',
    pagination: () => '',
    select: () => '<select></select>',
    canVisit: () => true,
    pageRows: (rows) => rows,
    getSelection: () => new Set(),
    table: (columns, rows, scope, id) => {
      tables.push({ columns, rows, scope, id });
      return `<table data-table="${escape(id)}"></table>`;
    },
    openDrawer: (title, description, body) => drawers.push({ title, description, body })
  };
  runInNewContext(source, {
    window: { IDOrderOpening: orderOpening, IDDesignAPI: api, IDDesignModules: modules, IDPagination: { defaultPageSize: 10, render: () => '' } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    structuredClone: globalThis.structuredClone,
    Date,
    Map,
    Set
  });
  const module = modules.find((entry) => entry.id === 'commerce');
  return {
    api,
    module,
    tables,
    drawers,
    render(route, id) {
      tables.length = 0;
      buttons.length = 0;
      api.state.route = route;
      module.render();
      const captured = tables.find((entry) => entry.id === id);
      assert(captured, `缺少表格 ${id}`);
      const setting = buttons.find(
        (button) =>
          button.label === '列设置' &&
          button.action === 'column-settings' &&
          button.attributes === `data-table-id="${id}"`
      );
      assert(setting, `${id} 列设置入口未绑定实际表格`);
      return captured;
    }
  };
}

function requireColumns(table, ids) {
  const actual = Array.from(table.columns, (column) => column.id);
  assert.equal(new Set(actual).size, actual.length, '每个字段必须使用独立且唯一的列编号');
  for (const id of ids) assert(actual.includes(id), `${table.id} 缺少 ${id}`);
}

const orderColumns = [
  'orderNo',
  'owner',
  'customerId',
  'email',
  'plan',
  'businessType',
  'payment',
  'paymentId',
  'paidAmount',
  'saleAmount',
  'profit',
  'start',
  'expiry',
  'expiryReminder',
  'paymentStatus',
  'expiryStatus',
  'refundStatus',
  'accountStatus',
  'businessStatus',
  'status',
  'wechat',
  'customerPhone',
  'whatsapp',
  'telegram',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
  'notes',
  'source',
  'actions'
];
const claudeColumns = [
  'phone',
  'kyc',
  'verifier',
  'verifierPhone',
  'tenantId'
];

test('GPT 列表完整显示联系、交易、周期和备注字段，并绑定本表列设置', () => {
  const context = runtime();
  const table = context.render('orders/gpt', 'commerce-orders-GPT');
  requireColumns(table, orderColumns);
  for (const column of table.columns) {
    assert(!claudeColumns.includes(column.id), 'GPT 不应混入 Claude 人员专属列');
    assert(
      !['cardId', 'emailType', 'accountSource', 'previousOrderId', 'actualOpenedAt'].includes(column.id),
      '不能恢复后续明确取消的订单字段'
    );
  }
  const expiry = table.columns.find((column) => column.id === 'expiryReminder');
  const owner = table.columns.find(column => column.id === 'owner');
  assert.equal(owner.render({ ownerId: 'staff', owner: '业务员工', createdBy: '代录管理员' }), '业务员工');
  assert.equal(owner.render({ createdBy: '原录入人' }), '原录入人');
  assert.equal(owner.render({}), '历史未记录');
  const profit = table.columns.find(column => column.id === 'profit');
  assert.equal(profit.render({ ...table.rows[0], paidConfirmed: false }), '—');
  assert.match(expiry.render(table.rows[0]), /天后到期/);
  assert.match(expiry.render({ entitlementStatus: 'active', start: '2026-09-01T10:30', expiry: '2026-10-01T10:30' }), /已过期/);
  assert.match(expiry.render({ start: '2026-09-01T10:30', expiry: '2026-10-01T10:30' }), /待确认/);
  for (const id of ['createdAt', 'notes']) {
    const column = table.columns.find((entry) => entry.id === id);
    assert.equal(column.render({ [id]: '已填写资料' }), '已填写资料');
    assert.equal(column.render({}), id === 'createdAt' ? '历史未记录' : '未记录');
  }
});

test('Claude 同表保留 Pro、Max 的独立订单及认证资料列', () => {
  const context = runtime();
  const table = context.render('orders/claude', 'commerce-orders-Claude');
  requireColumns(table, [...orderColumns, ...claudeColumns]);
  assert.deepEqual([...new Set(table.rows.map(row => row.plan))].sort(), ['Max 20x', 'Max 5x', 'Pro']);
  assert.equal(new Set(table.rows.map(row => row.id)).size, table.rows.length);
  assert(!table.columns.some(column => column.id === 'cardId'));
  for (const id of claudeColumns) {
    const column = table.columns.find(entry => entry.id === id);
    assert.equal(column.render({}), id === 'owner' ? '历史未记录' : '未记录');
    if (id === 'owner') assert.equal(column.render({ createdBy: '录入员工', owner: '旧归属' }), '录入员工');
    else if (id === 'tenantId') assert.equal(column.render({ tenantId: 'tenant-demo-1' }), '陈租户');
    else assert.equal(column.render({ [id]: '已填写资料' }), '已填写资料');
  }
});

test('各产品共用银行卡资料列，旧单和 Apple 内购各自显示原口径', () => {
  const context = runtime();
  const pro = context.render('orders/claude', 'commerce-orders-Claude');
  const columns = ['proMaterialMode', 'proCardNumber', 'proCardSerial'];
  requireColumns(pro, columns);
  const manual = {
    product: 'Claude Pro', payment: '银行卡', proMaterialMode: 'manual_card',
    proCardNumber: '•••• 4242', proCardSerial: '00042-QA'
  };
  const render = (id, row) => pro.columns.find((column) => column.id === id).render(row);
  assert.equal(render('proMaterialMode', manual), '手动填写银行卡');
  assert.equal(render('proCardNumber', manual), '•••• 4242');
  assert.equal(render('proCardSerial', manual), '00042-QA');
  assert.equal(render('proMaterialMode', { product: 'Claude Pro', payment: '银行卡' }), '原订单资料');
  assert.equal(render('proMaterialMode', { product: 'Claude Pro', payment: '苹果内购' }), '不适用');
  assert.equal(render('proMaterialMode', { product: 'Claude Max', payment: '银行卡', proMaterialMode: 'tenant_card' }), '用卡人银行卡');
  requireColumns(context.render('orders/gpt', 'commerce-orders-GPT'), ['proMaterialMode', 'proCardNumber']);
});

test('客户与租户列表字段及列设置齐全', () => {
  const context = runtime();
  requireColumns(context.render('customers/list', 'commerce-customers'), [
    'name',
    'phone',
    'wechat',
    'qq',
    'whatsapp',
    'telegram',
    'source',
    'tags',
    'services',
    'createdBy',
    'createdAt',
    'updatedBy',
    'updatedAt',
    'notes',
    'actions'
  ]);
  requireColumns(context.render('customers/tenants', 'commerce-tenants'), [
    'name',
    'phone',
    'owner',
    'accounts',
    'createdBy',
    'createdAt',
    'updatedBy',
    'updatedAt',
    'notes',
    'actions'
  ]);
});

test('租户关联订单显示业务类型与当前运营状态，能看到冻结账号且不编造人员电话', () => {
  const context = runtime();
  context.module.onClick('commerce-contact-orders', {
    dataset: { id: 'tenant-demo-1', kind: 'tenant' }
  });
  const table = context.tables.find((entry) => entry.id === 'commerce-contact-orders');
  assert(table);
  requireColumns(table, [
    'orderNo',
    'email',
    'plan',
    'businessType',
    'start',
    'expiry',
    'accountStatus',
    'actions'
  ]);
  const frozen = table.rows.find((row) => row.email === 'claude.08@example.test');
  assert(frozen);
  assert.equal(
    table.columns.find((column) => column.id === 'accountStatus').render(frozen),
    '冻结'
  );
  assert.equal(
    table.columns.some((column) => column.id === 'ownerPhone'),
    false
  );
});
