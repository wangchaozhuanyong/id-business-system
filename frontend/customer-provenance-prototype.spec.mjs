import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as orderOpening from './order-opening.mjs';
import { URL } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('./commerce-prototype.js', import.meta.url), 'utf8');
const esc = (value = '') =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const units = (value = '0') => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
};
// Drive the real public handlers with fictional identities and form snapshots.
// No private exports, production data, network, or database is involved.
function runtime(localData) {
  let sequence = 0,
    callback,
    confirmation,
    time = '2026-11-04 10:30';
  const tables = [],
    drawers = [],
    notices = [],
    errors = new Map(),
    forms = [];
  const api = {
    state: {
      route: 'customers/list',
      query: '',
      demoOrders: [],
      drafts: new Map(),
      actor: { id: 'actor-a', name: '演示录入员' }
    },
    modules: {
      operations: {
        getCustomerTags: () => ['长期客户', '企业客户', '复购客户', '草稿标签'],
        getResources: () => [
          { id: 'card-demo-1', last6: '062847', status: '启用', currency: 'PHP', name: '演示卡' }
        ]
      }
    },
    money: {
      compare: (a, b) => (units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0),
      add: (a, b) => String((units(a) + units(b)) / 10000n),
      units,
      formatUnits: (v) => `${v / 10000n}.${String(v % 10000n).padStart(4, '0')}`
    },
    esc,
    icon: () => '',
    tag: esc,
    titleInfo: () => '',
    operatorIdProperty: (label, id) => `<div>${esc(label)} ${esc(id || '历史未记录')}</div>`,
    header: () => '',
    summary: () => '',
    button: () => '',
    textAction: () => '',
    empty: () => '',
    pagination: () => '',
    pageRows: (rows) => rows,
    table: (columns, rows, scope, id) => {
      tables.push({ columns, rows, scope, id });
      return '';
    },
    input: (id, value, attrs = '') =>
      `<input id="${id}" name="${id}" value="${esc(value)}" ${attrs}>`,
    select: (id) => `<select id="${id}" name="${id}"></select>`,
    field: (label, id, control) =>
      `<div class="field"><label for="${id}">${label}</label>${control}</div>`,
    readOptionList: (raw) => Array.isArray(raw) ? raw : JSON.parse(raw || '[]'),
    newId: (prefix) => `${prefix}-${++sequence}`,
    nowText: () => time,
    addCalendarMonth: () => '2026-12-03T10:30',
    readForm: (form) => ({ ...form.raw }),
    setError: (key, message) => errors.set(key, message),
    notify: (message) => notices.push(message),
    render: () => {},
    go: (route) => {
      api.state.route = route;
    },
    openDrawer: (title, description, body) => drawers.push({ title, description, body }),
    confirmAction: (_title, description, accept) => {
      confirmation = description;
      callback = accept;
    }
  };
  const modules = [];
  const document = {
    querySelectorAll: () => forms,
    querySelector: () => null,
    getElementById: () => null
  };
  runInNewContext(source, {
    window: { IDOrderOpening: orderOpening, IDDesignAPI: api, IDDesignModules: modules, IDLocalData: localData, IDPagination: { defaultPageSize: 10, render: () => '' } },
    document,
    structuredClone: globalThis.structuredClone,
    Date,
    Map,
    Set
  });
  const module = modules[0];
  function contact(raw = {}, kind = 'customer') {
    const form = {
      id: 'commerce-contact-form',
      dataset: { commerceDraft: `commerce-contact:${kind}:${raw.id || 'new'}` },
      raw: {
        'commerce-kind': kind,
        'commerce-name': '演示新客户',
        'commerce-phone': '演示联系电话',
        'commerce-tags': '["长期客户","企业客户"]',
        ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [`commerce-${key}`, value]))
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      removeAttribute() {}
    };
    module.onSubmit(form);
    return form;
  }
  function order(raw = {}) {
    const form = {
      id: 'commerce-order-form',
      dataset: { commerceDraft: 'commerce-order:test' },
      raw: {
        'commerce-product': 'GPT',
        'commerce-plan': 'Plus',
        'commerce-businessType': '续费',
        'commerce-email': 'own@example.test',
        'commerce-customerId': 'customer-demo-1',
        'commerce-paidAmount': '20',
        'commerce-saleAmount': '180',
        'commerce-paidCurrency': 'USD',
        'commerce-saleCurrency': 'CNY',
        'commerce-emailCostCurrency': 'CNY',
        'commerce-actualCostCurrency': 'CNY',
        'commerce-payment': '银行卡',
        'commerce-cardId': 'card-demo-1',
        'commerce-paymentId': '062847',
        'commerce-start': '2026-11-04T10:30',
        'commerce-expiry': '2026-12-03T10:30',
        'commerce-costBasis': 'standard',
        ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [`commerce-${key}`, value]))
      },
      querySelectorAll: () => [],
      elements: { namedItem: () => null },
      removeAttribute() {}
    };
    module.onSubmit(form);
    return form;
  }
  return {
    api,
    module,
    tables,
    drawers,
    notices,
    errors,
    forms,
    contact,
    order,
    confirmation: () => confirmation,
    confirm() {
      assert(callback, '没有待确认操作');
      const next = callback;
      callback = null;
      next();
    },
    time(value) {
      time = value;
    },
    table(route = 'customers/list', id = 'commerce-customers') {
      tables.length = 0;
      api.state.route = route;
      module.render();
      return tables.find((entry) => entry.id === id);
    },
    detail(id, kind = 'customer') {
      tables.length = 0;
      module.onClick('commerce-contact-detail', { dataset: { id, kind } });
      return drawers.at(-1);
    },
    records(id) {
      tables.length = 0;
      module.onClick('commerce-contact-services', { dataset: { id, kind: 'customer' } });
    },
    customers: () => api.modules.commerce.getCustomers(),
    tenants: () => api.modules.commerce.getTenants()
  };
}

