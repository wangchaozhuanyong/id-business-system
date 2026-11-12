import { addDecimalStrings } from '../../modules/contracts/decimal.ts';
import { buildCardIssueAllocations, calculateOrder, currencies, hasRecordedPaymentAmount } from '../../modules/finance/accounting.mjs';
import { checkBankReturns } from '../local-business-integrity.mjs';
import { migrationInputSchema } from './migration-input.mjs';
import { orderReceiptRecorded } from '../../frontend/order-opening.mjs';

const reportCurrencies = ['CNY', 'MYR'];
const amountPattern = /^\d{1,20}(?:\.\d{1,4})?$/;
const safeId = (value) => typeof value === 'string' && /^[\w.-]{1,120}$/.test(value) ? value : null;
const decimal = (value) => typeof value === 'string' && amountPattern.test(value) ? value : null;
const currency = (value) => currencies.includes(value) ? value : null;
const money = (amount, code) => ({ amount: decimal(amount), currency: currency(code) });
const sum = (amounts) => amounts.reduce((total, amount) => addDecimalStrings(total, amount), '0');
const difference = (left, right) => addDecimalStrings(left, '-' + right);
const equal = (left, right) => difference(left, right) === '0';
function greater(left, right) {
  const delta = difference(left, right);
  return delta !== '0' && !delta.startsWith('-');
}

function indexRows(rows, field, issues, label) {
  const byOrder = new Map();
  const seen = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const id = safeId(row?.[field]);
    const orderId = safeId(row?.orderId);
    if (!id || !orderId) {
      issues.add(`${label}存在无效编号或缺少原订单关联`);
      if (orderId) duplicates.add(orderId);
      continue;
    }
    if (seen.has(id)) {
      issues.add(`${label}编号重复`);
      duplicates.add(orderId);
      duplicates.add(seen.get(id));
    }
    seen.set(id, orderId);
    const group = byOrder.get(orderId) || [];
    group.push(row);
    byOrder.set(orderId, group);
  }
  return { byOrder, duplicates };
}

function inspectMoneyRows(rows, expected, issues, label) {
  if (!Array.isArray(rows)) {
    issues.add(`缺少${label}明细，无法区分零笔和未导出`);
    return { records: null, total: null };
  }
  const ids = new Set();
  const records = rows.map((row) => ({
    recordId: safeId(row?.id), ...money(row?.amount, row?.currency)
  }));
  let valid = true;
  for (const row of records) {
    if (!row.recordId || ids.has(row.recordId) || !row.amount ||
        equal(row.amount, '0') || !row.currency || row.currency !== expected) valid = false;
    ids.add(row.recordId);
  }
  if (!valid) issues.add(`${label}存在无效编号、金额或原币不一致`);
  return {
    records,
    total: valid && currency(expected) ? money(sum(records.map((row) => row.amount)), expected) : null
  };
}

