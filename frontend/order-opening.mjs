export const subscriptionStateLabels = Object.freeze({
  active: '有效', expired: '已过期', opened: '已开通', scheduled: '未开始',
  ended: '已终止', pending: '待确认', failed: '开通失败', dead: '死号'
});

export function subscriptionTime(value) {
  if (typeof value !== 'string') return NaN;
  let input = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) input += 'T00:00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(input)) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input) ? input : input + '+08:00');
}

export function orderTerminationTime(order, now = Date.now()) {
  if (order.subscriptionEnded !== true) return NaN;
  const end = subscriptionTime(order.subscriptionEndedAt);
  const start = subscriptionTime(order.start);
  return end <= now && (!Number.isFinite(start) || end >= start) ? end : NaN;
}

export const validOrderEmail = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
export const validOrderXHandle = value => typeof value === 'string' && /^@[a-z0-9_]{1,15}$/i.test(value.trim());

export const rechargeOrderOwner = order =>
  [order?.ownerId, order?.rechargeOwnerId, order?.createdById]
    .find(value => typeof value === 'string' && value.trim())?.trim() || '';

export const automaticGptOrder = order => order?.product === 'GPT' && order.source === '线上代充' && Boolean(order.taskId);

export function rechargeOrderCompletion(order, customer) {
  const ownerId = rechargeOrderOwner(order);
  const receiptRecorded = order.receiptConfirmed === true &&
    typeof order.saleAmount === 'string' && /^\d{1,16}(?:\.\d{1,4})?$/.test(order.saleAmount) &&
    typeof order.saleCurrency === 'string' && /^[A-Z]{3}$/.test(order.saleCurrency);
  const missing = [
    !ownerId && '归属人',
    !customer && (order.customerId ? '客户关联' : '客户'),
    !receiptRecorded && '客户实收'
  ].filter(Boolean);
  return { ownerId, receiptRecorded, missing, state: !ownerId ? 'unassigned' : missing.length ? 'pending' : 'complete' };
}

const customerKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
export const orderCustomerCreateAction = '新增订单并登记客户';

export function matchOrderCustomer(customers, name, wechat = '') {
  const nameKey = customerKey(name), wechatKey = customerKey(wechat);
  if (!nameKey) return { kind: 'empty' };
  if (name.length > 80 || wechat.length > 60 || /[\r\n]/.test(name + wechat)) return { kind: 'invalid' };
  const named = customers.filter(row => customerKey(row.name) === nameKey);
  const identify = rows => {
    if (rows.every(row => row.active === false)) return { kind: 'inactive' };
    return rows.length === 1 ? { kind: 'matched', customerId: rows[0].id } : { kind: 'ambiguous' };
  };
  if (!wechatKey) return named.length ? identify(named) : { kind: 'new' };

  const withWechat = customers.filter(row => customerKey(row.wechat) === wechatKey);
  const exact = withWechat.filter(row => customerKey(row.name) === nameKey);
  if (exact.length) return identify(exact);
  if (withWechat.length)
    return { kind: withWechat.every(row => row.active === false) ? 'inactive' : 'wechat-conflict' };
  if (named.length)
    return { kind: named.every(row => customerKey(row.wechat)) ? 'same-name' : 'ambiguous' };
  return { kind: 'new' };
}

export function orderNeedsAccount(order) {
  return !(order.product === 'Grok' && (order.loginMethod === 'x' || (!order.email && order.xHandle))
    ? validOrderXHandle(order.xHandle) : validOrderEmail(order.email));
}

export function orderFieldChanged(order, prior, ...fields) {
  return !prior || fields.some(field => (order[field] ?? '') !== (prior[field] ?? ''));
}

function subscriptionFamily(order) {
  if (['Claude Pro', 'Claude Max'].includes(order.product)) return 'Claude';
  if (order.product === 'Grok') {
    if (order.plan?.startsWith('The X Subscription ')) return 'Grok:x_subscription';
    if (order.plan?.startsWith('SuperGrok')) return 'Grok:supergrok';
    return 'Grok:x_premium';
  }
  return order.product;
}

