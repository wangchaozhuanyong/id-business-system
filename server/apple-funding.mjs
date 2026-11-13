import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  appleRegion, appleAmountUnits, appleFundingIndex, appleFundingEligibility, appleTarget
} from '../modules/finance/apple-funding.mjs';
import { orderFieldChanged } from '../modules/orders/order-opening.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';

export const emptyAppleLedger = () => ({ wallets: [], allocations: [], movements: [], refunds: [] });

// A paid handoff already owns a debit, even before staff finish its order.
// The eventual order uses this same id; these references are never new sales.
export function pendingRenewalPayments(items = [], orders = []) {
  const existing = new Set(orders.map(order => order.id));
  return (Array.isArray(items) ? items : []).filter(row => row.status === 'paid' && row.funding?.ledgerPosted === true &&
    row.paidSource?.id === row.order?.id && !existing.has('order-' + row.id)).map(row => ({
    id: 'order-' + row.id, source: '管理员手工', payment: '苹果内购', paidConfirmed: true,
    paidAmount: row.funding.amount, paidCurrency: row.funding.currency, appleIdId: row.funding.appleIdId,
    email: row.paidSource.email || '', customerId: row.paidSource.customerId, refunds: [],
    renewalHandoffId: row.id
  }));
}

export function renewalLedgerCommerce(commerce, items) {
  const orders = commerce?.orders || [];
  return { ...commerce, orders: [...orders, ...pendingRenewalPayments(items, orders)] };
}

export function validApplePaidPrices(prices, plans) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  return object(prices) && Object.entries(prices).every(([product, rows]) =>
    Object.hasOwn(plans, product) && object(rows) && Object.entries(rows).every(([plan, regions]) =>
      plans[product].includes(plan) && object(regions) && Object.entries(regions).every(([region, amount]) =>
        appleRegion(region) && (amount === '' || appleAmountUnits(amount) > 0n))));
}

export function stageAppleOpenings(previous, next, ledger, actor, now = new Date(), orders = []) {
  const before = new Map((previous?.mailboxes || []).filter(row => row.type === 'apple').map(row => [row.id, row]));
  const nextLedger = structuredClone(ledger || emptyAppleLedger());
  let changed = false;
  const funding = appleFundingIndex(orders, nextLedger);
  const retainedIds = new Set((next?.mailboxes || []).filter(row => row.type === 'apple' && !row.deleted).map(row => row.id));
  for (const [id, state] of funding.byWallet) {
    if (before.has(id) && !before.get(id).deleted && !retainedIds.has(id) && (state.used || state.pending.length))
      return { error: '苹果 ID 已有付款占用或绑定，必须保留原资料' };
  }
  for (const row of next?.mailboxes || []) {
    if (row.type !== 'apple') {
      if ('appleOpeningBalance' in row || 'appStoreRegion' in row) return { error: 'Id地区和期初余额仅用于苹果 ID' };
      continue;
    }
    const original = before.get(row.id);
    if (original && row.email !== original.email) return { error: '已有苹果 ID 的账号邮箱不能更改' };
    if (row.appStoreRegion !== undefined && row.appStoreRegion !== null && row.appStoreRegion !== '' && !appleRegion(row.appStoreRegion)) return { error: '请选择有效的 Id地区' };
    if (original?.appStoreRegion && original.appStoreRegion !== row.appStoreRegion &&
        (funding.byWallet.get(row.id)?.used || funding.byWallet.get(row.id)?.pending.length))
      return { error: '已有内购使用记录，不能更改 Id地区' };
    if (!Object.hasOwn(row, 'appleOpeningBalance')) continue;
    const amount = row.appleOpeningBalance;
    if (original || !appleRegion(row.appStoreRegion) || appleAmountUnits(amount) === null ||
        nextLedger.wallets.some(wallet => wallet.id === row.id))
      return { error: '期初余额只能在新增苹果 ID 时登记，请核对 Id地区和金额' };
    delete row.appleOpeningBalance;
    const positive = appleAmountUnits(amount) > 0n;
    nextLedger.wallets.push({ id: row.id, balance: amount, currency: 'USD', version: positive ? 2 : 1 });
    if (positive) nextLedger.movements.push({
      id: randomUUID(), appleIdId: row.id, kind: 'opening', label: '期初余额',
      amount, before: '0', after: amount, versionAfter: 2, orderId: '', orderNo: '',
      reason: '录入时核对的实际余额', actor: actor.name, actorId: actor.id,
      at: toV2DateTimeInput(now).replace('T', ' ')
    });
    changed = true;
  }
  return { ledger: nextLedger, changed };
}

