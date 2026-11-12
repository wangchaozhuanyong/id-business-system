import { automaticGptOrder, orderOpeningConfirmed, rechargeOrderOwner, subscriptionChainRoot, subscriptionTime, validOrderEmail } from '../frontend/order-opening.mjs';
import { accountMarkedDead, releasedAccountOrders } from './account-lifecycle.mjs';

export const renewalExpiryIssue = '续费到期时间待核对';
export const renewalAssociationIssue = '续费归属待核对';
const hour = 3_600_000;
const emailKey = value => validOrderEmail(value) ? value.trim().toLowerCase() : '';
const closed = order => order.cancelled || order.subscriptionEnded || ['cancelled', '已撤单'].includes(order.status);

// Called inside the import transaction with the current orders and inventory.
export function matchRechargeRenewal(order, commerce, inventory, legacyOpened = []) {
  const email = emailKey(order.email);
  const completed = subscriptionTime(order.rechargeCompletedAt);
  if (!automaticGptOrder(order) || order.entitlementStatus !== 'active' ||
      !email || !order.plan || !Number.isFinite(completed) || closed(order))
    return { kind: 'none' };
  const orders = commerce.orders || [];
  const accounts = (inventory?.accounts || []).filter(account => account.type === 'gpt' && emailKey(account.email) === email);
  const released = new Set(accounts.flatMap(account => [...releasedAccountOrders(account)]));
  const periods = orders.filter(row => row.id !== order.id && row.product === 'GPT' &&
    emailKey(row.email) === email && !closed(row) && !released.has(row.id) &&
    orderOpeningConfirmed(row, completed, legacyOpened.includes(row.id)));
  const deadline = completed + (commerce.renewalWarningHours ?? (commerce.renewalWarningDays ?? 3) * 24) * hour;
  const due = periods.filter(row => {
    const start = subscriptionTime(row.start), expiry = subscriptionTime(row.expiry);
    return start <= completed && expiry > start && expiry <= deadline;
  });
  if (!due.length) return { kind: 'none' };
  const review = { kind: 'review' };
  const byId = new Map(orders.map(row => [row.id, row]));
  const customers = new Set(periods.map(row => row.customerId).filter(Boolean));
  const accountIds = new Set(periods.map(row => row.accountId).filter(Boolean));
  const chainKeys = new Set(periods.filter(row => row.customerId).map(row => {
    const root = subscriptionChainRoot(row, byId);
    return root.subscriptionAnchor || root.customerId;
  }));
  const [customerId] = customers;
  const customer = commerce.customers?.find(row => row.id === customerId && row.active !== false);
  if (customers.size !== 1 || accountIds.size > 1 || chainKeys.size > 1 || accounts.length > 1 ||
      (order.customerId && order.customerId !== customerId) ||
      !customer ||
      accounts.some(account => accountMarkedDead(account) || ['recovered', 'retired'].includes(account.accountLifecycle?.disposition) ||
        (account.accountLifecycle?.customerId && account.accountLifecycle.customerId !== customerId)))
    return review;
  const [prior, second] = due.sort((a, b) => subscriptionTime(b.expiry) - subscriptionTime(a.expiry) ||
    subscriptionTime(b.start) - subscriptionTime(a.start));
  const owner = rechargeOrderOwner(order);
  const previousOwner = automaticGptOrder(prior) ? rechargeOrderOwner(prior) : customer.ownerId || prior.ownerId;
  if (prior.customerId !== customerId || prior.plan !== order.plan ||
      (owner && previousOwner && owner !== previousOwner) ||
      (second && subscriptionTime(second.expiry) === subscriptionTime(prior.expiry) &&
        subscriptionTime(second.start) === subscriptionTime(prior.start)))
    return review;
  if (periods.some(row => row !== prior && (row.previousOrderId === prior.id ||
      (subscriptionTime(row.start) >= subscriptionTime(prior.start) &&
        (!Number.isFinite(subscriptionTime(row.expiry)) || subscriptionTime(row.expiry) > subscriptionTime(prior.expiry))))))
    return review;
  return { kind: 'matched', prior };
}
