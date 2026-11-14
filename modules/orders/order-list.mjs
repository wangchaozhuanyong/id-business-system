import {
  automaticGptOrder, manualOrderDetailsMissing, orderOpeningConfirmed, rechargeOrderCompletion,
  subscriptionPeriodState, subscriptionStateLabels, subscriptionTime, orderReceiptRecorded
} from './order-opening.mjs';
import { calculateConfirmedNetReceipt, calculateOrder, calculateOrderCost, hasRecordedPaymentAmount } from '../finance/accounting.mjs';

export const isClaudeOrder = order => String(order?.product || '').startsWith('Claude');
export const personalOrderProduct = product => product === 'Gemini' || product === 'Grok';
export const listIdentity = row => row?.loginMethod === 'x' && row.xHandle ? row.xHandle : row?.email || row?.xHandle || '';
export const validListAmount = input => /^\d+(?:\.\d{1,4})?$/.test(String(input));

export function normalizedListPlan(plan) {
  return ({
    plus: 'Plus', pro: 'Pro 100', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500',
    'Pro 5x': 'Pro 100', 'Pro 20x': 'Pro 200', 'Pro 50x': 'Pro 500', go: 'Go',
    max5: 'Max 5x', max20: 'Max 20x', pro_5x: 'Pro 100', pro_20x: 'Pro 200', pro_50x: 'Pro 500'
  })[plan] || plan || 'Plus';
}

export const claudeListPlan = (product, plan) => product === 'Claude Pro' && plan === 'pro' ? 'Pro' : normalizedListPlan(plan);

export function orderListMissing(order, customers, at) {
  if (automaticGptOrder(order)) return rechargeOrderCompletion(order, customers instanceof Map
    ? customers.get(order.customerId) : customers.find(row => row.id === order.customerId)).missing;
  const reasons = [];
  const missing = manualOrderDetailsMissing(order, customers, at);
  if (!order.customerId || missing?.customer) reasons.push('客户待补充');
  if (!validListAmount(order.saleAmount || '')) reasons.push('售卖金额待补充');
  if (!validListAmount(order.paidAmount || '') || !order.paidCurrency) reasons.push('代付金额或币种待核对');
  if (!order.start || !order.expiry || missing?.period) reasons.push('订阅周期待补充');
  if (missing?.end) reasons.push('实际终止时间待补充');
  if (missing?.cost) reasons.push('实际总成本待补充');
  if (order.payment === '银行卡' && order.proMaterialMode === 'people' && !order.tenantId && !order.phone)
    reasons.push('人员资料待补充');
  return reasons;
}

export function listPaymentStatus(order) {
  const history = order.financialEvidence?.some(record => record.kind === 'payment') ||
    order.corrections?.some(({ previous }) => previous?.paidConfirmed && validListAmount(previous.paidAmount) &&
      /[1-9]/.test(previous.paidAmount));
  if (order.paidConfirmed || history) return '已付款';
  if (hasRecordedPaymentAmount(order)) return '已登记付款';
  return validListAmount(order.paidAmount || '') ? '付款待核对' : '未登记付款';
}

export function listSubscriptionStatus(order, at, { legacy = false, released = false } = {}) {
  return subscriptionStateLabels[subscriptionPeriodState({
    start: order.start, expiry: order.expiry, confirmed: orderOpeningConfirmed(order, at, legacy),
    ended: order.subscriptionEnded || released,
    cancelled: order.cancelled || ['cancelled', '已撤单'].includes(order.status),
    failed: order.entitlementStatus === 'failed' || ['failed', '失败'].includes(order.status)
  }, at)];
}

export function orderListTime(row, tab) {
  const dates = [row.createdAt, row.start];
  if (tab === 'cancelled') return [row.cancellationEvents?.at(-1)?.at, ...dates];
  if (tab === 'refunded') {
    const latest = (row.refunds || []).reduce((time, refund) =>
      Math.max(time, subscriptionTime(refund.at) || -Infinity), -Infinity);
    return [latest, ...dates];
  }
  return dates;
}

export function matchesOrderQuery(row, query, { customer, owner, tenant }) {
  const base = `${row.email} ${row.orderNo} ${customer} ${owner} ${row.cardTypeName || ''} ${row.proCardNumber || ''} ${row.proCardSerial || ''}`;
  if (personalOrderProduct(row.product)) return [base, listIdentity(row), row.xHandle, row.plan, row.billingReceipt]
    .join(' ').toLowerCase().includes(query.toLowerCase());
  if (!isClaudeOrder(row)) return base.includes(query);
  const fields = [base, row.paymentId, row.proCardNumber, row.proCardSerial, row.verifier,
    row.verifierPhone, row.phone, row.tenantId ? tenant : ''];
  if (fields.some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase()))) return true;
  const digits = query.replace(/[\s-]/g, '');
  return /^\d+$/.test(digits) && String(row.proCardNumber || '').includes(digits);
}

export function orderAccountingFact(order, options) {
  const revenue = calculateConfirmedNetReceipt(order, options);
  const result = revenue === null ? calculateOrderCost(order, options) : calculateOrder(order, options);
  let cost, gain = null, originalProfit;
  if (result.status === 'ready' && !result.requiresPaymentConfirmation) {
    cost = result;
    if (revenue !== null) gain = result.profit ?? null;
  } else {
    const known = revenue === null ? result : calculateOrderCost(order, options);
    cost = known.status === 'ready' && !known.requiresPaymentConfirmation ? known : known.knownCost;
  }
  const reasons = [result.reason, ...(result.additionalReasons || [])];
  const currency = order.saleCurrency;
  if (gain === null && orderReceiptRecorded(order) && order.costBasis === 'actual' &&
      currency === order.actualCostCurrency && currency !== options.currency &&
      ['CNY', 'MYR'].includes(currency) && reasons.some(reason => /汇率/.test(reason))) {
    const original = calculateOrder(order, { ...options, currency });
    if (original.status === 'ready' && original.profit != null) originalProfit = { amount: original.profit, currency };
  }
  return { cost, gain, originalProfit, revenue, result };
}
