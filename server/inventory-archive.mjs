import { createHash, randomUUID } from 'node:crypto';
import { inventoryAccountTypes, inventoryMailboxTypes, registrationAddress } from '../modules/inventory/list.mjs';
import { listIdentity } from '../modules/orders/order-list.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { isMailboxRegistration, registrationOccupancy } from './inventory-registration.mjs';

const list = value => Array.isArray(value) ? value : [];
const accounts = new Set(inventoryAccountTypes);
const mailboxes = new Set(inventoryMailboxTypes);
const idValid = id => typeof id === 'string' && id.length > 0 && id.length <= 256;
const versionOf = asset => asset.version ?? 1;
const healthOf = asset => ['normal', 'dead', 'unlocking'].includes(asset.health) ? asset.health : 'normal';
export const archiveAction = 'inventory_archive';
export const restoreArchiveAction = 'inventory_restore_archive';
export const archiveReasons = Object.freeze({ wrong_import: '误导入', wrong_entry: '误录入', retire_stock: '移出库存' });
export const restoreArchiveReasons = Object.freeze({ accidental_archive: '误归档', needed_again: '恢复原资料' });
export const archiveDomain = id => 'inventory-archive:' + createHash('sha256').update(id).digest('hex');
export const archiveReceiptDomain = id => 'inventory-archive-receipt:' + id;

function assetKind(asset) {
  if (accounts.has(asset?.type)) return 'account';
  if (mailboxes.has(asset?.type)) return 'mailbox';
}

function archiveProblem(asset, inventory, commerce, managedMailboxes, { keepRegistration = false } = {}) {
  const kind = assetKind(asset);
  if (!kind || !idValid(asset.id) || !Number.isSafeInteger(versionOf(asset) + 1) || versionOf(asset) < 0)
    return '此资料需通过所属业务的专用入口处理。';
  const state = asset.inventoryState ?? (asset.used ? 'used' : 'available');
  if (state !== 'available' || ['已使用', '已提取'].includes(asset.status) ||
      asset.used || asset.mailboxUsage === 'used' || asset.claimId || asset.claimBatchId || asset.reservation ||
      asset.deleted || asset.relayDeleted || asset.claudeHistory || asset.accountLifecycle || asset.usedAt || asset.actualUsedAt ||
      list(asset.accountLifecycleEvents).length || list(asset.usageLinks).length || list(asset.usageCorrections).length)
    return '资料已使用、领用、占用或有历史关联，请核对原业务。';
  if (!keepRegistration && (isMailboxRegistration(asset) || asset.sourceMailboxId || asset.sourceClaimId))
    return '此账号已登记注册来源，请保留账号与来源邮箱。';
  const id = asset.id, address = registrationAddress(asset.email);
  const identity = registrationAddress(listIdentity(asset));
  if (list(inventory.batches).some(batch => list(batch.items).some(item => item.assetId === id)) ||
      list(inventory.returnRecords).some(row => row.assetId === id) ||
      list(inventory.registrationRecords).some(row => row.assetId === id ||
        (row.accountId === id && (!keepRegistration || row.state !== '成功'))))
    return '资料已有领用、归还或注册记录，请保留原记录。';
  if (kind === 'mailbox' &&
      (asset.microsoftSecurity?.recoveryMailboxId || asset.microsoftSecurity?.recoveryAccess === 'inventory' ||
        (asset.appPassword && /^.+@(?:gmail|googlemail)\.com$/i.test(asset.email || '')) ||
        (address && registrationOccupancy(inventory).has(address)) ||
        [...list(inventory.accounts), ...list(inventory.mailboxes)].some(row =>
          row.sourceMailboxId === id || row.recoveryMailboxId === id || row.microsoftSecurity?.recoveryMailboxId === id ||
          (row.id !== id && address && registrationAddress(row.auxiliary) === address)) ||
        managedMailboxes.some(row => row.registrationAssetId === id || (address && registrationAddress(row.email) === address))))
    return '邮箱已关联注册、辅助邮箱或收信授权，请到邮箱业务核对。';
  if (list(commerce?.orders).some(row => [row.accountId, row.mailboxId, row.sourceMailboxId].includes(id) ||
      (identity && registrationAddress(listIdentity(row)) === identity) ||
      (address && registrationAddress(row.email) === address)))
    return '资料已关联订单或订阅，请保留原记录。';
  return '';
}

