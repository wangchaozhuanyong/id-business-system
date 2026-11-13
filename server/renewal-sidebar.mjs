import { orderOpeningConfirmed, subscriptionTime } from '../modules/orders/order-opening.mjs';
import { renewalProjection } from '../modules/orders/renewal-reminders.mjs';
import { releasedSubscriptionOrderIds } from './account-lifecycle.mjs';
import { legacyOpeningOrderIds, subscriptionDomain } from './subscription-management.mjs';

export function renewalSidebar(store, at = Date.now()) {
  const { data } = store.load('commerce');
  const orderDocument = data || {};
  const { orders = [], customers = [], logs = [], renewalWarningDays, renewalWarningHours =
    renewalWarningDays == null ? 72 : renewalWarningDays * 24 } = orderDocument;
  const released = releasedSubscriptionOrderIds(store.load('inventory').data, orderDocument);
  const legacy = new Set(legacyOpeningOrderIds(orders, store.featureDocument(subscriptionDomain).data));
  const { reminders } = renewalProjection({
    orders, customers, logs, renewalWarningHours, evaluatedAt: at,
    hasOpeningEvidence: order => orderOpeningConfirmed(order, at, legacy.has(order.id)),
    endedInventoryOrder: order => released.has(order.id)
  });
  let nextAt = Infinity;
  for (const order of orders) {
    if (order.cancelled || order.subscriptionEnded || released.has(order.id)) continue;
    for (const transition of [subscriptionTime(order.start), subscriptionTime(order.rechargeCompletedAt),
      subscriptionTime(order.expiry) - renewalWarningHours * 3_600_000]) {
      if (transition > at && transition < nextAt) nextAt = transition;
    }
  }
  return { count: reminders.filter(row => row.state !== 'processed').length, nextAt: Number.isFinite(nextAt) ? nextAt : null };
}
