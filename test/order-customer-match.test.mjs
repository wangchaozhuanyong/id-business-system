import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { describeWriteOperation } from '../server/write-operation.mjs';
import { hasInlineOrderCustomerContact, matchInlineOrderCustomer, matchOrderCustomer,
  orderCustomerCalibrateAction, orderCustomerChanges, orderCustomerCreateAction } from '../frontend/order-opening.mjs';

const customer = (id, name, wechat, active = true) => ({ id, name, wechat, active, version: 1 });
const customers = [
  customer('unique', '客户Ａ', 'Acme_123'),
  customer('first', '同名客户', 'first'),
  customer('second', '同名客户', 'second'),
  customer('disabled', '停用客户', 'disabled', false),
  customer('unverified', '微信空缺', '')
];

test('按完整姓名和微信匹配，重名与停用资料不触发随单建档', () => {
  const match = (name, wechat = '') => matchOrderCustomer(customers, name, wechat);
  assert.deepEqual(match(' 客户a '), { kind: 'matched', customerId: 'unique' });
  assert.equal(match('同名客户').kind, 'ambiguous');
  assert.deepEqual(match('同名客户', 'ＳＥＣＯＮＤ'), { kind: 'matched', customerId: 'second' });
  assert.equal(match('同名客户', 'different').kind, 'same-name');
  assert.equal(match('微信空缺', 'different').kind, 'ambiguous');
  assert.equal(match('另一姓名', 'first').kind, 'wechat-conflict');
  assert.equal(match('停用客户').kind, 'inactive');
  assert.equal(match('另一姓名', 'disabled').kind, 'inactive');
  assert.equal(match('全新客户', 'different').kind, 'new');
  assert.equal(matchOrderCustomer([...customers, customer('same-pair', '同名客户', 'second', false)], '同名客户', 'second').kind,
    'ambiguous');
});

test('随单建档校验当前版本和客户唯一性，订单失败不写入客户', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const actor = { id: 'qa-admin', name: '隔离录单员', role: 'admin' };
  const save = (version, data, action) => store.saveBatch([{ domain: 'commerce', version, data, action }], { actor })[0];
  const seeded = save(0, { customers: structuredClone(customers), orders: [], tenants: [], operating: [], rentBatches: [], logs: [] }, '新增资料');
  const pending = (snapshot, id, name, wechat) => {
    const data = structuredClone(snapshot);
    data.customers.unshift({ ...customer('customer-' + id, name, wechat), createdById: 'other', source: '不得随单写入' });
    data.orders.unshift({
      id, version: 1, product: 'GPT', plan: 'Plus', source: '管理员手工', businessType: '续费',
      customerId: 'customer-' + id, email: id + '@example.test', payment: '银行卡', paidAmount: '20',
      paidCurrency: 'PHP', saleAmount: '100', saleCurrency: 'CNY', paidConfirmed: true, receiptConfirmed: true,
      start: '2026-11-11T12:00', expiry: '2026-12-11T12:00', corrections: [], refunds: [], bankReturns: []
    });
    return data;
  };
  const create = (version, data) => save(version, data, orderCustomerCreateAction);
  const orphan = pending(seeded.data, 'orphan', '孤立客户', 'orphan');
  orphan.orders = [];
  assert.throws(() => create(seeded.version, orphan), { status: 400 });

  const invalid = pending(seeded.data, 'bad-order', '新客户', 'new_wechat');
  invalid.orders[0].paidAmount = '0';
  assert.throws(() => create(seeded.version, invalid), { status: 400 });
  assert.deepEqual(store.load('commerce'), { version: seeded.version, data: seeded.data });
  assert.equal(store.audit().length, 1);

  for (const [name, wechat] of [['客户a', 'different'], ['另一姓名', 'DISABLED'], ['新客户', 'second']])
    assert.throws(() => create(seeded.version, pending(seeded.data, 'duplicate', name, wechat)), { status: 409 });

  const competing = pending(seeded.data, 'other-tab', '新客户', 'ＮＥＷ＿ＷＥＣＨＡＴ');
  const saved = create(seeded.version, pending(seeded.data, 'new-order', '新客户', 'new_wechat'));
  assert.equal(saved.data.orders[0].customerId, saved.data.customers[0].id);
  assert.equal(saved.data.customers[0].createdById, actor.id);
  assert.equal(saved.data.customers[0].createdBy, actor.name);
  assert.equal(Object.hasOwn(saved.data.customers[0], 'source'), false);
  assert.throws(() => create(seeded.version, competing), { status: 409 });
  assert.throws(() => create(saved.version, pending(saved.data, 'other-tab', '新客户', 'NEW_WECHAT')), { status: 409 });
  assert.deepEqual(store.load('commerce'), { version: saved.version, data: saved.data });
});

