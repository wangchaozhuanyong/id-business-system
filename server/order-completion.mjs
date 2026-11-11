import { randomUUID } from 'node:crypto';
import { assignOrderOwner, checkSubscriptionTermination, manualOrderDetailsAction, moneyUnits, validMoney } from './order-policy.mjs';
import { validCurrencyCode } from '../modules/finance/accounting.mjs';
import {
  manualBusinessOrder, manualOrderDetailsMissing, orderOpeningConfirmed, subscriptionTime, validOrderEmail, validOrderXHandle
} from '../frontend/order-opening.mjs';
import { accountLifecycleSummary, systemAccount } from './account-lifecycle.mjs';
import { isClaudeHistoricalSale } from './claude-history-intake.mjs';
import { registrationEmail, registrationOccupancy, registrationProductConflict } from './inventory-registration.mjs';
import { stockTypeForProduct, targetKey } from './personal-subscriptions.mjs';

const roles = ['employee', 'admin', 'super'];
const defaultSources = ['微信', 'WhatsApp', 'Telegram', '网站', '客户推荐', '其他'];
const contactFields = [['customerPhone', 'phone'], ['wechat', 'wechat'], ['qq', 'qq'], ['whatsapp', 'whatsapp'], ['telegram', 'telegram']];
const orderFields = ['id', 'orderNo', 'email', 'plan', 'start', 'expiry', 'rechargeCompletedAt', 'version',
  'saleAmount', 'saleCurrency', 'paidAmount', 'paidCurrency', 'paidConfirmed', 'receiptConfirmed', 'notes'];
const manager = (actor) => ['admin', 'super'].includes(actor?.role);
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const ownerId = order => clean(order.ownerId) || clean(order.rechargeOwnerId) || clean(order.createdById);
const hasRecordedOwner = order => Boolean(clean(ownerId(order)) || clean(order.owner));
const sourceOf = (order, customer) => clean(order.customerSource) || clean(customer?.source);
const automatic = (order) => order.id && order.source === '线上代充' && order.product === 'GPT' && order.taskId &&
  !order.cancelled && !order.draft && !['draft', 'failed', 'cancelled', '草稿', '失败', '已撤单'].includes(order.status);
const visible = (order, actor) => automatic(order) && (manager(actor) || ownerId(order) === actor.id);
const sourcesOf = (settings) => Array.isArray(settings?.customerSources) ? settings.customerSources : defaultSources;
const fields = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

export class OrderCompletionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireCompletionActor(actor) {
  if (!actor?.id || !roles.includes(actor.role)) throw new OrderCompletionError(403, '当前账号无权访问订单补全');
}

export function rechargePriceSnapshot({ version, data }, plan, at) {
  const configuredSale = data?.orderPrices?.GPT?.[plan]?.CNY;
  const paidPrices = Object.fromEntries(Object.entries(data?.gptPaidPrices?.[plan] || {})
    .filter(([currency, amount]) => validCurrencyCode(currency) && validMoney(amount)));
  return {
    settingsVersion: version, at, saleCurrency: 'CNY',
    saleAmount: validMoney(configuredSale) ? configuredSale : '',
    paidPrices
  };
}

function paymentView(order) {
  const price = order.rechargePriceSnapshot;
  const standardPaidAmount = price?.paidPrices?.[order.paidCurrency] || '';
  const actual = moneyUnits(order.paidAmount), configured = moneyUnits(standardPaidAmount);
  const financeIssues = [];
  if (!price) financeIssues.push('历史定价依据待核对');
  else {
    if (!price.saleAmount) financeIssues.push('入库时未配置收费金额');
    if (order.paidCurrency && !standardPaidAmount) financeIssues.push('入库时未配置该币种代付金额');
  }
  if (!order.paidConfirmed || actual === null || !validCurrencyCode(order.paidCurrency)) {
    financeIssues.push('代充实扣待核对');
  } else if (configured !== null && actual !== configured) {
    financeIssues.push('配置代付与实际扣款有差额');
  }
  if (!order.receiptConfirmed) financeIssues.push('实收待确认');
  return {
    configuredSaleAmount: price?.saleAmount ?? '', configuredSaleCurrency: price?.saleCurrency ?? '',
    standardPaidAmount, financeIssues
  };
}

