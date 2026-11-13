import { randomUUID } from 'node:crypto';
import { RelayError } from './vendure-provider.mjs';

const emailPattern = /^[^\s@,|]+@[^\s@,|]+\.[^\s@,|]+$/;
const idPattern = /^[\w.:-]{1,180}$/;
const emailOf = (value) => String(value ?? '').trim().toLowerCase();
const batchInput = (rows) => rows.map(({ email, note }) => note ? `${email},${note}` : email).join('\n');

function readInput(input) {
  const { parentId, parentVersion, days, rows, batch, existingId, existingVersion } = input;
  if (Object.keys(input).some((key) => !['parentId', 'parentVersion', 'days', 'rows', 'batch', 'existingId', 'existingVersion'].includes(key)) ||
      typeof parentId !== 'string' || !idPattern.test(parentId) ||
      !Number.isSafeInteger(parentVersion) || parentVersion < 1 ||
      !Number.isSafeInteger(days) || days < 1 || days > 3650 ||
      typeof batch !== 'boolean' || !Array.isArray(rows) ||
      rows.length < 1 || rows.length > (batch ? 500 : 1) ||
      (existingId === undefined ? existingVersion !== undefined :
        batch || typeof existingId !== 'string' || !idPattern.test(existingId) ||
          !Number.isSafeInteger(existingVersion) || existingVersion < 1)) {
    throw new RelayError(400, '请核对主邮箱、有效天数和登记资料');
  }
  const seen = new Set();
  const entries = rows.map((row, index) => {
    const email = emailOf(row?.email);
    if (!row || Object.keys(row).some((key) => !['email', 'note'].includes(key)) ||
        typeof row.email !== 'string' || email.length > 254 || !emailPattern.test(email) ||
        typeof row.note !== 'string' || row.note.length > 500 || /[\r\n\x00]/.test(row.note) ||
        seen.has(email)) {
      throw new RelayError(400, `第 ${index + 1} 条的邮箱或备注无效，或邮箱重复`);
    }
    seen.add(email);
    return { email, note: row.note.trim() };
  });
  if (batch && batchInput(entries).length > 100_000)
    throw new RelayError(400, '批量登记内容过长，请分批提交');
  return { parentId, parentVersion, days, entries, batch, existingId, existingVersion };
}

function resolveRows(upstream, entries, remoteParentId, localAliases, remoteAliasIdFor, existingFor) {
  if (!Array.isArray(upstream)) throw new RelayError(502, '收件服务返回的隐藏邮箱资料无效');
  const byEmail = Map.groupBy(upstream, (row) => emailOf(row?.aliasEmail));
  const byId = Map.groupBy(upstream, (row) => String(row?.id ?? ''));
  return entries.map(({ email }, index) => {
    const matches = byEmail.get(email) ?? [];
    const existing = existingFor(email);
    const existingRemoteId = existing && remoteAliasIdFor(existing);
    if (!matches.length && !existingRemoteId) return undefined;
    const [row] = matches;
    const id = String(row?.id ?? '');
    if (matches.length !== 1 || !idPattern.test(id) || byId.get(id).length !== 1 ||
        (existingRemoteId && id !== existingRemoteId) ||
        String(row.primaryAccountId) !== remoteParentId || row.status !== 'ACTIVE' ||
        typeof row.buyerQueryCode !== 'string' || !row.buyerQueryCode.trim() ||
        localAliases.some((local) => local.id !== existing?.id && remoteAliasIdFor(local) === id)) {
      throw new RelayError(409, `第 ${index + 1} 条的主邮箱归属、状态或编号冲突，请核对原收件记录`);
    }
    return row;
  });
}

