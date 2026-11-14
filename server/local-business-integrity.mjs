import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_CLAUDE_AGING_HOURS,
  MAX_CLAUDE_AGING_HOURS,
  isClaudeAged
} from '../modules/inventory/inventory-claude-aging.ts';
import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { claimAllowsDelivery, pendingInventoryClaim } from './inventory-usage.mjs';
import { releasedAccountOrders, stockLinkedToCustomer, systemAccount } from './account-lifecycle.mjs';
import { isHistoricallyOpenedClaude } from './inventory-history.mjs';
import { personalDelivery, personalProduct, sameTarget, stockTypeForProduct } from './personal-subscriptions.mjs';
import { inventoryOperationalStatus, orderReceiptRecorded } from '../modules/orders/order-opening.mjs';
import { hasRecordedPaymentAmount, orderExpenseTerms, validCurrencyCode } from '../modules/finance/accounting.mjs';

function units(value) {
  if (typeof value !== 'string' || !/^-?\d{1,16}(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const magnitude = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  return value.startsWith('-') ? -magnitude : magnitude;
}

function indexRows(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const id = row?.[key];
    if (typeof id !== 'string' || !id || result.has(id)) return null;
    result.set(id, row);
  }
  return result;
}

export function checkRelayInventory(inventory) {
  const relay = inventory.appleRelay;
  const aliases = inventory.mailboxes.filter((row) => row?.type === 'relay');
  if (!relay && !aliases.length) return;
  if (!relay || ![relay.parents, relay.imports, relay.events].every(Array.isArray)) {
    return '苹果隐藏邮箱登记资料不完整';
  }
  const parents = indexRows(relay.parents, 'id');
  if (!parents || !indexRows(aliases, 'id')) return '苹果邮箱编号重复或无效';
  for (const alias of aliases) {
    if (!parents.has(alias.parentMailboxId)) return '隐藏邮箱必须关联已登记的主邮箱';
  }
}

export function checkBankReturns(previous, commerce) {
  const orders = indexRows(commerce.orders, 'id');
  if (!orders) return '订单编号重复或无效';
  for (const order of orders.values()) {
    if (order.bankReturns === undefined) continue;
    if (!Array.isArray(order.bankReturns) || !indexRows(order.bankReturns, 'id')) {
      return '银行卡回款记录格式不正确';
    }
    if (!order.bankReturns.length) continue;
    const paid = units(order.paidAmount);
    const previousReturns = previous?.orders?.find(row => row.id === order.id)?.bankReturns || [];
    let total = 0n;
    for (const record of order.bankReturns) {
      const amount = units(record.amount);
      if (
        amount === null ||
        amount <= 0n ||
        record.currency !== order.paidCurrency ||
        (record.cardId !== order.cardId && !previousReturns.some(before => isDeepStrictEqual(before, record)))
      ) {
        return '银行卡回款必须按原付款银行卡和代付币种登记';
      }
      total += amount;
    }
    if (order.payment !== '银行卡' || !hasRecordedPaymentAmount(order) || paid === null || total > paid) {
      return '银行卡累计回款不得超过已登记代付金额';
    }
  }
  for (const order of previous?.orders || []) {
    if (!order.bankReturns?.length) continue;
    const next = orders.get(order.id)?.bankReturns || [];
    if (order.bankReturns.some((record, index) => !isDeepStrictEqual(record, next[index]))) {
      return '银行卡实际回款记录必须保留';
    }
  }
}

export function hasConfirmedMoney(order) {
  const confirmed = (row) =>
    hasRecordedPaymentAmount(row) ||
    (row?.paidConfirmed === true && (units(row.paidAmount) ?? 0n) > 0n) ||
    (orderReceiptRecorded(row) && (units(row.saleAmount) ?? 0n) > 0n);
  return (
    confirmed(order) ||
    (Array.isArray(order?.financialEvidence) &&
      order.financialEvidence.some(
        (entry) => ['payment', 'receipt'].includes(entry?.kind) && (units(entry.amount) ?? 0n) > 0n
      )) ||
    (Array.isArray(order?.corrections) &&
      order.corrections.some((entry) => confirmed(entry?.previous)))
  );
}

export function checkOrderFinancialHistory(previous, commerce) {
  const orders = new Map(commerce.orders.map((order) => [order.id, order]));
  const priorOrders = new Map((previous?.orders || []).map((order) => [order.id, order]));
  for (const order of priorOrders.values()) {
    const existing = Array.isArray(order.refunds) ? order.refunds : [];
    const nextOrder = orders.get(order.id);
    const next = nextOrder?.refunds;
    for (const field of ['corrections', 'compensations']) {
      const before = Array.isArray(order[field]) ? order[field] : [];
      if (before.length && (!Array.isArray(nextOrder?.[field]) ||
          before.some((entry, index) => !isDeepStrictEqual(entry, nextOrder[field][index]))))
        return '原订单更正及补偿撤回记录必须保留';
    }
    // Payment normalization can group payments ahead of receipts. Preserve the
    // immutable sequence within each kind instead of depending on that grouping.
    for (const [kind, before] of Map.groupBy(Array.isArray(order.financialEvidence) ? order.financialEvidence : [], entry => entry?.kind)) {
      const after = (Array.isArray(nextOrder?.financialEvidence) ? nextOrder.financialEvidence : [])
        .filter(entry => entry?.kind === kind);
      if (before.some((entry, index) => !isDeepStrictEqual(entry, after[index])))
        return '原订单付款和实收凭据必须保留，不能删除或改写';
    }
    if (
      existing.length &&
      (!Array.isArray(next) ||
        existing.some((refund, index) => !isDeepStrictEqual(refund, next[index])))
    ) {
      return '原有客户退款记录必须保留，金额及其他资料不能改写';
    }
    if (
      hasConfirmedMoney(order) &&
      (!nextOrder || (!order.cancelled && nextOrder.cancelled) || !hasConfirmedMoney(nextOrder))
    ) {
      return '已有实际付款或实收的订单必须保留，不能直接撤单或清除财务事实';
    }
  }
  for (const order of orders.values()) {
    if (order.refunds === undefined) continue;
    if (!Array.isArray(order.refunds)) return '客户退款记录格式不正确';
    if (!order.refunds.length) continue;

    const prior = priorOrders.get(order.id);
    const existing = Array.isArray(prior?.refunds) ? prior.refunds : [];
    const added = order.refunds.slice(existing.length);
    if (
      !added.length &&
      order.saleAmount === prior?.saleAmount &&
      order.saleCurrency === prior?.saleCurrency &&
      order.receiptConfirmed === prior?.receiptConfirmed &&
      order.payment === prior?.payment &&
      order.cancelled === prior?.cancelled
    ) {
      continue;
    }
    if (
      existing.length &&
      (order.saleCurrency !== prior.saleCurrency || order.payment !== prior.payment)
    ) {
      return '已有客户退款，必须保留原实收币种和支付方式';
    }
    if (
      added.length &&
      prior &&
      (units(order.saleAmount) !== units(prior.saleAmount) ||
        order.saleCurrency !== prior.saleCurrency ||
        order.receiptConfirmed !== prior.receiptConfirmed ||
        order.payment !== prior.payment)
    ) {
      return '登记退款时不能同时修改原实收金额、币种或支付资料';
    }
    const ids = new Set(existing.map((refund) => refund?.id));
    for (const refund of added) {
      if (
        typeof refund?.id !== 'string' ||
        !refund.id ||
        ids.has(refund.id) ||
        !['银行卡', '苹果内购'].includes(order.payment) ||
        refund.payment !== order.payment
      ) {
        return '新增客户退款必须有唯一编号，并与原订单支付方式一致';
      }
      ids.add(refund.id);
    }
    let total = 0n;
    for (const refund of order.refunds) {
      const amount = units(refund?.amount);
      if (
        typeof order.saleCurrency !== 'string' ||
        !/^[A-Z]{3}$/.test(order.saleCurrency) ||
        refund?.currency !== order.saleCurrency ||
        amount === null ||
        amount <= 0n
      ) {
        return '客户退款金额必须大于零，并按原实收币种登记';
      }
      total += amount;
    }
    const received = units(order.saleAmount);
    if (
      order.cancelled ||
      !orderReceiptRecorded(order) ||
      received === null ||
      total > received
    ) {
      return '客户累计退款不得超过已确认实收金额，已撤单不能登记退款';
    }
  }
}

export function checkCustomerReferences(previous, commerce) {
  const customers = indexRows(commerce.customers, 'id');
  if (!customers) return '客户编号重复或无效';
  if (!previous) return;
  const before = new Set((previous?.customers || []).map(row => row.id));
  const orders = new Map((previous?.orders || []).map(row => [row.id, row]));
  for (const row of commerce.orders) {
    if (customers.has(row.customerId)) continue;
    const prior = orders.get(row.id);
    // Leave legacy missing references visible; never invent a customer or make
    // unrelated maintenance depend on repairing historical records first.
    if (before.has(row.customerId) || (row.customerId && row.customerId !== prior?.customerId) ||
        (prior?.customerId && !row.customerId))
      return '订单关联的客户必须保留，请停用客户或核对订单客户';
  }
}

const financialFields = ['paidAmount', 'paidCurrency', 'paidConfirmed', 'saleAmount', 'saleCurrency',
  'receiptConfirmed', 'costBasis', 'actualCostAmount', 'actualCostCurrency', 'appleRecoverableCostAmount',
  'emailCostAmount', 'emailCostCurrency'];
const sameFinancialFields = (left, right) => financialFields.every(field =>
  isDeepStrictEqual(left?.[field] ?? '', right?.[field] ?? ''));

export function checkOrderFinancialRevision(prior, next, action) {
  if (!prior || sameFinancialFields(prior, next)) return;
  if (action !== '补偿撤回更正') {
    for (const [amount, currency] of [['actualCostAmount', 'actualCostCurrency'], ['emailCostAmount', 'emailCostCurrency']]) {
      if ((next[amount] ?? '') === (prior[amount] ?? '') && (next[currency] ?? '') === (prior[currency] ?? '')) continue;
      if ((next[amount] ?? '') !== '' && ((units(next[amount]) ?? -1n) < 0n || !validCurrencyCode(next[currency])))
        return '成本金额和币种无效，请核对原始凭据';
    }
    if (next.costBasis === 'actual' && ((units(next.actualCostAmount) ?? -1n) < 0n || !validCurrencyCode(next.actualCostCurrency)))
      return '实际总成本必须有有效金额和币种';
    if (['appleRecoverableCostAmount', 'actualCostAmount', 'actualCostCurrency', 'costBasis']
        .some(field => (next[field] ?? '') !== (prior[field] ?? '')) &&
        (next.appleRecoverableCostAmount ?? '') !== '' &&
        ((units(next.appleRecoverableCostAmount) ?? -1n) < 0n ||
          units(next.appleRecoverableCostAmount) > (units(next.actualCostAmount) ?? -1n)))
      return 'Apple 可退成本必须在实际总成本范围内';
  }
  const before = prior.corrections || [], after = next.corrections || [];
  if (!Number.isSafeInteger(prior.version) || next.version !== prior.version + 1)
    return '修改订单金额必须更新订单版本并保留更正记录';
  if (action === '更正订单' && Array.isArray(after) && after.length === before.length + 1) {
    const correction = after.at(-1);
    if (typeof correction?.id === 'string' && correction.id && !before.some(row => row.id === correction.id) &&
        typeof correction.reason === 'string' && correction.reason.trim() &&
        correction.versionAfter === next.version && correction.previous?.version === prior.version &&
        sameFinancialFields(prior, correction.previous)) return;
  }
  if (action === '补偿撤回更正') {
    const correction = before.at(-1), previous = prior.compensations || [], compensations = next.compensations;
    const compensation = compensations?.at(-1);
    if (correction?.versionAfter === prior.version && sameFinancialFields(next, correction.previous) &&
        Array.isArray(compensations) && compensations.length === previous.length + 1 &&
        typeof compensation?.id === 'string' && compensation.id && !previous.some(row => row.id === compensation.id) &&
        compensation.correctionId === correction.id && compensation.fromVersion === prior.version &&
        compensation.toVersion === next.version && typeof compensation.reason === 'string' && compensation.reason.trim()) return;
  }
  return '请通过订单更正或补偿撤回登记金额变化，并保留原因和原金额';
}

export function checkRentHistory(previous, commerce, action) {
  const batches = indexRows(commerce.rentBatches, 'id');
  if (!batches) return '租金批次编号重复或无效';
  for (const batch of previous?.rentBatches || []) {
    const next = batches.get(batch.id);
    const items = Array.isArray(next?.items) && indexRows(next.items, 'id');
    if (!items || items.size !== (batch.items || []).length)
      return '历史租金批次和发放明细必须保留';
    if (Object.keys({ ...batch, ...next }).some(key => key !== 'items' && !isDeepStrictEqual(batch[key], next[key])))
      return '原租金批次资料必须保留';
    for (const item of batch.items || []) {
      const updated = items.get(item.id);
      if (!updated) return '历史租金发放明细必须保留';
      if (isDeepStrictEqual(item, updated)) continue;
      const payments = item.payments || [], nextPayments = updated.payments;
      if (!Array.isArray(nextPayments) || payments.some((row, index) => !isDeepStrictEqual(row, nextPayments[index])))
        return '原租金发放记录必须保留';
      if (['已发放', '已取消'].includes(item.status)) return '已发放或已取消的租金明细不可改写';
      const entry = nextPayments.at(-1);
      const unchanged = Object.keys({ ...item, ...updated }).filter(key =>
        !['status', 'version', 'notes', 'paidAt', 'payments'].includes(key));
      if (action !== '租金发放登记' || nextPayments.length !== payments.length + 1 ||
          updated.version !== item.version + 1 || unchanged.some(key => !isDeepStrictEqual(item[key], updated[key])) ||
          !['已发放', '发放失败', '待发放', '已取消'].includes(updated.status) ||
          entry?.status !== updated.status || typeof entry.at !== 'string' || !entry.at.trim() ||
          typeof entry.notes !== 'string' || !entry.notes.trim() || entry.notes !== updated.notes ||
          updated.paidAt !== (updated.status === '已发放' ? entry.at : ''))
        return '请通过租金发放登记追加记录，并保留原明细';
    }
  }
}

export function checkOrderExpenseReferences(previous, commerce, receipts = []) {
  if (!receipts.length) return;
  const before = new Map((previous?.orders || []).map(row => [row.id, row]));
  const after = new Map(commerce.orders.map(row => [row.id, row]));
  const dependencies = [...financialFields, 'payment', 'product', 'status', 'draft', 'entitlementStatus',
    'cardId', 'cardTypeId', 'cardTypeName', 'proMaterialMode', 'corrections'];
  for (const [id, linked] of Map.groupBy(receipts.filter(row => row.orderId && !row.voidedAt), row => row.orderId)) {
    const prior = before.get(id), next = after.get(id);
    if (!prior) continue;
    if (!next) return '已有费用凭据关联的订单必须保留';
    if (dependencies.every(field => isDeepStrictEqual(prior[field], next[field]))) continue;
    try { orderExpenseTerms(next, linked); }
    catch { return '订单修改与已登记费用凭据不一致，请先核对费用凭据的核算方式和金额'; }
  }
}

function stockAccounts(accounts) {
  const index = new Map();
  for (const account of accounts) {
    if (typeof account?.id === 'string' && account.id) {
      index.set(account.id, index.has(account.id) ? null : account);
    }
  }
  return index;
}

function meetsClaudeAging(account, inventory) {
  const configured = inventory.tableSettings?.find((entry) => entry?.[0] === 'claude')?.[1];
  const hours = configured?.hours ?? DEFAULT_CLAUDE_AGING_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_CLAUDE_AGING_HOURS) return false;
  const fallback = account.claudeHistory ? '' : account.createdAt || account.importedAt || '';
  const input = String(String(account.registered || '').trim() || fallback)
    .trim()
    .replace(' ', 'T');
  const local = /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00` : input;
  const date = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(local)
    ? new Date(local)
    : parseV2DateTimeInput(local);
  return isClaudeAged(date, new Date(), hours);
}

export function checkStockDeliveries(previousCommerce, commerce, previousInventory, inventory, actor) {
  const orders = new Map((commerce?.orders || []).map((order) => [order.id, order]));
  const priorOrders = new Map((previousCommerce?.orders || []).map((order) => [order.id, order]));
  const accounts = inventory?.accounts || [];
  const priorAccounts = stockAccounts(previousInventory?.accounts || []);
  const nextAccounts = stockAccounts(accounts);
  const usedAccounts = new Set();
  for (const order of priorOrders.values()) {
    if (order.businessType !== '成品交付') continue;
    const next = orders.get(order.id);
    if (
      !next ||
      next.businessType !== order.businessType ||
      next.accountId !== order.accountId ||
      next.product !== order.product ||
      (order.accountId && (next.email !== order.email ||
        (personalProduct(order.product) && !sameTarget(next, order))))
    ) {
      return '原成品交付订单及其库存账号必须保留';
    }
    if (personalDelivery(order) && order.accountId &&
      !releasedAccountOrders(priorAccounts.get(order.accountId) || {}).has(order.id)) usedAccounts.add(order.accountId);
  }

  const newSales = new Map();
  for (const order of orders.values()) {
    const prior = priorOrders.get(order.id);
    if (order.businessType === '首次开通' && stockTypeForProduct(order.product) === 'claude' &&
        (!prior || prior.email !== order.email || prior.accountId !== order.accountId || prior.businessType !== order.businessType)) {
      const email = String(order.email || '').trim().toLowerCase();
      if (order.accountId || order.accountSource === '库存' ||
          (email && accounts.some(account => account?.type === 'claude' && systemAccount(account) &&
            email === String(account.email || '').trim().toLowerCase() &&
            stockLinkedToCustomer(account, order.customerId, previousCommerce))))
        return '该账号来自系统库存，请使用成品交付或续费';
    }
    if (order.businessType !== '成品交付') continue;
    if (personalDelivery(prior)) continue;
    if (prior && prior.businessType !== '成品交付') return '已保存订单不能改为成品交付，请登记独立新订单';
    const personal = personalProduct(order.product);
    if (personal && order.cancelled && !personalDelivery(order)) continue;
    if (order.source === '管理员手工' && !order.accountId && order.entitlementStatus === 'active') continue;
    if (
      typeof order.accountId !== 'string' ||
      !order.accountId ||
      usedAccounts.has(order.accountId)
    ) {
      return '成品交付必须使用未交付的库存账号，同一账号不能重复交付';
    }
    usedAccounts.add(order.accountId);
    if (personal && !personalDelivery(order)) {
      const account = nextAccounts.get(order.accountId);
      const before = priorAccounts.get(order.accountId);
      const state = row => row?.inventoryState || (row?.used ? 'used' : 'available');
      const claim = pendingInventoryClaim(previousInventory, before);
      const nextClaim = pendingInventoryClaim(inventory, account);
      if (!account || !before || account.type !== stockTypeForProduct(order.product) ||
          account.source === '客户提供' || ['客户自有', 'customer'].includes(account.accountSource) ||
          !sameTarget(order, account) || state(account) !== state(before) ||
          (!prior && ((before.health || 'normal') !== 'normal' || inventoryOperationalStatus(before) !== '正常' ||
            (before.usageLinks?.length && before.accountLifecycle?.disposition !== 'recovered'))) ||
          account.claimId !== before.claimId || (state(before) !== 'available' &&
            (!claim || nextClaim?.item.id !== claim.item.id || (!prior && !claimAllowsDelivery(claim, actor)))))
        return '待核对订单须保留原可交付库存与领用';
      continue;
    }
    newSales.set(order.id, order);
  }

  for (const account of accounts) {
    if (!Array.isArray(account?.usageLinks)) continue;
    const prior = priorAccounts.get(account.id);
    const previousLinks = Array.isArray(prior?.usageLinks) ? prior.usageLinks : [];
    const links = account.usageLinks.slice(previousLinks.length);
    for (const link of links) {
      if (link?.kind !== 'order-sale') continue;
      const order = newSales.get(link.orderId);
      const priorState = prior?.inventoryState || (prior?.used ? 'used' : 'available');
      const claim = priorState === 'claimed' && pendingInventoryClaim(previousInventory, prior);
      const delivered = claim && inventory.batches?.find((row) => row.id === claim.batch.id)
        ?.items?.find((row) => row.id === claim.item.id);
      const validClaimDelivery = claimAllowsDelivery(claim, actor) &&
        account.claimId === prior.claimId && account.claimBatchId === prior.claimBatchId &&
        delivered?.status === 'used' && delivered.orderId === order?.id && delivered.usedAt;
      const type = stockTypeForProduct(order?.product);
      if (
        !order ||
        nextAccounts.get(account.id) !== account ||
        order.accountId !== account.id ||
        !prior ||
        (priorState !== 'available' && !validClaimDelivery) ||
        (prior.health || 'normal') !== 'normal' ||
        inventoryOperationalStatus(prior) !== '正常' ||
        (previousLinks.length && prior.accountLifecycle?.disposition !== 'recovered') ||
        links.length !== 1 ||
        account.inventoryState !== 'used' ||
        prior.type !== type ||
        account.type !== type ||
        (personalProduct(order.product)
          ? !sameTarget(order, prior) || !sameTarget(order, account) ||
            prior.source === '客户提供' || ['客户自有', 'customer'].includes(prior.accountSource)
          : !order.email || prior.email !== order.email || account.email !== order.email)
      ) {
        return '成品交付必须与原可用库存账号的使用记录一起保存';
      }
      if (isHistoricallyOpenedClaude(prior)) return '已开通的 Claude 历史账号不能再次交付';
      if (type === 'claude' && !meetsClaudeAging(prior, previousInventory)) {
        return 'Claude 库存账号未达到养号阈值，不能交付';
      }
      newSales.delete(order.id);
    }
  }
  if (newSales.size) return '成品交付必须与库存使用记录一起保存';
}

function checkMovements(previous, ledger, appleIds, wallets, orders, allocations, refunds, completedRenewalId) {
  const balances = new Map();
  const history = new Map();
  const debits = new Map();
  const received = new Set();
  const debitKey = (row) => JSON.stringify([row.orderId, row.appleIdId]);
  for (const movement of ledger.movements) {
    if (!appleIds.has(movement?.appleIdId) || !wallets.has(movement.appleIdId)) {
      return '苹果 ID 已有余额流水，必须保留原资料';
    }
    const amount = units(movement.amount);
    if (amount === null) return '苹果 ID 余额变动金额格式不正确';
    if (movement.kind === 'order-charge' || movement.kind === 'order-reversal') {
      if (!movement.orderId || (movement.kind === 'order-charge' ? amount >= 0n : amount <= 0n)) {
        return '苹果内购扣款或冲正的金额方向不正确';
      }
      const key = debitKey(movement);
      debits.set(key, (debits.get(key) || 0n) - amount);
    } else if (movement.kind === 'apple-refund') {
      const refund = refunds.get(movement.refundId);
      if (
        refund?.status !== 'received' ||
        refund.orderId !== movement.orderId ||
        refund.appleIdId !== movement.appleIdId ||
        units(refund.amount) !== amount ||
        received.has(refund.id)
      ) {
        return 'Apple 回款流水必须与一笔已到账记录对应';
      }
      received.add(refund.id);
    } else if (['opening', 'topup'].includes(movement.kind)) {
      if (amount <= 0n || movement.orderId ||
          (movement.kind === 'opening' && (!String(movement.reason || '').trim() || balances.has(movement.appleIdId))))
        return '苹果 ID 期初余额或充值流水不正确';
    } else if (!['manual', 'manual-undo'].includes(movement.kind) || movement.orderId) {
      return '苹果 ID 余额变动类型不正确';
    }
    if (movement.orderId && !orders.has(movement.orderId)) return '余额流水的原订单不存在';
    const prior = balances.get(movement.appleIdId) || { balance: 0n, version: 1 };
    if (movement.kind === 'manual-undo') {
      const original = history.get(movement.originalEntryId);
      if (
        !['manual', 'topup'].includes(original?.kind) ||
        original.appleIdId !== movement.appleIdId ||
        original.undoneBy !== movement.id ||
        original.versionAfter !== prior.version ||
        units(original.amount) !== -amount
      ) {
        return '人工余额变动撤回必须关联最近的原流水并反向补偿';
      }
    }
    if (
      typeof movement.id !== 'string' ||
      !movement.id ||
      history.has(movement.id) ||
      units(movement.before) !== prior.balance ||
      units(movement.after) !== prior.balance + amount ||
      prior.balance + amount < 0n ||
      movement.versionAfter !== prior.version + 1
    ) {
      return '苹果 ID 余额与变动流水不一致';
    }
    balances.set(movement.appleIdId, {
      balance: prior.balance + amount,
      version: movement.versionAfter
    });
    history.set(movement.id, movement);
  }
  for (const movement of previous?.movements || []) {
    const next = history.get(movement.id);
    if (!next) return '原有苹果 ID 余额流水必须保留';
    const { undoneBy, ...values } = next;
    const { undoneBy: previousUndo, ...previousValues } = movement;
    // The paid handoff already fixed the order id. Only its newly assigned
    // display number may be attached when the verified handoff completes.
    if (completedRenewalId && movement.orderId === completedRenewalId && !Object.hasOwn(previousValues, 'orderNo') &&
        values.orderNo === orders.get(completedRenewalId)?.orderNo) delete values.orderNo;
    if (
      !isDeepStrictEqual(values, previousValues) ||
      (previousUndo && previousUndo !== undoneBy) ||
      (undoneBy && history.get(undoneBy)?.originalEntryId !== movement.id)
    ) {
      return '原有苹果 ID 余额流水不能改写';
    }
  }
  for (const wallet of wallets.values()) {
    const expected = balances.get(wallet.id) || { balance: 0n, version: 1 };
    if (
      wallet.currency !== 'USD' ||
      units(wallet.balance) !== expected.balance ||
      wallet.version !== expected.version
    ) {
      return '苹果 ID 可用余额必须由流水核对';
    }
  }
  for (const allocation of allocations.values()) {
    const key = debitKey(allocation);
    if (debits.get(key) !== units(allocation.amount)) return '苹果内购扣款与余额流水不一致';
    debits.delete(key);
  }
  if ([...debits.values()].some((amount) => amount !== 0n)) {
    return '苹果内购扣款必须有原订单或完整冲正';
  }
  if (
    [...refunds.values()].some((refund) => refund.status === 'received' && !received.has(refund.id))
  ) {
    return 'Apple 已到账记录必须有对应的余额流水';
  }
}

export function checkAppleLedger(previous, ledger, inventory, commerce, previousCommerce, { completedRenewalId } = {}) {
  const appleIds = new Set(
    (inventory?.mailboxes || []).filter((row) => row?.type === 'apple').map((row) => row.id)
  );
  const orders = new Map((commerce?.orders || []).map((order) => [order?.id, order]));
  const wallets = indexRows(ledger.wallets, 'id');
  const allocations = indexRows(ledger.allocations, 'orderId');
  const refunds = indexRows(ledger.refunds, 'id');
  if (!wallets || !allocations || !refunds) return '苹果 ID 账本编号重复或无效';
  const movementError = checkMovements(
    previous,
    ledger,
    appleIds,
    wallets,
    orders,
    allocations,
    refunds,
    completedRenewalId
  );
  if (movementError) return movementError;

  const settled = new Map();
  const reserved = new Map();
  for (const record of refunds.values()) {
    const order = orders.get(record.orderId);
    const allocation = allocations.get(record.orderId);
    const amount = units(record.amount);
    if (
      !order?.refunds?.some((refund) => refund?.id === record.id) ||
      !appleIds.has(record.appleIdId) ||
      amount === null ||
      !['pending', 'received', 'none'].includes(record.status) ||
      (record.status === 'none'
        ? amount !== 0n
        : amount <= 0n || allocation?.appleIdId !== record.appleIdId)
    ) {
      return 'Apple 回款记录与原订单、退款或付款账号不一致';
    }
    if (record.status === 'received') {
      settled.set(record.orderId, (settled.get(record.orderId) || 0n) + amount);
    } else if (record.status === 'pending') {
      reserved.set(record.orderId, (reserved.get(record.orderId) || 0n) + amount);
    }
  }
  for (const before of previous?.refunds || []) {
    const after = refunds.get(before.id);
    if (
      !after ||
      before.appleIdId !== after.appleIdId ||
      before.orderId !== after.orderId ||
      (before.status === 'received' && !isDeepStrictEqual(before, after))
    ) {
      return '原有 Apple 回款记录必须保留，已到账金额不能改写';
    }
  }
  for (const allocation of allocations.values()) {
    const order = orders.get(allocation.orderId);
    const amount = units(allocation.amount);
    const received = settled.get(allocation.orderId) || 0n;
    if (
      order?.payment !== '苹果内购' ||
      !order.paidConfirmed ||
      order.paidCurrency !== 'USD' ||
      order.appleIdId !== allocation.appleIdId ||
      !appleIds.has(allocation.appleIdId) ||
      !wallets.has(allocation.appleIdId) ||
      amount === null ||
      amount <= 0n ||
      units(order.paidAmount) !== amount ||
      units(allocation.returned) !== received ||
      received + (reserved.get(allocation.orderId) || 0n) > amount
    ) {
      return '苹果内购的扣款、待回款与原订单不一致';
    }
  }
  const priorOrders = new Map((previousCommerce?.orders || []).map(row => [row.id, row]));
  const originalAllocations = new Set((previous?.allocations || []).map(row => row.orderId));
  const originalRefunds = new Set((previous?.refunds || []).map(row => row.id));
  for (const order of orders.values()) {
    const prior = priorOrders.get(order.id);
    const samePayment = prior?.paidConfirmed && !originalAllocations.has(order.id) && ['payment', 'appleIdId', 'paidCurrency', 'paidAmount'].every(key =>
      (order[key] ?? '') === (prior[key] ?? ''));
    const externalApple = order.externalApplePayment === true && !order.appleIdId;
    if (order.payment === '苹果内购' && order.paidConfirmed && !externalApple && !allocations.has(order.id) && !samePayment) {
      return '确认苹果内购时必须同时保存余额扣款';
    }
    for (const refund of order?.refunds || []) {
      if (refund?.payment === '苹果内购' && !externalApple && refunds.get(refund.id)?.orderId !== order.id &&
          (originalRefunds.has(refund.id) || !prior?.refunds?.some(saved => isDeepStrictEqual(saved, refund)))) {
        return '苹果内购退款必须同时登记本次 Apple ID 回款金额';
      }
    }
  }
}