function customerView(row) {
  return row ? {
    ...fields(row, ['id', 'name', 'source', ...contactFields.map(([, key]) => key)]),
    version: row.version ?? 0
  } : null;
}

function orderView(order, customer, actor, names = new Map()) {
  const source = sourceOf(order, customer);
  const owner = ownerId(order);
  const customerLinkMissing = Boolean(order.customerId && !customer);
  const missing = [...(customer ? [] : [customerLinkMissing ? '客户关联待核对' : '客户']),
    ...(source ? [] : ['客户来源'])];
  return {
    ...fields(order, [...orderFields, ...contactFields.map(([key]) => key)]),
    ...paymentView(order), customer: customerView(customer),
    customerSource: source, customerLinkMissing,
    owner: order.owner || names.get(owner) || (owner === actor.id ? actor.name : ''),
    state: !owner ? 'unassigned' : missing.length ? 'pending' : 'complete',
    missing
  };
}

function manualOrderView(order, customer, names) {
  const details = manualOrderDetailsMissing(order, customer ? [customer] : []);
  const needsOwner = !hasRecordedOwner(order);
  const missing = [
    details.customer && (order.customerId ? '客户关联待核对' : '客户'),
    details.account && '邮箱账号',
    details.period && '订阅周期',
    (!order.paidConfirmed || !(moneyUnits(order.paidAmount) > 0n) || !validCurrencyCode(order.paidCurrency)) && '实际代付',
    (!order.receiptConfirmed || !validMoney(order.saleAmount) || !validCurrencyCode(order.saleCurrency)) && '客户实收',
    details.end && '实际终止时间',
    needsOwner && '归属人'
  ].filter(Boolean);
  return {
    ...fields(order, ['id', 'orderNo', 'product', 'plan', 'start', 'expiry']),
    email: clean(order.email) || (order.product === 'Grok' ? clean(order.xHandle) : ''), customerName: customer?.name || '',
    owner: clean(order.owner) || names.get(ownerId(order)) ||
      (ownerId(order) === order.createdById ? clean(order.createdBy) : ''),
    missing, needsOwner
  };
}

function findOrder(data, id, actor) {
  const order = data?.orders?.find((row) => row.id === id);
  if (!order || !visible(order, actor)) throw new OrderCompletionError(404, '订单不存在或当前账号无法补全');
  return order;
}

function contactKey(value, key) {
  const normalized = clean(value).normalize('NFKC').toLowerCase();
  if (key === 'telegram') return normalized.replace(/^@/, '');
  if (['phone', 'whatsapp'].includes(key) && /^\+?[\d\s().-]+$/.test(normalized))
    return normalized.replace(/[\s().-]/g, '');
  return normalized;
}

export function readOrderCompletion(data, settings, actor, params, readOwners) {
  requireCompletionActor(actor);
  const customers = data?.customers || [];
  if (params.has('orderId')) {
    const order = findOrder(data, params.get('orderId'), actor);
    if (!ownerId(order) || order.customerId) return { items: [] };
    const query = clean(params.get('q')).slice(0, 100);
    if (!query) return { items: [] };
    const match = ['name', ...contactFields.map(([, key]) => key)].map((key) => [key, contactKey(query, key)]);
    const items = customers.filter((row) => row.active !== false &&
      match.some(([key, keyword]) => keyword && contactKey(row[key], key).includes(keyword)))
      .slice(0, 20).map(customerView);
    return { items };
  }
  const people = manager(actor) ? readOwners?.() || [] : [];
  const names = new Map(people.map(({ id, name }) => [id, name]));
  const byId = new Map(customers.map((row) => [row.id, row]));
  const items = (data?.orders || []).filter((row) => visible(row, actor))
    .map((row) => orderView(row, byId.get(row.customerId), actor, names));
  return {
    items, sources: sourcesOf(settings), canAssign: manager(actor),
    ...(manager(actor) && { manualItems: (data?.orders || []).filter(manualBusinessOrder)
      .map(row => manualOrderView(row, byId.get(row.customerId), names)).filter(row => row.missing.length) }),
    owners: people.filter((row) => row.active !== false && roles.includes(row.role)).map(({ id, name }) => ({ id, name }))
  };
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)))
    throw new OrderCompletionError(400, '请求包含不可编辑的字段');
}

