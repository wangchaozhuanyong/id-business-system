import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isHistoricallyOpenedClaude } from './inventory-history.mjs';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { inventoryOperationalStatus, manualBusinessOrder, orderFieldChanged, validOrderEmail } from '../modules/orders/order-opening.mjs';
import { personalProduct, personalStock, sameTarget, stockTypeForProduct, targetKey } from './personal-subscriptions.mjs';
import { registrationOccupancy, registrationProductConflict } from './inventory-registration.mjs';

const rows = value => Array.isArray(value) ? value : [];
const emailKey = value => String(value || '').trim().toLowerCase();
const instant = value => /(?:Z|[+-]\d\d:\d\d)$/i.test(String(value || ''))
  ? Date.parse(value) : parseV2DateTimeInput(String(value || '').replace(' ', 'T'))?.getTime() || 0;
const orderTime = order => instant(order.start) || instant(order.createdAt);
const productType = order => stockTypeForProduct(order.product);
const managedAccount = account => ['gpt', 'claude'].includes(account?.type) || personalStock(account?.type);
export const systemAccount = account => managedAccount(account) &&
  account.source !== '客户提供' && !['客户自有', 'customer'].includes(account.accountSource);
export const accountMarkedDead = account => account?.health === 'dead' ||
  (!account?.health && (account?.status === '死号' || account?.claudeHistory?.phase === 'dead'));
const state = account => account.inventoryState || (account.used ? 'used' : 'available');
const kycLabel = value => value === true || ['KYC 认证', 'KYC认证'].includes(value) ? 'KYC 认证'
  : value === false || value === '未认证' ? '未认证' : '未记录';
export const releasedAccountOrders = account => new Set(rows(account.accountLifecycleEvents)
  .filter(event => ['release', 'retire'].includes(event.action)).flatMap(event => rows(event.orderIds)));

export class AccountLifecycleError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

function firstById(items) {
  const index = new Map();
  for (const row of rows(items)) if (!index.has(row.id)) index.set(row.id, row);
  return index;
}

function lifecycleReadContext(commerce) {
  const ordersByTarget = new Map();
  for (const order of rows(commerce?.orders)) {
    const type = productType(order), identity = personalStock(type) ? targetKey(order) : emailKey(order.email);
    let identities = ordersByTarget.get(type);
    if (!identities) ordersByTarget.set(type, identities = new Map());
    const related = identities.get(identity);
    if (related) related.push(order); else identities.set(identity, [order]);
  }
  return { ordersByTarget, customers: firstById(commerce?.customers), tenants: firstById(commerce?.tenants) };
}

export function relatedAccountOrders(account, commerce, context) {
  const links = new Set(rows(account.usageLinks).map(link => link.orderId).filter(Boolean));
  const identity = personalStock(account.type) ? targetKey(account) : emailKey(account.email);
  const candidates = context ? context.ordersByTarget.get(account.type)?.get(identity) || [] : rows(commerce?.orders);
  const all = candidates.filter(order => productType(order) === account.type &&
    (personalStock(account.type) ? sameTarget(order, account)
      : emailKey(order.email) === emailKey(account.email)));
  const direct = all.filter(order => order.accountId === account.id || links.has(order.id));
  if (personalStock(account.type)) return direct.sort((a, b) => orderTime(b) - orderTime(a));
  const customers = new Set(direct.map(order => order.customerId).filter(Boolean));
  const linked = new Set(direct);
  return all.filter(order => linked.has(order) || (order.businessType === '续费' && customers.has(order.customerId)))
    .sort((a, b) => orderTime(b) - orderTime(a) || instant(b.createdAt) - instant(a.createdAt));
}

export function stockLinkedToCustomer(account, customerId, commerce) {
  return Boolean(customerId && (account.accountLifecycle?.customerId === customerId ||
    relatedAccountOrders(account, commerce).some(order => order.customerId === customerId)));
}

