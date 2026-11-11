import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleLocalBusiness } from '../server/local-business.mjs';
import { applyOrderCompletion, readOrderCompletion, rechargePriceSnapshot } from '../server/order-completion.mjs';
import { buildRechargeOrder, rechargeOrderEvidence } from '../server/recharge-order-sync.mjs';

const at = '2026-11-10T09:30:00.000Z';
const a = { id: 'staff-a', name: '员工甲', role: 'employee' };
const b = { id: 'staff-b', name: '员工乙', role: 'employee' };
const admin = { id: 'admin', name: '管理员', role: 'admin' };
const disabled = { id: 'inactive', name: '已停用', role: 'employee', active: false };
const owners = () => [a, b, admin, disabled];
const settings = {
  orderPrices: { GPT: { Plus: { CNY: '140.00', MYR: '90' } } },
  gptPaidPrices: { Plus: { PHP: '100.0000', MYR: '60' } },
  customerSources: ['网站', '客户推荐']
};
const price = rechargePriceSnapshot({ version: 8, data: settings }, 'Plus', at);
const existing = { id: 'customer-a', active: true, name: '已有客户', version: 3, phone: '123456', source: '' };
const order = (id, props = {}) => ({
  id, orderNo: 'SYN-' + id, source: '线上代充', taskId: 'task-' + id, email: id + '@example.test',
  product: 'GPT', plan: 'Plus', version: 1, rechargeOwnerId: a.id, createdById: a.id,
  saleAmount: price.saleAmount, saleCurrency: price.saleCurrency, paidAmount: '100', paidCurrency: 'PHP',
  paidConfirmed: true, receiptConfirmed: false, rechargePriceSnapshot: price, ...props
});
const payload = (...orders) => ({
  orders,
  customers: [existing, { id: 'inactive-customer', active: false, name: '已停用客户' }]
});
const view = (data, actor, query = {}) => readOrderCompletion(data, settings, actor, new URLSearchParams(query), owners);
const change = (data, actor, command) => applyOrderCompletion(data, settings, actor, command, owners, at);
const listIds = (data, actor) => view(data, actor).items.map(({ id }) => id);
const complete = { action: 'complete', orderId: 'own', version: 1, customerId: existing.id,
  customerVersion: existing.version, customerSource: '网站', contacts: { wechat: 'contact-test' }, notes: '业务补充' };

test('有效充值码把成功入单映射到领用员工，列表、详情资料和检索按订单归属隔离', () => {
  const task = { jobKey: 'job-a', status: 'success', cdk: 'synthetic-code', createdAt: at, cardLast4: '1234' };
  const evidence = rechargeOrderEvidence(task, {
    now: Date.parse(at),
    bills: [{ cdk_code: 'synthetic-code', email: 'acct@example.test', status: 'success', plan_type: 'plus', payment_time: at,
      stripe_session_id: 'synthetic-session', card_last4: '1234' }],
    codes: [], cards: [],
    ownerData: { requests: [{ id: 'batch-a', status: 'issued', applicantId: a.id, codes: ['SYNTHETIC-CODE'] }] }
  });
  assert.equal(evidence.employeeId, a.id);
  const imported = { ...buildRechargeOrder(evidence, settings, Date.parse(at)), id: 'imported', orderNo: 'SYN-imported' };
  assert.equal(imported.rechargeOwnerId, a.id);
  const data = payload(imported, order('own', { cardId: 'internal-card', cdk: task.cdk }),
    order('another', { rechargeOwnerId: b.id, createdById: b.id }),
    order('historical', { rechargeOwnerId: undefined }),
    order('unassigned', { rechargeOwnerId: '', createdById: '' }),
    order('manual', { source: '手工录单' }), order('void', { cancelled: true }),
    order('draft', { status: 'draft' }));
  assert.deepEqual(listIds(data, a), ['imported', 'own', 'historical']);
  assert.deepEqual(listIds(data, b), ['another']);
  assert.deepEqual(listIds(data, admin), ['imported', 'own', 'another', 'historical', 'unassigned']);
  assert.equal(view(data, admin).items.at(-1).state, 'unassigned');
  assert.equal(view(data, a).canAssign, false);
  assert.deepEqual(view(data, a).owners, []);
  assert.equal(view(data, a, { orderId: 'own', q: '123-456' }).items[0].id, existing.id);
  assert.deepEqual(view(data, a, { orderId: 'own', q: '已停用' }).items, []);
  assert.throws(() => view(data, b, { orderId: 'own', q: '客户' }), { status: 404 });
  assert.throws(() => view(data, null), { status: 403 });
  assert.doesNotMatch(JSON.stringify(view(data, a)), /synthetic-code|internal-card|task-own/i);
});