function text(value, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > max)
    throw new OrderCompletionError(400, '补全资料的格式或长度无效');
  return value.trim();
}

function fill(current, input, label) {
  if (clean(current) && input && input !== current)
    throw new OrderCompletionError(409, label + '已有记录，请刷新核对');
  return clean(current) ? current : input;
}

function editMetadata(actor, at) {
  return { updatedById: actor.id, updatedBy: actor.name, updatedAt: at };
}

export function assignMissingManualOrderOwners(data, actor, command, readOwners, at) {
  requireCompletionActor(actor);
  if (!manager(actor)) throw new OrderCompletionError(403, '只有管理员可以补齐手工订单归属');
  exactKeys(command, ['action']);
  if (command.action !== 'assign-manual-owners') throw new OrderCompletionError(400, '订单补全操作无效');
  const orders = (data?.orders || []).filter(order => manualBusinessOrder(order) && !hasRecordedOwner(order));
  if (!orders.length) return [];
  const people = new Map([actor, ...(readOwners?.() || [])]
    .filter(row => row.role === 'super' && row.active !== false && clean(row.id) && clean(row.name))
    .map(row => [row.id, row]));
  if (people.size !== 1) throw new OrderCompletionError(409, '暂时无法确认在用的超级管理员');
  const [owner] = people.values();
  return orders.map(order => ({ ...order, ...editMetadata(actor, at), version: (order.version ?? 0) + 1,
    ownerId: owner.id, owner: owner.name }));
}

