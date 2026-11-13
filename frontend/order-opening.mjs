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

function hoursText(hours) {
  const days = Math.floor(hours / 24), rest = hours % 24;
  return [days && `${days} 天`, rest && `${rest} 小时`].filter(Boolean).join(' ');
}

export function expiredDuration(value, now) {
  const expiry = typeof value === 'number' ? value : subscriptionTime(value);
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry > now) return '';
  const elapsed = hoursText(Math.floor((now - expiry) / 3_600_000));
  return elapsed ? `已到期 ${elapsed}` : '已到期不足 1 小时';
}

export function subscriptionDuration(value, now) {
  const expiry = typeof value === 'number' ? value : subscriptionTime(value);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return '';
  if (expiry <= now) return expiredDuration(expiry, now);
  const remaining = hoursText(Math.floor((expiry - now) / 3_600_000));
  return remaining ? `剩余 ${remaining}` : '剩余不足 1 小时';
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

// Manual entries record actual receipts. The legacy confirmation flag only
// distinguishes configured prices from receipts on automatically imported tasks.
export function orderReceiptRecorded(order) {
  return Boolean(order && (order.source !== '线上代充' || order.receiptConfirmed === true) &&
    typeof order.saleAmount === 'string' && /^\d{1,16}(?:\.\d{1,4})?$/.test(order.saleAmount) &&
    typeof order.saleCurrency === 'string' && /^[A-Z]{3}$/.test(order.saleCurrency));
}

export const rechargeRenewalExpiryPending = order => automaticGptOrder(order) && Boolean(order.previousOrderId) &&
  order.entitlementStatus === 'active' && !order.cancelled && !order.subscriptionEnded &&
  !order.expiry && Number.isFinite(subscriptionTime(order.rechargeCompletedAt));

export function rechargeOrderCompletion(order, customer) {
  const ownerId = rechargeOrderOwner(order);
  const receiptRecorded = orderReceiptRecorded(order);
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
  return {
    customer: !customers.some(row => row.id === order.customerId),
    account: orderNeedsAccount(order),
    period: !(subscriptionTime(order.expiry) > subscriptionTime(order.start)),
    end: order.subscriptionEnded === true && !Number.isFinite(orderTerminationTime(order, now)),
    ...(historicalSale && !order.actualCostAmount && { cost: true })
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
  // A saved manual subscription period records the opening itself. Accounting
  // confirmation and optional contact details do not determine service status.
  return order.entitlementStatus === 'active' || legacyConfirmed ||
    (['管理员手工', '历史入库'].includes(order.source) &&
      subscriptionTime(order.expiry) > subscriptionTime(order.start));
}

// Old Claude imports wrote 冻结 for all rows. Interpret only untouched
// import defaults; subsequent status changes take precedence.
export function inventoryOperationalStatus(asset) {
  const imported = asset?.type === 'claude' && asset.source === '历史入库' &&
    asset.status === '冻结' && asset.health === 'normal' &&
    ['aging', 'opened'].includes(asset.claudeHistory?.phase) && asset.importId &&
    !asset.healthChangedAt && !asset.inventoryHistory?.some(event =>
      ['健康状态变化', '修改资料', '撤回修改'].includes(event.action)) &&
    asset.inventoryHistory?.some(event => event.action === 'Claude 历史入库');
  return imported ? '正常' : asset?.status || '正常';
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
  inventoryOperationalStatus, automaticGptOrder, orderReceiptRecorded, rechargeOrderOwner, rechargeOrderCompletion, rechargeRenewalExpiryPending, expiredDuration, subscriptionDuration
});
