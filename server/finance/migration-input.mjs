import { addDecimalStrings } from '../../modules/contracts/decimal.ts';
import {
  V2_GPT_BANK_ORDER_PLANS, V2_SUBSCRIPTION_ORDER_CURRENCIES
} from '../../modules/contracts/subscription-orders.ts';

export const migrationInputSchema = 'id-finance-migration-v1';
const safeId = (value) => typeof value === 'string' && /^[\w.-]{1,120}$/.test(value) ? value : null;
const amount = (value) => typeof value === 'string' && /^\d{1,20}(?:\.\d{1,4})?$/.test(value) ? value : null;
const currency = (value) => V2_SUBSCRIPTION_ORDER_CURRENCIES.includes(value) ? value : null;
const positive = (value) => amount(value) !== null && /[1-9]/.test(value);
const version = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const total = (rows) => rows.reduce((sum, row) => addDecimalStrings(sum, row.amount), '0');
const equal = (left, right) => addDecimalStrings(left, '-' + right) === '0';

function utc(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : null;
}

function frozenSnapshot(value, gaps) {
  if (value == null) {
    gaps.add('缺少独立新版兼容的历史汇率快照及报价凭据');
    return undefined;
  }
  const common = ['kind', 'source', 'at', 'expiresAt', 'basisAt', 'rates'];
  const keys = value.kind === 'automatic' ? [...common, 'provider', 'fetchedAt'] : common;
  if (!['manual', 'automatic'].includes(value.kind) || typeof value.source !== 'string' ||
      !utc(value.at) || !utc(value.expiresAt) || !utc(value.basisAt) ||
      (value.kind === 'automatic' && (typeof value.provider !== 'string' || !utc(value.fetchedAt))) ||
      !value.rates || Array.isArray(value.rates) || typeof value.rates !== 'object' ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      Object.entries(value.rates).some(([code, rate]) =>
        !currency(code) || typeof rate !== 'string' || !/^\d{1,20}(?:\.\d{1,8})?$/.test(rate))) {
    gaps.add('历史汇率快照格式未经确认，需核对原凭据');
    return undefined;
  }
  // Preserve the complete verified format verbatim. Reconciliation validates the
  // window, rate values and required currencies against the original order.
  return structuredClone(value);
}

function linkedRows(rows, order, currencyCode, gaps, label, bank = false) {
  if (!Array.isArray(rows)) {
    gaps.add(`缺少${label}逐笔明细或明确零笔凭据`);
    return undefined;
  }
  const ids = new Set();
  const output = [];
  let invalid = false;
  for (const row of rows) {
    if (!safeId(row?.id) || ids.has(row.id) || row.orderId !== order.id ||
        !positive(row.amount) || !currency(row.currency) || row.currency !== currencyCode ||
        (bank && (!order.cardId || row.cardId !== order.cardId))) {
      invalid = true;
      continue;
    }
    ids.add(row.id);
    output.push({ id: row.id, amount: row.amount, currency: row.currency, ...(bank ? { cardId: row.cardId } : {}) });
  }
  if (invalid) {
    gaps.add(`${label}明细与稳定编号、原币或原付款卡不一致`);
    return undefined;
  }
  return output;
}