test('客户和租户展示明确录入、修改字段，旧记录不冒充当前人', () => {
  const r = runtime();
  for (const [route, id] of [
    ['customers/list', 'commerce-customers'],
    ['customers/tenants', 'commerce-tenants']
  ]) {
    const t = r.table(route, id);
    for (const key of ['createdBy', 'createdAt', 'updatedBy', 'updatedAt']) {
      assert(t.columns.some((col) => col.id === key));
      assert.equal(t.columns.find((col) => col.id === key).render(t.rows[0]), '历史未记录');
    }
  }
  const c = r.table();
  for (const key of ['qq', 'tags', 'services']) assert(c.columns.some((col) => col.id === key));
});

test('客户与租户录入草稿独立，保存后留在当前页签并更新最近记录', () => {
  const r = runtime();
  r.api.state.route = 'customers/new';
  r.api.state.drafts.set('commerce-contact:customer:new', { 'commerce-name': '客户草稿' });
  const customer = r.module.render();
  assert.match(customer, /aria-selected="true"[^>]*data-tab="customer">客户录入/);
  assert.match(customer, /value="客户草稿"/);

  r.module.onClick('commerce-contact-entry-tab', { dataset: { tab: 'tenant' } });
  assert.equal(r.api.state.route, 'customers/new/tenant');
  assert.equal(r.module.matches(r.api.state.route), true);
  const tenant = r.module.render();
  assert.match(tenant, /aria-selected="true"[^>]*data-tab="tenant">租户录入/);
  assert.match(tenant, /name="commerce-kind" value="tenant"/);
  assert.doesNotMatch(tenant, /客户草稿/);
  r.contact({ name: '工作台租户' }, 'tenant');
  r.confirm();
  assert.equal(r.tenants()[0].name, '工作台租户');
  assert.equal(r.api.state.route, 'customers/new/tenant');
  r.module.render();
  assert.equal(r.tables.at(-1).rows[0].name, '工作台租户');

  r.module.onClick('commerce-contact-entry-tab', { dataset: { tab: 'customer' } });
  assert.match(r.module.render(), /value="客户草稿"/);
  r.contact({ name: '工作台客户', phone: '60123456789' });
  r.confirm();
  assert.equal(r.customers()[0].name, '工作台客户');
  assert.equal(r.api.state.route, 'customers/new');
  assert.equal(r.api.state.drafts.has('commerce-contact:customer:new'), false);
  r.module.render();
  assert.equal(r.tables.at(-1).rows[0].name, '工作台客户');
});

test('新增客户保存QQ和标签，录入身份由会话生成而非表单填写', () => {
  const r = runtime();
  r.contact({
    qq: '演示QQ新增',
    createdBy: '伪造名称',
    createdById: '伪造ID',
    createdAt: '2000-01-01',
    updatedBy: '伪造修改人'
  });
  r.confirm();
  const c = r.customers()[0];
  assert.equal(c.qq, '演示QQ新增');
  assert.deepEqual(Array.from(c.tags), ['长期客户', '企业客户']);
  assert.equal(c.createdBy, '演示录入员');
  assert.equal(c.createdById, 'actor-a');
  assert.equal(c.createdAt, '2026-11-04 10:30');
  assert.equal(c.updatedById, 'actor-a');
});