test('录单按五种联系方式匹配，保留姓名换号候选和跨档案冲突', () => {
  const a = { ...customers[0], phone: '+60 12-3456789', qq: '00912',
    whatsapp: 'https://wa.me/60123456789', telegram: '@Cust_A' };
  const b = { ...customers[1], phone: '13900000000' };
  const match = input => matchInlineOrderCustomer([a, b, ...customers.slice(2)], input);
  for (const input of [{ wechat: 'acme_123' }, { phone: '+60123456789' }, { qq: '00912' },
    { whatsapp: '+60123456789' }, { telegram: 'cust_a' }]) {
    const result = match(input);
    assert.equal(result.kind, 'matched');
    assert.equal(result.customerId, a.id);
  }
  assert.equal(match({ phone: '+8600912' }).kind, 'new');
  assert.equal(match({ name: '客户Ａ' }).kind, 'review');
  for (const field of ['wechat', 'phone', 'qq', 'whatsapp', 'telegram']) {
    const result = match({ name: a.name, [field]: ['phone', 'whatsapp'].includes(field) ? '+8613912345678' : 'new_contact' });
    assert.equal(result.kind, 'review');
    assert.deepEqual(result.ids, [a.id]);
  }
  assert.equal(match({ name: '停用客户' }).kind, 'inactive');
  assert.equal(match({ wechat: a.wechat, phone: b.phone }).kind, 'conflict');
  assert.equal(match({ wechat: a.wechat, name: b.name }).kind, 'conflict');
  assert.equal(match({ name: b.name, wechat: b.wechat }).customerId, b.id);
  assert.equal(match({ name: '同名客户' }).ids.length, 2);
  assert.equal(match({ name: a.name, whatsapp: '+86' }).kind, 'invalid');
  assert.equal(match({ source: '客户推荐', tags: [] }).kind, 'empty');
  assert.equal(match({ wechat: a.wechat, source: '客户推荐', tags: ['新标签'] }).customerId, a.id);
  assert.equal(match({ wechat: a.wechat, telegram: '@another_handle' }).kind, 'review');
  assert.deepEqual(orderCustomerChanges(a, { telegram: 'cust_a', tags: [], qq: '' }), {});
  assert.deepEqual(orderCustomerChanges(a, { name: '新姓名', tags: ['标签'] }), { name: '新姓名', tags: ['标签'] });
});

test('新版录单任意一种联系方式即可，姓名、空白和单填区号不计入', () => {
  for (const contact of [{ wechat: 'test_wx' }, { phone: '+60 12-3456789' }, { qq: '00912' },
    { whatsapp: '+60123456789' }, { telegram: '@demo_account' }])
    assert.equal(hasInlineOrderCustomerContact(contact), true);
  assert.equal(hasInlineOrderCustomerContact({ name: '只填姓名', wechat: '  ', phone: '', whatsapp: '+86', telegram: '@' }), false);
  assert.equal(hasInlineOrderCustomerContact({ whatsapp: '+60' }), false);
  assert.equal(hasInlineOrderCustomerContact({ phone: '+86' }), false);
  assert.equal(hasInlineOrderCustomerContact({ phone: '0060' }), false);
});