export function inventoryHealthRecoveryProblem(asset, inventory, commerce, managedMailboxes) {
  if (asset.source === '客户提供' || ['客户自有', 'customer'].includes(asset.accountSource))
    return '客户自有账号请到原账号页面核对。';
  const identity = registrationAddress(listIdentity(asset));
  if (identity && records(inventory).some(row =>
    row?.id !== asset.id && row?.type === asset.type && registrationAddress(listIdentity(row)) === identity))
    return '同类型库存已有相同资料，请到库存页面核对。';
  // A health-only change leaves the source mailbox and the completed registration intact.
  return archiveProblem(asset, inventory, commerce, managedMailboxes, { keepRegistration: true });
}

function archiveFailure(message, status = 409) {
  throw new InventoryArchiveError(status, message);
}

export class InventoryArchiveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const records = inventory => [...list(inventory?.accounts), ...list(inventory?.mailboxes)];

export function archivePreview(snapshot, commerce, managedMailboxes, id) {
  if (!idValid(id)) archiveFailure('库存资料编号无效。', 400);
  const rows = records(snapshot.data).filter(row => row.id === id);
  if (!rows.length) archiveFailure('资料已归档或不存在，请刷新后核对。', 404);
  if (rows.length !== 1) archiveFailure('库存资料编号重复，请核对原记录。');
  const [asset] = rows;
  const collection = accounts.has(asset.type) ? 'accounts' : 'mailboxes';
  const message = !list(snapshot.data[collection]).includes(asset)
    ? '资料类型与所属库存不符，请先核对原记录。'
    : archiveProblem(asset, snapshot.data, commerce, managedMailboxes);
  return { status: message ? 'unavailable' : 'available', version: snapshot.version, id, assetVersion: versionOf(asset),
    identity: listIdentity(asset), type: asset.type, health: healthOf(asset),
    ...(message ? { message } : { reasons: Object.entries(archiveReasons) }) };
}

export function prepareArchive(snapshot, commerce, managedMailboxes, command) {
  const preview = archivePreview(snapshot, commerce, managedMailboxes, command.id);
  if (preview.version !== command.version || preview.assetVersion !== command.assetVersion)
    archiveFailure('库存或资料版本已经变化，请重新打开归档预览。');
  if (preview.status !== 'available') archiveFailure(preview.message);
  const collection = accounts.has(preview.type) ? 'accounts' : 'mailboxes';
  const index = snapshot.data[collection].findIndex(row => row.id === preview.id);
  const asset = snapshot.data[collection][index];
  const data = { ...snapshot.data, [collection]: snapshot.data[collection].toSpliced(index, 1),
    undo: list(snapshot.data.undo).filter(row => row?.[0] !== asset.id) };
  return { asset, data, collection, kind: assetKind(asset) };
}

export function archiveRestoreProblem(entry, inventory, commerce, managedMailboxes) {
  const asset = entry.asset;
  const identity = registrationAddress(listIdentity(asset));
  if (records(inventory).some(row => row.id === asset.id ||
      (identity && row.type === asset.type && registrationAddress(listIdentity(row)) === identity)))
    return '编号或同类型资料已经存在，请核对现有库存。';
  return archiveProblem(asset, inventory, commerce, managedMailboxes);
}

export function restoreArchivedInventory(entry, inventory, actor, at) {
  const time = toV2DateTimeInput(at).replace('T', ' ');
  const asset = { ...entry.asset, version: versionOf(entry.asset) + 1,
    lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time,
    inventoryHistory: [...list(entry.asset.inventoryHistory), {
      id: randomUUID(), action: '恢复归档资料', detail: '恢复原库存状态', actorId: actor.id, actor: actor.name, time
    }] };
  return { ...inventory, [entry.collection]: [asset, ...inventory[entry.collection]] };
}

// All ordinary inventory saves carry an active snapshot. A stale or older UI
// must not delete the active row or reinsert a held archive through that path.
export function checkInventoryArchiveChanges(previous, next, isArchived) {
  for (const collection of ['accounts', 'mailboxes']) {
    const before = new Set(list(previous?.[collection]).map(row => row.id));
    const after = new Set(list(next?.[collection]).map(row => row.id));
    if (list(previous?.[collection]).some(row => assetKind(row) && !after.has(row.id)))
      return '库存资料请通过归档入口移出，保留恢复记录。';
    if (list(next?.[collection]).some(row => !before.has(row.id) && idValid(row.id) && isArchived(row.id)))
      return '此资料编号处于归档状态，请通过操作记录恢复。';
  }
  return '';
}
