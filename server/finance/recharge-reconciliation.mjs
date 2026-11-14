import { financeReconciliation } from '../../modules/website/pages.mjs';
import { cardTypeDocument, orderCardArchiveDocument } from '../card-management.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const clean = (value, maximum) => typeof value === 'string' && value.length <= maximum &&
  !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const configuredPlans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const configuredStatuses = new Set(['success', 'failed', 'pending']);
const cardNumber = value => {
  const number = clean(value, 40).replace(/[ -]/g, '');
  return /^\d{12,19}$/.test(number) ? number : '';
};
const reference = value => clean(String(value ?? ''), 160);

export function createFinanceReconciliation(client, store) {
  return async (input, actor) => {
    if (!financeReconciliation.roles.includes(actor?.role)) fail(403, '当前账号无权查看代充对账');
    const page = Number(input.get('page') || 1);
    const since = input.get('from'), until = input.get('to');
    const status = input.get('status') || '', plan = input.get('plan') || '', last4 = input.get('last4') || '';
    const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
    if (!Number.isInteger(page) || page < 1 || page > 5000 || (since && !day(since)) || (until && !day(until)) ||
        (since && until && since > until)) fail(400, '请核对查询日期');
    if ((status && !configuredStatuses.has(status)) || (plan && !configuredPlans.has(plan)) ||
        (last4 && !/^\d{4}$/.test(last4)))
      fail(400, '请核对扣款状态、套餐或卡号后四位');
    const billingTime = (date, end = false) =>
      new Date(Date.parse(date + 'T00:00:00+08:00') + (end ? 86_400_000 - 1 : 0)).toISOString().replace('T', ' ').slice(0, 23);
    const params = new URLSearchParams({ page: String(page), ...(since && { start_date: billingTime(since) }),
      ...(until && { end_date: billingTime(until, true) }), ...(status && { status }),
      ...(plan && { plan_type: plan }), ...(last4 && { card_last4: last4 }) });
    const data = await client.get('/api/admin/billing?' + params);
    const items = billingRows(data);
    const warning = await attachCardTypes(items, client, store);
    const total = data.total !== null && data.total !== undefined && /^\d+$/.test(String(data.total)) &&
      Number.isSafeInteger(Number(data.total)) ? Number(data.total) : undefined;
    return { items, ...(total !== undefined && { total }),
      hasMore: total !== undefined ? total > page * 20 : items.length === 20,
      ...(warning && { warning }) };
  };
}

async function attachCardTypes(items, client, store) {
  if (!items.some(row => row.cardNumber && row.cardTypeState !== 'conflict')) return '';
  let types, archive, pool, unavailable = false;
  try {
    types = store.featureDocument(cardTypeDocument).data || { items: [], assignments: {} };
    archive = store.featureDocument(orderCardArchiveDocument).data?.cards || {};
  } catch {
    for (const row of items) if (row.cardNumber && row.cardTypeState !== 'conflict') row.cardTypeState = 'unavailable';
    return '银行卡分类暂未读取，账单原始卡号、邮箱和扣款记录仍可查看。';
  }
  try {
    const result = await client.get('/api/admin/cards');
    if (!Array.isArray(result.cards)) throw new Error('Invalid card pool');
    pool = result.cards;
  } catch { pool = []; unavailable = true; }
  const byNumber = new Map(), byId = new Map();
  const add = (id, number, last4) => {
    if (!/^(recharge|orbitcard):[1-9]\d*$/.test(id) || !number || last4 && !number.endsWith(last4)) return;
    if (!byNumber.has(number)) byNumber.set(number, new Set());
    if (!byId.has(id)) byId.set(id, new Set());
    byNumber.get(number).add(id);
    byId.get(id).add(number);
  };
  for (const row of pool) add('recharge:' + row.id, cardNumber(row.card_number), row.last4);
  for (const [id, row] of Object.entries(archive)) add(id, cardNumber(row.number), row.last4);
  const labels = new Map((types.items || []).map(row => [row.id, clean(row.name, 160)]));
  for (const row of items) {
    if (!row.cardNumber || row.cardTypeState === 'conflict') continue;
    const matches = [...(byNumber.get(row.cardNumber) || [])];
    if (!matches.length) row.cardTypeState = unavailable ? 'unavailable' : 'unmatched';
    else if (matches.length !== 1 || byId.get(matches[0]).size !== 1) row.cardTypeState = 'ambiguous';
    else {
      row.cardType = labels.get(types.assignments?.[matches[0]]) || '';
      row.cardTypeState = row.cardType ? 'matched' : 'unassigned';
    }
  }
  return unavailable ? '卡池暂未读取，未能确认的卡类型已标注；账单原始资料保持可见。' : '';
}

function billingRows(data) {
  const rows = Array.isArray(data) ? data : data.items || data.records || data.billing;
  if (!Array.isArray(rows)) fail(503, '暂时无法读取对账记录');
  return rows.slice(0, 500).map(row => {
    const number = cardNumber(row.card_number);
    const last4 = /^\d{4}$/.test(row.card_last4 || row.last4) ? row.card_last4 || row.last4 : '';
    const email = clean(row.email, 254);
    const errorCode = clean(row.error_code, 80);
    const paymentReference = clean(row.stripe_session_id, 255);
    return {
      time: clean(row.payment_time || row.paidAt || row.paid_at || row.createdAt || row.created_at || row.time, 64),
      reference: reference(row.id ?? row.orderNo ?? row.order_no),
      amount: clean(String(row.amount ?? row.paidAmount ?? row.paid_amount ?? ''), 40),
      currency: clean(row.currency || row.paidCurrency || row.paid_currency, 12),
      ...(configuredPlans.has(row.plan_type) && { plan: row.plan_type }),
      status: clean(row.status, 40),
      last4,
      cardNumber: number,
      cardType: '',
      cardTypeState: !number ? 'missing-number' : last4 && !number.endsWith(last4) ? 'conflict' : 'unmatched',
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
      paymentReference: /^[A-Za-z0-9_-]+$/.test(paymentReference) ? paymentReference : '',
      errorCode: /^[A-Za-z0-9_.:-]+$/.test(errorCode) ? errorCode : ''
    };
  });
}