export function accountLifecycleSummary(account, commerce, now = Date.now(), context) {
  const history = relatedAccountOrders(account, commerce, context);
  const released = releasedAccountOrders(account);
  const personal = personalStock(account.type);
  const current = history.filter(order => !released.has(order.id) && !order.cancelled && !order.subscriptionEnded &&
    (!personal || order.entitlementStatus === 'active'));
  const held = personal && history.some(order => order.businessType === '成品交付' && !order.cancelled &&
    order.entitlementStatus !== 'active');
  const currentCustomers = [...new Set(current.map(order => order.customerId).filter(Boolean))];
  const lifecycle = account.accountLifecycle;
  const closed = lifecycle && ['recovered', 'retired'].includes(lifecycle.disposition);
  const latest = current[0];
  const customerId = closed ? '' : lifecycle?.customerId || latest?.customerId || '';
  const label = account.claudeHistory && account.health === 'dead' ? '已归档'
    : isHistoricallyOpenedClaude(account) ? '历史已开通'
    : lifecycle?.disposition === 'retired' ? '不再复用'
    : held ? '已保留待核对'
    : state(account) === 'claimed' ? '已提取待使用'
    : state(account) === 'available' && account.source === '历史入库' && inventoryOperationalStatus(account) === '冻结' ? '待核对交付资料'
    : state(account) === 'available' ? lifecycle?.disposition === 'recovered' ? '已回收可用' : '首次可用'
    : latest && instant(latest.expiry) && instant(latest.expiry) <= now ? '到期待处理' : '使用中';
  const name = id => (context ? context.customers.get(id) : rows(commerce?.customers).find(customer => customer.id === id))?.name || (id ? '历史客户' : '未分配');
  const snapshot = order => ({
    id: order.id, orderNo: order.orderNo || order.id, product: order.product, plan: order.plan || '', businessType: order.businessType,
    customerId: order.customerId || '', customer: name(order.customerId), start: order.start || '', expiry: order.expiry || '',
    payment: order.payment || '', paymentId: order.paymentId || '', paidAmount: order.paidAmount || '',
    paidCurrency: order.paidCurrency || '', paidConfirmed: order.paidConfirmed === true,
    ...(personal && { entitlementStatus: order.entitlementStatus, cancelled: order.cancelled === true }),
    kyc: kycLabel(order.kyc), verifier: order.verifier || '', verifierPhone: order.verifierPhone || '',
    tenant: (context ? context.tenants.get(order.tenantId) : rows(commerce?.tenants).find(tenant => tenant.id === order.tenantId))?.name || '',
    released: released.has(order.id)
  });
  const verified = history.find(order => kycLabel(order.kyc) === 'KYC 认证');
  return {
    assetId: account.id, systemOwned: systemAccount(account), label, customerId, customer: name(customerId),
    currentOrderIds: closed ? [] : current.map(order => order.id), currentCustomers: closed ? [] : currentCustomers,
    disposition: lifecycle?.disposition || (state(account) === 'used' ? 'in_use' : 'new'),
    cycle: lifecycle?.cycle || 0,
    lastRecoveredAt: rows(account.accountLifecycleEvents).findLast(event => event.action === 'release')?.time || '',
    latestKyc: verified ? snapshot(verified) : kycLabel(account.kyc) === 'KYC 认证' ? {
      kyc: 'KYC 认证', orderNo: '账号原始资料', verifier: account.verifier || '', verifierPhone: account.verifierPhone || '', tenant: ''
    } : null,
    currentKyc: closed ? '待重新核实' : kycLabel(latest?.kyc ?? account.kyc),
    orders: history.map(snapshot), events: rows(account.accountLifecycleEvents)
  };
}

export function accountLifecycleSummaries(inventory, commerce, now) {
  const accounts = rows(inventory?.accounts).filter(managedAccount);
  if (!accounts.length) return [];
  const context = lifecycleReadContext(commerce);
  return accounts.map(account => accountLifecycleSummary(account, commerce, now, context));
}

export function releasedSubscriptionOrderIds(inventory, commerce) {
  const accounts = rows(inventory?.accounts).filter(managedAccount);
  const identity = account => account.loginMethod === 'x' && account.xHandle
    ? account.xHandle : account.email || account.xHandle;
  const identityCounts = new Map();
  for (const account of accounts) {
    const key = JSON.stringify([account.type, emailKey(identity(account))]);
    identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
  }
  const ids = new Set();
  let context;
  for (const account of accounts) {
    const released = releasedAccountOrders(account);
    if (!released.size) continue;
    if (!personalStock(account.type) &&
        identityCounts.get(JSON.stringify([account.type, emailKey(identity(account))])) !== 1) continue;
    context ??= lifecycleReadContext(commerce);
    for (const order of relatedAccountOrders(account, commerce, context)) {
      if (released.has(order.id) && (personalStock(account.type)
        ? order.accountId === account.id : emailKey(order.email) === emailKey(identity(account))))
        ids.add(order.id);
    }
  }
  return ids;
}

