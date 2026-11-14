import { isDeepStrictEqual } from 'node:util';
import { hasConfirmedMoney } from './local-business-integrity.mjs';
import { historicalFeeAction, historicalFeeKind } from './finance/snapshot-integrity.mjs';
import { orderCustomerCreateAction } from '../modules/orders/order-opening.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';

const creation = new Set(['新增独立订单', orderCustomerCreateAction]);
const correction = '更正订单';
const compensation = '补偿撤回更正';
const cancel = '业务撤单';
const restore = '恢复业务订单';
const changes = new Set([correction, historicalFeeAction]);
const trackedActions = new Set([...creation, ...changes, compensation, cancel, restore, '退款登记', '银行卡回款登记']);
const orderReversalActions = new Set([compensation, cancel, restore]);
export const isOrderReversalAction = action => orderReversalActions.has(action);

const list = value => Array.isArray(value) ? value : [];
const validEventId = id => typeof id === 'string' && id.length > 0 && id.length <= 256;
const latest = (row, key) => list(row?.[key]).at(-1);
const isAppend = (before, after) => {
  const prior = list(before), rows = list(after), event = rows.at(-1);
  return rows.length === prior.length + 1 && validEventId(event?.id) &&
    !prior.some(row => row.id === event.id) && isDeepStrictEqual(prior, rows.slice(0, -1));
};
const allReferences = ['previousOrderId', 'claudeRenewalId', 'proRenewalSourceId', 'previousSubscriptionOrderId'];

function hasOrderRecoveryDependent(orderId, orders, handoffs) {
  return orders.some(row => row.id !== orderId && allReferences.some(field => row[field] === orderId)) ||
    list(handoffs).some(row => row.status !== 'returned' && row.order?.id === orderId);
}

function orderRecoveryBlock(order, mode, orders, handoffs) {
  if (order.taskId || order.taskEvidenceId || order.source === '线上代充') return '已有充值任务，请先从原任务核对处理结果。';
  if (['running', 'processing', 'payment_unknown'].includes(order.status) || order.paymentStatus === 'unknown')
    return '订单仍在处理中或付款结果待核对。';
  if (hasOrderRecoveryDependent(order.id, orders, handoffs)) return '已有后续订单或续费申请，请到原单核对。';
  if (mode === 'undo') return order.cancelled ? '订单已撤单，请先核对当前业务状态。' : '';
  if (hasConfirmedMoney(order) || list(order.refunds).length || list(order.bankReturns).length)
    return '已有付款、实收、退款或回款记录，请从原单或财务入口核对。';
  return '';
}

export function captureOrderAudit(previous, next, action) {
  if (!trackedActions.has(action)) return;
  const prior = new Map(list(previous?.orders).map(row => [row.id, row]));
  const orders = list(next.orders);
  const diff = orders.filter(row => !isDeepStrictEqual(prior.get(row.id), row));
  if (diff.length !== 1 || orders.length !== prior.size + Number(creation.has(action))) return;
  const [row] = diff;
  const before = prior.get(row.id);
  if (!validEventId(row.id) || !Number.isSafeInteger(row.version) || row.version < 1 ||
      (creation.has(action) ? before : !before || row.version !== (before.version ?? 0) + 1)) return;
  let eventId;
  if (changes.has(action)) {
    const change = latest(row, 'corrections');
    if (!isAppend(before.corrections, row.corrections) || change?.versionAfter !== row.version) return;
    eventId = change.id;
  } else if (action === compensation || action === cancel || action === restore) {
    const field = action === compensation ? 'compensations' : 'cancellationEvents';
    if (!isAppend(before[field], row[field])) return;
    eventId = latest(row, field).id;
  } else if (action === '退款登记' || action === '银行卡回款登记') {
    const field = action === '退款登记' ? 'refunds' : 'bankReturns';
    if (!isAppend(before[field], row[field])) return;
    eventId = latest(row, field).id;
  }
  return { targetId: row.id, recoveryKind: 'order', targetVersion: row.version,
    ...(typeof row.orderNo === 'string' && /^[A-Za-z\d_-]{1,60}$/.test(row.orderNo) && { orderNo: row.orderNo }),
    ...(eventId && { eventId }) };
}