export function fillManualOrderDetails(data, inventory, actor, command, at, legacyConfirmed = false) {
  requireCompletionActor(actor);
  if (!manager(actor)) throw new OrderCompletionError(403, '只有管理员可以补齐手工订单资料');
  exactKeys(command, ['action', 'orderId', 'version', 'details']);
  const fields = ['customerId', 'email', 'xHandle', 'start', 'expiry', 'subscriptionEndedAt'];
  exactKeys(command.details, fields);
  const now = Date.parse(at);
  const prior = data?.orders?.find(row => row.id === command.orderId);
  const missing = manualOrderDetailsMissing(prior, data?.customers || [], now);
  if (!missing) throw new OrderCompletionError(404, '未找到可补齐资料的原订单');
  const invalid = message => { throw new OrderCompletionError(409, message); };
  if (command.action !== 'fill-manual-details') throw new OrderCompletionError(400, '订单补全操作无效');
  if (command.version !== (prior.version ?? 0)) invalid('订单已变化，请刷新后补齐资料');
  const details = Object.fromEntries(Object.entries(command.details).map(([key, value]) => [key, text(value, 254)]));
  const order = { ...prior, ...details };
  const edits = fields.filter(key => order[key] !== prior[key]);
  if (!edits.length || Object.values(details).some(value => !value)) invalid('请填写可核实的原订单资料');
  if (edits.includes('customerId') && (!missing.customer ||
      !data.customers.some(row => row.id === order.customerId && row.active !== false)))
    invalid('请选择在用的客户并保留原有客户关联');
  const fillsAccount = edits.includes('email') || edits.includes('xHandle');
  if (fillsAccount) {
    const isX = order.product === 'Grok' && order.loginMethod === 'x';
    if (!missing.account || (isX ? edits.includes('email') || !validOrderXHandle(order.xHandle) :
        edits.includes('xHandle') || !validOrderEmail(order.email)))
      invalid('请核对账号格式及原订单的账号关联');
  }
  if (fillsAccount || edits.includes('customerId')) {
    const email = registrationEmail(order.email);
    const product = stockTypeForProduct(order.product);
    const target = order.product === 'Grok' && order.loginMethod === 'x'
      ? (validOrderXHandle(order.xHandle) ? targetKey(order) : '')
      : (validOrderEmail(order.email) ? targetKey(order) : '');
    const stock = (inventory?.accounts || []).filter(row => systemAccount(row) && row.type === product &&
      (row.id === prior.accountId || (target && targetKey(row) === target)));
    if (validOrderEmail(email)) {
      const facts = registrationOccupancy(inventory).get(email) || [];
      const conflict = registrationProductConflict(facts, product, stock[0]?.id);
      if (conflict) invalid(conflict);
    }
    if (prior.accountId && (stock.length !== 1 || stock[0].id !== prior.accountId ||
        (target && targetKey(stock[0]) !== target))) invalid('请保留原订单关联的库存账号');
    const currentCustomer = stock.length === 1 ? accountLifecycleSummary(stock[0], data, now).customerId : '';
    const firstHistoricalBuyer = edits.includes('customerId') && !fillsAccount && !prior.customerId &&
      !currentCustomer && stock.length === 1 && isClaudeHistoricalSale(prior, stock[0]);
    if (stock.length && (stock.length !== 1 || !order.customerId ||
        (currentCustomer !== order.customerId && !firstHistoricalBuyer)))
      invalid('账号已关联库存，请先核对原客户归属');
    if (target && order.customerId && data.orders.some(row => row.id !== prior.id && !row.cancelled && !row.draft &&
        !row.subscriptionEnded && stockTypeForProduct(row.product) === product &&
        row.customerId && row.customerId !== order.customerId && targetKey(row) === target))
      invalid('同一账号已有其他客户的订单，请先核对原客户归属');
    if (fillsAccount && order.appleIdId && data.orders.some(row => row.id !== prior.id && row.appleIdId === order.appleIdId &&
        (row.paidConfirmed || row.appleFunding?.bound) && targetKey(row) && targetKey(row) !== target))
      invalid('该苹果 ID 已绑定其他订阅账号，请核对原账单');
  }
  if ((edits.includes('start') || edits.includes('expiry')) &&
      (!missing.period || !(subscriptionTime(order.expiry) > subscriptionTime(order.start))))
    invalid('请保留原有效周期，补录时填写有效的订阅起止时间');
  if (edits.includes('subscriptionEndedAt') && !missing.end)
    invalid('请按原记录补充实际终止时间');
  const terminationError = checkSubscriptionTermination(order, prior, manualOrderDetailsAction, now);
  if (terminationError) invalid(terminationError);
  if (legacyConfirmed && orderOpeningConfirmed(prior, now, true)) order.entitlementStatus = 'active';
  return { order: { ...order, ...editMetadata(actor, at), version: command.version + 1 } };
}

