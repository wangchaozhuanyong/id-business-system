import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_CLAUDE_AGING_HOURS,
  MAX_CLAUDE_AGING_HOURS,
  isClaudeAged
} from '../modules/inventory/inventory-claude-aging.ts';
import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { claimAllowsDelivery, pendingInventoryClaim } from './inventory-usage.mjs';

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
    let total = 0n;
    for (const record of order.bankReturns) {
      const amount = units(record.amount);
      if (
        amount === null ||
        amount <= 0n ||
        record.currency !== order.paidCurrency ||
        record.cardId !== order.cardId
      ) {
        return '银行卡回款必须按原付款银行卡和代付币种登记';
      }
      total += amount;
    }
    if (order.payment !== '银行卡' || !order.paidConfirmed || paid === null || total > paid) {
      return '银行卡累计回款不得超过已确认代付金额';
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

function hasConfirmedMoney(order) {
  const confirmed = (row) =>
    (row?.paidConfirmed === true && (units(row.paidAmount) ?? 0n) > 0n) ||
    (row?.receiptConfirmed === true && (units(row.saleAmount) ?? 0n) > 0n);
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
      order.receiptConfirmed !== true ||
      received === null ||
      total > received
    ) {
      return '客户累计退款不得超过已确认实收金额，已撤单不能登记退款';
    }
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
  const input = String(String(account.registered || '').trim() || account.createdAt || account.importedAt || '')
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
      next.email !== order.email
    ) {
      return '原成品交付订单及其库存账号必须保留';
    }
    if (order.accountId) usedAccounts.add(order.accountId);
  }

  const newSales = new Map();
  for (const order of orders.values()) {
    if (order.businessType !== '成品交付') continue;
    const prior = priorOrders.get(order.id);
    if (prior?.businessType === '成品交付') continue;
    if (prior) return '已保存订单不能改为成品交付，请登记独立新订单';
    if (
      typeof order.accountId !== 'string' ||
      !order.accountId ||
      usedAccounts.has(order.accountId)
    ) {
      return '成品交付必须使用未交付的库存账号，同一账号不能重复交付';
    }
    usedAccounts.add(order.accountId);
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
      const type =
        order?.product === 'GPT'
          ? 'gpt'
          : /^Claude (?:Pro|Max)$/.test(order?.product || '')
            ? 'claude'
            : '';
      if (
        !order ||
        nextAccounts.get(account.id) !== account ||
        order.accountId !== account.id ||
        !prior ||
        (priorState !== 'available' && !validClaimDelivery) ||
        (prior.health || 'normal') !== 'normal' ||
        (prior.status || '正常') !== '正常' ||
        previousLinks.length ||
        links.length !== 1 ||
        account.inventoryState !== 'used' ||
        prior.type !== type ||
        account.type !== type ||
        !order.email ||
        prior.email !== order.email ||
        account.email !== order.email
      ) {
        return '成品交付必须与原可用库存账号的使用记录一起保存';
      }
      if (type === 'claude' && !meetsClaudeAging(prior, previousInventory)) {
        return 'Claude 库存账号未达到养号阈值，不能交付';
      }
      newSales.delete(order.id);
    }
  }
  if (newSales.size) return '成品交付必须与库存使用记录一起保存';
}

function checkMovements(previous, ledger, appleIds, wallets, orders, allocations, refunds) {
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
    } else if (!['manual', 'manual-undo'].includes(movement.kind) || movement.orderId) {
      return '苹果 ID 余额变动类型不正确';
    }
    if (movement.orderId && !orders.has(movement.orderId)) return '余额流水的原订单不存在';
    const prior = balances.get(movement.appleIdId) || { balance: 0n, version: 1 };
    if (movement.kind === 'manual-undo') {
      const original = history.get(movement.originalEntryId);
      if (
        original?.kind !== 'manual' ||
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

export function checkAppleLedger(previous, ledger, inventory, commerce) {
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
    refunds
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
  for (const order of orders.values()) {
    if (order?.payment === '苹果内购' && order.paidConfirmed && !allocations.has(order.id)) {
      return '确认苹果内购时必须同时保存余额扣款';
    }
    for (const refund of order?.refunds || []) {
      if (refund?.payment === '苹果内购' && refunds.get(refund.id)?.orderId !== order.id) {
        return '苹果内购退款必须同时登记本次 Apple ID 回款金额';
      }
    }
  }
}
