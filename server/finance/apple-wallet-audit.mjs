import { appleAmountUnits } from '../../frontend/apple-funding.mjs';
import { hasRecordedPaymentAmount } from '../../modules/finance/accounting.mjs';

const validId = value => typeof value === 'string' && /^[\w.-]{1,120}$/.test(value) &&
  !/^\d{12,19}$/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value > 0;
const orderKinds = new Set(['order-charge', 'order-reversal', 'apple-refund']);
const movementKinds = new Set([...orderKinds, 'opening', 'topup', 'manual', 'manual-undo']);
const signedUnits = value => {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('-')) return appleAmountUnits(value);
  const amount = appleAmountUnits(value.slice(1));
  return amount === null ? null : -amount;
};
const format = amount => {
  if (amount === null) return null;
  const absolute = amount < 0n ? -amount : amount;
  return (amount < 0n ? '-' : '') + (absolute / 10000n) + '.' + (absolute % 10000n).toString().padStart(4, '0');
};

function group(rows, field) {
  const byId = new Map();
  let invalid = 0;
  for (const row of rows) {
    const id = row?.[field];
    if (!validId(id)) {
      invalid++;
      continue;
    }
    const items = byId.get(id);
    if (items) items.push(row);
    else byId.set(id, [row]);
  }
  return { byId, invalid };
}

function single(index, id) {
  const rows = index.get(id);
  return rows?.length === 1 ? rows[0] : undefined;
}

function evidenceIds(rows) {
  return [...new Set(rows.map(row => row.id).filter(validId))];
}