function adaptApple(order, evidence, gaps) {
  const input = evidence.apple;
  if (!input || !Array.isArray(input.refunds) || !Array.isArray(input.walletEntries)) {
    gaps.add('缺少 Apple 逐笔退款或原钱包订单流水');
    return null;
  }
  const { allocation } = input;
  const allocations = [];
  if (allocation?.orderId === order.id && order.appleIdId && allocation.appleIdId === order.appleIdId &&
      positive(allocation.amount) && amount(allocation.returned) !== null) {
    allocations.push({
      orderId: order.id, appleIdId: order.appleIdId, amount: allocation.amount, returned: allocation.returned
    });
  } else {
    gaps.add('缺少绑定原订单和原 Apple ID 的扣款分配证据');
  }

  const customerRefunds = [];
  const refunds = [];
  const received = new Map();
  const ids = new Set();
  const statuses = { not_required: 'none', pending: 'pending', received: 'received' };
  let badRefund = false;
  for (const row of input.refunds) {
    const status = typeof row?.returnStatus === 'string' && Object.hasOwn(statuses, row.returnStatus)
      ? statuses[row.returnStatus]
      : null;
    const returnAmount = amount(row?.expectedAppleReturnUsd);
    const receiptId = safeId(row?.receivedLedgerEntryId);
    if (!status || !safeId(row?.id) || ids.has(row.id) || row.orderId !== order.id ||
        !order.appleIdId || row.appleAccountId !== order.appleIdId ||
        !positive(row.customerRefundAmount) || !currency(row.customerRefundCurrency) ||
        row.customerRefundCurrency !== order.saleCurrency ||
        !utc(row.customerRefundedAt) || returnAmount === null ||
        (status === 'none' ? positive(returnAmount) : !positive(returnAmount)) ||
        (status === 'received' ? !receiptId || !utc(row.receivedAt) || received.has(receiptId) :
          row.receivedLedgerEntryId != null || row.receivedAt != null) ||
        row.reversalLedgerEntryId != null || row.reversedAt != null) {
      badRefund = true;
      continue;
    }
    ids.add(row.id);
    customerRefunds.push({ id: row.id, amount: row.customerRefundAmount, currency: row.customerRefundCurrency });
    const refund = { id: row.id, orderId: order.id, appleIdId: order.appleIdId, amount: returnAmount, status };
    refunds.push(refund);
    if (receiptId) received.set(receiptId, refund);
  }
  if (badRefund) gaps.add('Apple 退款存在无效关联、已撤回记录或缺少实际到账证据');

  const movements = [];
  const entryIds = new Set();
  const postedReceipts = new Set();
  for (const item of input.walletEntries) {
    const entry = item?.entry;
    if (!safeId(entry?.id) || entryIds.has(entry.id) || entry.subscriptionOrderId !== order.id ||
        !order.appleIdId || item.appleAccountId !== order.appleIdId || !positive(entry.amountUsd)) {
      gaps.add('Apple 钱包流水缺少订单／钱包关联或金额无效');
      continue;
    }
    entryIds.add(entry.id);
    const movement = { id: entry.id, orderId: order.id, appleIdId: order.appleIdId };
    if (entry.entryType === 'subscription_apple_charge' && entry.direction === 'debit') {
      movements.push({ ...movement, kind: 'order-charge', amount: '-' + entry.amountUsd });
    } else if (entry.entryType === 'subscription_apple_return' && entry.direction === 'credit' &&
        received.has(entry.id) && equal(entry.amountUsd, received.get(entry.id).amount)) {
      movements.push({ ...movement, kind: 'apple-refund', refundId: received.get(entry.id).id, amount: entry.amountUsd });
      postedReceipts.add(entry.id);
    } else {
      gaps.add('Apple 钱包流水类型或到账金额无法直接映射，需人工核对');
    }
  }
  if ([...received.keys()].some((id) => !postedReceipts.has(id)))
    gaps.add('Apple 已到账记录缺少对应钱包入账流水');
  return { allocations, refunds, movements, customerRefunds: badRefund ? undefined : customerRefunds };
}

