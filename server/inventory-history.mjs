import { inventoryOperationalStatus } from '../frontend/order-opening.mjs';
import { isDeepStrictEqual } from 'node:util';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';

const claimChanges = new Set([
  'status',
  'usedAt',
  'returnedAt',
  'reason',
  'orderId',
  'registrationId'
]);
const registrationChanges = new Set(['state', 'actorId', 'actor', 'time']);
const claimStates = new Set(['pending', 'used', 'returned', 'abnormal']);
const registrationStates = new Set(['待核对', '成功', '失败且未使用']);
const list = (value) => (Array.isArray(value) ? value : []);
const hasId = (row) => typeof row?.id === 'string' && row.id.length > 0;

function retainFields(before, after, changes) {
  return (
    Boolean(after) &&
    Object.keys(before).every(
      (field) =>
        changes?.has(field) ||
        (Object.hasOwn(after, field) && isDeepStrictEqual(before[field], after[field]))
    )
  );
}

function* historyPairs(previous, next) {
  const byId = new Map();
  const unnamed = [];
  for (const row of list(next)) {
    if (!hasId(row)) unnamed.push(row);
    else byId.set(row.id, byId.has(row.id) ? null : row);
  }
  for (const before of list(previous)) {
    if (hasId(before)) {
      yield [before, byId.get(before.id)];
    } else {
      const index = unnamed.findIndex((row) => isDeepStrictEqual(row, before));
      yield [before, index < 0 ? undefined : unnamed.splice(index, 1)[0]];
    }
  }
}

export const isHistoricallyOpenedClaude = asset => asset?.type === 'claude' && asset.claudeHistory?.phase === 'opened';

function useState(asset) {
  return asset?.inventoryState || (asset?.used === true ? 'used' : undefined);
}

function checkClaimTransition(asset, previous, next) {
  const expectedState = {
    pending: 'claimed',
    used: 'used',
    returned: 'available',
    abnormal: 'available'
  }[next.status];
  if (
    expectedState === 'available' &&
    (previous.taskId || previous.orderId || previous.registrationId)
  )
    return '已关联任务、订单或注册核对的库存资料不能直接归还';
  if (
    (useState(asset) || 'available') !== expectedState ||
    (expectedState === 'claimed' && asset.claimId !== previous.id)
  )
    return '库存使用状态必须与原提取明细的处理结果一致';
}