export function auditAppleWallets({ commerce, appleBalance, inventory } = {}) {
  const coverage = {
    orders: Array.isArray(commerce?.orders),
    inventory: Array.isArray(inventory?.mailboxes),
    wallets: Array.isArray(appleBalance?.wallets),
    movements: Array.isArray(appleBalance?.movements),
    allocations: Array.isArray(appleBalance?.allocations),
    refunds: Array.isArray(appleBalance?.refunds)
  };
  const issues = [];
  for (const [section, available] of Object.entries(coverage))
    if (!available) issues.push({ code: 'missing_section', section });
  const walletRows = coverage.wallets ? appleBalance.wallets : [];
  const movementRows = coverage.movements ? appleBalance.movements : [];
  const allocationRows = coverage.allocations ? appleBalance.allocations : [];
  const refundRows = coverage.refunds ? appleBalance.refunds : [];
  const orders = coverage.orders ? commerce.orders : [];
  const assets = coverage.inventory ? inventory.mailboxes.filter(row => row?.type === 'apple') : [];
  const indexes = [
    ['wallet', walletRows, 'id'], ['movement', movementRows, 'id'], ['allocation', allocationRows, 'orderId'],
    ['refund', refundRows, 'id'], ['order', orders, 'id'], ['inventory', assets, 'id']
  ].map(([section, rows, field]) => {
    const { byId, invalid } = group(rows, field);
    if (invalid) issues.push({ code: 'invalid_id', section, count: invalid });
    for (const [id, matches] of byId)
      if (matches.length > 1) issues.push({ code: 'duplicate_id', section, id, count: matches.length });
    return byId;
  });
  const [walletIndex, movementIndex, allocationIndex, refundIndex, orderIndex, inventoryIndex] = indexes;
  const byWallet = group(movementRows, 'appleIdId');
  const byOrder = group(movementRows.filter(row => orderKinds.has(row?.kind)), 'orderId');
  const refundsByOrder = group(refundRows, 'orderId');
  const byRefund = group(movementRows.filter(row => row?.kind === 'apple-refund'), 'refundId');
  for (const [section, rows] of [['wallet_movement', byWallet], ['order_movement', byOrder],
    ['order_refund', refundsByOrder], ['refund_movement', byRefund]]) {
    if (rows.invalid) issues.push({ code: 'invalid_reference', section, count: rows.invalid });
  }
  for (const row of [...allocationRows, ...refundRows]) {
    if (!validId(row?.appleIdId)) issues.push({ code: 'invalid_wallet_reference',
      ...(validId(row?.orderId) && { orderId: row.orderId }) });
  }

  const wallets = [];
  const verifiedWallets = new Set();
  const walletIds = new Set([
    ...walletIndex.keys(), ...byWallet.byId.keys(),
    ...[...allocationRows, ...refundRows].map(row => row?.appleIdId).filter(validId)
  ]);
  for (const walletId of walletIds) {
    const wallet = single(walletIndex, walletId);
    const movements = byWallet.byId.get(walletId) || [];
    const storedBalance = appleAmountUnits(wallet?.balance);
    const rowIssues = new Set();
    if (coverage.inventory && !single(inventoryIndex, walletId)) rowIssues.add('wallet_inventory_missing_or_ambiguous');
    if (coverage.wallets && !wallet) rowIssues.add('wallet_missing_or_ambiguous');
    if (wallet && (storedBalance === null || wallet.currency !== 'USD' || !validVersion(wallet.version)))
      rowIssues.add('invalid_wallet_snapshot');

    let balance = 0n, version = 1, chainValid = coverage.movements && !byWallet.invalid;
    for (const movement of movements) {
      const amount = signedUnits(movement.amount);
      const before = appleAmountUnits(movement.before);
      const after = appleAmountUnits(movement.after);
      const original = movement.kind === 'manual-undo' && single(movementIndex, movement.originalEntryId);
      const consistentUndo = movement.kind !== 'manual-undo' ||
        (amount !== null && ['manual', 'topup'].includes(original?.kind) && original.appleIdId === walletId &&
          original.undoneBy === movement.id && original.versionAfter === version && signedUnits(original.amount) === -amount);
      const undo = movement.undoneBy && single(movementIndex, movement.undoneBy);
      const consistentMarker = !movement.undoneBy ||
        (undo?.kind === 'manual-undo' && undo.originalEntryId === movement.id && undo.appleIdId === walletId);
      if (!single(movementIndex, movement.id) || !movementKinds.has(movement.kind) ||
          amount === null || before !== balance || after !== balance + amount || after < 0n ||
          movement.versionAfter !== version + 1 || !consistentUndo || !consistentMarker ||
          (['opening', 'topup', 'order-reversal', 'apple-refund'].includes(movement.kind) && amount <= 0n) ||
          (movement.kind === 'order-charge' && amount >= 0n) ||
          (movement.kind === 'opening' && (version !== 1 || !String(movement.reason || '').trim())) ||
          (orderKinds.has(movement.kind) ? !validId(movement.orderId) : Boolean(movement.orderId))) {
        chainValid = false;
        rowIssues.add('wallet_movement_chain_invalid');
      }
      if (after !== null) balance = after;
      if (validVersion(movement.versionAfter)) version = movement.versionAfter;
    }
    if (wallet && chainValid && (storedBalance !== balance || wallet.version !== version))
      rowIssues.add('wallet_snapshot_mismatch');
    if (wallet && chainValid && !rowIssues.size) verifiedWallets.add(walletId);
    for (const code of rowIssues) issues.push({ code, walletId });
    wallets.push({
      walletId, currency: 'USD', storedBalance: format(storedBalance),
      movementBalance: chainValid ? format(balance) : null,
      storedVersion: validVersion(wallet?.version) ? wallet.version : null,
      movementVersion: chainValid ? version : null,
      movementIds: evidenceIds(movements), issues: [...rowIssues]
    });
  }

  const orderRows = [];
  const linkedOrders = new Set([
    ...orders.filter(row => row?.payment === '苹果内购' && validId(row.id)).map(row => row.id),
    ...allocationIndex.keys(), ...byOrder.byId.keys(), ...refundsByOrder.byId.keys()
  ]);
  for (const orderId of linkedOrders) {
    const order = single(orderIndex, orderId);
    const allocation = single(allocationIndex, orderId);
    const walletId = validId(order?.appleIdId) ? order.appleIdId : null;
    const movements = byOrder.byId.get(orderId) || [];
    const refunds = refundsByOrder.byId.get(orderId) || [];
    const paid = order?.paidCurrency === 'USD' && hasRecordedPaymentAmount(order)
      ? appleAmountUnits(order.paidAmount) : null;
    const rowIssues = new Set();
    if (coverage.orders && !order) rowIssues.add('apple_order_missing_or_ambiguous');
    if (order && order.payment !== '苹果内购' && (allocation || refunds.length))
      rowIssues.add('apple_allocation_on_non_apple_order');
    if (walletId && coverage.wallets && !single(walletIndex, walletId)) rowIssues.add('order_wallet_missing_or_ambiguous');
    const expected = order?.payment === '苹果内购' && !order.draft &&
      !['draft', '草稿', 'failed', '失败'].includes(order.status) &&
      (walletId || order.externalApplePayment !== true) && (paid !== null || order.paidConfirmed === true);
    if (expected && !walletId) rowIssues.add('order_wallet_unrecorded');
    if (walletId && !paid && (allocation || movements.length || order?.paidConfirmed === true))
      rowIssues.add('order_payment_unrecorded');
    if (expected && walletId && coverage.allocations && !allocation) rowIssues.add('allocation_missing_or_ambiguous');
    if (allocation && (!walletId || allocation.appleIdId !== walletId || !paid ||
        appleAmountUnits(allocation.amount) !== paid))
      rowIssues.add('allocation_mismatch');

    const debits = new Map();
    let debitComplete = coverage.movements && !byOrder.invalid && !byWallet.invalid;
    for (const movement of movements) {
      if (movement.kind === 'apple-refund') continue;
      const amount = signedUnits(movement.amount);
      if (!single(movementIndex, movement.id) || !validId(movement.appleIdId) || amount === null ||
          (movement.kind === 'order-charge' ? amount >= 0n : amount <= 0n)) {
        debitComplete = false;
        rowIssues.add('order_debit_invalid');
        continue;
      }
      debits.set(movement.appleIdId, (debits.get(movement.appleIdId) || 0n) - amount);
    }
    const matchingDebit = debits.get(walletId) || 0n;
    const foreignDebit = [...debits].some(([id, amount]) => id !== walletId && amount !== 0n);
    const hasDebit = debits.size > 0;
    let debitEvidence = 'none';
    if (!debitComplete) debitEvidence = 'unknown';
    else if (foreignDebit || (hasDebit && matchingDebit !== 0n && matchingDebit !== paid)) debitEvidence = 'conflicting';
    else if (paid !== null && matchingDebit === paid) debitEvidence = 'posted';
    else if (hasDebit) debitEvidence = 'reversed';
    if (debitEvidence === 'conflicting' || (allocation && debitComplete && debitEvidence !== 'posted'))
      rowIssues.add('order_debit_mismatch');
    if (coverage.allocations && !allocation && debitEvidence === 'posted')
      rowIssues.add('posted_debit_without_allocation');

    let received = 0n, pending = 0n;
    let refundComplete = coverage.refunds && coverage.movements && !refundsByOrder.invalid && !byRefund.invalid;
    const customerRefunds = group(Array.isArray(order?.refunds) ? order.refunds : [], 'id').byId;
    for (const refund of refunds) {
      const amount = appleAmountUnits(refund.amount);
      const posted = byRefund.byId.get(refund.id) || [];
      const state = refund.status;
      if (!single(refundIndex, refund.id) || !single(customerRefunds, refund.id) || !walletId ||
          refund.appleIdId !== walletId || !['received', 'pending', 'none'].includes(state) ||
          amount === null || (state === 'none' ? amount !== 0n : amount <= 0n) ||
          (state === 'received' ? posted.length !== 1 || !single(movementIndex, posted[0].id) ||
            posted[0].orderId !== orderId || posted[0].appleIdId !== walletId ||
            signedUnits(posted[0].amount) !== amount : posted.length !== 0)) {
        refundComplete = false;
        rowIssues.add('refund_evidence_mismatch');
        continue;
      }
      if (state === 'received') received += amount;
      if (state === 'pending') pending += amount;
    }
    if (movements.some(row => row.kind === 'apple-refund' && single(refundIndex, row.refundId)?.orderId !== orderId) ||
        (walletId && coverage.refunds && [...customerRefunds.values()].flat().some(row =>
          row.payment === '苹果内购' && single(refundIndex, row.id)?.orderId !== orderId))) {
      refundComplete = false;
      rowIssues.add('refund_evidence_mismatch');
    }
    if (allocation && refundComplete && appleAmountUnits(allocation.returned) !== received)
      rowIssues.add('allocation_refund_mismatch');
    if (paid !== null && refundComplete && pending + received > paid)
      rowIssues.add('refund_exceeds_debit');

    for (const code of rowIssues) issues.push({ code, orderId, ...(walletId && { walletId }) });
    orderRows.push({
      orderId, walletId, currency: 'USD', paid: format(paid),
      allocated: format(appleAmountUnits(allocation?.amount)),
      movementDebit: debitComplete ? format(matchingDebit) : null, debitEvidence,
      walletChainVerified: verifiedWallets.has(walletId),
      received: refundComplete ? format(received) : null, pending: refundComplete ? format(pending) : null,
      movementIds: evidenceIds(movements), refundIds: evidenceIds(refunds), issues: [...rowIssues]
    });
  }

  return { coverage, counts: { wallets: wallets.length, orders: orderRows.length, issueCount: issues.length },
    issues, wallets, orders: orderRows };
}
