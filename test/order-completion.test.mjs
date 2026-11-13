import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { applyOrderCompletion, assignMissingManualOrderOwners, fillManualOrderDetails,
  readOrderCompletion, rechargePriceSnapshot } from '../server/order-completion.mjs';
import { createOrderSnapshot, calculateConfirmedNetReceipt } from '../modules/finance/accounting.mjs';
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
  assert.deepEqual(new Set(listIds(data, admin)), new Set(['imported', 'own', 'another', 'historical', 'unassigned']));
  assert.equal(view(data, admin).items.find(row => row.id === 'unassigned').state, 'unassigned');
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
  const { items } = readOrderCompletion(data, changedSettings, a, new URLSearchParams(), owners);
  const { same, difference, historical, unknown, unpriced } = Object.fromEntries(items.map(row => [row.id, row]));
  assert.equal(same.configuredSaleAmount, '140.00');
  assert.equal(same.standardPaidAmount, '100.0000');
  assert.deepEqual(same.financeIssues, ['客户实收未登记']);
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

test('订单补全按实际开通时间由新到旧，旧单缺开通时间时使用已知业务时间', () => {
  const data = payload(
    order('unknown-time'),
    order('old-opening', { rechargeCompletedAt: '2026-11-08T03:00:00Z', createdAt: '2026-11-12 11:30' }),
    order('new-opening', { rechargeCompletedAt: '2026-11-10 16:00', createdAt: '2026-11-10 15:00' }),
    order('legacy-start', { start: '2026-11-09 09:00' })
  );
  assert.deepEqual(listIds(data, a), ['new-opening', 'legacy-start', 'old-opening', 'unknown-time']);
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
  assert.equal(view(filled, a).items[0].state, 'pending');
  assert.deepEqual(view(filled, a).items[0].missing, ['客户实收']);
  assert.throws(() => change(filled, a, complete), { status: 409 });
  for (const command of [
    { customerId: 'someone-else' }, { customerSource: '客户推荐' },
    { contacts: { wechat: 'different' } }, { notes: '改旧备注' }
  ]) assert.throws(() => change(filled, a, { ...complete, version: 2, customerVersion: 4, ...command }), { status: 409 });
});

