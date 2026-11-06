import { isDeepStrictEqual } from 'node:util';

import { createOrderSnapshot, snapshotAction } from '../../modules/finance/accounting.mjs';

// Call inside the commerce document transaction, after its version check.
// Other commerce writes must carry frozen snapshots through unchanged.
export function checkFinanceSnapshots(
  previous, incoming, { action, clock = Date.now(), verifyAutomaticSnapshot } = {}
) {
  const before = new Map((previous?.orders || []).map((order) => [order.id, order]));
  const after = new Map(incoming.orders.map((order) => [order.id, order]));
  if (after.size !== incoming.orders.length) return '订单编号重复，无法核对汇率快照';
  for (const [id, order] of before) {
    if (!order.fxSnapshot) continue;
    if (!isDeepStrictEqual(order.fxSnapshot, after.get(id)?.fxSnapshot))
      return '已冻结的订单汇率快照不可覆盖或删除';
    if (!isDeepStrictEqual(order.costSettings, after.get(id)?.costSettings))
      return '已核算订单的原费用规则快照不可覆盖';
  }
  const added = incoming.orders.filter((order) => order.fxSnapshot && !before.get(order.id)?.fxSnapshot);
  if (action !== snapshotAction) return added.length ? '请通过订单汇率登记操作冻结快照' : '';
  if (!previous || added.length !== 1 || before.size !== after.size)
    return '一次只能为一笔已有订单冻结汇率快照';
  const [next] = added;
  const prior = before.get(next.id);
  if (!prior || prior.cancelled || next.version !== prior.version + 1)
    return '订单已撤单或版本已变化，无法冻结汇率快照';
  try {
    if (next.fxSnapshot.kind === 'automatic') {
      if (!verifyAutomaticSnapshot?.(next.fxSnapshot, prior))
        return '自动汇率快照未获服务器确认或报价已过期';
    } else if (!isDeepStrictEqual(next.fxSnapshot, createOrderSnapshot(next.fxSnapshot, prior, clock))) {
      return '订单汇率快照格式不正确';
    }
  } catch (error) {
    return error.message;
  }
  const [event, ...history] = incoming.logs;
  if (event?.type !== snapshotAction || event.entityId !== next.id ||
      !isDeepStrictEqual(history, previous.logs))
    return '冻结汇率快照必须追加本单操作记录并保留历史';
  const orders = previous.orders.map((order) =>
    order.id === next.id ? {
      ...order,
      fxSnapshot: next.fxSnapshot,
      version: next.version,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
      updatedById: next.updatedById
    } : order
  );
  if (!isDeepStrictEqual(incoming, { ...previous, orders, logs: incoming.logs }))
    return '冻结汇率快照时不可同时修改其他业务资料';
  return '';
}
