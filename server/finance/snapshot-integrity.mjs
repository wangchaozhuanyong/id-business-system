import { isDeepStrictEqual } from 'node:util';

import { createOrderSnapshot, snapshotAction } from '../../modules/finance/accounting.mjs';

export const historicalFeeAction = '更正历史付款费率';
export const historicalFeeKind = 'historical-card-fee';
const rateIs = (value, fraction) => typeof value === 'string' &&
  new RegExp(`^0\\.${fraction}0*$`).test(value);

function checkHistoricalFeeCorrection(previous, incoming, before, after, currentCostSettings, actor) {
  const fail = '历史费率更正条件未满足，请单独核对订单、费用规则和更正依据';
  if (!previous || !actor?.id || !['admin', 'super'].includes(actor.role) ||
      before.size !== after.size) return fail;
  const changed = incoming.orders.filter(order => !isDeepStrictEqual(order, before.get(order.id)));
  if (changed.length !== 1) return fail;
  const next = changed[0], prior = before.get(next.id);
  if (!prior || prior.product !== 'GPT' || prior.payment !== '银行卡' || prior.costBasis !== 'standard' ||
      prior.cancelled || prior.source === '线上代充' || prior.taskId || prior.taskEvidenceId ||
      prior.rechargeCompletedAt || prior.costSettings?.version !== 2 ||
      !rateIs(prior.costSettings.cardPercent, '08') || !currentCostSettings ||
      !Number.isSafeInteger(currentCostSettings.version) || currentCostSettings.version <= 2 ||
      !rateIs(currentCostSettings.cardPercent, '008') || !isDeepStrictEqual(next.costSettings, currentCostSettings)) return fail;
  const { version: _oldVersion, cardPercent: _oldRate, ...oldRules } = prior.costSettings;
  const { version: _newVersion, cardPercent: _newRate, ...newRules } = currentCostSettings;
  if (!isDeepStrictEqual(oldRules, newRules) || !Number.isSafeInteger(prior.version) ||
      next.version !== prior.version + 1 || next.updatedById !== actor.id) return fail;
  const existing = prior.corrections || [], corrections = next.corrections;
  if (!Array.isArray(existing) || !Array.isArray(corrections) ||
      existing.some(item => item?.kind === historicalFeeKind) || corrections.length !== existing.length + 1 ||
      !isDeepStrictEqual(corrections.slice(0, -1), existing)) return fail;
  const correction = corrections.at(-1), reason = correction?.reason;
  const { corrections: _corrections, refunds: _refunds, bankReturns: _returns, ...original } = prior;
  if (correction?.kind !== historicalFeeKind || correction.verified !== true ||
      typeof correction.id !== 'string' || !correction.id || existing.some(item => item?.id === correction.id) ||
      typeof correction.at !== 'string' || !correction.at || correction.actorId !== actor.id ||
      typeof reason !== 'string' || reason !== reason.trim() || !reason || reason.length > 200 ||
      /(?:\d[ -]?){12,19}/.test(reason) || correction.versionAfter !== next.version ||
      !isDeepStrictEqual(correction.previous, original)) return fail;
  const [entry, ...logs] = incoming.logs || [];
  if (!entry?.id || (previous.logs || []).some(item => item?.id === entry.id) ||
      entry.type !== historicalFeeAction || entry.entityId !== prior.id || entry.actorId !== actor.id ||
      typeof entry.detail !== 'string' || !entry.detail.includes(reason) ||
      !isDeepStrictEqual(logs, previous.logs)) return fail;
  const orders = previous.orders.map(order => order.id === prior.id ? {
    ...order, costSettings: currentCostSettings, corrections, version: next.version,
    updatedAt: next.updatedAt, updatedBy: next.updatedBy, updatedById: next.updatedById
  } : order);
  return isDeepStrictEqual(incoming, { ...previous, orders, logs: incoming.logs }) ? '' : fail;
}

// Call inside the commerce document transaction, after its version check.
// Other commerce writes must carry frozen snapshots through unchanged.
export function checkFinanceSnapshots(
  previous, incoming, { action, clock = Date.now(), verifyAutomaticSnapshot, currentCostSettings, actor,
    verifiedCardBackfillId } = {}
) {
  const before = new Map((previous?.orders || []).map((order) => [order.id, order]));
  const after = new Map(incoming.orders.map((order) => [order.id, order]));
  if (after.size !== incoming.orders.length) return '订单编号重复，无法核对汇率快照';
  for (const [id, order] of before) {
    const next = after.get(id);
    if ((order.corrections || []).some(item => item?.kind === historicalFeeKind) &&
        !isDeepStrictEqual(order.costSettings, next?.costSettings)) return '已更正的费用规则不可覆盖或删除';
    for (const [index, correction] of (order.corrections || []).entries()) {
      if ([historicalFeeKind, 'historical-card-backfill'].includes(correction?.kind) &&
          !isDeepStrictEqual(correction, next?.corrections?.[index])) return '历史费率或原付款卡更正记录不可覆盖或删除';
    }
    if (action === '补偿撤回更正' && [historicalFeeKind, 'historical-card-backfill'].includes(order.corrections?.at(-1)?.kind) &&
        !isDeepStrictEqual(order, next)) return '历史费率或原付款卡更正不可通过普通撤回覆盖';
  }
  if (action === historicalFeeAction)
    return checkHistoricalFeeCorrection(previous, incoming, before, after, currentCostSettings, actor);
  for (const [id, order] of after) {
    const original = before.get(id)?.corrections || [];
    if ((order.corrections || []).some((item, index) =>
      item?.kind === historicalFeeKind && !isDeepStrictEqual(item, original[index]) ||
      item?.kind === 'historical-card-backfill' && !isDeepStrictEqual(item, original[index]) &&
        !(verifiedCardBackfillId === id && index === original.length && index === order.corrections.length - 1)))
      return '请通过对应的历史订单更正入口登记';
  }
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
