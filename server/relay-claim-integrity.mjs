const blockedClaimStates = new Set(['pending', 'used']);
const blockedRegistrationStates = new Set(['成功', '待核对']);
const boundedId = (value) => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const list = (value) => (Array.isArray(value) ? value : []);
const index = (rows) => new Map(rows.map((row) => [row?.id, row]));
const state = (row) => row?.inventoryState ?? (row?.used ? 'used' : 'available');
const hasUsage = (row) =>
  row?.usageLinks !== undefined && (!Array.isArray(row.usageLinks) || row.usageLinks.length > 0);
const isActiveParent = (parent) => parent?.status === 'ACTIVE' && !parent.deleted;
const isActiveAlias = (row) =>
  row.relayStatus === 'ACTIVE' && !row.relayDeleted &&
  (row.health ?? 'normal') === 'normal' && (row.status ?? '正常') === '正常';

export class RelayClaimError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalidClaim() {
  return new RelayClaimError(409, '隐藏邮箱领取必须由可提取库存、新批次和待使用明细一一对应');
}

function assetRows(document) {
  return [...list(document?.mailboxes), ...list(document?.accounts)];
}

function knownRelayAssets(before, after) {
  return new Set(
    [...assetRows(before), ...assetRows(after)].filter((row) => row?.type === 'relay').map((row) => row.id)
  );
}

function claimedOrUsedByHistory(document) {
  const blocked = new Set();
  for (const batch of list(document?.batches)) {
    for (const item of list(batch?.items)) {
      if (blockedClaimStates.has(item?.status)) blocked.add(item.assetId);
    }
  }
  for (const record of list(document?.registrationRecords)) {
    if (blockedRegistrationStates.has(record?.state)) blocked.add(record.assetId);
  }
  return blocked;
}

function checkAliasIdentity(previous, next, relayIds) {
  const before = index(assetRows(previous));
  const after = new Map();
  for (const row of assetRows(next)) {
    if (!relayIds.has(row?.id)) continue;
    if (!boundedId(row.id) || after.has(row.id) || row.type !== 'relay') {
      throw new RelayClaimError(409, '隐藏邮箱编号或资料类型不能替换或重复');
    }
    after.set(row.id, row);
    const prior = before.get(row.id);
    if (
      prior &&
      (prior.type !== 'relay' || prior.email !== row.email || prior.parentMailboxId !== row.parentMailboxId)
    ) {
      throw new RelayClaimError(409, '隐藏邮箱地址、资料类型和所属主邮箱不能通过库存保存变更');
    }
  }
  if (list(next.accounts).some((row) => row?.type === 'relay')) {
    throw new RelayClaimError(409, '隐藏邮箱只能保存在邮箱库存');
  }
  for (const id of relayIds) {
    if (before.get(id)?.type === 'relay' && !after.has(id)) {
      throw new RelayClaimError(409, '已有隐藏邮箱编号必须保留，请使用隐藏邮箱停用操作');
    }
  }
  return { before, after };
}

function checkClaimItem(item, batch, asset, prior, parent, priorParent, actor) {
  if (
    !prior || !isActiveAlias(prior) || !isActiveAlias(asset) ||
    state(prior) !== 'available' || prior.used || prior.claimId || prior.claimBatchId || hasUsage(prior) ||
    !isActiveParent(priorParent) || !isActiveParent(parent) || parent.email !== priorParent.email ||
    !boundedId(asset.parentMailboxId) || item.parentMailboxId !== asset.parentMailboxId ||
    item.type !== 'relay' || item.email !== asset.email || item.status !== 'pending' ||
    item.usedAt || item.returnedAt || item.orderId || item.registrationId || item.taskId ||
    state(asset) !== 'claimed' || asset.used !== true || hasUsage(asset) ||
    asset.claimId !== item.id || asset.claimBatchId !== batch.id ||
    (item.actorId !== undefined && item.actorId !== actor.id) ||
    (asset.lastOperatedById !== undefined && asset.lastOperatedById !== actor.id)
  ) throw invalidClaim();
}