test('严格拒绝越权、直接覆盖财务字段、无效资料和并发覆盖', () => {
  const data = payload(order('own'));
  assert.throws(() => change(data, b, complete), { status: 404 });
  for (const key of ['saleAmount', 'paidAmount', 'receiptConfirmed', 'rechargePriceSnapshot', 'plan', 'email'])
    assert.throws(() => change(data, a, { ...complete, [key]: 'tampered' }), { status: 400 });
  assert.throws(() => change(data, a, { ...complete, ownerId: b.id, reason: '合成依据' }), { status: 403 });
  assert.throws(() => change(data, a, { ...complete, receipt: { amount: 'not money', currency: 'CNY' } }), { status: 400 });
  assert.throws(() => change(data, a, { ...complete, receipt: { amount: '25', currency: 'XX' } }), { status: 400 });
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

test('同一 GPT 原单补分配、客户及跨币种实收，后续回读和重试不覆盖记录', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const evidence = { jobKey: 'new-recharge', email: '', plan: 'Plus', start: '2026-11-10T17:30',
    expiry: '2026-12-10T17:30', completedAt: at, paidAmount: '100', paidCurrency: 'PHP',
    paymentId: '', cardId: '', employeeId: '' };
  const auto = buildRechargeOrder(evidence, settings, Date.parse(at));
  auto.fxSnapshot = createOrderSnapshot({ source: '合成凭据 R-11', at: '2026-11-10T00:00:00Z',
    expiresAt: '2026-11-11T00:00:00Z', rates: { MYR: '1.6', PHP: '0.12', USD: '7' } }, auto, Date.parse(at));
  const upstream = { since: Date.parse(at), row: { jobKey: auto.taskId, needs: ['邮箱证据待核对'] }, order: auto };
  const imported = store.applyRechargeOrder(upstream);
  const [{ id }] = store.load('commerce').data.orders;
  assert.equal(store.orderCompletionView(a, new URLSearchParams(), owners).items.length, 0);
  const partial = store.saveOrderCompletion(admin, { action: 'complete', orderId: id, version: 1, notes: '合成备注' }, owners);
  assert.equal(partial.state, 'unassigned');
  const command = { action: 'complete', orderId: id, version: 2, ownerId: a.id, reason: '已核对领码记录',
    newCustomer: { name: '测试买家' }, receipt: { amount: '90.50', currency: 'MYR' } };
  const saved = store.saveOrderCompletion(admin, command, owners);
  assert.equal(saved.state, 'complete');
  assert.throws(() => store.saveOrderCompletion(admin, command, owners), { status: 409 });
  const { data } = store.load('commerce');
  assert.equal(data.customers.length, 1);
  assert.equal(data.orders.length, 1);
  const [original] = data.orders;
  assert.equal(original.orderNo, imported.orderNo);
  assert.equal(original.email, '');
  assert.equal(original.paymentId, '');
  assert.equal(original.customerSource, undefined);
  assert.equal(original.notes, '合成备注');
  assert.deepEqual(original.financialEvidence.map(event => [event.kind, event.amount, event.currency]),
    [['payment', '100', 'PHP'], ['receipt', '90.50', 'MYR']]);
  assert.equal(calculateConfirmedNetReceipt(original, { currency: 'CNY', clock: Date.parse(at) }), '144.8000');

  const readback = { ...upstream, order: { ...auto, email: 'captured@example.test', paymentId: '1234', rechargeOwnerId: b.id } };
  assert.equal(store.applyRechargeOrder(readback).orderNo, original.orderNo);
  assert.equal(store.applyRechargeOrder(readback).orderNo, original.orderNo);
  const updated = store.load('commerce').data.orders;
  assert.equal(updated.length, 1);
  assert.equal(updated[0].version, 4);
  assert.equal(updated[0].email, 'captured@example.test');
  assert.equal(updated[0].subscriptionAnchor, id);
  assert.equal(updated[0].paymentId, '1234');
  assert.equal(updated[0].ownerId, a.id);
  assert.equal(updated[0].saleAmount, original.saleAmount);
  assert.deepEqual(updated[0].financialEvidence, original.financialEvidence);
  assert.deepEqual(updated[0].fxSnapshot, original.fxSnapshot);
  const noChange = store.saveOrderCompletion(a, { action: 'complete', orderId: id, version: 4,
    customerId: original.customerId, customerVersion: 1, receipt: { amount: '90.5', currency: 'MYR' } }, owners);
  assert.equal(noChange.version, store.load('commerce').version);
  assert.equal(store.load('commerce').data.orders[0].version, 4);

  const privateOrder = { ...auto, taskId: 'foreign', rechargeOwnerId: b.id, createdById: b.id,
    email: 'foreign@example.test', proCardNumber: '4111111111111111' };
  store.applyRechargeOrder({ ...upstream, row: { jobKey: privateOrder.taskId, needs: [] }, order: privateOrder });
  const commerceFor = async actor => {
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.data = JSON.parse(raw); } };
    await handleLocalBusiness({ method: 'GET', url: '/api/local/commerce', headers: { host: 'fixture.local' } },
      res, '/api/local/commerce', store, actor);
    assert.equal(res.status, 200);
    return res.data.data;
  };
  const staff = await commerceFor(a);
  assert.deepEqual(staff.orders.map(row => row.id), [id]);
  assert.doesNotMatch(JSON.stringify(staff), /foreign@example\.test|4111111111111111/);
  assert.equal((await commerceFor(admin)).orders.length, 2);
});

