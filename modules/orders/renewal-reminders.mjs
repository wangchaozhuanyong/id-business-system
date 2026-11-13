import { rechargeRenewalExpiryPending, subscriptionChainRoot, subscriptionTime, validOrderEmail, validOrderXHandle } from './order-opening.mjs';

const orderContactFields = [
  ['customerPhone', 'phone'], ['wechat', 'wechat'], ['qq', 'qq'],
  ['whatsapp', 'whatsapp'], ['telegram', 'telegram']
];
const supportedProducts = new Set(['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']);
const personalProduct = product => product === 'Gemini' || product === 'Grok';
const personalSeries = (product, plan) => product === 'Gemini' ? 'google_ai'
  : plan?.startsWith('The X Subscription ') ? 'x_subscription'
    : plan?.startsWith('SuperGrok') ? 'supergrok' : 'x_premium';
const isClaude = order => String(order?.product || '').startsWith('Claude');
const orderIdentity = order => personalProduct(order?.product)
  ? order.loginMethod === 'x' && order.xHandle ? order.xHandle : order.email || order.xHandle || ''
  : order?.email || '';

export function contactKey(text, channel) {
  const normalized = String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (channel === 'telegram') return normalized.replace(/^@/, '');
  if ((channel === 'phone' || channel === 'whatsapp') && /^\+?[\d\s().-]+$/.test(normalized))
    return normalized.replace(/[\s().-]/g, '');
  return normalized;
}

function orderContactKeys(record, order = true) {
  return orderContactFields.flatMap(([orderField, customerField]) => {
    const contact = contactKey(record[order ? orderField : customerField], customerField);
    return contact ? [`${customerField}:${contact}`] : [];
  });
}

export function subscriptionFamily(order) {
  if (personalProduct(order.product)) return order.product + ':' + personalSeries(order.product, order.plan);
  return isClaude(order) ? 'Claude' : order.product;
}
export function subscriptionEmail(order) {
  const target = orderIdentity(order);
  return (validOrderEmail(target) || (order.product === 'Grok' && validOrderXHandle(target)))
    ? target.trim().toLowerCase() : '';
}
export function sameSubscriptionAccount(a, b, requireFamily = true) {
  return Boolean(subscriptionEmail(a)) && subscriptionEmail(a) === subscriptionEmail(b) &&
    (requireFamily ? subscriptionFamily(a) === subscriptionFamily(b) : a.product === b.product) &&
    (!personalProduct(a.product) || !a.platformAccountId || !b.platformAccountId || a.platformAccountId === b.platformAccountId);
}

export function orderCustomerContacts(orders, customers, knownCustomers) {
  const byContact = new Map();
  const index = (keys, id) => {
    for (const key of keys) {
      if (!byContact.has(key)) byContact.set(key, new Set());
      byContact.get(key).add(id);
    }
  };
  for (const row of customers) index(orderContactKeys(row, false), row.id);
  for (const row of orders)
    if (row.customerId && (!knownCustomers || knownCustomers.has(row.customerId)))
      index(orderContactKeys(row), row.customerId);
  return byContact;
}
export function customersMatchingContacts(order, byContact) {
  return new Set(orderContactKeys(order).flatMap(key => [...(byContact.get(key) || [])]));
}
export function identifyOrderCustomers(orders, customers) {
  let byContact;

  const identities = new Map(), anonymous = new Map();
  for (const row of orders) {
    if (row.customerId) {
      identities.set(row.id, row.customerId);
      continue;
    }
    const keys = orderContactKeys(row);
    const matches = customersMatchingContacts(row, byContact ??= orderCustomerContacts(orders, customers));
    if (matches.size === 1) {
      identities.set(row.id, [...matches][0]);
    } else if (!matches.size && keys.length) {
      const groups = new Set(keys.map((key) => anonymous.get(key)).filter(Boolean));
      const group = groups.values().next().value || { id: `contact:${row.id}`, keys: new Set(), orders: [] };
      for (const other of groups) {
        if (other === group) continue;
        for (const key of other.keys) group.keys.add(key);
        group.orders.push(...other.orders);
      }
      for (const key of keys) group.keys.add(key);
      group.orders.push(row.id);
      for (const key of group.keys) anonymous.set(key, group);
    }
  }
  for (const group of new Set(anonymous.values()))
    for (const id of group.orders) identities.set(id, group.id);
  return identities;
}