test('内联录单按标准化的联系电话匹配，不改写其他渠道或猜测旧裸号的国家', () => {
  const profiles = [
    { id: 'mobile', name: '手机号', phone: '138 0000 0000' },
    { id: 'landline', name: '固定电话', phone: '010-6500 1234' },
    { id: 'foreign', name: '其他国家', phone: '0060-5645455' },
    { id: 'unknown', name: '区号未确认', phone: '605645455' }
  ];
  const match = phone => matchInlineOrderCustomer(profiles, { phone });
  assert.equal(match('+8613800000000').customerId, 'mobile');
  assert.equal(match('+861065001234').customerId, 'landline');
  assert.equal(match('+605645455').customerId, 'foreign');
  assert.equal(match('605645455').kind, 'invalid');
  assert.deepEqual(orderCustomerChanges(profiles[1], { phone: '+86 (010) 6500 1234' }), {});
  assert.deepEqual(orderCustomerChanges(profiles[1], { phone: '0060-5645455' }), { phone: '+605645455' });
});

test('多人共用联系方式须选择，可用姓名和其他渠道缩小候选，交集为空时阻止绑定', () => {
  const household = [
    { id: 'first', name: '张一', phone: '13912345678', qq: '00123', telegram: '@first_c' },
    { id: 'second', name: '张二', phone: '13912345678', qq: '00123', telegram: '@second_c' },
    { id: 'third', name: '张三', phone: '13912345678', qq: '00999', wechat: 'third-c' },
    { id: 'other', name: '李四', phone: '13900000000', qq: '00123', wechat: 'other-c' }
  ];
  const match = fields => matchInlineOrderCustomer(household, { phone: '13912345678', ...fields });
  assert.deepEqual(match({}).ids, ['first', 'second', 'third']);
  assert.equal(match({}).kind, 'review');
  assert.deepEqual(match({ qq: '00123' }).ids, ['first', 'second']);
  assert.equal(match({ qq: '00123' }).customerId, undefined);
  assert.equal(match({ name: '张二' }).customerId, 'second');
  assert.equal(match({ qq: '00999' }).customerId, 'third');
  assert.equal(match({ qq: '00123', telegram: 'first_c' }).customerId, 'first');
  assert.equal(match({ qq: '00123', name: '张三' }).kind, 'conflict');
  assert.equal(match({ qq: '00123', wechat: 'other-c' }).kind, 'conflict');
  assert.equal(match({ name: '李四' }).kind, 'conflict');
  household[1].active = false;
  assert.equal(match({ name: '张二' }).kind, 'inactive');
  assert.equal(match({ qq: '00123' }).kind, 'review');
  assert.deepEqual(match({ qq: '00123' }).ids, ['first']);
});

