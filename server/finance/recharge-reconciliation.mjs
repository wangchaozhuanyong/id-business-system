import { financeReconciliation } from '../../modules/website/pages.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const clean = (value, maximum) => typeof value === 'string' && value.length <= maximum &&
  !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const configuredPlans = new Set(['plus', 'pro100', 'pro200', 'pro500']);

export function createFinanceReconciliation(client) {
  return async (input, actor) => {
    if (!financeReconciliation.roles.includes(actor?.role)) fail(403, '当前账号无权查看代充对账');
    const page = Number(input.get('page') || 1);
    const since = input.get('from'), until = input.get('to');
    const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
    if (!Number.isInteger(page) || page < 1 || page > 5000 || (since && !day(since)) || (until && !day(until)) ||
        (since && until && since > until)) fail(400, '请核对查询日期');
    const billingTime = (date, end = false) =>
      new Date(Date.parse(date + 'T00:00:00+08:00') + (end ? 86_400_000 - 1 : 0)).toISOString().replace('T', ' ').slice(0, 23);
    const params = new URLSearchParams({ page: String(page), ...(since && { start_date: billingTime(since) }),
      ...(until && { end_date: billingTime(until, true) }) });
    const data = await client.get('/api/admin/billing?' + params);
    const items = billingRows(data);
    return { items, hasMore: Number.isSafeInteger(Number(data.total)) ? Number(data.total) > page * 20 : items.length === 20 };
  };
}

function billingRows(data) {
  const rows = Array.isArray(data) ? data : data.items || data.records || data.billing;
  if (!Array.isArray(rows)) fail(503, '暂时无法读取对账记录');
  return rows.slice(0, 500).map(row => ({
    time: clean(row.payment_time || row.paidAt || row.paid_at || row.createdAt || row.created_at || row.time, 64),
    reference: clean(String(row.id ?? row.orderNo ?? row.order_no ?? ''), 80),
    amount: clean(String(row.amount ?? row.paidAmount ?? row.paid_amount ?? ''), 40),
    currency: clean(row.currency || row.paidCurrency || row.paid_currency, 12),
    ...(configuredPlans.has(row.plan_type) && { plan: row.plan_type }),
    status: clean(row.status, 40),
    last4: /^\d{4}$/.test(row.card_last4 || row.last4) ? row.card_last4 || row.last4 : ''
  }));
}