export function registerAppleRelayAliases(input, actor, { perform, provider, remoteIdFor, remoteAliasIdFor, savePrimaries }, history) {
  const { parentId, parentVersion, days, entries, batch, existingId, existingVersion } = readInput(input);
  return perform(async (parents, upstream, aliases) => {
    const parent = parents.find((row) => row.id === parentId && !row.deleted);
    const remoteParentId = parent && remoteIdFor(parent);
    if (!parent || (parent.version || 1) !== parentVersion || parent.status !== 'ACTIVE' ||
        !remoteParentId || !upstream.some((row) => String(row.id) === remoteParentId &&
          emailOf(row.email) === emailOf(parent.email) && row.status === 'ACTIVE')) {
      throw new RelayError(409, '请刷新并选择已授权且正常的 Apple 主邮箱');
    }
    const localAliases = [...aliases.values()];
    const prior = existingId ? aliases.get(existingId) : undefined;
    if (existingId && (!prior || prior.relayDeleted || prior.relayStatus !== 'ACTIVE' ||
        (prior.version || 1) !== existingVersion || prior.parentMailboxId !== parentId ||
        emailOf(prior.email) !== entries[0].email || remoteAliasIdFor(prior))) {
      throw new RelayError(409, '原隐藏邮箱已变化或已有收件绑定，请刷新后重新核对');
    }
    const localEmails = new Set(localAliases.filter((row) => row.id !== existingId).map((row) => emailOf(row.email)));
    const historicalAliases = new Map(history?.pending.filter(row => row.alias).map(row => [row.email, row.alias]));
    for (const [email, expected] of historicalAliases) {
      const current = aliases.get(expected.id);
      if (!current || current.version !== expected.version || current.parentMailboxId !== parentId ||
          emailOf(current.email) !== email || current.relayDeleted || current.relayStatus !== 'ACTIVE')
        throw new RelayError(409, '原隐藏邮箱已变化，请重新预检');
    }
    const existingFor = email => historicalAliases.get(email);
    const duplicateIndex = entries.findIndex(({ email }) => localEmails.has(email) && !existingFor(email));
    if (duplicateIndex >= 0)
      throw new RelayError(409, `第 ${duplicateIndex + 1} 条已在本系统登记，请刷新核对`);

    const readMatches = async () => resolveRows(
      await provider.virtualEmails(), entries, remoteParentId, localAliases, remoteAliasIdFor, existingFor
    );
    let matches = await readMatches();
    if (actor.role === 'registrar' && matches.some(Boolean))
      throw new RelayError(409, '收件服务已有该隐藏邮箱，请联系管理员核对并授权');
    const missing = entries.filter((_, index) => !matches[index]);
    if (missing.length) {
      const settings = { primaryAccountId: remoteParentId, codeResetIntervalDays: days };
      let writeError;
      let createdAliasId;
      try {
        if (batch) await provider.batchCreateAliases({ ...settings, rawInput: batchInput(missing) });
        else createdAliasId = (await provider.createAlias({ ...settings, aliasEmail: missing[0].email,
          note: missing[0].note }))?.id;
      } catch (error) {
        writeError = error;
      }
      if (actor.role === 'registrar' && (batch || !idPattern.test(String(createdAliasId ?? ''))))
        throw new RelayError(409, '收件服务未确认这次新登记，请联系管理员核对结果');
      matches = await readMatches();
      if (actor.role === 'registrar' && String(matches[0]?.id) !== String(createdAliasId))
        throw new RelayError(409, '新登记的收信记录待核对，请联系管理员');
      const missingLines = matches.flatMap((row, index) => row ? [] : [index + 1]);
      if (missingLines.length) {
        const shown = missingLines.slice(0, 8).join('、') + (missingLines.length > 8 ? ' 等' : '');
        throw new RelayError(writeError?.status || 502,
          `收件服务未确认第 ${shown} 条，本系统尚未入库。可按相同内容重试，已登记的地址会复用。`);
      }
    }
    const records = matches.map((remote, index) => {
      const { email, note } = entries[index];
      const previous = prior || existingFor(email);
      return {
        id: previous?.id ?? `apple-alias-${randomUUID()}`,
        expectedVersion: previous ? (previous.version || 1) : null,
        remoteAliasId: String(remote.id),
        parentMailboxId: parentId,
        email: previous?.email || email,
        notes: note,
        codeResetIntervalDays: Number.isSafeInteger(remote.codeResetIntervalDays) ? remote.codeResetIntervalDays : days,
        queryExpiry: typeof remote.codeExpiresAt === 'string' ? remote.codeExpiresAt : '',
        sourceCreatedAt: remote.createdAt
      };
    });
    if (history) {
      try {
        return await savePrimaries([], actor, records, { parentId, parentVersion, batch, history });
      } catch (error) {
        if ([400, 403, 409].includes(error.status)) throw new RelayError(error.status, error.message);
        throw error;
      }
    }
    return {
      inventory: await savePrimaries([], actor, records, { parentId, parentVersion, batch }),
      registered: records.length
    };
  });
}
