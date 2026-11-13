import { randomUUID } from 'node:crypto';

export const tenantCardLimit = 99;
export function tenantCardNumber(value) {
  const number = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
  return /^\d{12,19}$/.test(number) ? number : '';
}

export class TenantCardError extends Error {
  constructor(status, message, matches = []) {
    super(message);
    this.status = status;
    this.matches = matches;
  }
}

export function tenantCardMatches(number, cards, commerce, excludeOrderId = '', archive) {
  if (!number) return [];
  const last4 = number.slice(-4);
  const matches = cards.filter(card => tenantCardNumber(card.number) === number).map(card => ({
    cardId: card.id, tenantId: card.tenantId,
    tenantName: commerce?.tenants?.find(tenant => tenant.id === card.tenantId)?.name || '', last4
  }));
  if (matches.length) return matches;
  const order = (commerce?.orders || []).find(row => row.id !== excludeOrderId && orderBankSnapshots(row)
    .some(snapshot => snapshot.payment === '银行卡' &&
      [snapshot.proCardNumber, archive?.cards?.[snapshot.cardId]?.number].some(value => tenantCardNumber(value) === number)));
  return order ? [{ orderId: order.id, orderNo: order.orderNo || order.id, last4 }] : [];
}

export function duplicateTenantCard(matches) {
  return new TenantCardError(409, '已有此银行卡号，不能重复登记', matches);
}

export function stageOrderTenantCard(order, cards, commerce, previous, archive) {
  const number = tenantCardNumber(order.tenantCardNumber);
  delete order.tenantCardNumber;
  if (order.payment !== '银行卡' || order.proMaterialMode !== 'tenant_card' ||
      !['Claude Pro', 'Claude Max'].includes(order.product) || !number)
    throw new TenantCardError(400, '请输入完整的租户银行卡号');
  const matches = tenantCardMatches(number, cards, { ...commerce, orders: previous?.orders }, order.id, archive);
  const chosen = order.cardId ? matches.find(match => match.cardId === order.cardId) : matches.length === 1 ? matches[0] : null;
  if (matches.length && !chosen?.cardId) {
    const message = matches.length > 1 ? '该卡号有多条历史记录，请先核对并选卡' : '银行卡号与所选银行卡不一致，或已在原订单使用';
    throw new TenantCardError(409, message, matches);
  }
  if (chosen) {
    if (order.tenantId && order.tenantId !== chosen.tenantId)
      throw new TenantCardError(409, '该银行卡属于其他租户，请核对后再提交', matches);
    order.tenantId = chosen.tenantId;
    order.cardId = chosen.cardId;
    return;
  }
  if (order.cardId) throw new TenantCardError(409, '银行卡号与所选银行卡不一致，请重新核对');
  if (!(commerce.tenants || []).some(tenant => tenant.id === order.tenantId && tenant.active !== false))
    throw new TenantCardError(400, '请为这张新银行卡选择在用租户');
  const count = cards.filter(card => card.tenantId === order.tenantId).length;
  if (count >= tenantCardLimit) throw new TenantCardError(409, '该租户已达 99 张银行卡上限');
  order.cardId = 'tenant:' + randomUUID();
  cards.push({ id: order.cardId, tenantId: order.tenantId, number, label: `银行卡 ${count + 1}`, active: true });
}