test('配置与实际扣款独立，历史订单保留原收费并标记缺失依据', () => {
  assert.deepEqual(price, {
    settingsVersion: 8, at, saleAmount: '140.00', saleCurrency: 'CNY', paidPrices: { PHP: '100.0000', MYR: '60' }
  });
  const changedSettings = { ...settings, orderPrices: { GPT: { Plus: { CNY: '199' } } },
    gptPaidPrices: { Plus: { PHP: '109' } } };
  const data = payload(order('same'), order('difference', { paidAmount: '101', receiptConfirmed: true }),
    order('historical', { rechargePriceSnapshot: undefined, saleAmount: '130' }),
    order('unknown', { paidAmount: '', paidCurrency: '', paidConfirmed: false }),
    order('unpriced', { saleAmount: '', rechargePriceSnapshot: rechargePriceSnapshot({ version: 0, data: null }, 'Plus', at) }));
  const [same, difference, historical, unknown, unpriced] = readOrderCompletion(data, changedSettings, a, new URLSearchParams(), owners).items;
  assert.equal(same.configuredSaleAmount, '140.00');
  assert.equal(same.standardPaidAmount, '100.0000');
  assert.deepEqual(same.financeIssues, ['实收待确认']);
  assert.deepEqual(difference.financeIssues, ['配置代付与实际扣款有差额']);
  assert.equal(difference.paidAmount, '101');
  assert.equal(historical.saleAmount, '130');
  assert.equal(historical.configuredSaleAmount, '');
  assert(historical.financeIssues.includes('历史定价依据待核对'));
  assert(unknown.financeIssues.includes('代充实扣待核对'));
  assert(unpriced.financeIssues.includes('入库时未配置收费金额'));
  assert(unpriced.financeIssues.includes('入库时未配置该币种代付金额'));
  assert.equal(change(data, a, { ...complete, orderId: unpriced.id }).order.customerId, existing.id);
});

test('补齐原单客户资料时保留入库金额、回执、归属和现有资料', () => {
  const prior = order('own', { fxSnapshot: { source: 'fixture' }, paymentId: '1234', financialEvidence: [{ kind: 'payment' }] });
  const data = payload(prior);
  const result = change(data, a, complete);
  const updated = result.order;
  assert.equal(updated.id, prior.id);
  assert.equal(updated.orderNo, prior.orderNo);
  assert.equal(updated.customerId, existing.id);
  assert.equal(updated.customerSource, '网站');
  assert.equal(updated.customerPhone, existing.phone);
  assert.equal(updated.wechat, 'contact-test');
  assert.equal(updated.notes, '业务补充');
  assert.equal(updated.updatedById, a.id);
  assert.equal(updated.version, 2);
  for (const key of ['createdById', 'rechargeOwnerId', 'paidAmount', 'paidCurrency', 'saleAmount', 'saleCurrency',
    'paidConfirmed', 'receiptConfirmed', 'rechargePriceSnapshot', 'paymentId', 'fxSnapshot', 'financialEvidence'])
    assert.deepEqual(updated[key], prior[key], key);
  assert.deepEqual(result.customer, { ...existing, version: 4, source: '网站', wechat: 'contact-test',
    updatedById: a.id, updatedBy: a.name, updatedAt: at });
  assert.equal(data.orders[0], prior);
  assert.equal(data.customers[0].source, '');
  const filled = { orders: [updated], customers: [result.customer] };
  assert.equal(view(filled, a).items[0].state, 'complete');
  assert.throws(() => change(filled, a, complete), { status: 409 });
  for (const command of [
    { customerId: 'someone-else' }, { customerSource: '客户推荐' },
    { contacts: { wechat: 'different' } }, { notes: '改旧备注' }
  ]) assert.throws(() => change(filled, a, { ...complete, version: 2, customerVersion: 4, ...command }), { status: 409 });
});