const usesApple = order => order?.payment === '苹果内购' && Boolean(order.appleIdId);
const isDraft = order => order?.draft || ['draft', '草稿'].includes(order?.status);
const sameAppleTarget = (a, b) => appleTarget(a) === appleTarget(b) &&
  (!a.platformAccountId || a.platformAccountId === b.platformAccountId);

export function stageConfirmedRenewalDebit(ledger, order, payer, at) {
  if (!usesApple(order)) return null;
  const data = structuredClone(ledger || emptyAppleLedger());
  if (data.allocations.some(row => row.orderId === order.id) || data.movements.some(row => row.orderId === order.id))
    throw Object.assign(new Error('本次续费付款已有记录，请刷新后核对'), { status: 409 });
  const wallet = data.wallets.find(row => row.id === order.appleIdId);
  const before = appleAmountUnits(wallet?.balance), paid = appleAmountUnits(order.paidAmount);
  if (!wallet || wallet.currency !== 'USD' || before === null || paid === null || paid <= 0n || before < paid)
    throw Object.assign(new Error('原苹果 ID 余额待核对，请联系财务'), { status: 409 });
  const priorBalance = wallet.balance;
  const remaining = (before - paid).toString().padStart(5, '0');
  wallet.balance = remaining.slice(0, -4) + '.' + remaining.slice(-4);
  wallet.version++;
  data.allocations.push({ orderId: order.id, appleIdId: wallet.id, amount: order.paidAmount, returned: '0',
    version: 1, email: order.email });
  data.movements.push({ id: randomUUID(), appleIdId: wallet.id, orderId: order.id, kind: 'order-charge',
    label: '续费内购扣款', amount: '-' + order.paidAmount, before: priorBalance, after: wallet.balance,
    versionAfter: wallet.version, actor: payer.name, actorId: payer.id, at: toV2DateTimeInput(at).replace('T', ' ') });
  return data;
}

function conflictsWithAppleBinding(order, other) {
  if (other.id === order.id || !other.appleIdId || !usesApple(other)) return false;
  const bound = other.appleFunding?.bound || other.paidConfirmed;
  const reserved = !isDraft(other) && (!other.cancelled ||
    other.cancellationEvents?.at(-1)?.appleUnpaidConfirmed !== true);
  if (!bound && !reserved) return false;
  const sameTarget = appleTarget(other) === appleTarget(order);
  return other.appleIdId === order.appleIdId
    ? !sameTarget || Boolean(other.customerId && other.customerId !== order.customerId) : sameTarget;
}