test('录单复核只更新已确认客户，客户与订单同存，过期版本、冲突、非法字段均回滚', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const actor = { id: 'operator', name: '录单员', role: 'admin' };
  const save = (version, data, action, operation) => store.saveBatch([{ domain: 'commerce', version, data, action }],
    { actor, operation })[0];
  const profiles = structuredClone(customers);
  profiles[0].phone = profiles[1].phone = '13900000042';
  profiles.find(row => row.id === 'unverified').whatsapp = '+86';
  const seed = save(0, { customers: profiles, orders: [], tenants: [], operating: [], rentBatches: [], logs: [] }, '新增资料');
  function pending(snapshot, input, decision, id = 'unique', confirmedSameName = false) {
    const data = structuredClone(snapshot.data);
    const existing = data.customers.find(row => row.id === id);
    const review = { input, decision, customerVersion: existing?.version, confirmedSameName };
    data.orders.unshift({ id: 'order-' + (snapshot.version + 1), version: 1, product: 'GPT', plan: 'Plus',
      source: '管理员手工', businessType: '续费', customerId: id, email: 'customer@example.test', payment: '银行卡',
      paidAmount: '20', paidCurrency: 'PHP', saleAmount: '100', saleCurrency: 'CNY',
      start: '2026-11-11T12:00', expiry: '2026-12-11T12:00', customerMatchReview: review });
    if (decision === 'calibrate') Object.assign(existing, orderCustomerChanges(existing, input), { version: existing.version + 1 });
    if (decision === 'new') data.customers.unshift({ id, ...input, active: true, version: 1 });
    return data;
  }
  const updated = { name: customers[0].name, wechat: 'newWechat', whatsapp: '+8613912345678', source: '客户推荐' };
  const action = orderCustomerCalibrateAction;
  const stale = pending(seed, updated, 'calibrate');
  stale.orders[0].customerMatchReview.customerVersion = 0;
  const invalidOrder = pending(seed, updated, 'calibrate');
  invalidOrder.orders[0].paidAmount = '0';
  const forbiddenEdit = pending(seed, updated, 'calibrate');
  forbiddenEdit.customers[0].notes = '额外字段';
  const wrongSnapshot = pending(seed, updated, 'calibrate');
  wrongSnapshot.orders[0].wechat = customers[1].wechat;
  for (const [data, status] of [[stale, 409], [invalidOrder, 400], [forbiddenEdit, 409], [wrongSnapshot, 409],
    [pending(seed, { ...updated, wechat: customers[1].wechat }, 'calibrate'), 409]]) {
    assert.throws(() => save(seed.version, data, action), { status });
    assert.equal(store.load('commerce').version, seed.version);
  }
  for (const [input, decision, id, action] of [
    [{ name: '无联系方式的新客户', wechat: '  ' }, 'new', 'new-no-contact', orderCustomerCreateAction],
    [{ name: '微信空缺' }, 'matched', 'unverified', '新增独立订单'],
    [{ name: '微信空缺', source: '网站' }, 'calibrate', 'unverified', orderCustomerCalibrateAction]
  ]) {
    assert.throws(() => save(seed.version, pending(seed, input, decision, id), action),
      { status: 400, message: '请至少填写一种联系方式' });
    assert.deepEqual(store.load('commerce'), { version: seed.version, data: seed.data });
  }
  const proposal = pending(seed, updated, 'calibrate');
  const operation = describeWriteOperation('operation-order-customer-calibrate', actor,
    [{ domain: 'commerce', version: seed.version, data: proposal, action }]);
  const saved = save(seed.version, proposal, action, operation);
  assert.equal(saved.data.customers[0].wechat, updated.wechat);
  assert.equal(saved.data.customers[0].updatedById, actor.id);
  assert.equal(saved.data.orders[0].whatsapp, updated.whatsapp);
  assert.equal(saved.data.orders[0].wechat, updated.wechat);
  assert.equal(saved.data.orders[0].customerMatchReview, undefined);
  assert.ok(proposal.orders[0].customerMatchReview);
  assert.equal(save(seed.version, proposal, action, operation).version, saved.version);
  assert.equal(saved.data.orders.length, 1);
  assert.throws(() => save(seed.version, proposal, action), { status: 409 });
  const sameName = { ...updated, wechat: 'other_wechat', phone: '0060-5645455', whatsapp: '+60123456789', qq: '123456' };
  assert.throws(() => save(saved.version, pending(saved, sameName, 'new', 'other'), orderCustomerCreateAction), { status: 409 });
  const created = save(saved.version, pending(saved, sameName, 'new', 'other', true), orderCustomerCreateAction);
  assert.equal(created.data.customers[0].source, '客户推荐');
  assert.equal(created.data.customers[0].phone, '+605645455');
  assert.equal(created.data.orders[0].customerPhone, '+605645455');
  assert.equal(created.data.customers[0].qq, '123456');
  assert.equal(created.data.customers[0].whatsapp, '+60123456789');
  assert.equal(created.data.customers[0].createdById, actor.id);
  const silent = pending(created, { name: updated.name, wechat: 'another_wechat' }, 'matched');
  assert.throws(() => save(created.version, silent, '新增独立订单'), { status: 409 });
  const unchanged = save(created.version, pending(created, { name: updated.name }, 'matched'), '新增独立订单');
  assert.deepEqual(unchanged.data.customers, created.data.customers);
  assert.equal(unchanged.data.orders[0].wechat, updated.wechat);
  const shared = { phone: profiles[0].phone };
  const outside = pending(unchanged, shared, 'matched', 'second');
  assert.throws(() => save(unchanged.version, outside, '新增独立订单'), { status: 409 });
  const chosen = save(unchanged.version, pending(unchanged, shared, 'matched', 'first'), '新增独立订单');
  assert.equal(chosen.data.orders[0].customerId, 'first');
  assert.equal(chosen.data.orders[0].customerPhone, '+86' + shared.phone);
  assert.deepEqual(chosen.data.customers, unchanged.data.customers);
});