export function pendingRelayClaimIds(previous, next, { action, actor }) {
  const relayIds = knownRelayAssets(previous, next);
  const batches = list(next.batches);
  if (!relayIds.size && !batches.some((batch) => list(batch?.items).some((item) => item?.type === 'relay'))) {
    return [];
  }
  const { before, after } = checkAliasIdentity(previous, next, relayIds);
  const previousBatches = index(list(previous?.batches));
  const previousItems = new Set(
    list(previous?.batches).flatMap((batch) => list(batch?.items).map((item) => item?.id))
  );
  const nextBatchCounts = new Map();
  const nextItemCounts = new Map();
  for (const batch of batches) {
    nextBatchCounts.set(batch?.id, (nextBatchCounts.get(batch?.id) ?? 0) + 1);
    for (const item of list(batch?.items)) {
      nextItemCounts.set(item?.id, (nextItemCounts.get(item?.id) ?? 0) + 1);
    }
  }
  const previousParents = index(list(previous?.appleRelay?.parents));
  const nextParents = index(list(next.appleRelay?.parents));
  const previouslyBlocked = claimedOrUsedByHistory(previous);
  const registering = new Set(
    list(next.registrationRecords)
      .filter((record) => blockedRegistrationStates.has(record?.state))
      .map((record) => record.assetId)
  );
  const ids = new Set();
  for (const batch of batches) {
    const previousBatch = previousBatches.get(batch?.id);
    const itemsInPreviousBatch = index(list(previousBatch?.items));
    for (const item of list(batch?.items)) {
      if (item?.type !== 'relay' && !relayIds.has(item?.assetId)) continue;
      if (itemsInPreviousBatch.has(item?.id)) continue;
      if (!actor?.id || !['admin', 'super'].includes(actor.role)) {
        throw new RelayClaimError(403, '只有管理员可以提取苹果隐藏邮箱');
      }
      if (
        action !== 'inventory_extract' || previousBatch || batch.kind !== 'mail' || batch.actorId !== actor.id ||
        (typeof actor.name === 'string' && batch.actorName !== actor.name) ||
        !boundedId(batch.id) || nextBatchCounts.get(batch.id) !== 1 ||
        !boundedId(item?.id) || previousItems.has(item.id) || nextItemCounts.get(item.id) !== 1 ||
        ids.has(item.assetId) || previouslyBlocked.has(item.assetId) || registering.has(item.assetId)
      ) throw invalidClaim();
      const asset = after.get(item.assetId);
      if (!asset) throw invalidClaim();
      checkClaimItem(
        item, batch, asset, before.get(item.assetId),
        nextParents.get(asset.parentMailboxId), previousParents.get(asset.parentMailboxId), actor
      );
      ids.add(item.assetId);
    }
  }
  for (const [id, asset] of after) {
    const prior = before.get(id);
    const addedClaim =
      (state(asset) === 'claimed' && state(prior) !== 'claimed') ||
      (asset.claimId && asset.claimId !== prior?.claimId) ||
      (asset.claimBatchId && asset.claimBatchId !== prior?.claimBatchId);
    const directUse = state(prior) === 'available' &&
      (state(asset) === 'used' || (!prior?.used && asset.used) || (!hasUsage(prior) && hasUsage(asset)));
    if ((addedClaim || directUse) && !ids.has(id)) throw invalidClaim();
  }
  if (ids.size > 100) throw new RelayClaimError(400, '一次最多提取 100 条苹果隐藏邮箱');
  return [...ids];
}

export function requireVerifiedRelayClaimIds(ids, verifiedIds) {
  if (!ids.length) return;
  if (!Array.isArray(verifiedIds)) {
    throw new RelayClaimError(503, '苹果隐藏邮箱提取资格尚未完成后台核验');
  }
  const verified = new Set(verifiedIds);
  if (verifiedIds.length !== ids.length || verified.size !== ids.length || !ids.every((id) => verified.has(id))) {
    throw new RelayClaimError(409, '所选隐藏邮箱未全部通过提取核验，请刷新后重新选择');
  }
}
