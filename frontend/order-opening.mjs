export const subscriptionStateLabels = Object.freeze({
  active: '有效', expired: '已过期', opened: '已开通', scheduled: '未开始',
  ended: '已终止', pending: '待确认', failed: '开通失败'
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

export function orderNeedsAccount(order) {
  const oneOffClaude = ['Claude Pro', 'Claude Max'].includes(order.product) && order.businessType === '续费' &&
    !order.accountId && !order.claudeRenewalId;
  return !oneOffClaude && !(order.product === 'Grok' && order.loginMethod === 'x'
    ? validOrderXHandle(order.xHandle) : validOrderEmail(order.email));
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
  validOrderEmail, validOrderXHandle, subscriptionPeriodState, subscriptionStateLabels, subscriptionTime
});