export function stageInitialTenantCards(previous, next, existing = [], makeId = () => 'tenant:' + randomUUID(), archive) {
  const prior = new Set((previous?.tenants || []).map(row => row.id));
  const additions = [], targets = [];
  const seen = new Set(existing.map(row => tenantCardNumber(row.number)));
  for (const tenant of next?.tenants || []) {
    if (!Object.hasOwn(tenant, 'initialCards')) continue;
    if (prior.has(tenant.id)) throw new Error('已有租户请通过银行卡管理添加银行卡');
    if (!Array.isArray(tenant.initialCards) || tenant.initialCards.length > tenantCardLimit)
      throw new Error('每位租户最多登记 99 张银行卡');
    for (const [index, item] of tenant.initialCards.entries()) {
      const number = tenantCardNumber(item?.number);
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      if (!item || Object.keys(item).some(key => !['number', 'label'].includes(key)) ||
          (item.number != null && typeof item.number !== 'string') ||
          (item.label != null && typeof item.label !== 'string') ||
          label.length > 80 || /[\x00-\x1f\x7f]/.test(label))
        throw new Error(`第 ${index + 1} 张银行卡格式不正确`);
      if (!label && !item.number?.trim()) continue;
      if (!number)
        throw new Error(`第 ${index + 1} 张银行卡格式不正确`);
      const matches = tenantCardMatches(number, existing, { ...previous, tenants: next.tenants }, '', archive);
      if (seen.has(number) || matches.length) throw duplicateTenantCard(matches);
      seen.add(number);
      additions.push({ id: makeId(), tenantId: tenant.id, number, label: label || `银行卡 ${index + 1}`, active: true });
    }
    targets.push(tenant);
  }
  for (const tenant of targets) delete tenant.initialCards;
  return { additions, targets: targets.map(row => row.id) };
}

function indexCards(cards) {
  const byId = new Map(), numbers = new Set();
  for (const card of cards) {
    const number = tenantCardNumber(card.number);
    if (!number) continue;
    byId.set(card.id, number);
    numbers.add(number);
  }
  return { byId, numbers };
}

function orderBankSnapshots(order) {
  const corrections = Array.isArray(order.corrections) ? order.corrections : [];
  return [order, ...corrections.map(entry => entry?.previous).filter(Boolean)];
}

function orderCardNumbers(order, { byId, numbers }, archive) {
  const used = new Set();
  for (const row of orderBankSnapshots(order)) {
    if (row.payment === '银行卡') {
      const number = byId.get(row.cardId) || tenantCardNumber(row.proCardNumber) ||
        tenantCardNumber(archive?.cards?.[row.cardId]?.number);
      if (numbers.has(number)) used.add(number);
    }
    for (const entry of Array.isArray(row.financialEvidence) ? row.financialEvidence : []) {
      const number = entry?.kind === 'payment' && byId.get(entry.cardId);
      if (number) used.add(number);
    }
  }
  return used;
}

function useRecord(order) {
  return { orderId: order.id, orderNo: order.orderNo || order.id, at: order.cardUsedAt || order.createdAt || '' };
}

function recordedUses(cards, orders, index, archive) {
  const uses = new Map();
  const remember = (number, use) => {
    if (!number || !use?.orderId) return;
    if (!uses.has(number)) uses.set(number, new Map());
    if (!uses.get(number).has(use.orderId)) uses.get(number).set(use.orderId, use);
  };
  for (const card of cards) remember(index.byId.get(card.id), card.firstUse);
  for (const order of orders) {
    for (const number of orderCardNumbers(order, index, archive)) remember(number, useRecord(order));
  }
  return { uses, remember };
}

export function tenantCardUseHistory(cards, orders, archive) {
  const index = indexCards(cards);
  const { uses } = recordedUses(cards, orders, index, archive);
  return new Map(cards.map(card => [card.id, uses.get(index.byId.get(card.id))?.values().next().value]));
}

// Keep the first use in the existing encrypted card document, even if an order is corrected.
export function stageTenantCardUses(cards, previousOrders, nextOrders, at, archive) {
  if (!cards.length) return cards;
  const index = indexCards(cards);
  const { uses, remember } = recordedUses(cards, previousOrders, index, archive);
  for (const order of nextOrders) {
    for (const number of orderCardNumbers(order, index, archive)) {
      const prior = uses.get(number);
      if (prior?.has(order.id)) continue;
      if (prior?.size) throw new Error('此租户银行卡已经使用过，请选择未使用的银行卡');
      remember(number, { ...useRecord(order), at });
    }
  }
  return cards.map(card => {
    const firstUse = card.firstUse || uses.get(index.byId.get(card.id))?.values().next().value;
    return firstUse && !card.firstUse ? { ...card, firstUse } : card;
  });
}