export function checkInventoryHistory(previous, next, { trustedAccountLifecycle = false } = {}) {
  for (const key of ['mailboxes', 'accounts']) {
    const corrections = new Map(list(previous?.[key]).filter(hasId).map((row) => [row.id, row]));
    for (const row of list(next[key])) {
      const original = corrections.get(row?.id);
      if (!isDeepStrictEqual(original?.claudeHistory, row?.claudeHistory))
        return 'Claude 历史入库资料必须通过专用入口登记';
      if (useState(row) === 'claimed' && useState(original) !== 'claimed') {
        if (isHistoricallyOpenedClaude(original) || (row?.claudeHistory &&
            (original.health !== 'normal' || inventoryOperationalStatus(original) !== '正常')))
          return 'Claude 历史账号当前不可提取';
      }
      for (const field of ['accountLifecycle', 'accountLifecycleEvents']) {
        if (!trustedAccountLifecycle && !isDeepStrictEqual(original?.[field], row?.[field]))
          return '账号使用与回收记录必须通过专用操作登记';
      }
      if (list(original?.accountLifecycleEvents).some((event, index) =>
        !isDeepStrictEqual(event, list(row.accountLifecycleEvents)[index])))
        return '原有账号回收及分配历史必须保留';
      if (!Object.hasOwn(row || {}, 'usageCorrections')) continue;
      const before = corrections.get(row.id);
      if (!before || !isDeepStrictEqual(before.usageCorrections, row.usageCorrections))
        return '库存使用更正必须通过专用操作登记';
    }
  }
  if (!previous) return;
  const references = new Set();
  const consumed = new Set();
  const claimedAssets = new Map();
  for (const batch of list(previous.batches)) {
    for (const item of list(batch?.items)) {
      references.add(item?.assetId);
      if (item?.status === 'used') consumed.add(item.assetId);
    }
  }
  for (const entry of [...list(previous.returnRecords), ...list(previous.registrationRecords)]) {
    references.add(entry?.assetId);
    if (entry?.state === '成功') consumed.add(entry.assetId);
  }

  for (const key of ['mailboxes', 'accounts']) {
    for (const [before, after] of historyPairs(previous[key], next[key])) {
      if (!before || typeof before !== 'object') continue;
      if (list(before.usageCorrections).length && (!after ||
        before.email !== after.email || before.type !== after.type ||
        !isDeepStrictEqual(before.usageCorrections, after.usageCorrections)))
        return '原有库存使用更正记录必须保留';
      const links = list(before.usageLinks);
      const status = useState(before);
      const used =
        isHistoricallyOpenedClaude(before) || status === 'used' || links.length > 0 || (hasId(before) && consumed.has(before.id));
      const referenced = status === 'claimed' || (hasId(before) && references.has(before.id));
      const reusable = ['gpt', 'claude', 'gemini', 'grok'].includes(before.type) &&
        before.accountLifecycle?.disposition === 'recovered' && ['available', 'claimed'].includes(useState(after));
      if ((used || referenced) && !after) return '已有使用或领用记录的库存资料必须保留';
      if (status === 'claimed' && hasId(before) && before.claimId)
        claimedAssets.set(before.id, { claimId: before.claimId, after });
      if (
        used &&
        ((!reusable && useState(after) !== 'used' && (status === 'used' || useState(after) !== status)) ||
          (!before.relayDeleted && after.relayDeleted) ||
          (before.email && before.email !== after.email) ||
          (before.type && before.type !== after.type))
      )
        return '已实际使用的库存资料不能退回或替换';
      if (used && ['gpt', 'claude', 'gemini', 'grok'].includes(before.type) && before.source !== '客户提供' &&
        !['客户自有', 'customer'].includes(before.accountSource) &&
        (after.source === '客户提供' || ['客户自有', 'customer'].includes(after.accountSource)))
        return '已有库存使用历史的账号不能改为客户自有来源';
      if (links.some((link, index) => !isDeepStrictEqual(link, list(after.usageLinks)[index])))
        return '原有库存使用关联必须保留';
    }
  }

  for (const [before, after] of historyPairs(previous.batches, next.batches)) {
    if (!before || typeof before !== 'object') continue;
    const { items, ...metadata } = before;
    if (!retainFields(metadata, after)) return '原有提取批次及登记内容必须保留';
    for (const [prior, updated] of historyPairs(items, after.items)) {
      if (!prior || typeof prior !== 'object') continue;
      const pending = prior.status === 'pending';
      if (
        !retainFields(prior, updated, pending ? claimChanges : undefined) ||
        (pending && !claimStates.has(updated.status))
      )
        return '原有提取明细及已完成结果必须保留';
      const asset = claimedAssets.get(prior.assetId);
      if (pending && hasId(prior) && asset?.claimId === prior.id) {
        const error = checkClaimTransition(asset.after, prior, updated);
        if (error) return error;
      }
    }
  }

  for (const [before, after] of historyPairs(previous.returnRecords, next.returnRecords)) {
    if (before && typeof before === 'object' && !retainFields(before, after))
      return '原有归还记录必须保留';
  }
  for (const [before, after] of historyPairs(
    previous.registrationRecords,
    next.registrationRecords
  )) {
    if (!before || typeof before !== 'object') continue;
    const unresolved = before.state === '待核对';
    if (
      !retainFields(before, after, unresolved ? registrationChanges : undefined) ||
      (unresolved && !registrationStates.has(after.state))
    )
      return '原有注册记录及已确认结果必须保留';
  }
}

export function checkAppleIdHealthChanges(previous, next, action, actor, now = new Date()) {
  const prior = new Map(list(previous?.mailboxes).filter(row => row.type === 'apple').map(row => [row.id, row]));
  for (const row of list(next?.mailboxes)) {
    if (row.type !== 'apple') continue;
    const before = prior.get(row.id), state = row.health || 'normal';
    if (!before || state === (before.health || 'normal')) continue;
    const history = list(row.inventoryHistory), previousHistory = list(before.inventoryHistory);
    const event = history.at(-1);
    if (action !== 'inventory_health_change' || !['normal', 'dead', 'unlocking'].includes(state) ||
        !hasId(event) || event.action !== '健康状态变化' || event.detail !== state || typeof event.reason !== 'string' ||
        !event.reason.trim() || event.reason.length > 300 || history.length !== previousHistory.length + 1 ||
        previousHistory.some((entry, index) => entry?.id === event.id || !isDeepStrictEqual(entry, history[index])))
      return '请通过苹果 ID 状态操作填写原因并保存';
    if (actor?.id && actor.name) {
      const time = toV2DateTimeInput(now).replace('T', ' ');
      Object.assign(event, { actorId: actor.id, actor: actor.name, time, reason: event.reason.trim() });
      Object.assign(row, { healthChangedAt: time, lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time });
    }
  }
  return '';
}