function inspectApple(order, indexes, issues) {
  const empty = { allocation: null, pending: null, received: null, records: null };
  if (!indexes) {
    issues.add('缺少 Apple 扣款、回款或余额流水导出');
    return { facts: empty, ledger: null };
  }
  const [allocations, refunds, movements] = indexes.map(({ byOrder }) => byOrder.get(order.id) || []);
  const ambiguous = indexes.some(({ duplicates }) => duplicates.has(order.id));
  if (ambiguous) issues.add('Apple 账本编号缺失或重复');
  const allocation = allocations.length === 1 ? allocations[0] : null;
  const paid = decimal(order.paidAmount);
  if (!allocation || !safeId(order.appleIdId) || allocation.appleIdId !== order.appleIdId ||
      !paid || equal(paid, '0') || !decimal(allocation.amount) || !equal(allocation.amount, paid))
    issues.add('Apple 扣款分配缺失或与原订单不一致');

  const customerRefunds = new Set(Array.isArray(order.refunds) ? order.refunds.map((row) => row?.id) : []);
  const linked = new Map(refunds.map((row) => [row.id, row]));
  const receipts = new Map();
  for (const movement of movements) {
    if (movement.kind !== 'apple-refund') continue;
    const matched = receipts.get(movement.refundId) || [];
    matched.push(movement);
    receipts.set(movement.refundId, matched);
  }
  const records = [];
  const received = [];
  const pending = [];
  let complete = !ambiguous;
  for (const row of refunds) {
    const amount = decimal(row.amount);
    const valid = customerRefunds.has(row.id) && row.appleIdId === order.appleIdId &&
      amount !== null && ['pending', 'received', 'none'].includes(row.status) &&
      (row.status === 'none' ? equal(amount, '0') : !equal(amount, '0'));
    const matching = receipts.get(row.id) || [];
    const posted = valid && row.status === 'received' && matching.length === 1 &&
      matching[0].appleIdId === row.appleIdId && decimal(matching[0].amount) !== null &&
      equal(matching[0].amount, amount);
    records.push({
      recordId: row.id, ...money(amount, 'USD'),
      status: ['pending', 'received', 'none'].includes(row.status) ? row.status : 'unknown',
      matchedMovement: posted ? matching[0].id : null
    });
    if (!valid || (row.status === 'received' ? !posted : matching.length !== 0)) complete = false;
    if (posted) received.push(amount);
    if (valid && row.status === 'pending') pending.push(amount);
  }
  if ([...customerRefunds].some((id) => !linked.has(id)) ||
      [...receipts.keys()].some((id) => !linked.has(id)))
    complete = false;
  if (!complete) issues.add('Apple 回款状态与客户退款或实际到账流水无法对应');
  const receivedTotal = sum(received);
  const pendingTotal = sum(pending);
  if (allocation && (!decimal(allocation.returned) || !equal(allocation.returned, receivedTotal)))
    issues.add('Apple 已到账流水合计与扣款分配的已回款金额不一致');
  if (paid && greater(sum([receivedTotal, pendingTotal]), paid))
    issues.add('Apple 实际到账和待回款合计超过原扣款');

  const debits = new Map();
  let validDebits = true;
  for (const row of movements) {
    if (row.kind === 'apple-refund') continue;
    const charge = row.kind === 'order-charge';
    const magnitude = decimal(charge && typeof row.amount === 'string' && row.amount.startsWith('-')
      ? row.amount.slice(1) : row.kind === 'order-reversal' ? row.amount : null);
    if (!safeId(row.appleIdId) || !magnitude || equal(magnitude, '0')) {
      validDebits = false;
      continue;
    }
    const prior = debits.get(row.appleIdId) || '0';
    debits.set(row.appleIdId, charge ? addDecimalStrings(prior, magnitude) : difference(prior, magnitude));
  }
  if (!validDebits || !paid || !equal(debits.get(order.appleIdId) || '0', paid) ||
      [...debits].some(([id, debit]) => id !== order.appleIdId && !equal(debit, '0')))
    issues.add('Apple 原扣款与冲正流水净额无法对平');

  return {
    facts: {
      allocation: allocation ? {
        paid: money(allocation.amount, 'USD'), declaredReturned: money(allocation.returned, 'USD')
      } : null,
      pending: complete ? money(pendingTotal, 'USD') : null,
      received: complete ? money(receivedTotal, 'USD') : null,
      records
    },
    ledger: allocation
  };
}

function checkOrder(order, indexes, clock, migrationGaps, cardIssueAllocations) {
  const issues = new Set(migrationGaps);
  const paid = money(order.paidAmount, order.paidCurrency);
  const sold = money(order.saleAmount, order.saleCurrency);
  if (!paid.amount || !paid.currency) issues.add('缺少有效的原币代付金额或币种');
  if (!sold.amount || !sold.currency) issues.add('缺少有效的原币实收金额或币种');
  if (!hasRecordedPaymentAmount(order)) issues.add(order.source === '线上代充'
    ? '自动代充尚未取得实际扣款结果' : '缺少已登记的代付金额或币种');
  if (!orderReceiptRecorded(order)) issues.add('缺少已登记的实收金额或币种');
  if (!order.start) issues.add('缺少订单订阅时点');
  const feeVersion = order.costSettings?.version;
  if (!Number.isSafeInteger(feeVersion) || feeVersion < 1) issues.add('缺少费用规则版本快照');

  const customerRefunds = inspectMoneyRows(order.refunds, order.saleCurrency, issues, '客户退款');
  if (customerRefunds.total && sold.amount && greater(customerRefunds.total.amount, sold.amount))
    issues.add('客户累计退款超过原实收');
  let bankReturns = null;
  let apple = null;
  if (order.payment === '银行卡') {
    bankReturns = inspectMoneyRows(order.bankReturns, order.paidCurrency, issues, '银行卡实际回款');
    if (Array.isArray(order.bankReturns)) {
      const bankError = checkBankReturns(null, { orders: [order] });
      if (bankError) {
        issues.add(bankError);
        bankReturns.total = null;
      }
    }
    if (indexes?.some(({ byOrder }) => byOrder.has(order.id)))
      issues.add('银行卡订单关联了 Apple 账本记录');
  } else if (order.payment === '苹果内购') {
    apple = inspectApple(order, indexes, issues);
    if (order.bankReturns?.length) issues.add('苹果内购订单关联了银行卡回款');
  } else {
    issues.add('支付方式缺失或未识别');
  }

  // Invalid or incomplete rows are already listed as blocking evidence. Keep
  // malformed rows out of the calculator while checking for separate FX gaps.
  const financialOrder = {
    ...order,
    refunds: customerRefunds.total ? order.refunds : [],
    bankReturns: bankReturns?.total ? order.bankReturns : []
  };
  const currencyResults = {};
  const pendingReasons = new Set(issues);
  for (const target of reportCurrencies) {
    const result = calculateOrder(financialOrder, { currency: target, appleLedger: apple?.ledger, clock, cardIssueAllocations });
    if (result.status === 'pending')
      for (const reason of [result.reason, ...(result.additionalReasons || [])]) pendingReasons.add(reason);
    if (order.cancelled === true) {
      currencyResults[target] = { status: 'excluded', reason: '订单已撤单' };
    } else if (issues.size || result.status === 'pending') {
      currencyResults[target] = { status: 'pending' };
      if (result.status === 'pending') currencyResults[target].reason = result.reason;
    } else {
      const { items, ...totals } = result;
      currencyResults[target] = totals;
    }
  }

  const allocation = cardIssueAllocations?.get(order.id);
  const legacyFee = order.issueFeeSnapshot?.applied ? decimal(order.issueFeeSnapshot.amountUsd)
    : order.issueFeeSnapshot?.applied === false && !order.issueFeeSnapshot.pending ? '0' : null;
  return {
    orderId: order.id, orderNo: safeId(order.orderNo), cancelled: order.cancelled === true,
    ...(allocation && { cardIssueAllocation: {
      ...allocation, previousUsd: legacyFee,
      differenceUsd: allocation.status === 'ready' && legacyFee !== null ? difference(allocation.amountUsd, legacyFee) : null
    } }),
    status: order.cancelled === true ? 'excluded' : pendingReasons.size ? 'pending' : 'ready',
    feeRuleVersion: Number.isSafeInteger(feeVersion) && feeVersion > 0 ? feeVersion : null,
    snapshotKind: ['manual', 'automatic'].includes(order.fxSnapshot?.kind) ? order.fxSnapshot.kind : null,
    original: {
      paid, received: sold,
      emailCost: money(order.emailCostAmount, order.emailCostCurrency),
      actualCost: money(order.actualCostAmount, order.actualCostCurrency),
      appleRecoverableCost: money(order.appleRecoverableCostAmount, order.actualCostCurrency),
      customerRefunds, bankReturns, apple: apple?.facts ?? null
    },
    pendingReasons: [...pendingReasons],
    calculations: currencyResults
  };
}