test('姓名必填而客户联系方式可空，失败保留草稿且不写入', () => {
  const r = runtime();
  const key = 'commerce-contact:customer:new';
  r.api.state.drafts.set(key, { 'commerce-name': '  ' });
  r.contact({ name: '  ', phone: '  ' });
  assert.equal(r.errors.get('commerce-contact-name'), '请填写姓名');
  assert.equal(r.errors.get('commerce-contact-phone'), '');
  assert.equal(r.customers().length, 3);
  assert(r.api.state.drafts.has(key));
  r.contact({ phone: '', qq: 'qq-only' });
  r.confirm();
  assert.equal(r.customers()[0].qq, 'qq-only');
  assert(!r.api.state.drafts.has(key));
  const before = r.customers().length;
  r.contact({ name: '网站下单无联系方式客户', phone: '', qq: '', wechat: '', whatsapp: '', telegram: '' });
  r.confirm();
  assert.equal(r.customers().length, before + 1);
  assert.equal(r.customers()[0].phone, '');
});

test('按同渠道核对重复客户，覆盖停用记录、格式差异和编辑冲突', () => {
  const r = runtime();
  r.contact({ name: '林先生', phone: '', wechat: ' ＤＥＭＯ＿ＬＩＮ ' });
  assert.match(r.errors.get('commerce-contact-wechat'), /已有同名客户/);
  assert.equal(r.customers().length, 3);
  r.module.onClick('commerce-contact-disable', {
    dataset: { id: 'customer-demo-1', kind: 'customer' }
  });
  r.confirm();
  r.contact({ name: '林先生', phone: '', telegram: 'DEMO_LIN' });
  assert.match(r.errors.get('commerce-contact-telegram'), /已停用.*恢复/);
  assert.equal(r.customers().length, 3);
  r.contact({ name: '同名客户', phone: '+60 (12) 345-6789' });
  r.confirm();
  r.contact({ name: '同名客户', phone: '+60123456789' });
  assert.match(r.errors.get('commerce-contact-phone'), /已有同名客户/);
  const saved = r.customers()[0];
  r.contact({
    id: saved.id,
    version: '1',
    name: saved.name,
    phone: saved.phone,
    notes: '可正常修改'
  });
  r.confirm();
  assert.equal(r.customers()[0].notes, '可正常修改');
  r.contact({ id: saved.id, version: '2', name: '陈女士', phone: '', wechat: 'demo_chen' });
  assert.match(r.errors.get('commerce-contact-wechat'), /已有同名客户/);
  assert.equal(r.customers()[0].version, 2);
});

test('同名不同联系方式可区分；共享联系方式只在核对后分别保存', () => {
  const r = runtime();
  r.contact({ name: '林先生', phone: '', qq: '独立演示QQ' });
  r.confirm();
  r.contact({ name: '另一位演示客户', phone: '', wechat: 'demo_lin' });
  assert.match(r.confirmation(), /其他客户已使用此客户微信.*不会合并/);
  assert.equal(r.customers().length, 4);
  r.confirm();
  assert.equal(r.customers().length, 5);
  assert.equal(r.customers().find((c) => c.id === 'customer-demo-1').name, '林先生');
});

test('另一人编辑只更新最近修改，录入人和时间保持不变', () => {
  const r = runtime();
  r.contact();
  r.confirm();
  const initial = r.customers()[0];
  r.api.state.actor = { id: 'actor-b', name: '演示修改员' };
  r.time('2026-11-04 11:30');
  r.contact({
    id: initial.id,
    version: '1',
    name: '编辑后',
    tags: '["复购客户"]',
    createdBy: '伪造'
  });
  r.confirm();
  const changed = r.customers()[0];
  assert.equal(changed.createdById, 'actor-a');
  assert.equal(changed.createdBy, '演示录入员');
  assert.equal(changed.createdAt, initial.createdAt);
  assert.equal(changed.updatedById, 'actor-b');
  assert.equal(changed.updatedAt, '2026-11-04 11:30');
  assert.deepEqual(Array.from(changed.tags), ['复购客户']);
  const detail = r.detail(changed.id);
  assert.match(detail.body, /QQ/);
  assert.match(detail.body, /客户标签/);
  assert.match(detail.body, /演示录入员/);
  assert.match(detail.body, /演示修改员/);
});

