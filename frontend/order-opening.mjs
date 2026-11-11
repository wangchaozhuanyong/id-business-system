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
  orderOpeningConfirmed, subscriptionPeriodState, subscriptionStateLabels, subscriptionTime
});
