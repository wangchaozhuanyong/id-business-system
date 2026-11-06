import { randomUUID } from 'node:crypto';
import { RelayError } from './vendure-provider.mjs';

const fields = ['id', 'version', 'email', 'appPassword', 'note', 'days', 'status'];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idPattern = /^[\w.:-]{1,180}$/;
const emailOf = (row) => String(row?.email ?? '').trim().toLowerCase();

function readInput(input) {
  const { id, version, appPassword, note, days, status } = input;
  const email = emailOf(input);
  if (
    Object.keys(input).some((key) => !fields.includes(key)) ||
    typeof input.email !== 'string' || email.length > 254 || !emailPattern.test(email) ||
    typeof note !== 'string' || note.length > 500 ||
    !Number.isSafeInteger(days) || days < 1 || days > 3650 ||
    (id === undefined ? version !== undefined || status !== undefined :
      typeof id !== 'string' || !idPattern.test(id) || !Number.isSafeInteger(version) ||
      version < 1 || !['ACTIVE', 'DISABLED'].includes(status)) ||
    (appPassword !== undefined && (typeof appPassword !== 'string' ||
      !appPassword.trim() || appPassword.length > 256 || /[\x00-\x1f\x7f]/.test(appPassword)))
  ) throw new RelayError(400, '请核对主邮箱、应用专用密码、有效天数和资料版本');
  return { id, version, email, appPassword: appPassword?.trim(), note: note.trim(), days, status };
}

function providerRows(value) {
  if (!Array.isArray(value)) throw new RelayError(502, '收件服务返回的主邮箱资料无效');
  const ids = new Set(), emails = new Set();
  for (const row of value) {
    const id = String(row?.id ?? ''), email = emailOf(row);
    if (!idPattern.test(id) || !emailPattern.test(email) || ids.has(id) || emails.has(email))
      throw new RelayError(502, '收件服务主邮箱资料有重复或无效编号');
    ids.add(id);
    emails.add(email);
  }
  return value;
}

function recordFor(remote, prior, imported = false) {
  return {
    id: prior?.id || `apple-primary-${randomUUID()}`,
    expectedVersion: prior ? (prior.version || 1) : null,
    remotePrimaryId: String(remote.id),
    email: emailOf(remote),
    note: typeof remote.note === 'string' ? remote.note : '',
    days: Number.isSafeInteger(remote.codeResetIntervalDays) ? remote.codeResetIntervalDays : 30,
    status: remote.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    connection: remote.status === 'AUTH_ERROR' ? '授权异常，请测试连接或更新专用密码' : '',
    queryExpiry: remote.codeExpiresAt || '',
    lastSyncedAt: remote.lastSyncedAt || '',
    ...(imported && { imported, sourceCreatedAt: remote.createdAt })
  };
}