export function confirmedRenewalOrders(orders, at, hasOpeningEvidence) {
  return orders.flatMap((order) => {
    const start = subscriptionTime(order.start), expiry = subscriptionTime(order.expiry);
    if (!supportedProducts.has(order.product) || !Number.isFinite(start) || !(expiry > start) ||
        !hasOpeningEvidence(order, at)) return [];
    return [{ order, start, expiry }];
  });
}

export function renewalProjection({ orders, customers, logs, renewalWarningHours, evaluatedAt, hasOpeningEvidence, endedInventoryOrder }) {
  const identities = identifyOrderCustomers(orders, customers);
  const deadline = evaluatedAt + renewalWarningHours * 3_600_000;
  const orderIndex = new Map(orders.map(order => [order.id, order]));
  const rows = confirmedRenewalOrders(orders, evaluatedAt, hasOpeningEvidence).map((row) => {
    const { order } = row;
    const identity = identities.get(order.id);
    return { ...row, identity, subscription: renewalSubscriptionKey(order, identity, orderIndex) };
  });
  const latest = new Map();
  for (const row of rows) {
    if (row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order)) continue;
    const prior = latest.get(row.subscription);
    if (!prior || row.expiry > prior.expiry || (row.expiry === prior.expiry && row.start > prior.start))
      latest.set(row.subscription, row);
  }
  const decisions = new Map(), links = new Map();
  for (const entry of logs) {
    if (['拒续费', '恢复续费提醒'].includes(entry.type) && !decisions.has(entry.entityId))
      decisions.set(entry.entityId, entry);
    if (entry.type === '关联续费订单') {
      if (!links.has(entry.entityId)) links.set(entry.entityId, []);
      links.get(entry.entityId).push(entry.relatedOrderId);
    }
  }
  const byId = new Map(rows.map((row) => [row.order.id, row]));
  const verifiedRenewals = new Map();
  for (const order of orders) {
    if (!rechargeRenewalExpiryPending(order) || endedInventoryOrder(order)) continue;
    const prior = byId.get(order.previousOrderId);
    if (prior && order.customerId && order.customerId === prior.order.customerId &&
        sameSubscriptionAccount(order, prior.order) && subscriptionTime(order.rechargeCompletedAt) <= evaluatedAt)
      verifiedRenewals.set(prior.order.id, order);
  }
  const reminders = [];
  for (const row of rows) {
    if (row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order) || row.start > evaluatedAt) continue;
    const isSuccessor = (candidate) => candidate && candidate !== row && !candidate.order.cancelled &&
      !candidate.order.subscriptionEnded && candidate.expiry > row.expiry && candidate.start >= row.start;
    const automatic = latest.get(row.subscription);
    const successor = isSuccessor(automatic) ? automatic : links.get(row.order.id)?.map((id) => byId.get(id))
      .find((candidate) => isSuccessor(candidate) && candidate.subscription === row.subscription &&
        (!row.identity || row.identity === candidate.identity));
    const decision = decisions.get(row.order.id);
    const refused = decision?.type === '拒续费';
    const completed = successor?.order || verifiedRenewals.get(row.order.id);
    const state = completed || refused ? 'processed' :
      row.expiry <= evaluatedAt ? 'expired' : row.expiry <= deadline ? 'upcoming' : '';
    if (state) reminders.push({ ...row, state, refused: !completed && refused,
      completed: completed || null, decision });
  }
  return { reminders, rows, latest, identities, evaluatedAt, deadline };
}
export function renewalSubscriptionKey(order, identity, byId) {
  const root = subscriptionChainRoot(order, byId);
  const account = subscriptionEmail(root);
  return root.subscriptionAnchor || (identity && account
    ? JSON.stringify([identity, subscriptionFamily(root), account]) : root.id);
}