export function orderAuditDecision(audit, order, orders, handoffs) {
  if (!order) return { message: '原订单已不存在或编号有冲突。' };
  if (audit.action === compensation || audit.action === restore)
    return { message: '此笔业务处理已经记录，请查看原单历史。' };
  if (audit.action === '退款登记' || audit.action === '银行卡回款登记')
    return { message: '资金记录请在原订单的退款与回款记录中核对。' };
  if (audit.action === historicalFeeAction)
    return { message: '历史费率更正请在原订单的成本与汇率中核对。' };
  const mode = creation.has(audit.action) ? 'cancel' : audit.action === cancel ? 'restore' : audit.action === correction ? 'undo' : '';
  if (!mode) return { message: '请在原订单核对本次操作。' };
  const event = audit.action === correction ? latest(order, 'corrections') : audit.action === cancel ? latest(order, 'cancellationEvents') : null;
  if (audit.targetVersion !== order.version || (event && audit.eventId !== event.id) ||
      (mode === 'restore' ? order.cancelled !== true : order.cancelled === true))
    return { message: '原操作后订单已变化，请查看原单历史。' };
  if (mode === 'undo' && (!event || event.versionAfter !== order.version ||
      [historicalFeeKind, 'historical-card-backfill'].includes(event.kind)))
    return { message: '该更正需要在原订单按专用规则核对。' };
  if (mode === 'restore' && (!event || event.action !== cancel))
    return { message: '找不到对应的撤单记录，请查看原单历史。' };
  const message = orderRecoveryBlock(order, mode, orders, handoffs);
  return message ? { message } : { mode, version: order.version, ...(audit.eventId && { eventId: audit.eventId }) };
}

export function checkOrderReversal(previous, next, action, readHandoffs, actor, now) {
  const orders = list(previous?.orders);
  const byId = new Map(orders.map(row => [row.id, row]));
  if (!isOrderReversalAction(action)) {
    if (next.orders.some(row => {
      const prior = byId.get(row.id);
      return prior && (Boolean(prior.cancelled) !== Boolean(row.cancelled) ||
        !isDeepStrictEqual(list(prior.cancellationEvents), list(row.cancellationEvents)));
    })) return '请通过原订单的专用撤单或恢复入口变更，保留历史记录。';
    return;
  }
  const changed = list(next.orders).filter(row => !isDeepStrictEqual(byId.get(row.id), row));
  if (changed.length !== 1 || orders.length !== next.orders.length)
    return '恢复或撤单一次只可处理一笔原订单。';
  const [row] = changed, prior = byId.get(row.id);
  if (!prior || row.version !== (prior.version ?? 0) + 1) return '订单版本已变化，请重新核对。';
  const mode = action === restore ? 'restore' : action === cancel ? 'cancel' : 'undo';
  const blocked = orderRecoveryBlock(prior, mode, orders, readHandoffs());
  if (blocked) return blocked;
  const at = toV2DateTimeInput(now).replace('T', ' ');
  if (action === compensation) {
    const change = latest(prior, 'corrections'), receipt = latest(row, 'compensations');
    if (!change || prior.version !== change.versionAfter || !isAppend(prior.compensations, row.compensations) ||
        receipt.correctionId !== change.id || receipt.fromVersion !== prior.version || receipt.toVersion !== row.version ||
        typeof receipt.reason !== 'string' || !receipt.reason.trim() || Boolean(row.cancelled) !== Boolean(prior.cancelled) ||
        !isDeepStrictEqual(list(prior.cancellationEvents), list(row.cancellationEvents)))
      return '须从原订单核对最新更正记录。';
    Object.assign(receipt, { actorId: actor.id, actor: actor.name, at, reason: receipt.reason.trim() });
    return;
  }
  const event = latest(row, 'cancellationEvents');
  if (Boolean(prior.cancelled) === (mode === 'cancel') || row.cancelled !== (mode === 'cancel') ||
      !isAppend(prior.cancellationEvents, row.cancellationEvents) ||
      event.action !== action || typeof event.reason !== 'string' || !event.reason.trim())
    return '须使用原订单的专用撤单或恢复入口并保留历史。';
  const { cancelled: _cancelled, version: _version, cancellationEvents: _events, ...saved } = row;
  const { cancelled: _priorCancelled, version: _priorVersion, cancellationEvents: _priorEvents, ...existing } = prior;
  if (!isDeepStrictEqual(saved, existing)) return '撤单或恢复只处理订单状态，其他更正请从原单另行登记。';
  Object.assign(event, { actorId: actor.id, actor: actor.name, at, reason: event.reason.trim() });
}