export function createAppleRelayPrimaryManagement({
  provider, current, remoteIdFor, remoteAliasIdFor, importAliasIds, savePrimaries
}) {
  let busy = false;

  async function perform(operation) {
    if (busy) throw new RelayError(409, '正在处理主邮箱，请稍候重试');
    busy = true;
    try {
      const [local, upstream] = await Promise.all([current(), provider.primaryAccounts().then(providerRows)]);
      return await operation([...local.parents.values()], upstream, local.aliases);
    } finally {
      busy = false;
    }
  }

  async function persist(rows, actor, aliases = []) {
    try {
      return await savePrimaries(rows, actor, aliases);
    } catch (error) {
      if (error.status === 409)
        throw new RelayError(409, '收件服务已响应，本地资料有更新。请刷新核对，已有授权可用“导入已有主邮箱”恢复');
      throw error;
    }
  }

  return {
    save(input, actor) {
      const { id, version, email, appPassword, note, days, status } = readInput(input);
      return perform(async (local, upstream) => {
        const prior = id ? local.find((row) => row.id === id && !row.deleted) : null;
        if (id && (!prior || (prior.version || 1) !== version))
          throw new RelayError(409, '主邮箱资料已变化，请重新载入');
        if (prior && emailOf(prior) !== email)
          throw new RelayError(409, '请保留主邮箱地址。登记另一地址请新增主邮箱');
        if (local.some((row) => !row.deleted && row.id !== id && emailOf(row) === email))
          throw new RelayError(409, '主邮箱已存在，请从原记录编辑');

        const remoteId = prior && remoteIdFor(prior);
        const existing = upstream.find((row) => emailOf(row) === email);
        if (remoteId && String(existing?.id) !== remoteId)
          throw new RelayError(409, '原收件服务的主邮箱编号或邮箱地址无法核对');
        if (!remoteId && existing)
          throw new RelayError(409, '收件服务已有该主邮箱，请先导入已有授权');
        if (!remoteId && !appPassword)
          throw new RelayError(400, '请填写 Apple 应用专用密码');
        if (!remoteId && status === 'DISABLED')
          throw new RelayError(400, '首次授权请将主邮箱设为正常，保存后可停用');
        const settings = { note, codeResetIntervalDays: days, ...(appPassword && { appPassword }) };
        const statusChanged = prior && status !== (prior.status || 'ACTIVE');
        const remote = remoteId
          ? await provider.updatePrimary(remoteId, { ...settings, ...(statusChanged && { status }) })
          : await provider.createPrimary({ ...settings, email });
        providerRows([remote]);
        if (emailOf(remote) !== email || (remoteId && String(remote.id) !== remoteId))
          throw new RelayError(502, '收件服务回执的邮箱或编号无法核对，请刷新后检查');
        const row = recordFor(remote, prior);
        return { inventory: await persist([row], actor), parentId: row.id };
      });
    },

    importExisting(input, actor) {
      if (Object.keys(input).length) throw new RelayError(400, '导入已有主邮箱无需填写凭据');
      return perform(async (local, upstream, localAliases) => {
        const pending = [];
        const parentIds = new Map();
        for (const remote of upstream) {
          const matches = local.filter((row) => emailOf(row) === emailOf(remote) ||
            remoteIdFor(row) === String(remote.id));
          const prior = matches[0];
          if (matches.length > 1 || prior?.deleted ||
              (prior && emailOf(prior) !== emailOf(remote)) ||
              (prior && remoteIdFor(prior) && remoteIdFor(prior) !== String(remote.id)))
            throw new RelayError(409, '已有主邮箱与收件服务绑定冲突，请先核对原记录');
          const row = !prior || !remoteIdFor(prior) ? recordFor(remote, prior, true) : prior;
          if (row !== prior) pending.push(row);
          if (remote.status === 'ACTIVE') parentIds.set(String(remote.id), row.id);
        }
        const aliases = importAliasIds.length
          ? await selectAliases(localAliases, parentIds)
          : [];
        return {
          imported: pending.length,
          ...(importAliasIds.length && { importedAliases: aliases.length }),
          ...(pending.length || aliases.length ? { inventory: await persist(pending, actor, aliases) } : {})
        };
      });
    }
  };

  async function selectAliases(localAliases, parentIds) {
    const upstream = await provider.virtualEmails();
    if (!Array.isArray(upstream)) throw new RelayError(502, '收件服务返回的隐藏邮箱资料无效');
    const selected = [];
    for (const id of importAliasIds) {
      const matching = upstream.filter((row) => String(row?.id) === id);
      const remote = matching[0];
      const parentMailboxId = parentIds.get(String(remote?.primaryAccountId));
      const email = emailOf({ email: remote?.aliasEmail });
      if (matching.length !== 1 || remote.status !== 'ACTIVE' || !parentMailboxId ||
          !emailPattern.test(email) || typeof remote.buyerQueryCode !== 'string' || !remote.buyerQueryCode.trim() ||
          (remote.codeExpiresAt !== null && !(Date.parse(remote.codeExpiresAt) > Date.now()))) {
        throw new RelayError(409, '指定隐藏邮箱的状态、有效期或主邮箱归属已变化，请重新核对');
      }
      const matches = [...localAliases.values()].filter((row) =>
        emailOf(row) === email || remoteAliasIdFor(row) === id
      );
      const prior = matches[0];
      if (matches.length > 1 || prior?.relayDeleted ||
          (prior && (emailOf(prior) !== email || prior.parentMailboxId !== parentMailboxId ||
            (remoteAliasIdFor(prior) && remoteAliasIdFor(prior) !== id)))) {
        throw new RelayError(409, '指定隐藏邮箱与已有库存绑定冲突，请先核对');
      }
      if (prior && remoteAliasIdFor(prior)) continue;
      selected.push({
        id: prior?.id ?? `apple-alias-${randomUUID()}`,
        expectedVersion: prior ? (prior.version || 1) : null,
        remoteAliasId: id, parentMailboxId, email,
        notes: typeof remote.note === 'string' ? remote.note : '',
        codeResetIntervalDays: Number.isSafeInteger(remote.codeResetIntervalDays) ? remote.codeResetIntervalDays : 30,
        queryExpiry: remote.codeExpiresAt ?? '',
        sourceCreatedAt: remote.createdAt
      });
    }
    return selected;
  }
}