export function subscriptionChainRoot(order, ordersById) {
  const login = row => !orderNeedsAccount(row)
    ? String(row.loginMethod === 'x' ? row.xHandle : row.email || row.xHandle).trim().toLowerCase() : '';
  let root = order;
  const seen = new Set([root.id]);
  while (root.customerId && (root.previousOrderId || root.claudeRenewalId)) {
    const previous = ordersById.get(root.previousOrderId || root.claudeRenewalId);
    if (!previous || seen.has(previous.id) || previous.customerId !== order.customerId ||
        subscriptionFamily(previous) !== subscriptionFamily(order) ||
        (login(previous) && login(order) && login(previous) !== login(order)) ||
        (previous.accountId && order.accountId && previous.accountId !== order.accountId)) break;
    seen.add(previous.id);
    root = previous;
  }
  return root;
}

export function manualBusinessOrder(order) {
  return Boolean(order?.id) && ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'].includes(order.product) &&
    order.source !== '线上代充' && !order.cancelled && !order.draft && order.entitlementStatus !== 'failed' &&
    !['draft', 'failed', 'cancelled', '草稿', '失败', '已撤单'].includes(order.status);
}

export function manualOrderDetailsMissing(order, customers, now = Date.now()) {
  if (!manualBusinessOrder(order)) return null;
  const historicalSale = ['Claude Pro', 'Claude Max'].includes(order.product) &&
    order.source === '历史入库' && order.businessType === '成品交付' && order.accountId;
  const hasSalePrice = typeof order.saleAmount === 'string' && /^\d{1,16}(?:\.\d{1,4})?$/.test(order.saleAmount) &&
    /[1-9]/.test(order.saleAmount) && typeof order.saleCurrency === 'string' && /^[A-Z]{3}$/.test(order.saleCurrency);
  return {
    customer: !customers.some(row => row.id === order.customerId),
    account: orderNeedsAccount(order),
    period: !(subscriptionTime(order.expiry) > subscriptionTime(order.start)),
    end: order.subscriptionEnded === true && !Number.isFinite(orderTerminationTime(order, now)),
    ...(historicalSale && !order.actualCostAmount && { cost: true }),
    ...(historicalSale && order.receiptConfirmed !== true && hasSalePrice && { receipt: true })
  };
}

export function orderOpeningConfirmed(order, now, legacyConfirmed = false) {
  if (order.draft || ['draft', 'failed', '草稿', '失败'].includes(order.status) ||
      ['pending', 'failed'].includes(order.entitlementStatus)) return false;
  if (order.source === '线上代充') {
    if (!order.taskId) return false;
    if (order.entitlementStatus === 'active') return true;
    const completed = subscriptionTime(order.rechargeCompletedAt);
    const start = subscriptionTime(order.start), expiry = subscriptionTime(order.expiry);
    return Number.isFinite(completed) && completed <= now &&
      (!Number.isFinite(start) || completed >= start) && (!Number.isFinite(expiry) || completed < expiry);
  }
  return order.entitlementStatus === 'active' || legacyConfirmed ||
    (['管理员手工', '历史入库'].includes(order.source) &&
      order.paidConfirmed === true && order.receiptConfirmed === true);
}

export function subscriptionPeriodState({ start, expiry, confirmed, ended, cancelled, failed }, now) {
  if (ended) return 'ended';
  if (cancelled) return 'pending';
  if (failed) return 'failed';
  if (!confirmed) return 'pending';
  const from = subscriptionTime(start), until = subscriptionTime(expiry);
  if (!(until > from)) return 'opened';
  if (from > now) return 'scheduled';
  return until <= now ? 'expired' : 'active';
}

if (typeof window !== 'undefined') window.IDOrderOpening = Object.freeze({
  orderOpeningConfirmed, orderTerminationTime, orderNeedsAccount, manualOrderDetailsMissing,
  validOrderEmail, validOrderXHandle, subscriptionPeriodState, subscriptionStateLabels, subscriptionTime,
  matchOrderCustomer, orderCustomerCreateAction, orderFieldChanged, subscriptionChainRoot,
  automaticGptOrder, rechargeOrderOwner, rechargeOrderCompletion
});