test('严格拒绝越权、金额字段、未设置来源和并发资料覆盖', () => {
  const data = payload(order('own'));
  assert.throws(() => change(data, b, complete), { status: 404 });
  for (const key of ['saleAmount', 'paidAmount', 'receiptConfirmed', 'rechargePriceSnapshot', 'ownerId', 'plan', 'email'])
    assert.throws(() => change(data, a, { ...complete, [key]: 'tampered' }), { status: 400 });
  assert.throws(() => change(data, a, { ...complete, contacts: { start: at } }), { status: 400 });
  assert.throws(() => change(data, a, { ...complete, customerSource: '无此来源' }), { status: 400 });
  assert.throws(() => change(data, a, { ...complete, customerVersion: 2 }), { status: 409 });
  assert.throws(() => change(data, a, { ...complete, customerId: 'inactive-customer', customerVersion: 0 }), { status: 409 });
  assert.throws(() => change(data, a, {
    action: 'complete', orderId: 'own', version: 1, newCustomer: { name: '新客户', notes: '不可通过嵌套字段写入' },
    customerSource: '网站'
  }), { status: 400 });
});

test('新客户与原单的关联一起产生，重复客户不会被静默创建', () => {
  const data = payload(order('own'));
  const command = { action: 'complete', orderId: 'own', version: 1, newCustomer: { name: '新客户' },
    customerSource: '客户推荐', contacts: { customerPhone: '789012' } };
  const result = change(data, a, command);
  assert.equal(result.createdCustomer, true);
  assert.equal(result.customer.name, '新客户');
  assert.equal(result.customer.createdById, a.id);
  assert.equal(result.customer.source, '客户推荐');
  assert.equal(result.order.customerId, result.customer.id);
  assert.equal(result.order.customerPhone, result.customer.phone);
  assert.throws(() => change(data, a, { ...command, newCustomer: { name: existing.name },
    contacts: { customerPhone: '123-456' } }), { status: 409 });
});

test('只有管理员可为待归属单选择启用员工，已有归属不可重分配', () => {
  const data = payload(order('unassigned', { rechargeOwnerId: '', createdById: '' }));
  const command = { action: 'assign', orderId: 'unassigned', version: 1, ownerId: a.id, reason: '已核对领用记录' };
  assert.throws(() => change(data, a, command), { status: 403 });
  assert.throws(() => change(data, admin, { ...command, ownerId: disabled.id }), { status: 409 });
  assert.throws(() => change(data, admin, { ...command, reason: ' ' }), { status: 400 });
  const { order: assigned } = change(data, admin, command);
  assert.equal(assigned.ownerId, a.id);
  assert.equal(assigned.createdById, '');
  assert.deepEqual(assigned.rechargeOwnerAssignment, { actorId: admin.id, at, reason: command.reason });
  const updated = payload(assigned);
  assert.deepEqual(listIds(updated, a), ['unassigned']);
  assert.deepEqual(listIds(updated, b), []);
  assert.throws(() => change(updated, admin, { ...command, version: 2 }), { status: 409 });
});

test('HTTP 只允许同源 POST 保存并返回窄结果', async () => {
  const origin = 'https://completion.example.test';
  const data = payload(order('own'));
  let changes = 0;
  const store = {
    orderCompletionView: (actor, params) => readOrderCompletion(data, settings, actor, params, owners),
    saveOrderCompletion: (actor, command) => {
      const result = change(data, actor, command);
      changes++;
      return { orderId: result.order.id, version: 2 };
    }
  };
  async function request(method, actor, command, from = origin) {
    const req = Readable.from(command ? [Buffer.from(JSON.stringify(command))] : []);
    Object.assign(req, { method, url: '/api/local/order-completion', headers: { origin: from, 'content-type': 'application/json' } });
    const headers = {};
    let status, body;
    await handleLocalBusiness(req, {
      setHeader(name, value) { headers[name] = value; },
      writeHead(value) { status = value; },
      end(value) { body = JSON.parse(value); }
    }, req.url, store, actor, { publicOrigin: origin });
    return { status, body, headers };
  }
  const result = await request('GET', a);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.body.items[0].id, 'own');
  assert.equal((await request('GET', null)).status, 403);
  assert.equal((await request('POST', a, complete, 'https://other.example.test')).status, 403);
  assert.equal((await request('PUT', a, complete)).status, 405);
  assert.equal((await request('POST', b, complete)).status, 404);
  assert.equal((await request('POST', a, { ...complete, paidAmount: '1' })).status, 400);
  assert.equal(changes, 0);
  assert.deepEqual((await request('POST', a, complete)).body, { orderId: 'own', version: 2 });
  assert.equal(changes, 1);
});