export function changeAccountLifecycle(inventory, commerce, command, actor, now = new Date()) {
  if (!actor?.id || !['admin', 'super'].includes(actor.role)) throw new AccountLifecycleError('只有管理员可以结束账号使用或恢复库存', 403);
  if (!['release', 'retire'].includes(command?.action) || typeof command.commandId !== 'string' ||
      !command.commandId || command.commandId.length > 100 || typeof command.reason !== 'string' ||
      !command.reason.trim() || command.reason.trim().length > 300)
    throw new AccountLifecycleError('请选择有效操作并填写 1–300 字原因', 400);
  const account = rows(inventory?.accounts).find(row => row.id === command.assetId);
  if (!systemAccount(account)) throw new AccountLifecycleError('只可处理本系统自有库存账号');
  const request = { action: command.action, reason: command.reason.trim(), controlled: command.controlled === true,
    accessReviewed: command.accessReviewed === true, tasksReviewed: command.tasksReviewed === true, endEarly: command.endEarly === true };
  const existing = rows(account.accountLifecycleEvents).find(event => event.id === command.commandId);
  if (existing) {
    if (existing.actorId !== actor.id || !isDeepStrictEqual(existing.request, request))
      throw new AccountLifecycleError('同一操作编号的提交内容已变化，请重新核对');
    return { changed: false, account };
  }
  if (Number(command.assetVersion) !== Number(account.version)) throw new AccountLifecycleError('账号版本已变化，请重新打开核对');
  if (isHistoricallyOpenedClaude(account)) throw new AccountLifecycleError('Claude 历史已开通账号须保留使用记录');
  if (state(account) !== 'used') throw new AccountLifecycleError('只可处理已使用账号；已提取资料请使用原归还流程');
  if (command.action === 'retire' && account.accountLifecycle?.disposition === 'retired')
    throw new AccountLifecycleError('账号已停止复用');
  if (!request.controlled || !request.accessReviewed || !request.tasksReviewed)
    throw new AccountLifecycleError('请确认账号控制权、原客户访问处理及执行任务已核对', 400);
  if (command.action === 'release' && ((account.health || 'normal') !== 'normal' || (account.status || '正常') !== '正常'))
    throw new AccountLifecycleError('账号异常，请先核对健康状态，不能直接回到可用库存');
  const unresolvedTask = rows(inventory.batches).some(batch => rows(batch.items).some(item =>
    item.assetId === account.id && item.status === 'pending' && (item.taskId || item.registrationId))) ||
    ['reserved', 'unknown', 'payment_unknown', 'running'].includes(account.reservation?.outcome);
  if (unresolvedTask) throw new AccountLifecycleError('账号仍有待处理任务或未知付款结果，不能结束占用');
  if (personalStock(account.type) && rows(commerce?.orders).some(order => order.accountId === account.id &&
      !order.cancelled && order.entitlementStatus === 'pending'))
    throw new AccountLifecycleError('关联订单的权益仍待核对，不能结束账号占用');
  const summary = accountLifecycleSummary(account, commerce, now.getTime());
  if (summary.currentCustomers.length > 1) throw new AccountLifecycleError('存在多个未结束客户关联，请先核对历史归属');
  const released = releasedAccountOrders(account);
  const cycleOrders = relatedAccountOrders(account, commerce).filter(order => !released.has(order.id));
  const current = cycleOrders.filter(order => summary.currentOrderIds.includes(order.id));
  if (cycleOrders.some(order => ['running', 'processing', 'payment_unknown'].includes(order.status) || order.paymentStatus === 'unknown'))
    throw new AccountLifecycleError('关联订单仍在执行或付款结果未知，请先核对');
  if (current.some(order => instant(order.expiry) > now.getTime()) && !request.endEarly)
    throw new AccountLifecycleError('订阅尚未到期，请明确确认提前结束本次客户使用', 400);
  const time = toV2DateTimeInput(now).replace('T', ' ');
  const event = { id: command.commandId, action: command.action, request, reason: request.reason,
    time, actorId: actor.id, actor: actor.name, customerId: summary.customerId,
    cycle: summary.cycle, orderIds: cycleOrders.map(order => order.id) };
  (account.accountLifecycleEvents ||= []).push(event);
  account.accountLifecycle = { disposition: command.action === 'release' ? 'recovered' : 'retired',
    cycle: summary.cycle, customerId: '', endedAt: time };
  account.inventoryState = command.action === 'release' ? 'available' : 'used';
  account.used = account.inventoryState !== 'available';
  delete account.claimId;
  delete account.claimBatchId;
  account.version = (Number(account.version) || 0) + 1;
  Object.assign(account, { lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time });
  (account.inventoryHistory ||= []).push({ id: randomUUID(), action: command.action === 'release' ? '恢复可用库存' : '停止复用',
    detail: request.reason, actorId: actor.id, actor: actor.name, time });
  return { changed: true, account };
}