test('手工及历史单按缺项列给管理员，空白归属补给在用超级管理员', () => {
  const manual = (id, props = {}) => order(id, { source: '历史入库', taskId: '', email: '', createdById: '',
    rechargeOwnerId: '', customerId: existing.id, entitlementStatus: 'active', start: '2026-10-15', expiry: '2026-11-15',
    ...props });
  const empty = manual('historical'), assigned = manual('employee', { ownerId: a.id });
  const named = manual('named', { owner: '历史归属人' });
  const automatic = order('automatic', { rechargeOwnerId: '', createdById: '' });
  const data = payload(empty, assigned, named, automatic, manual('draft', { draft: true }),
    manual('one-off', { product: 'Claude Pro', businessType: '续费', ownerId: a.id }));
  const managerRows = view(data, admin).manualItems;
  assert.deepEqual(managerRows.find(row => row.id === empty.id).missing, ['归属人']);
  assert.equal(managerRows.some(row => ['employee', 'named', 'one-off', 'automatic', 'draft'].includes(row.id)), false);
  assert.equal(view(data, a).manualItems, undefined);
  const command = { action: 'assign-manual-owners' };
  const superAdmin = { id: 'primary', role: 'super', name: '合成超级管理员' };
  const getOwners = () => [...owners(), superAdmin, { id: 'inactive-super', role: 'super', active: false }];
  assert.throws(() => assignMissingManualOrderOwners(data, a, command, getOwners, at), { status: 403 });
  assert.throws(() => assignMissingManualOrderOwners(data, admin, command, owners, at), { status: 409 });
  const [saved, ...other] = assignMissingManualOrderOwners(data, admin, command, getOwners, at);
  assert.equal(other.length, 0);
  assert.deepEqual(saved, { ...empty, version: 2, ownerId: superAdmin.id, owner: superAdmin.name,
    updatedById: admin.id, updatedBy: admin.name, updatedAt: at });
  assert.deepEqual(assignMissingManualOrderOwners(payload(saved, assigned, named, automatic), admin, command, getOwners, at), []);
});

test('原单分次补资料，保留收付款、有效期开通与人员历史，拒绝实际归属冲突', () => {
  const legacy = order('legacy', { source: '历史入库', taskId: '', businessType: '续费', email: '', customerId: '',
    start: '2026-10-10', expiry: '2026-11-12', saleAmount: '120', subscriptionEnded: true,
    financialEvidence: [{ kind: 'payment', amount: '100', currency: 'PHP' }] });
  const data = payload(legacy);
  const command = { action: 'fill-manual-details', orderId: legacy.id, version: 1,
    details: { email: 'proven@example.test' } };
  const emptyInventory = { accounts: [], mailboxes: [] };
  assert.throws(() => fillManualOrderDetails(data, emptyInventory, a, command, at), { status: 403 });
  assert.throws(() => fillManualOrderDetails(data, emptyInventory, admin, { ...command, version: 0 }, at), { status: 409 });
  assert.throws(() => fillManualOrderDetails(data, emptyInventory, admin,
    { ...command, details: { saleAmount: '200', receiptConfirmed: true } }, at), { status: 400 });
  const { order: updated } = fillManualOrderDetails(data, emptyInventory, admin, command, at, true);
  assert.deepEqual(updated, { ...legacy, email: 'proven@example.test', entitlementStatus: 'active',
    updatedAt: at, updatedById: admin.id, updatedBy: admin.name, version: 2 });
  assert.equal(legacy.email, '');
  const done = { ...command, version: 2, details: { customerId: existing.id, subscriptionEndedAt: '2026-11-08T14:00' } };
  const next = payload(updated);
  const { order: completed } = fillManualOrderDetails(next, emptyInventory, admin, done, at);
  assert.equal(completed.subscriptionEndedAt, '2026-11-08T14:00');
  assert.equal(completed.customerId, existing.id);
  assert.equal(completed.receiptConfirmed, false);
  const sameEmail = { ...legacy, id: 'other-order', email: updated.email, customerId: 'other-customer', subscriptionEnded: false };
  assert.throws(() => fillManualOrderDetails(payload(updated, sameEmail), emptyInventory, admin, done, at),
    { status: 409, message: /其他客户/ });
  assert.throws(() => fillManualOrderDetails(next, emptyInventory, admin,
    { ...done, details: { subscriptionEndedAt: '2026-09-01T14:00' } }, at), { status: 409 });
  assert.throws(() => fillManualOrderDetails(payload(completed), emptyInventory, admin,
    { ...done, version: 3, details: { subscriptionEndedAt: '2026-11-09T14:00' } }, at), { status: 409 });
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