test('编辑历史记录不补造录入人，租户业务归属人与录入人分开', () => {
  const r = runtime();
  r.contact({ id: 'customer-demo-1', version: '1' });
  r.confirm();
  const c = r.customers().find((entry) => entry.id === 'customer-demo-1');
  assert.equal(c.createdBy, undefined);
  assert.equal(c.updatedById, 'actor-a');
  r.contact({ name: '新租户', owner: '业务负责人' }, 'tenant');
  r.confirm();
  const t = r.tenants()[0];
  assert.equal(t.owner, '演示录入员', '新增租户不再信任自由填写的归属人文字');
  assert.equal(t.ownerId, 'actor-a');
  assert.equal(t.createdBy, '演示录入员');
  const historical = r.tenants().find(row => row.id === 'tenant-demo-1');
  r.contact({ id: historical.id, version: String(historical.version), owner: '冒名修改', ownerId: 'actor-a' }, 'tenant');
  r.confirm();
  assert.equal(historical.owner, '林负责人');
  assert.equal(Object.hasOwn(historical, 'ownerId'), false, '历史文字归属不猜测员工编号');
});

test('员工新增租户只读显示自己，不读取可分配人员目录', () => {
  const actor = { id: 'staff', name: '当前员工', role: 'employee' };
  const r = runtime({ authRequired: true, actor: () => actor });
  r.module.onClick('commerce-contact-add', { dataset: { kind: 'tenant' } });
  const { body } = r.drawers.at(-1);
  assert.match(body, /id="commerce-contact-ownerId" value="当前员工" readonly/);
  assert.doesNotMatch(body, /commerce-contact-ownerId-picker|业务归属人员/);
});

test('历史业务按明确客户编号汇总次数、首末开通及来源单号，不按邮箱猜客户', () => {
  const r = runtime();
  const base = r.api.state.demoOrders[0];
  r.api.state.demoOrders.push(
    { ...base, id: 'older', orderNo: 'OLDER', start: '2026-09-01T10:00', cancelled: true },
    { ...base, id: 'later', orderNo: 'LATER', start: '2026-11-01T10:00' },
    {
      ...base,
      id: 'not-this-customer',
      customerId: '',
      orderNo: 'NO-CUSTOMER',
      start: '2026-08-01T10:00'
    },
    { ...base, id: 'unpaid', paidConfirmed: false, orderNo: 'UNPAID', start: '2026-07-01T10:00' },
    { ...base, id: 'synced', source: '线上代充', taskId: 'job-synced', orderNo: 'SYNCED',
      paidConfirmed: false, rechargeCompletedAt: '2026-10-15T02:00:12Z', start: '2026-10-15T10:00',
      expiry: '2026-11-15T10:00' },
    { ...base, id: 'pending-opening', source: '线上代充', taskId: 'job-pending', orderNo: 'NO-OPENING',
      paidConfirmed: true, rechargeCompletedAt: '', start: '2026-10-16T10:00', expiry: '2026-11-16T10:00' }
  );
  r.records('customer-demo-1');
  const table = r.tables.find((t) => t.id === 'commerce-contact-services');
  const service = table.rows.find((entry) => entry.name === 'GPT · Plus');
  assert.equal(service.count, 4);
  assert.equal(service.firstOpenedAt, '2026-09-01T10:00');
  assert.equal(service.lastOpenedAt, '2026-11-01T10:00');
  assert(!service.orderNos.includes('NO-CUSTOMER'));
  assert(!service.orderNos.includes('UNPAID'));
  assert(service.orderNos.includes('SYNCED'));
  assert(!service.orderNos.includes('NO-OPENING'));
  r.contact();
  r.confirm();
  r.records(r.customers()[0].id);
  assert.equal(r.tables.find((t) => t.id === 'commerce-contact-services').rows.length, 0);
});

test('列表搜索覆盖标签、历史业务、QQ、备注、录入人', () => {
  const r = runtime();
  r.contact({ qq: 'QQ-FIND', notes: '备注关键字' });
  r.confirm();
  for (const query of ['企业客户', 'QQ-find', '备注关键字', '演示录入员']) {
    r.api.state.query = query;
    assert.equal(r.table().rows.length, 1);
  }
  r.api.state.query = 'GPT · Plus';
  assert(r.table().rows.some((c) => c.id === 'customer-demo-1'));
});

test('编辑可选择配置标签并恢复草稿，关闭不会清空', () => {
  const r = runtime();
  const key = 'commerce-contact:customer:customer-demo-1';
  r.api.state.drafts.set(key, { 'commerce-tags': '["草稿标签"]', 'commerce-version': '1' });
  r.module.onClick('commerce-contact-edit', {
    dataset: { id: 'customer-demo-1', kind: 'customer' }
  });
  const { body } = r.drawers.at(-1);
  assert.match(body, /value="草稿标签" data-customer-tag checked/);
  assert.match(body, /value="企业客户" data-customer-tag/);
  assert.match(body, /for="commerce-contact-qq"/);
  assert(r.api.state.drafts.has(key));
});