const legacyBuyerSources = new Set(['历史入库', '管理员手工', '', null, undefined]);

function canFillHistoricalStockBuyer(order, account) {
  return manualBusinessOrder(order) && productType(order) === 'claude' && order.businessType === '成品交付' &&
    !order.customerId && !order.taskId && legacyBuyerSources.has(order.source) &&
    systemAccount(account) && account.type === 'claude' && order.accountId === account.id &&
    validOrderEmail(order.email) && emailKey(order.email) === emailKey(account.email) &&
    (account.source === '历史入库' || ['opened', 'dead'].includes(account.claudeHistory?.phase) ||
      rows(account.usageLinks).some(link => link.kind === 'order-sale' && link.orderId === order.id));
}

function isRecordedOrderCorrection(prior, order) {
  const before = rows(prior.corrections), after = rows(order.corrections);
  const correction = after.at(-1);
  const { corrections, refunds, bankReturns, ...snapshot } = prior;
  return (order.source ?? '') === (prior.source ?? '') && order.version === (Number(prior.version) || 0) + 1 &&
    after.length === before.length + 1 &&
    correction?.versionAfter === order.version && typeof correction.reason === 'string' && correction.reason.trim() &&
    isDeepStrictEqual(correction.previous, snapshot) &&
    before.every((entry, index) => isDeepStrictEqual(entry, after[index]));
}

export function checkInventoryRenewals(previousCommerce, commerce, inventory, {
  action, actor, priorInventory = inventory, completedCustomerOrders
} = {}) {
  const previous = new Map(rows(previousCommerce?.orders).map(order => [order.id, order]));
  const accountsById = firstById(inventory?.accounts);
  const priorAccountsById = priorInventory === inventory ? accountsById : firstById(priorInventory?.accounts);
  let originalClaudeOrders, proposedClaudeOrders, activeCustomers, registrations;
  for (const order of rows(commerce?.orders)) {
    const prior = previous.get(order.id);
    if (prior) {
      const account = priorAccountsById.get(prior.accountId) ?? accountsById.get(prior.accountId);
      if (systemAccount(account)) {
        if (orderFieldChanged(order, prior, 'accountId', 'email', 'product', 'businessType') ||
            (personalStock(account.type) && !sameTarget(order, prior)))
          return '原库存账号及客户关联必须保留，不能通过普通订单更正重新分配';
        if (orderFieldChanged(order, prior, 'customerId')) {
          if (prior.customerId)
            return '原库存账号及客户关联必须保留，已登记的客户不能通过普通订单更正更换';
          if (action !== '更正订单' || !actor?.id || !['admin', 'super'].includes(actor.role) ||
              !canFillHistoricalStockBuyer(prior, account))
            return '原库存账号及客户关联必须保留，请从订单详情核对原客户资料';
          if (!activeCustomers) {
            const originalCustomers = firstById(previousCommerce?.customers);
            activeCustomers = new Set(rows(commerce.customers).filter(customer => customer.id &&
              customer.active !== false && originalCustomers.has(customer.id) &&
              originalCustomers.get(customer.id).active !== false).map(customer => customer.id));
          }
          if (!activeCustomers.has(order.customerId))
            return '请选择原订单对应的有效客户';
          originalClaudeOrders ??= lifecycleReadContext(previousCommerce).ordersByTarget.get('claude') || new Map();
          proposedClaudeOrders ??= lifecycleReadContext(commerce).ordersByTarget.get('claude') || new Map();
          const email = emailKey(prior.email);
          registrations ??= registrationOccupancy(priorInventory);
          if (registrationProductConflict(registrations.get(email), account.type, account.id))
            return '此邮箱关联多个账号或平台，请先核对原库存账号';
          const currentCustomer = account.accountLifecycle?.customerId;
          if ((currentCustomer && currentCustomer !== order.customerId) ||
              [originalClaudeOrders, proposedClaudeOrders].some(index => index.get(email)?.some(other =>
                other.id !== prior.id && !other.cancelled && !other.draft && !other.subscriptionEnded &&
                other.customerId && other.customerId !== order.customerId)))
            return '此账号已有其他客户的记录，请先核对原订单的客户';
          if (!isRecordedOrderCorrection(prior, order)) return '请填写补登记客户的更正原因';
          completedCustomerOrders?.add(order.id);
        }
      }
      if (!personalProduct(order.product) || prior.entitlementStatus === 'active' ||
          order.entitlementStatus !== 'active') continue;
    }
    if (personalProduct(order.product)) {
      if (!order.accountId || order.businessType === '成品交付') continue;
      const account = accountsById.get(order.accountId);
      if (order.businessType !== '续费' || !systemAccount(account) ||
          account.type !== productType(order) || !sameTarget(order, account))
        return '请明确选择与本次续费一致的库存账号';
      const summary = accountLifecycleSummary(account, previousCommerce);
      if (state(account) !== 'used' || summary.disposition !== 'in_use' ||
          summary.currentCustomers.length !== 1 || summary.customerId !== order.customerId)
        return '库存账号当前归属与本次续费不一致';
      order.accountSource = '库存';
      continue;
    }
    if (order.businessType !== '续费' || !productType(order)) continue;
    const explicitlyOwned = ['客户自有', 'customer'].includes(order.accountSource);
    if (explicitlyOwned && order.accountId) return '客户自有账号不能关联库存编号';
    const email = emailKey(order.email);
    const matches = email ? rows(inventory?.accounts).filter(account => systemAccount(account) &&
      account.type === productType(order) && emailKey(account.email) === email &&
      (!order.platformAccountId || !account.platformAccountId || order.platformAccountId === account.platformAccountId) &&
      (order.accountId ? account.id === order.accountId :
        order.accountSource === '库存' || stockLinkedToCustomer(account, order.customerId, previousCommerce))) : [];
    if (!matches.length) {
      if (order.accountId || order.accountSource === '库存') return '库存账号与本次续费邮箱不一致';
      continue;
    }
    if (matches.length > 1) return '存在重复库存账号，请先核对资料';
    const [account] = matches;
    if (order.accountId && order.accountId !== account.id) return '续费库存编号与邮箱不一致';
    const summary = accountLifecycleSummary(account, previousCommerce);
    if (summary.disposition === 'retired') return '账号已停止复用，不能直接续费';
    if (summary.disposition === 'recovered' || state(account) !== 'used') return '账号已回收或尚未分配，请通过成品交付明确重新分配后再续费';
    if (summary.currentCustomers.length !== 1 || !summary.customerId) return '账号当前客户归属待核对，不能自动续费';
    if (summary.customerId !== order.customerId) return '账号当前由其他客户使用，不能沿用该历史邮箱续费';
    order.accountId = account.id;
    order.accountSource = '库存';
  }
}