export function reconcileOrders(input, { clock = Date.now(), fullCardHistory = false } = {}) {
  const orders = input?.commerce?.orders;
  if (!Array.isArray(orders) || !Number.isFinite(clock))
    throw new Error('需要独立新版的 commerce.orders 数组和有效检查时点');
  const orderIds = new Set();
  for (const order of orders) {
    const id = safeId(order?.id);
    if (!id || orderIds.has(id)) throw new Error('订单编号重复或无效，无法对账');
    orderIds.add(id);
  }
  const issues = new Set();
  const ledger = input.appleBalance;
  const indexes = ledger && ['allocations', 'refunds', 'movements'].every((key) => Array.isArray(ledger[key]))
    ? [
      indexRows(ledger.allocations, 'orderId', issues, 'Apple 扣款分配'),
      indexRows(ledger.refunds, 'id', issues, 'Apple 回款'),
      indexRows(ledger.movements.filter((row) => row?.orderId || ['order-charge', 'order-reversal', 'apple-refund'].includes(row?.kind)), 'id', issues, 'Apple 订单流水')
    ] : null;
  if (ledger && !indexes) issues.add('Apple 账本导出不完整');
  for (const { byOrder } of indexes || [])
    if ([...byOrder.keys()].some((id) => !orderIds.has(id))) issues.add('Apple 账本存在本批未导出的原订单');
  const migration = input.migration;
  const migrationGaps = new Map();
  let excludedLegacy;
  if (migration !== undefined) {
    if (migration?.schema !== migrationInputSchema ||
        !Array.isArray(migration.orders) || !Array.isArray(migration.excluded))
      throw new Error('迁移输入缺口格式无效');
    for (const row of migration.orders) {
      if (!orderIds.has(row?.orderId) || migrationGaps.has(row.orderId) || !Array.isArray(row.gaps) ||
          row.gaps.some((gap) => typeof gap !== 'string' || !gap.trim() || gap.length > 160))
        throw new Error('迁移输入缺口缺少唯一的原订阅订单编号或有效原因');
      migrationGaps.set(row.orderId, row.gaps);
    }
    excludedLegacy = migration.excluded.map((row) => {
      if (!safeId(row?.orderId)) throw new Error('旧 ID 通用业务订单缺少有效编号');
      return {
        orderId: row.orderId,
        orderNo: safeId(row.orderNo),
        receivedOriginal: money(row.receivedOriginal?.amount, row.receivedOriginal?.currency),
        reason: '旧 ID 通用业务订单需独立核对，缺少经确认的订阅订单关联'
      };
    });
    if (excludedLegacy.length) issues.add('本批含旧 ID 通用业务订单，需另行核对');
  }
  const allocations = fullCardHistory ? buildCardIssueAllocations(orders, { clock }) : undefined;
  const checked = orders.map((order) => checkOrder(order, indexes, clock, migrationGaps.get(order.id), allocations));
  const counts = { ready: 0, pending: 0, excluded: 0 };
  for (const order of checked) counts[order.status]++;
  return {
    asOf: new Date(clock).toISOString(), counts, batchIssues: [...issues], orders: checked,
    ...(excludedLegacy && { excludedLegacy })
  };
}