function adaptGpt(source, evidenceInput, gaps) {
  const evidence = evidenceInput?.orderId === source.id ? evidenceInput : {};
  if (evidence !== evidenceInput) gaps.add('财务补充凭据缺少原订单编号或编号不一致');
  const payment = source.paymentMethod === 'bank_card' ? '银行卡' :
    source.paymentMethod === 'apple_in_app' ? '苹果内购' : null;
  if (!payment || !V2_GPT_BANK_ORDER_PLANS.includes(source.plan)) gaps.add('订阅支付方式或 GPT 套餐不在已核对契约内');
  if (source.cancelledAt !== null && source.cancelledAt !== undefined && !utc(source.cancelledAt))
    gaps.add('撤单时间格式无法确认');
  const order = {
    id: source.id, orderNo: safeId(source.orderNo),
    product: 'GPT', payment,
    start: utc(source.openedAt), expiry: utc(source.dueAt),
    cancelled: Boolean(utc(source.cancelledAt)),
    cardId: safeId(source.cardId), appleIdId: safeId(source.appleAccountId),
    paidAmount: amount(source.paidAmount), paidCurrency: currency(source.paidCurrency),
    saleAmount: amount(source.saleAmount), saleCurrency: currency(source.saleCurrency),
    paidConfirmed: source.paidConfirmed === true,
    receiptConfirmed: source.receiptConfirmed === true,
    costConfirmed: source.costConfirmed === true,
    costBasis: ['standard', 'actual'].includes(source.costBasis) ? source.costBasis : null
  };
  if (!order.costBasis) gaps.add('订阅成本依据未知');
  if (payment === '银行卡' && !['CNY', 'MYR'].includes(order.saleCurrency))
    gaps.add('银行卡订阅实收币种不在来源契约内');
  if (payment === '苹果内购' && !['CNY', 'MYR', 'USD'].includes(order.saleCurrency))
    gaps.add('Apple 订阅实收币种不在来源契约内');
  if (payment === '银行卡' && !order.cardId) gaps.add('缺少原付款银行卡稳定编号');
  if (payment === '苹果内购' && !order.appleIdId) gaps.add('缺少原付款 Apple ID 稳定编号');
  if (version(source.feeRuleVersion)) order.costSettings = { version: source.feeRuleVersion };
  const fee = evidence.feeRule;
  if (fee && version(fee.version) && fee.version === source.feeRuleVersion &&
      [fee.paymentFeeRate, fee.fixedFeeUsd, fee.cardOpeningFeeUsd].every((value) => amount(value) !== null)) {
    Object.assign(order.costSettings, {
      cardPercent: fee.paymentFeeRate, cardPerPaymentUsd: fee.fixedFeeUsd, cardIssueUsd: fee.cardOpeningFeeUsd
    });
  } else if (payment === '银行卡' && order.costBasis === 'standard') {
    gaps.add('缺少该订单所用版本的银行卡费用规则明细');
  }
  if (order.costBasis === 'standard') {
    const email = evidence.emailCost;
    if (amount(email?.amount) !== null && currency(email.currency)) {
      order.emailCostAmount = email.amount;
      order.emailCostCurrency = email.currency;
    } else {
      gaps.add('缺少原订单邮箱成本金额与币种确认');
    }
    if (payment === '银行卡') {
      const issue = evidence.issueFeeSnapshot;
      if (typeof issue?.applied === 'boolean' && order.cardId && issue.cardId === order.cardId &&
          (!issue.applied || (amount(issue.amountUsd) !== null && amount(fee?.cardOpeningFeeUsd) !== null &&
            equal(issue.amountUsd, fee.cardOpeningFeeUsd)))) {
        order.issueFeeSnapshot = { applied: issue.applied, cardId: issue.cardId };
        if (issue.applied) order.issueFeeSnapshot.amountUsd = issue.amountUsd;
      } else {
        gaps.add('缺少与原卡及原费用版本一致的一次性开卡费证据');
      }
    }
  } else if (order.costBasis === 'actual') {
    const actual = evidence.actualCost;
    if (amount(actual?.amount) !== null && currency(actual.currency)) {
      order.actualCostAmount = actual.amount;
      order.actualCostCurrency = actual.currency;
      if (amount(actual.appleRecoverableAmount) !== null)
        order.appleRecoverableCostAmount = actual.appleRecoverableAmount;
    } else {
      gaps.add('缺少原币实际总成本，不能从已换算净成本反推');
    }
  }

  order.fxSnapshot = frozenSnapshot(evidence.fxSnapshot, gaps);
  let apple = null;
  if (payment === '银行卡') {
    order.refunds = linkedRows(evidence.customerRefunds, order, order.saleCurrency, gaps, '客户退款');
    order.bankReturns = linkedRows(evidence.bankReturns, order, order.paidCurrency, gaps, '银行卡实际回款', true);
  } else if (payment === '苹果内购') {
    apple = adaptApple(order, evidence, gaps);
    order.refunds = apple?.customerRefunds;
  }
  if (amount(source.customerRefundTotal) === null || !order.refunds ||
      !equal(total(order.refunds), source.customerRefundTotal))
    gaps.add('订阅客户退款汇总与原币逐笔明细无法对平');
  return { order, apple };
}

export function adaptFinanceMigrationInput(input) {
  if (input?.schema !== migrationInputSchema || !Array.isArray(input.orders))
    throw new Error('需要显式声明 id-finance-migration-v1 和订单来源的隔离导出');
  const commerce = { orders: [] };
  const appleBalance = { allocations: [], refunds: [], movements: [] };
  const migration = { schema: migrationInputSchema, excluded: [], orders: [] };
  const ids = new Set();
  for (const row of input.orders) {
    const source = row?.order;
    const id = safeId(source?.id);
    if (!id) throw new Error('来源订单缺少稳定编号');
    if (!['legacy-id-business-order', 'gpt-subscription-v2'].includes(row.kind))
      throw new Error('订单来源类型未在适配契约内');
    const identity = row.kind + ':' + id;
    if (ids.has(identity)) throw new Error('同一来源内的订单编号重复');
    ids.add(identity);
    if (row.kind === 'legacy-id-business-order') {
      migration.excluded.push({
        orderId: id, orderNo: safeId(source.orderNo), reason: '旧 ID 通用业务订单需独立核对，缺少经确认的订阅订单关联',
        receivedOriginal: { amount: amount(source.receivedOriginalAmount), currency: currency(source.receivedCurrency) }
      });
      continue;
    }
    const gaps = new Set();
    const { order, apple } = adaptGpt(source, row.evidence, gaps);
    commerce.orders.push(order);
    if (apple) {
      for (const key of Object.keys(appleBalance)) appleBalance[key].push(...apple[key]);
    }
    if (gaps.size) migration.orders.push({ orderId: id, gaps: [...gaps] });
  }
  return { commerce, appleBalance, migration };
}