export function applyOrderCompletion(data, settings, actor, command, readOwners, at) {
  requireCompletionActor(actor);
  const envelope = ['action', 'orderId', 'version'];
  const assign = command?.action === 'assign';
  exactKeys(command, assign ? [...envelope, 'ownerId', 'reason'] : [...envelope,
    'customerId', 'customerVersion', 'newCustomer', 'customerSource', 'contacts', 'notes']);
  if (typeof command.orderId !== 'string' || !Number.isSafeInteger(command.version) ||
      !['complete', 'assign'].includes(command.action))
    throw new OrderCompletionError(400, '订单或资料版本无效');
  if (assign && !manager(actor)) throw new OrderCompletionError(403, '只有管理员可以确认订单归属');
  const order = findOrder(data, command.orderId, actor);
  if (order.version !== command.version) throw new OrderCompletionError(409, '订单已更新，请关闭并重新打开后核对');
  const next = { ...order, ...editMetadata(actor, at), version: order.version + 1 };
  if (assign) {
    if (ownerId(order)) throw new OrderCompletionError(409, '订单已有归属人');
    const reason = text(command.reason, 200);
    if (!reason) throw new OrderCompletionError(400, '请填写归属依据');
    const owner = { ownerId: text(command.ownerId, 100) };
    if (!owner.ownerId) throw new OrderCompletionError(400, '请选择归属人');
    const error = assignOrderOwner(owner, null, actor, readOwners?.() || []);
    if (error) throw new OrderCompletionError(error.status, error.message);
    Object.assign(next, owner);
    next.rechargeOwnerAssignment = { actorId: actor.id, at, reason };
    return { order: next };
  }
  if (!ownerId(order)) throw new OrderCompletionError(409, '请先确认订单归属');
  const customers = data.customers || [];
  const inputId = text(command.customerId, 100);
  const current = customers.find((row) => row.id === (order.customerId || inputId));
  if (order.customerId && !current) throw new OrderCompletionError(409, '原订单的客户关联待核对');
  const adding = command.newCustomer !== undefined;
  if (order.customerId && (adding || (inputId && inputId !== order.customerId)))
    throw new OrderCompletionError(409, '订单已关联客户，请刷新核对');
  if (adding && (inputId || command.customerVersion !== undefined))
    throw new OrderCompletionError(400, '请选择已有客户或新增客户');
  if (!current && !adding) throw new OrderCompletionError(400, '请选择客户');
  if (current?.active === false && !order.customerId) throw new OrderCompletionError(409, '所选客户已停用');
  if (current && command.customerVersion !== (current.version ?? 0))
    throw new OrderCompletionError(409, '客户资料已更新，请重新打开后核对');
  const source = fill(sourceOf(order, current), text(command.customerSource, 40), '客户来源');
  if (!source || (!sourceOf(order, current) && !sourcesOf(settings).includes(source)))
    throw new OrderCompletionError(400, '请选择系统设置中的客户来源');

  const contacts = command.contacts === undefined ? {} : command.contacts;
  exactKeys(contacts, contactFields.map(([key]) => key));
  if (adding) exactKeys(command.newCustomer, ['name']);
  const name = current ? current.name : text(command.newCustomer.name, 80);
  if (!clean(name)) throw new OrderCompletionError(400, '请填写客户姓名');

  const customerChanges = {};
  if (!clean(current?.source)) customerChanges.source = source;
  for (const [orderKey, customerKey] of contactFields) {
    const entered = text(contacts[orderKey], 60);
    const existing = clean(order[orderKey]) ? order[orderKey] : current?.[customerKey];
    const value = fill(existing, entered, '联系方式');
    if (value && !clean(order[orderKey])) next[orderKey] = value;
    if (value && !clean(current?.[customerKey])) customerChanges[customerKey] = value;
  }
  next.notes = fill(order.notes, text(command.notes, 1000), '备注') || '';
  if (customers.some((row) => row.id !== current?.id && contactKey(row.name) === contactKey(name) &&
      contactFields.some(([, key]) => clean(customerChanges[key]) &&
        contactKey(row[key], key) === contactKey(customerChanges[key], key))))
    throw new OrderCompletionError(409, '已有同名客户使用相同联系方式，请核对并选择已有客户');

  let customer;
  if (!current) {
    customer = {
      id: 'commerce-customer-' + randomUUID(), name, active: true, version: 1, tags: [], notes: '',
      ...customerChanges, ...editMetadata(actor, at),
      createdById: actor.id, createdBy: actor.name, createdAt: at
    };
  } else if (Object.keys(customerChanges).length) {
    customer = { ...current, ...customerChanges, ...editMetadata(actor, at), version: (current.version ?? 0) + 1 };
  }
  next.customerId = (customer || current).id;
  next.customerSource = source;
  return { order: next, customer, createdCustomer: !current };
}