test('非法、重复或未配置的标签阻止保存', () => {
  for (const tags of ['{}', '[1]', '["重复","重复"]', JSON.stringify(['长'.repeat(41)])]) {
    const r = runtime();
    r.contact({ tags });
    assert.match(r.errors.get('commerce-contact-tags'), /格式无效/);
    assert.equal(r.customers().length, 3);
  }
  const r = runtime();
  r.contact({ tags: '["未配置的标签"]' });
  assert.match(r.errors.get('commerce-contact-tags'), /可选标签已变化/);
  assert.equal(r.customers().length, 3);
});

test('版本冲突、确认期间身份变化和未登录时不写资料或人员', () => {
  const r = runtime();
  r.contact({ id: 'customer-demo-1', version: '0' });
  assert.match(r.notices.at(-1), /变化/);
  r.contact();
  r.api.state.actor = { id: 'actor-b', name: '另一人' };
  r.confirm();
  assert.equal(r.customers().length, 3);
  assert.match(r.notices.at(-1), /身份已变化/);
  r.api.state.actor = null;
  r.contact();
  assert.match(r.notices.at(-1), /身份不可用/);
});

test('停用和恢复记录实际修改人，旧录入人不被补造', () => {
  const r = runtime();
  r.module.onClick('commerce-contact-disable', {
    dataset: { id: 'customer-demo-1', kind: 'customer' }
  });
  r.confirm();
  const c = r.customers().find((entry) => entry.id === 'customer-demo-1');
  assert.equal(c.active, false);
  assert.equal(c.updatedById, 'actor-a');
  assert.equal(c.createdBy, undefined);
});

test('订单新增记录会话身份，编辑保留原录入身份和时间', () => {
  const r = runtime();
  r.api.state.route = 'workspace/order';
  r.order({ createdBy: '伪造', createdById: 'fake' });
  r.confirm();
  const first = r.api.modules.commerce.listOrders()[0];
  assert.equal(first.createdById, 'actor-a');
  r.api.state.actor = { id: 'actor-b', name: '订单修改员' };
  r.time('2026-11-04 12:30');
  r.order({
    id: first.id,
    version: String(first.version),
    correctionReason: '核对备注',
    createdBy: '伪造2'
  });
  r.confirm();
  const edited = r.api.modules.commerce.getOrder(first.id);
  assert.equal(edited.createdById, 'actor-a');
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(edited.updatedById, 'actor-b');
  assert.equal(edited.corrections[0].actorId, 'actor-b');
});

test('订单编辑不补造未知录入人，确认期间身份变化不保存', () => {
  const r = runtime();
  r.api.state.route = 'workspace/order';
  const previous = r.api.state.demoOrders[0];
  delete previous.createdBy;
  delete previous.createdAt;
  r.order({ id: previous.id, version: String(previous.version), correctionReason: '补充备注' });
  r.confirm();
  const edited = r.api.modules.commerce.getOrder(previous.id);
  assert.equal(edited.createdBy, '');
  assert.equal(edited.createdById, '');
  assert.equal(edited.createdAt, '');
  assert.equal(edited.updatedById, 'actor-a');
  r.order();
  r.api.state.actor = { id: 'actor-b', name: '另一账号' };
  r.confirm();
  assert.match(r.notices.at(-1), /身份已变化/);
  assert.equal(r.api.modules.commerce.listOrders().length, 11);
});

test('历史首末时间按北京时间数值排序，兼容空格格式且不统计未来订单', () => {
  const r = runtime();
  r.time('2026-11-03 10:30');
  const base = r.api.state.demoOrders[0];
  const originalCount = r.api.state.demoOrders.length;
  r.api.state.demoOrders.splice(
    0,
    originalCount,
    { ...base, id: 'morning', orderNo: 'MORNING', start: '2026-11-02T09:00' },
    { ...base, id: 'afternoon', orderNo: 'AFTERNOON', start: '2026-11-02 15:00' },
    { ...base, id: 'future', orderNo: 'FUTURE', start: '2026-11-04T09:00' }
  );
  r.records('customer-demo-1');
  const service = r.tables.find((t) => t.id === 'commerce-contact-services').rows[0];
  assert.equal(service.count, 2);
  assert.equal(service.firstOpenedAt, '2026-11-02T09:00');
  assert.equal(service.lastOpenedAt, '2026-11-02 15:00');
  assert(!service.orderNos.includes('FUTURE'));
});
