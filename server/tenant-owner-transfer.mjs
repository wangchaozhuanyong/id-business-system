import { isDeepStrictEqual } from 'node:util';

export class TenantOwnerTransferError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new TenantOwnerTransferError(status, message); };
const manager = actor => actor?.id && actor.name && actor.active !== false && ['admin', 'super'].includes(actor.role);
const rowVersion = tenant => tenant.version ?? 0;
const keys = ['tenantId', 'ownerId', 'version', 'tenantVersion', 'reason', 'operationId'];

/** Ordinary commerce writes cannot create, rewrite or remove the server's transfer receipts. */
export function checkTenantTransferHistory(tenants, previous = []) {
  const next = new Map(tenants.map(row => [row.id, row]));
  for (const tenant of previous) {
    if (tenant.ownerTransfers?.length && !next.has(tenant.id))
      fail(409, '已有归属转交记录的租户只能停用，不能删除');
  }
  const before = new Map(previous.map(row => [row.id, row]));
  for (const tenant of tenants) {
    if (!isDeepStrictEqual(tenant.ownerTransfers, before.get(tenant.id)?.ownerTransfers))
      fail(409, '归属转交记录不可通过普通资料编辑修改');
  }
}

export function tenantOwnerTransferView(snapshot, tenantId) {
  const tenant = snapshot.data?.tenants?.find(row => row.id === tenantId);
  if (!tenant) fail(404, '租户不存在，请刷新列表');
  return { version: snapshot.version, tenant: { id: tenant.id, name: tenant.name,
    ownerId: tenant.ownerId || '', owner: tenant.owner || '', version: rowVersion(tenant) },
    history: structuredClone(tenant.ownerTransfers || []) };
}

/** The caller commits this plan and its audit together in the existing transaction. */
export function planTenantOwnerTransfer(snapshot, command, actor, readOwners, at = new Date().toISOString()) {
  if (!manager(actor)) fail(403, '只有管理员可以转交租户归属');
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).length !== keys.length || keys.some(key => !Object.hasOwn(command, key)) ||
      !['tenantId', 'ownerId', 'reason', 'operationId'].every(key => typeof command[key] === 'string') ||
      !command.tenantId || command.tenantId.length > 120 || !command.ownerId || command.ownerId.length > 120 ||
      !/^tenant-transfer-[a-zA-Z0-9-]{16,80}$/.test(command.operationId) ||
      !command.reason.trim() || command.reason.trim().length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command.reason) ||
      ![command.version, command.tenantVersion].every(value => Number.isSafeInteger(value) && value >= 0))
    fail(400, '请完整填写租户、新归属人和转交原因');
  const view = tenantOwnerTransferView(snapshot, command.tenantId);
  const reason = command.reason.trim();
  const receipt = snapshot.data.tenants.flatMap(row => row.ownerTransfers || [])
    .find(row => row.id === command.operationId);
  if (receipt) {
    if (receipt.tenantId !== command.tenantId || receipt.toOwnerId !== command.ownerId ||
        receipt.reason !== reason || receipt.actorId !== actor.id || receipt.commandVersion !== command.version ||
        receipt.previousTenantVersion !== command.tenantVersion)
      fail(409, '转交操作编号已用于其他内容，请重新核对');
    return { ...snapshot, receipt: structuredClone(receipt), replayed: true };
  }
  if (snapshot.version !== command.version || view.tenant.version !== command.tenantVersion)
    fail(409, '租户资料已变化，请读取最新归属后重新核对');
  if (view.tenant.ownerId === command.ownerId) fail(409, '新归属人与当前相同，无需转交');
  let owners;
  try { owners = readOwners(); }
  catch { fail(503, '暂时无法核对员工状态，请稍后重试'); }
  if (!Array.isArray(owners)) fail(503, '暂时无法核对员工状态，请稍后重试');
  const owner = owners.find(row => row.id === command.ownerId && row.active !== false &&
    typeof row.name === 'string' && row.name.trim() && ['admin', 'super', 'employee'].includes(row.role));
  if (!owner) fail(409, '新归属人已停用或不存在，请刷新人员列表');
  const data = structuredClone(snapshot.data);
  const tenant = data.tenants.find(row => row.id === command.tenantId);
  const saved = { id: command.operationId, tenantId: tenant.id,
    fromOwnerId: tenant.ownerId || '', fromOwner: tenant.owner || '',
    toOwnerId: owner.id, toOwner: owner.name, actorId: actor.id, actor: actor.name,
    reason, at, commandVersion: command.version, previousTenantVersion: command.tenantVersion };
  Object.assign(tenant, { ownerId: owner.id, owner: owner.name, version: rowVersion(tenant) + 1,
    updatedById: actor.id, updatedBy: actor.name, updatedAt: at,
    ownerTransfers: [...(tenant.ownerTransfers || []), saved] });
  return { version: snapshot.version + 1, data, receipt: saved, replayed: false };
}