export function applyAccountOrderLifecycle(previousCommerce, commerce, inventory, actor, now = new Date()) {
  const previous = new Map(rows(previousCommerce?.orders).map(order => [order.id, order]));
  const time = toV2DateTimeInput(now).replace('T', ' ');
  let changed = false;
  for (const order of rows(commerce?.orders)) {
    const prior = previous.get(order.id);
    if (!order.accountId || (personalProduct(order.product)
      ? order.entitlementStatus !== 'active' || prior?.entitlementStatus === 'active' : Boolean(prior))) continue;
    const account = rows(inventory?.accounts).find(row => row.id === order.accountId);
    if (!systemAccount(account)) continue;
    const cycle = (account.accountLifecycle?.cycle || 0) + (order.businessType === '成品交付' ? 1 : 0);
    if (order.businessType === '成品交付') {
      account.accountLifecycle = { disposition: 'in_use', customerId: order.customerId || '', orderId: order.id, cycle, startedAt: time };
    }
    (account.accountLifecycleEvents ||= []).push({ id: randomUUID(), action: order.businessType === '成品交付' ? 'assign' : 'renew',
      orderId: order.id, customerId: order.customerId || '', cycle, time,
      ...(actor?.id && { actorId: actor.id, actor: actor.name }) });
    if (actor?.id) Object.assign(account, { lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time });
    if (order.businessType === '续费') {
      (account.usageLinks ||= []).push({ kind: 'order-renewal', orderId: order.id, label: '库存账号续费', time });
      account.version = (Number(account.version) || 0) + 1;
      (account.inventoryHistory ||= []).push({ id: randomUUID(), action: '原客户续费', detail: order.orderNo || order.id,
        ...(actor?.id && { actorId: actor.id, actor: actor.name }), time });
    }
    changed = true;
  }
  return changed;
}