export function stageAppleOrderFunding(previous, next, ledger, inventory, settings, action, customers, completedCustomerOrders, paidRenewalId, postedRenewalId) {
  const prior = new Map((previous || []).map(row => [row.id, row]));
  const staged = new Map(prior);
  const nextIds = new Set((next || []).map(row => row.id));
  const customerIds = customers && new Set(customers.map(row => row.id));
  if (nextIds.size !== (next || []).length) return '订单编号重复，请刷新核对';
  for (const row of prior.values()) {
    if (usesApple(row) && !nextIds.has(row.id) && ((!row.cancelled && !isDraft(row)) || row.appleFunding?.bound || row.paidConfirmed))
      return '已有苹果 ID 占用或绑定，必须保留原订单';
  }
  const assets = new Map((inventory?.mailboxes || []).filter(row => row.type === 'apple').map(row => [row.id, row]));
  const wallets = new Map((ledger?.wallets || []).map(row => [row.id, row]));
  for (const order of next || []) {
    const old = prior.get(order.id);
    if (old?.appleFunding) order.appleFunding = old.appleFunding;
    else delete order.appleFunding;
    if (isDeepStrictEqual(old, order)) continue;
    if (!usesApple(order) && !usesApple(old)) continue;
    const buyerCompleted = completedCustomerOrders?.has(order.id) && !old?.customerId && customerIds?.has(order.customerId);
    if (buyerCompleted && orderFieldChanged(order, old, 'payment', 'appleIdId', 'paidConfirmed'))
      return '补登记客户时请保留原付款方式、Apple ID 和付款状态';
    const unchangedPaymentTarget = old && usesApple(order) && old.appleIdId === order.appleIdId &&
      sameAppleTarget(old, order) && ((old.customerId ?? '') === (order.customerId ?? '') || buyerCompleted);
    if (buyerCompleted && unchangedPaymentTarget && [previous, next].some(orders =>
      (orders || []).some(other => conflictsWithAppleBinding(order, other))))
      return '该 Apple ID 或订阅账号已有其他绑定，请核对原付款记录';
    const used = usesApple(old) && (old.paidConfirmed || old.appleFunding?.bound);
    if (used) {
      if (!unchangedPaymentTarget || (old.appleStoreRegion && old.appleStoreRegion !== order.appleStoreRegion))
        return '已使用的苹果 ID 和订阅账号绑定不能改写';
      if (!order.appleFunding && old.paidConfirmed && !order.paidConfirmed)
        order.appleFunding = { region: old.appleStoreRegion || assets.get(old.appleIdId)?.appStoreRegion || '', expected: '', bound: true };
      staged.set(order.id, order);
      continue;
    }
    const wasReserved = usesApple(old) && !old.cancelled && !isDraft(old);
    if (wasReserved && (!unchangedPaymentTarget || old.plan !== order.plan ||
        (old.appleStoreRegion && order.appleStoreRegion !== old.appleStoreRegion)))
      return '待付款苹果 ID 已占用，请先确认未付款并取消原订单';
    if (order.cancelled) {
      if (order.paidConfirmed) return '请先恢复并核对原订单，再确认实际付款';
      const cancellation = order.cancellationEvents?.at(-1);
      if (wasReserved && (action !== '业务撤单' || order.cancellationEvents?.length !== (old.cancellationEvents?.length || 0) + 1 ||
          cancellation?.action !== '业务撤单' || !String(cancellation.reason || '').trim() ||
          cancellation.appleUnpaidConfirmed !== true ||
          !isDeepStrictEqual(order.cancellationEvents.slice(0, -1), old.cancellationEvents || [])))
        return '释放苹果 ID 前须确认这笔订单未付款';
      staged.set(order.id, order);
      continue;
    }
    if (!usesApple(order)) continue;
    if (order.id === postedRenewalId && order.paidConfirmed) {
      const allocation = ledger?.allocations?.find(row => row.orderId === order.id);
      if (order.paidCurrency !== 'USD' || allocation?.appleIdId !== order.appleIdId ||
          appleAmountUnits(allocation.amount) !== appleAmountUnits(order.paidAmount))
        return '续费实付与已登记的 Apple 扣款不一致';
      order.appleFunding = { region: order.appleStoreRegion, expected: order.paidAmount, bound: true };
      staged.set(order.id, order);
      continue;
    }
    if (isDraft(order)) {
      if (wasReserved || order.paidConfirmed) return '已占用的苹果 ID 不能转回草稿';
      continue;
    }
    if (wasReserved && !order.paidConfirmed && !old.customerId && (!order.customerId || buyerCompleted) &&
        !orderFieldChanged(order, old, 'paidAmount', 'paidCurrency', 'appleStoreRegion')) {
      staged.set(order.id, order);
      continue;
    }
    if (customerIds && !customerIds.has(order.customerId)) return '请核对苹果内购订单的实际客户';
    // Old pending orders without a resource configuration remain readable. A newly
    // selected resource or payment confirmation always goes through the new checks.
    if (wasReserved && !order.paidConfirmed && !old.appleFunding &&
        !order.appleStoreRegion && !assets.get(order.appleIdId)?.appStoreRegion) continue;
    if (wasReserved && !order.paidConfirmed && old.appleFunding && old.paidAmount === order.paidAmount) {
      staged.set(order.id, order);
      continue;
    }
    const asset = assets.get(order.appleIdId);
    const balance = wallets.get(order.appleIdId);
    const wallet = asset && balance ? { id: asset.id, balance: balance.balance, currency: balance.currency,
      status: asset.status, health: asset.health, deleted: asset.deleted, appStoreRegion: asset.appStoreRegion } : null;
    const index = appleFundingIndex([...staged.values()].filter(item => item.id !== order.id), ledger);
    const check = appleFundingEligibility(wallet, order, index, settings, {
      actual: Boolean((wasReserved || order.id === paidRenewalId) && order.paidConfirmed),
      quotedPrice: wasReserved ? old.appleFunding?.expected : ''
    });
    if (check.error) return check.error;
    if (order.paidConfirmed) {
      const actual = appleAmountUnits(order.paidAmount);
      if (order.paidCurrency !== 'USD' || actual === null || actual <= 0n || actual > check.balance)
        return '请核对已确认的苹果内购实付金额及美元余额';
    }
    order.appleStoreRegion = check.region;
    order.appleFunding = {
      region: check.region, expected: old?.appleFunding?.expected || check.expected, bound: order.paidConfirmed === true
    };
    staged.set(order.id, order);
  }
}
