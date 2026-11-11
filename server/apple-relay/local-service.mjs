import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRelayCodeReset } from './code-reset.mjs';
import { createRelayMailReassignment } from './mail-reassignment.mjs';
import { createAppleRelayPrimaryManagement } from './primary-management.mjs';
import { historicalIntakePreview, requireHistoricalIntake } from './historical-intake.mjs';
import { RelayError, createVendureMailboxProvider } from './vendure-provider.mjs';
import { registrationEmail, registrationOccupancy } from '../inventory-registration.mjs';

const prefix = '/api/local/apple-relay/';
const mailLimit = 500;
const publicQueryWindowMs = 60_000;
const publicQueryAttemptLimit = 12;
const publicQueryConcurrentLimit = 2;
const historyPreviewConcurrentLimit = 2;
const extractionIdLimit = 100;
const extractionBodyLimit = 19 * 1024;
const historyCountFields = [
  'scannedCount',
  'matchedCount',
  'updatedCount',
  'unmatchedCount',
  'ambiguousCount',
  'unresolvedCount',
  'skippedCount'
];
const publicQueryActor = { id: 'public-mailbox-query', name: '公开查询' };
const invalidPublicCode = '查询码无效或已过期';
const allowedMethods = new Map([
  ['status', 'GET'],
  ['primary-save', 'POST'],
  ['primary-import', 'POST'],
  ['alias-register', 'POST'],
  ['alias-intake-preview', 'POST'],
  ['alias-intake-confirm', 'POST'],
  ['test', 'POST'],
  ['sync', 'POST'],
  ['mails', 'POST'],
  ['mail-detail', 'POST'],
  ['history-preview', 'POST'],
  ['extraction-eligibility', 'POST'],
  ['extraction-codes', 'POST'],
  ['query', 'POST'],
  ['code-read', 'POST'],
  ['code-reset-prepare', 'POST'],
  ['code-reset-confirm', 'POST'],
  ['mail-reassign-prepare', 'POST'],
  ['mail-reassign-confirm', 'POST']
]);
const normalizeEmail = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const normalizeCode = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const boundedId = (value) => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const validExpiry = (value) => value == null || Date.parse(value) > Date.now();

function requireAdministrator(actor, forbiddenMessage) {
  if (!boundedId(actor?.id)) throw new RelayError(401, '请先登录');
  if (!['admin', 'super'].includes(actor.role)) {
    throw new RelayError(403, forbiddenMessage);
  }
}

function validateExtractionIds(ids, message) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > extractionIdLimit ||
    !ids.every(boundedId) ||
    new Set(ids).size !== ids.length
  ) {
    throw new RelayError(400, message);
  }
}

function maskedEmail(email) {
  const [localPart, domain] = email.split('@');
  return `${localPart.slice(0, 3)}***@${domain}`;
}

export async function loadAppleRelayConfig(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new RelayError(503, '无法读取本机 Vendure 邮箱配置');
  }
  try {
    const details = await file.stat();
    if (
      !details.isFile() ||
      details.mode & 0o077 ||
      (process.getuid && details.uid !== process.getuid()) ||
      details.size > 128 * 1024
    ) {
      throw new RelayError(503, '本机 Vendure 邮箱配置必须为当前用户的私有文件');
    }
    const config = JSON.parse(await file.readFile('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new RelayError(503, '本机 Vendure 邮箱配置格式不正确');
    }
    return config;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(503, '本机 Vendure 邮箱配置格式不正确');
  } finally {
    await file.close();
  }
}

function loadBindings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError(503, 'Vendure 邮箱编号映射格式不正确');
  }
  const bindings = new Map(Object.entries(value));
  const remoteIds = new Set();
  for (const [localId, remoteId] of bindings) {
    if (!boundedId(localId) || !boundedId(remoteId) || remoteIds.has(remoteId)) {
      throw new RelayError(503, 'Vendure 邮箱编号映射无效或重复');
    }
    remoteIds.add(remoteId);
  }
  return bindings;
}

function checkedRows(value) {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object')) {
    throw new RelayError(502, 'Vendure 邮箱服务返回的资料格式不正确');
  }
  return value;
}

function activeParent(row) {
  return row && !row.deleted && row.status !== 'DISABLED';
}

function activeAlias(row) {
  return row && row.type === 'relay' && !row.relayDeleted && row.relayStatus !== 'DISABLED';
}

function snapshot(inventory) {
  return {
    parents: new Map((inventory?.appleRelay?.parents ?? []).map((row) => [row.id, row])),
    aliases: new Map(
      (inventory?.mailboxes ?? [])
        .filter((row) => row?.type === 'relay')
        .map((row) => [row.id, row])
    )
  };
}

function matchPrimaries(local, remoteRows, remoteIdFor) {
  const remote = uniqueRemoteRows(remoteRows);
  const matched = new Map();
  for (const [id, row] of local.parents) {
    const remoteId = remoteIdFor(row);
    const entry = remote.get(remoteId);
    if (
      activeParent(row) &&
      entry &&
      entry.status !== 'DISABLED' &&
      normalizeEmail(row.email) === normalizeEmail(entry.email)
    ) {
      matched.set(id, { local: row, remote: entry, remoteId });
    }
  }
  return matched;
}

function matchAliases(local, remoteRows, remoteAliasIdFor, primaryRows) {
  const remote = uniqueRemoteRows(remoteRows);
  const matched = new Map();
  for (const [id, row] of local.aliases) {
    const remoteId = remoteAliasIdFor(row);
    const owner = primaryRows.get(row?.parentMailboxId);
    const entry = remote.get(remoteId);
    if (
      activeAlias(row) &&
      owner &&
      entry?.status === 'ACTIVE' &&
      String(entry.primaryAccountId) === owner.remoteId &&
      normalizeEmail(row.email) === normalizeEmail(entry.aliasEmail)
    ) {
      matched.set(id, { local: row, remote: entry, remoteId, owner });
    }
  }
  return matched;
}

function uniqueRemoteRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.id);
    byId.set(id, byId.has(id) ? null : row);
  }
  return byId;
}

function blockedRelayExtractions(inventory) {
  const blocked = new Set();
  const occupied = registrationOccupancy(inventory);
  const heldEmails = new Set();
  for (const batch of inventory?.batches ?? []) {
    if (!Array.isArray(batch?.items)) continue;
    for (const item of batch.items) {
      if (['pending', 'used'].includes(item?.status)) blocked.add(item.assetId);
      if (batch.kind === 'mail' && item?.status === 'pending') heldEmails.add(registrationEmail(item.email));
    }
  }
  for (const record of inventory?.registrationRecords ?? []) {
    if (['待核对', '成功'].includes(record?.state)) blocked.add(record.assetId);
  }
  for (const alias of inventory?.mailboxes ?? []) {
    const email = registrationEmail(alias?.email);
    if (alias?.type === 'relay' && email && (occupied.has(email) || heldEmails.has(email))) blocked.add(alias.id);
  }
  return blocked;
}

function hasRelayUsageLink(alias) {
  return (
    alias.usageLinks !== undefined &&
    (!Array.isArray(alias.usageLinks) || alias.usageLinks.length > 0)
  );
}

function verificationCode(mail) {
  const provided = typeof mail.extractedCode === 'string' ? mail.extractedCode.trim() : '';
  if (/^[a-z0-9]{4,8}$/i.test(provided) && /\d/.test(provided)) return provided;

  // Same conservative fallback as the existing mailbox client, limited to clearly labelled codes.
  const candidates = new Set();
  const subject = String(mail.subject ?? '');
  const body = String(mail.bodyText ?? '');
  function addCandidate(source, match, minimumDigits) {
    const value = match[1];
    if (!/^\d{4,8}$/.test(value) || value.length < minimumDigits) return;
    const start = match.index + match[0].lastIndexOf(value);
    if (
      /\d(?:\s+|\s*[-–—]\s*)$/.test(source.slice(0, start)) ||
      /^(?:\s+|\s*[-–—]\s*)\d/.test(source.slice(start + value.length))
    )
      return;
    candidates.add(value);
  }
  for (const source of [subject, body]) {
    for (const match of source.matchAll(
      /(?:验证码|\b(?:verification|security|temporary|one[- ]time|login)[\t ]+code\b|\bOTP\b)[\t ]*[:：]?[\t ]*(?:\r?\n[\t ]*)?(\S+)/gi
    )) {
      addCandidate(source, match, 4);
    }
  }
  if (/\bChatGPT\b/i.test(subject) && /verification\s+code/i.test(subject)) {
    for (const match of body.matchAll(/^[\t ]*(\S+)[\t ]*\r?$/gm)) {
      addCandidate(body, match, 6);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

function displayMail(row, parentId, aliasId, includeBody) {
  const received = Date.parse(row.receivedAt);
  if (!boundedId(String(row.id ?? '')) || !Number.isFinite(received)) return null;
  return {
    id: String(row.id),
    parentId,
    aliasId,
    from: [row.fromName, row.fromAddress].filter(Boolean).join(' · '),
    subject: String(row.subject ?? ''),
    code: verificationCode(row),
    ...(includeBody && { body: String(row.bodyText ?? '') }),
    receivedAt: beijingMinute(received),
    read: row.isRead === true
  };
}

function beijingMinute(epoch) {
  return new Date(epoch + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function writeJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

async function readBody(request, maximumBytes = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new RelayError(415, '请求必须使用 JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maximumBytes) {
      request.resume();
      throw new RelayError(413, '请求内容过长');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RelayError(400, '请求内容无效');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RelayError(400, '请求内容无效');
  }
  return body;
}

export function createAppleRelayService({ config, readInventory, savePrimaries, planIntake, fetchImpl, recordAction, recordActions, publicOrigin }) {
  const provider = config ? createVendureMailboxProvider(config, fetchImpl) : null;
  const primaryBindings = loadBindings(config?.primaryBindings);
  const aliasBindings = loadBindings(config?.aliasBindings);
  const importAliasIds = config?.importAliasIds ?? [];
  if (!Array.isArray(importAliasIds) || importAliasIds.length > 2 ||
      !importAliasIds.every(boundedId) || new Set(importAliasIds).size !== importAliasIds.length)
    throw new RelayError(503, '指定隐藏邮箱导入编号无效');
  const syncing = new Map();
  const historyPreviews = new Set();
  const publicAttempts = [];
  let activePublicQueries = 0;

  async function current() {
    return snapshot(await readInventory());
  }

  const remoteIdFor = (row) => primaryBindings.get(row.id) ||
    (boundedId(row.remotePrimaryId) ? row.remotePrimaryId : undefined);
  const remoteAliasIdFor = (row) => aliasBindings.get(row.id) ||
    (boundedId(row.remoteAliasId) ? row.remoteAliasId : undefined);
  const primaryManagement = provider && savePrimaries && createAppleRelayPrimaryManagement({
    provider, current, remoteIdFor, remoteAliasIdFor, importAliasIds, savePrimaries
  });

  function matchRows(local, primaries, aliases) {
    const matchedParents = matchPrimaries(local, primaries, remoteIdFor);
    return {
      primaries,
      aliases,
      matchedParents,
      matchedAliases: matchAliases(local, aliases, remoteAliasIdFor, matchedParents)
    };
  }

  async function matched(includeAliases) {
    const [local, primaries, aliases] = await Promise.all([
      current(),
      provider.primaryAccounts().then(checkedRows),
      includeAliases ? provider.virtualEmails().then(checkedRows) : []
    ]);
    return matchRows(local, primaries, aliases);
  }

  async function scopedTargets(local, kind, ids, includeCode = false) {
    const primaryIds = new Set();
    const aliasIds = new Set();
    for (const id of ids) {
      const alias = kind === 'alias' ? local.aliases.get(id) : null;
      if (kind === 'alias' && (!activeAlias(alias) || !remoteAliasIdFor(alias))) continue;
      const parent = local.parents.get(alias ? alias.parentMailboxId : id);
      if (!activeParent(parent) || !remoteIdFor(parent)) continue;
      primaryIds.add(remoteIdFor(parent));
      if (alias) aliasIds.add(remoteAliasIdFor(alias));
    }
    if (!primaryIds.size) return matchRows(local, [], []);
    const result = await provider.relayTargets([...primaryIds], [...aliasIds], includeCode ? kind : undefined);
    return matchRows(local, checkedRows(result.primaries), checkedRows(result.aliases));
  }

  async function record(action, actor, parentId = '', aliasId = '') {
    await recordAction?.({ action, actor, parentId, aliasId });
  }

  function requireParent(state, id) {
    if (!boundedId(id)) throw new RelayError(400, '请选择主邮箱');
    const selected = state.matchedParents.get(id);
    if (!selected) throw new RelayError(409, '主邮箱未绑定、已停用或归属未核对');
    return selected;
  }

  function requireAlias(state, id) {
    if (!boundedId(id)) throw new RelayError(400, '请选择隐藏邮箱');
    const selected = state.matchedAliases.get(id);
    if (!selected) throw new RelayError(409, '隐藏邮箱未绑定、已停用或归属未核对');
    return selected;
  }

  async function extractionCatalog() {
    if (!provider?.supportsCodeQuery) {
      throw new RelayError(503, 'Vendure 邮箱查询码入口尚未配置');
    }
    const [primaries, aliases] = await Promise.all([
      provider.primaryAccounts().then(checkedRows),
      provider.virtualEmails().then(checkedRows)
    ]);
    const remoteParents = uniqueRemoteRows(primaries);
    const remoteAliases = uniqueRemoteRows(aliases);
    const codeCounts = new Map();
    for (const value of [
      ...primaries.map((row) => row.masterQueryCode),
      ...aliases.map((row) => row.buyerQueryCode)
    ]) {
      const code = normalizeCode(value);
      if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
    return { remoteParents, remoteAliases, codeCounts };
  }

  function resolveExtractionAlias(local, { remoteParents, remoteAliases, codeCounts }, alias) {
    if (!activeAlias(alias) || alias.relayStatus !== 'ACTIVE') {
      return { reason: '隐藏邮箱已停用或待核对' };
    }
    if ((alias.health ?? 'normal') !== 'normal' || (alias.status ?? '正常') !== '正常') {
      return { reason: '隐藏邮箱账号状态异常' };
    }
    const parent = local.parents.get(alias.parentMailboxId);
    if (!activeParent(parent) || parent.status !== 'ACTIVE')
      return { reason: '主邮箱未启用或待核对' };
    const remoteParentId = remoteIdFor(parent);
    const remoteParent = remoteParents.get(remoteParentId);
    const parentEmail = normalizeEmail(parent.email);
    if (
      !remoteParent ||
      !emailPattern.test(parentEmail) ||
      parentEmail !== normalizeEmail(remoteParent.email)
    ) {
      return { reason: '主邮箱绑定未核实' };
    }
    if (remoteParent.status !== 'ACTIVE') return { reason: 'Vendure 主邮箱暂不可用' };

    const remoteAlias = remoteAliases.get(remoteAliasIdFor(alias));
    const aliasEmail = normalizeEmail(alias.email);
    if (
      !remoteAlias ||
      String(remoteAlias.primaryAccountId) !== remoteParentId ||
      !emailPattern.test(aliasEmail) ||
      aliasEmail !== normalizeEmail(remoteAlias.aliasEmail)
    ) {
      return { reason: '隐藏邮箱绑定或所属主邮箱未核实' };
    }
    if (remoteAlias.status !== 'ACTIVE') return { reason: 'Vendure 隐藏邮箱已停用或待核对' };

    const queryCode =
      typeof remoteAlias.buyerQueryCode === 'string' ? remoteAlias.buyerQueryCode.trim() : '';
    const code = normalizeCode(queryCode);
    if (!code || code.length > 100 || code.includes('@')) {
      return { reason: '买家查询码未设置或格式无效' };
    }
    if (codeCounts.get(code) !== 1) return { reason: '买家查询码存在重复' };
    const expiry = remoteAlias.codeExpiresAt;
    if (expiry !== null && (typeof expiry !== 'string' || !validExpiry(expiry))) {
      return { reason: '买家查询码已过期或有效期无效' };
    }
    return { queryCode };
  }

  async function checkExtractionEligibility(aliasIds, actor) {
    requireAdministrator(actor, '当前账号无权检查隐藏邮箱提取资格');
    validateExtractionIds(aliasIds, '请提交 1 至 100 个不同的本机隐藏邮箱编号');
    const catalog = await extractionCatalog();
    const inventory = await readInventory();
    const local = snapshot(inventory);
    const blocked = blockedRelayExtractions(inventory);

    function reasonFor(id) {
      const alias = local.aliases.get(id);
      if (!alias) return '找不到该隐藏邮箱库存';
      if (
        (alias.inventoryState ?? 'available') !== 'available' ||
        alias.used ||
        alias.claimId ||
        alias.claimBatchId ||
        hasRelayUsageLink(alias) ||
        blocked.has(id)
      ) {
        return '隐藏邮箱已有领用、实际使用或注册待核对记录';
      }
      return resolveExtractionAlias(local, catalog, alias).reason ?? null;
    }

    return {
      items: aliasIds.map((id) => {
        const reason = reasonFor(id);
        return { id, eligible: reason === null, reason };
      })
    };
  }

  function checkedExtractionClaims(inventory, claimIds, catalog) {
    const local = snapshot(inventory);
    const requested = new Set(claimIds);
    const claims = new Map();
    const usedAssets = new Set();
    for (const batch of inventory?.batches ?? []) {
      if (!Array.isArray(batch?.items)) continue;
      for (const item of batch.items) {
        if (item?.status === 'used') usedAssets.add(item.assetId);
        if (!requested.has(item?.id)) continue;
        if (claims.has(item.id)) throw new RelayError(409, '原领用编号重复，请刷新后核对');
        claims.set(item.id, { batch, item });
      }
    }
    for (const registration of inventory?.registrationRecords ?? []) {
      if (registration?.state === '成功') usedAssets.add(registration.assetId);
    }

    return claimIds.map((id) => {
      const claim = claims.get(id);
      const alias = local.aliases.get(claim?.item.assetId);
      if (
        claim?.batch.kind !== 'mail' ||
        claim.item.type !== 'relay' ||
        claim.item.status !== 'pending' ||
        !alias ||
        alias.inventoryState !== 'claimed' ||
        alias.claimId !== id ||
        alias.claimBatchId !== claim.batch.id ||
        alias.email !== claim.item.email ||
        hasRelayUsageLink(alias) ||
        usedAssets.has(alias.id)
      ) {
        throw new RelayError(409, '原领用已结束或资料已变化，请刷新后重新选择');
      }
      const target = resolveExtractionAlias(local, catalog, alias);
      if (target.reason) throw new RelayError(409, target.reason);
      return {
        id,
        email: alias.email,
        queryCode: target.queryCode,
        aliasId: alias.id,
        parentId: alias.parentMailboxId
      };
    });
  }

  async function extractionCodes(claimIds, actor) {
    validateExtractionIds(claimIds, '请提交 1 至 100 个不同的领用明细编号');
    const catalog = await extractionCatalog();
    const verified = checkedExtractionClaims(await readInventory(), claimIds, catalog);
    await Promise.all(
      verified.map(({ parentId, aliasId }) => record('read_code', actor, parentId, aliasId))
    );
    const currentClaims = checkedExtractionClaims(await readInventory(), claimIds, catalog);
    if (
      currentClaims.some(
        (item, index) =>
          item.aliasId !== verified[index].aliasId || item.parentId !== verified[index].parentId
      )
    ) {
      throw new RelayError(409, '领用资料已变化，请刷新后重新选择');
    }
    return { items: currentClaims.map(({ id, email, queryCode }) => ({ id, email, queryCode })) };
  }

  async function previewHistory(input, actor) {
    const { parentId } = input;
    if (
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'parentId') ||
      !boundedId(parentId)
    ) {
      throw new RelayError(400, '仅可提交有效的主邮箱编号');
    }
    if (historyPreviews.has(parentId) || historyPreviews.size >= historyPreviewConcurrentLimit) {
      throw new RelayError(429, '正在检查历史邮件，请稍后再试');
    }
    historyPreviews.add(parentId);
    try {
      const state = await matched(false);
      const parent = requireParent(state, parentId);
      if (
        parent.local.status !== 'ACTIVE' ||
        parent.remote.status !== 'ACTIVE' ||
        state.primaries.filter((row) => String(row.id) === parent.remoteId).length !== 1
      ) {
        throw new RelayError(409, '主邮箱状态或绑定无法核对，请刷新后重试');
      }
      const { email, version } = parent.local;
      const raw = await provider.previewHistory(parent.remoteId);
      const counts = historyCountFields.map((field) => [field, raw[field]]);
      if (counts.some(([, value]) => !Number.isSafeInteger(value) || value < 0)) {
        throw new RelayError(502, 'Vendure 邮箱服务返回的历史预检数量无效');
      }
      if (raw.updatedCount !== 0) {
        throw new RelayError(502, 'Vendure 邮箱服务返回的历史预检结果不符合只读要求');
      }
      const localNow = (await current()).parents.get(parentId);
      if (
        !activeParent(localNow) ||
        localNow.status !== 'ACTIVE' ||
        localNow.email !== email ||
        localNow.version !== version ||
        remoteIdFor(localNow) !== parent.remoteId
      ) {
        throw new RelayError(409, '主邮箱资料已变化，请刷新后重试');
      }
      await record('history_preview', actor, parentId);
      return Object.fromEntries(counts);
    } finally {
      historyPreviews.delete(parentId);
    }
  }

  async function lookupCodeTarget(kind, id) {
    if (!['parent', 'alias'].includes(kind)) throw new RelayError(400, '请选择邮箱类型');
    if (!boundedId(id)) throw new RelayError(400, '请选择邮箱');
    const state = await scopedTargets(await current(), kind, [id], true);
    return kind === 'alias' ? requireAlias(state, id) : requireParent(state, id);
  }

  const codeReset = createRelayCodeReset({
    lookup: lookupCodeTarget,
    mutate: (kind, remoteId, days) =>
      kind === 'parent'
        ? provider.resetPrimaryCode(remoteId, days)
        : provider.resetAliasCode(remoteId, days),
    record: (kind, target, actor) =>
      kind === 'parent'
        ? record('reset_code', actor, target.local.id)
        : record('reset_code', actor, target.owner.local.id, target.local.id)
  });

  async function lookupMailAssignment({ parentId, mailId, aliasId, sourceAliasId }) {
    if (
      !boundedId(parentId) ||
      !boundedId(mailId) ||
      !boundedId(aliasId) ||
      (sourceAliasId !== undefined && sourceAliasId !== '' && !boundedId(sourceAliasId))
    ) {
      throw new RelayError(400, '请选择主邮箱、邮件和目标隐藏邮箱');
    }
    const state = await matched(true);
    const parent = requireParent(state, parentId);
    const alias = requireAlias(state, aliasId);
    if (alias.owner.local.id !== parentId) {
      throw new RelayError(409, '目标隐藏邮箱与所选主邮箱不匹配');
    }

    const rows = checkedRows(await provider.mailAssignmentCandidates(parent.remoteId));
    const matches = rows.filter((row) => String(row.id) === mailId);
    const [mail] = matches;
    if (matches.length !== 1 || String(mail.primaryAccountId) !== parent.remoteId) {
      throw new RelayError(409, '未能在该主邮箱最近的收件记录中核对邮件，请刷新后重试');
    }
    const source =
      mail.virtualEmailId === null
        ? null
        : [...state.matchedAliases.values()].find(
            (entry) =>
              entry.remoteId === String(mail.virtualEmailId) && entry.owner.local.id === parentId
          );
    if (source === undefined) {
      throw new RelayError(409, '邮件当前所属的隐藏邮箱未绑定或已停用');
    }
    if (sourceAliasId !== undefined && sourceAliasId !== (source?.local.id ?? '')) {
      throw new RelayError(409, '邮件当前归属已变化，请刷新后重试');
    }
    if (source?.remoteId === alias.remoteId) {
      throw new RelayError(409, '邮件已归属该隐藏邮箱，请选择其他目标');
    }

    const localNow = await current();
    const currentParent = localNow.parents.get(parentId);
    const aliasChanged = (candidate) => {
      const currentAlias = localNow.aliases.get(candidate.local.id);
      return (
        !activeAlias(currentAlias) ||
        currentAlias.parentMailboxId !== parentId ||
        currentAlias.email !== candidate.local.email ||
        currentAlias.version !== candidate.local.version
      );
    };
    if (
      !activeParent(currentParent) ||
      currentParent.email !== parent.local.email ||
      currentParent.version !== parent.local.version ||
      aliasChanged(alias) ||
      (source && aliasChanged(source))
    ) {
      throw new RelayError(409, '邮箱资料已变化，请刷新后重试');
    }
    const received = Date.parse(mail.receivedAt);
    if (!Number.isFinite(received)) throw new RelayError(502, '邮件接收时间无法核对');
    return { parent, alias, source, mail, receivedAt: beijingMinute(received) };
  }

  const mailReassignment = createRelayMailReassignment({
    lookup: lookupMailAssignment,
    mutate: (mailId, virtualEmailId) => provider.reassignMail(mailId, virtualEmailId),
    record: ({ parent, alias }, actor) =>
      record('mail_reassign', actor, parent.local.id, alias.local.id)
  });

  function codeResult(target, kind, includeCode = true) {
    const queryCode =
      kind === 'parent' ? target.remote.masterQueryCode : target.remote.buyerQueryCode;
    if (includeCode && (typeof queryCode !== 'string' || !queryCode))
      throw new RelayError(404, '该邮箱尚无可查看的查询码');
    return {
      ...(includeCode && { queryCode }),
      codeExpiresAt: target.remote.codeExpiresAt ?? null,
      email: target.local.email,
      ...(kind === 'alias' && {
        mailCount: target.remote.mailCount,
        lastMailReceivedAt: target.remote.lastMailReceivedAt,
        lastQueriedAt: target.remote.lastQueriedAt
      })
    };
  }

  async function readCurrentCode({ kind, id }, actor) {
    if (!actor?.id) throw new RelayError(401, '请先登录');
    const target = await lookupCodeTarget(kind, id);
    const result = codeResult(target, kind);
    if (kind === 'parent') await record('read_code', actor, target.local.id);
    else await record('read_code', actor, target.owner.local.id, target.local.id);
    return result;
  }

  async function readCodePage(input, actor) {
    requireAdministrator(actor, '当前账号无权读取邮箱查询码');
    const { kind, ids, includeCode = true } = input;
    if (Object.keys(input).some(key => !['kind', 'ids', 'includeCode'].includes(key)) ||
        typeof includeCode !== 'boolean' || !['parent', 'alias'].includes(kind) ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
        !ids.every(boundedId) || new Set(ids).size !== ids.length)
      throw new RelayError(400, '请提交同一类型的 1 至 50 个不同邮箱编号');

    const state = await scopedTargets(await current(), kind, ids, includeCode);
    const select = (state, id) => kind === 'alias' ? requireAlias(state, id) : requireParent(state, id);
    const identity = target => JSON.stringify([target.remoteId, target.local.id,
      target.local.version, target.local.email, target.local.parentMailboxId,
      target.owner?.remoteId, target.owner?.local.version, target.owner?.local.email]);
    const failure = (id, error) => {
      if (!(error instanceof RelayError)) throw error;
      return { id, status: error.status, error: error.message };
    };
    const selected = ids.map(id => {
      try {
        const target = select(state, id);
        return { id, target, identity: identity(target), result: codeResult(target, kind, includeCode) };
      } catch (error) {
        return { id, failure: failure(id, error) };
      }
    });
    if (includeCode) {
      const audits = selected.filter(item => item.target).map(({ target }) => ({
        action: 'read_code', actor,
        parentId: (target.owner ?? target).local.id,
        aliasId: kind === 'alias' ? target.local.id : ''
      }));
      if (audits.length && recordActions) await recordActions(audits);
      else await Promise.all(audits.map(event => recordAction?.(event)));
    }

    // An asynchronous audit must not let a removed/rebound mailbox return an old code.
    const local = await current();
    const latest = matchRows(local, state.primaries, state.aliases);
    return { items: selected.map(item => {
      if (item.failure) return item.failure;
      try {
        if (identity(select(latest, item.id)) !== item.identity)
          throw new RelayError(409, '邮箱资料已变化，请刷新后重试');
        return { id: item.id, ...item.result };
      } catch (error) {
        return failure(item.id, error);
      }
    }) };
  }

  async function sync(parent) {
    if (!syncing.has(parent.remoteId)) {
      const pending = provider
        .syncPrimary(parent.remoteId)
        .then((result) => {
          if (result.success !== true) {
            throw new RelayError(502, '收件同步失败，请检查主邮箱连接后重试');
          }
          if (!Number.isSafeInteger(result.syncedCount) || result.syncedCount < 0) {
            throw new RelayError(502, 'Vendure 邮箱服务返回的同步数量无效');
          }
          return result.syncedCount;
        })
        .finally(() => syncing.delete(parent.remoteId));
      syncing.set(parent.remoteId, pending);
    }
    return syncing.get(parent.remoteId);
  }

  function localMailTarget(local, parentId, aliasId) {
    const row = aliasId ? local.aliases.get(aliasId) : null;
    if (aliasId && (!activeAlias(row) || !remoteAliasIdFor(row)))
      throw new RelayError(409, '隐藏邮箱未绑定、已停用或归属未核对');
    if (row && parentId && row.parentMailboxId !== parentId)
      throw new RelayError(400, '隐藏邮箱与所选主邮箱不匹配');
    const owner = local.parents.get(row ? row.parentMailboxId : parentId);
    if (!activeParent(owner) || !remoteIdFor(owner))
      throw new RelayError(409, '主邮箱未绑定、已停用或归属未核对');
    const parent = { local: owner, remoteId: remoteIdFor(owner) };
    return row ? { parent, alias: { local: row, remoteId: remoteAliasIdFor(row) } } : { parent };
  }

  function sameMailTarget(target, fresh) {
    return fresh.parent.local.id === target.parent.local.id &&
      fresh.parent.remoteId === target.parent.remoteId &&
      normalizeEmail(fresh.parent.local.email) === normalizeEmail(target.parent.local.email) &&
      fresh.alias?.local.id === target.alias?.local.id &&
      fresh.alias?.remoteId === target.alias?.remoteId &&
      normalizeEmail(fresh.alias?.local.email) === normalizeEmail(target.alias?.local.email);
  }

  function selectMailTarget(state, target) {
    const alias = target.alias ? requireAlias(state, target.alias.local.id) : null;
    const parent = requireParent(state, target.parent.local.id);
    const fresh = alias ? { parent: alias.owner, alias } : { parent };
    if (!sameMailTarget(target, fresh)) throw new RelayError(409, '邮箱资料已变更，请重新查询');
    return fresh;
  }

  async function readScopedMails(target, { unassignedOnly = false, limit, mailId }) {
    const { parent, alias } = target;
    const page = await provider.relayMailPage({
      primaryAccountId: parent.remoteId,
      virtualEmailId: alias?.remoteId,
      unassignedOnly,
      limit,
      ...(mailId && { mailId })
    });
    const state = matchRows(await current(), page.primary ? checkedRows([page.primary]) : [], checkedRows(page.aliases));
    const fresh = selectMailTarget(state, target);
    const aliases = new Map([...state.matchedAliases.values()]
      .filter(candidate => candidate.owner.local.id === parent.local.id)
      .map(candidate => [candidate.remoteId, candidate.local.id]));
    const items = new Map();
    for (const row of checkedRows(page.items)) {
      if (String(row.primaryAccountId) !== parent.remoteId || (mailId && String(row.id) !== mailId)) continue;
      const unassigned = row.virtualEmailId === null;
      const remoteAliasId = String(row.virtualEmailId ?? '');
      if ((alias && remoteAliasId !== alias.remoteId) ||
          (unassignedOnly && !unassigned) ||
          (!unassigned && !aliases.has(remoteAliasId))) continue;
      const mail = displayMail(row, parent.local.id, aliases.get(remoteAliasId) ?? '', Boolean(mailId));
      const messageKey = String(row.messageId ?? mail?.id ?? '');
      if (mail && !items.has(messageKey)) items.set(messageKey, mail);
    }
    const rows = [...items.values()].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    return {
      items: rows.slice(0, limit),
      truncated: page.truncated === true || rows.length > limit,
      lastSyncedAt: Number.isFinite(Date.parse(fresh.parent.remote.lastSyncedAt))
        ? fresh.parent.remote.lastSyncedAt : null
    };
  }

  async function listMails({ parentId = '', aliasId = '', unassignedOnly = false, refresh = true }, actor) {
    if ((parentId !== '' && !boundedId(parentId)) ||
        (aliasId !== '' && !boundedId(aliasId)) ||
        typeof unassignedOnly !== 'boolean' || typeof refresh !== 'boolean' ||
        (aliasId && unassignedOnly)) {
      throw new RelayError(400, '收件筛选条件无效');
    }
    const local = await current();
    const targets = parentId || aliasId
      ? [localMailTarget(local, parentId, aliasId)]
      : [...local.parents.values()].filter(row => activeParent(row) && remoteIdFor(row))
          .map(row => localMailTarget(local, row.id, ''));
    if (!targets.length) throw new RelayError(409, '请先绑定并核对至少一个主邮箱');

    const results = [];
    let next = 0;
    async function readNext() {
      while (next < targets.length) {
        const index = next++;
        const target = targets[index];
        const { parent, alias } = target;
        const status = { parentId: parent.local.id, lastSyncedAt: null, read: false, syncFailed: false };
        if (refresh) {
          try {
            const state = await scopedTargets(await current(), alias ? 'alias' : 'parent',
              [alias?.local.id ?? parent.local.id]);
            await sync(selectMailTarget(state, target).parent);
            await record('sync', actor, parent.local.id, alias?.local.id);
          } catch {
            status.syncFailed = true;
          }
        }
        try {
          const page = await readScopedMails(target, { unassignedOnly, limit: 200 });
          results[index] = { ...page, status: { ...status, lastSyncedAt: page.lastSyncedAt, read: true } };
        } catch (error) {
          const keepPrevious = error instanceof RelayError && (error.status >= 500 || error.status === 429);
          let retain = false;
          if (keepPrevious) {
            try {
              retain = sameMailTarget(target, localMailTarget(await current(), parent.local.id, alias?.local.id));
            } catch { /* A removed or disabled local binding cannot retain its previous result. */ }
          }
          if (targets.length === 1) {
            if (keepPrevious && !retain) throw new RelayError(409, '邮箱资料已变更，请重新查询');
            throw error;
          }
          results[index] = { items: [], truncated: false, status: { ...status, keepPrevious: retain } };
        }
      }
    }
    await Promise.all([readNext(), readNext()]);
    const items = results.flatMap(result => result.items)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    return {
      items: items.slice(0, mailLimit),
      truncated: results.some(result => result.truncated) || items.length > mailLimit,
      mailboxes: results.map(result => result.status)
    };
  }

  async function readMailDetail({ parentId, mailId, aliasId = '' }, actor) {
    requireAdministrator(actor, '当前账号无权查看邮件正文');
    if (!boundedId(parentId) || !boundedId(mailId) || (aliasId !== '' && !boundedId(aliasId)))
      throw new RelayError(400, '请选择有效的收件记录');
    const target = localMailTarget(await current(), parentId, aliasId);
    const result = await readScopedMails(target, { limit: 1, mailId });
    if (!result.items.length) throw new RelayError(404, '邮件不存在或归属已变化');
    return result.items[0];
  }

  async function lookupEmailTarget(email) {
    const local = await current();
    const normalized = normalizeEmail(email);
    const parents = [...local.parents.values()].filter(row =>
      activeParent(row) && normalizeEmail(row.email) === normalized);
    const aliases = [...local.aliases.values()].filter(row =>
      activeAlias(row) && normalizeEmail(row.email) === normalized);
    if (parents.length + aliases.length !== 1) throw new RelayError(404, '未找到已绑定的邮箱');
    const target = localMailTarget(local, parents[0]?.id, aliases[0]?.id);
    const state = await scopedTargets(local, target.alias ? 'alias' : 'parent',
      [target.alias?.local.id ?? target.parent.local.id]);
    return selectMailTarget(state, target);
  }

  async function lookupQueryCode(value, expected) {
    const verified = await provider.relayCodeTarget(normalizeCode(value), expected && {
      expectedPrimaryId: expected.parent.remoteId,
      expectedAliasId: expected.alias?.remoteId
    });
    if (Number.isSafeInteger(verified.retryAfterSeconds) && verified.retryAfterSeconds > 0) {
      const error = new RelayError(429, '查询次数过多，请稍后再试');
      error.retryAfterSeconds = verified.retryAfterSeconds;
      throw error;
    }
    if (!verified.primary) throw new RelayError(404, invalidPublicCode);
    const state = matchRows(await current(), checkedRows([verified.primary]),
      verified.alias ? checkedRows([verified.alias]) : []);
    const parents = [...state.matchedParents.values()];
    const aliases = [...state.matchedAliases.values()];
    if (parents.length !== 1 || (verified.alias && aliases.length !== 1))
      throw new RelayError(404, invalidPublicCode);
    const alias = aliases[0];
    const target = alias ? { parent: alias.owner, alias } : { parent: parents[0] };
    const expiresAt = (alias ?? target.parent).remote.codeExpiresAt ?? null;
    if (!validExpiry(expiresAt) || (expected && !sameMailTarget(expected, target)))
      throw new RelayError(404, invalidPublicCode);
    return { ...target, expiresAt };
  }

  async function queryScopedMails(value, byEmail) {
    const target = byEmail ? await lookupEmailTarget(value) : await lookupQueryCode(value);
    await sync(target.parent);
    const result = await readScopedMails(target, { limit: !byEmail && target.alias ? 5 : 200 });
    if (byEmail) return { ...result, target, expiresAt: null };
    const latest = await lookupQueryCode(value, target);
    if (!validExpiry(target.expiresAt)) throw new RelayError(404, invalidPublicCode);
    const expiresAt = target.expiresAt && latest.expiresAt && Date.parse(target.expiresAt) < Date.parse(latest.expiresAt)
      ? target.expiresAt : latest.expiresAt ?? target.expiresAt;
    return { ...result, target, expiresAt };
  }

  async function queryMails(input, actor) {
    const value = typeof input.query === 'string' ? input.query.trim() : '';
    if (!value || value.length > 254) throw new RelayError(400, '请输入邮箱地址或查询码');
    const byEmail = emailPattern.test(value);
    if (!byEmail && value.length > 100) throw new RelayError(400, '查询码长度无效');
    if (!byEmail && !provider.supportsCodeQuery)
      throw new RelayError(503, 'Vendure 邮箱查询码入口尚未配置');
    const { target: { parent, alias }, ...result } = await queryScopedMails(value, byEmail);
    await record('query', actor, parent.local.id, alias?.local.id);
    return {
      ...result,
      targetType: alias ? 'alias' : 'parent',
      parentId: parent.local.id,
      aliasId: alias?.local.id ?? '',
      email: (alias ?? parent).local.email
    };
  }

  function reservePublicQuery(response) {
    const now = Date.now();
    while (publicAttempts.length && publicAttempts[0] <= now - publicQueryWindowMs) {
      publicAttempts.shift();
    }
    if (publicAttempts.length >= publicQueryAttemptLimit) {
      response.setHeader(
        'Retry-After',
        Math.ceil((publicAttempts[0] + publicQueryWindowMs - now) / 1000)
      );
      throw new RelayError(429, '查询次数过多，请稍后再试');
    }
    publicAttempts.push(now);
    if (activePublicQueries >= publicQueryConcurrentLimit) {
      response.setHeader('Retry-After', '5');
      throw new RelayError(429, '查询繁忙，请稍后再试');
    }
    activePublicQueries += 1;
  }

  async function publicQueryMails(input) {
    const code = typeof input.queryCode === 'string' ? input.queryCode.trim() : '';
    if (!code || code.length > 100 || code.includes('@') || Object.keys(input).length !== 1) {
      throw new RelayError(400, '请输入有效的邮箱查询码');
    }
    const { target: { parent, alias }, items, expiresAt: codeExpiresAt, truncated } =
      await queryScopedMails(code, false);

    await record('public_query', publicQueryActor);
    return {
      success: true,
      targetType: alias ? 'VIRTUAL' : 'PRIMARY',
      primaryEmail: alias ? null : maskedEmail(parent.local.email),
      aliasEmail: alias ? maskedEmail(alias.local.email) : null,
      codeExpiresAt,
      items: items.map(({ subject, receivedAt, code }) => ({
        subject: subject.slice(0, 500),
        receivedAt,
        extractedCode: code
      })),
      truncated
    };
  }

  return {
    checkExtractionEligibility,
    async handlePublicQuery(request, response) {
      let reserved = false;
      try {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw new RelayError(405, '邮箱查询需要 POST 请求');
        }
        if (
          request.headers.origin !== (publicOrigin || `http://${request.headers.host}`) ||
          (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
        ) {
          throw new RelayError(403, '仅支持本机同源请求');
        }
        if (!provider?.supportsCodeQuery) throw new RelayError(503, '邮箱查询服务尚未配置');

        reservePublicQuery(response);
        reserved = true;
        const result = await publicQueryMails(await readBody(request));
        writeJson(response, 200, result);
      } catch (error) {
        let status = error instanceof RelayError ? error.status : 500;
        let message = status >= 500 ? '邮箱查询暂时不可用，请稍后再试' : error.message;
        if (status === 404 || status === 409) {
          status = 404;
          message = invalidPublicCode;
        }
        if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        writeJson(response, status, { success: false, error: message, message });
      } finally {
        if (reserved) activePublicQueries -= 1;
      }
    },
    async handle(request, response, route, actor) {
      const action = route.slice(prefix.length);
      try {
        if (!route.startsWith(prefix) || !allowedMethods.has(action)) {
          throw new RelayError(404, '邮箱服务操作不存在');
        }
        if (request.method !== allowedMethods.get(action)) {
          response.setHeader('Allow', allowedMethods.get(action));
          throw new RelayError(405, '邮箱服务不支持此请求方式');
        }
        const origin = publicOrigin || `http://${request.headers.host}`;
        if (
          (request.headers.origin && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] &&
            request.headers['sec-fetch-site'] !== 'same-origin') ||
          (request.method === 'POST' && request.headers.origin !== origin)
        ) {
          throw new RelayError(403, '仅支持本机同源请求');
        }
        if (action === 'status') {
          const local = await current();
          const parentIds = [...local.parents.values()]
            .filter((row) => activeParent(row) && remoteIdFor(row))
            .map(({ id }) => id);
          return writeJson(response, 200, {
            configured: Boolean(provider),
            codeQueryConfigured: Boolean(provider?.supportsCodeQuery),
            ...(importAliasIds.length && { aliasImportCount: importAliasIds.length }),
            ...(provider && { numbers: {
              parent: Object.fromEntries([...local.parents.values()].filter(remoteIdFor)
                .map((row) => [row.id, remoteIdFor(row)])),
              alias: Object.fromEntries([...local.aliases.values()].filter(remoteAliasIdFor)
                .map((row) => [row.id, remoteAliasIdFor(row)]))
            } }),
            parentIds,
            aliasIds: [...local.aliases.values()]
              .filter((row) => activeAlias(row) && remoteAliasIdFor(row) &&
                parentIds.includes(row.parentMailboxId))
              .map(({ id }) => id)
          });
        }
        if (action === 'history-preview') {
          requireAdministrator(actor, '当前账号无权检查历史邮件');
        }
        if (action === 'primary-save' || action === 'primary-import') {
          requireAdministrator(actor, '只有管理员可以管理主邮箱授权');
          if (!primaryManagement) throw new RelayError(503, '原收件服务未连接，暂无法保存或导入主邮箱');
          const input = await readBody(request);
          const result = action === 'primary-save'
            ? await primaryManagement.save(input, actor)
            : await primaryManagement.importExisting(input, actor);
          return writeJson(response, 200, result);
        }
        if (action === 'alias-register') {
          requireAdministrator(actor, '只有管理员可以登记隐藏邮箱');
          if (!primaryManagement) throw new RelayError(503, '原收件服务未连接，暂无法登记隐藏邮箱');
          const input = await readBody(request, 512 * 1024);
          const result = await primaryManagement.registerAliases(input, actor);
          return writeJson(response, 200, result);
        }
        if (action === 'alias-intake-preview' || action === 'alias-intake-confirm') {
          requireAdministrator(actor, '只有管理员可以历史入库');
          if (!primaryManagement || !planIntake) throw new RelayError(503, '原收件服务未连接，暂无法历史入库');
          const input = await readBody(request, 192 * 1024);
          const plan = planIntake(input);
          if (action === 'alias-intake-preview') return writeJson(response, 200, historicalIntakePreview(plan));
          requireHistoricalIntake(plan, input);
          if (!plan.pending.length) return writeJson(response, 200, { reused: plan.rows.length });
          const { parentId, parentVersion, days, pending } = plan;
          const result = await primaryManagement.registerAliases({ parentId, parentVersion, days, batch: true,
            rows: pending.map(({ email, note }) => ({ email, note })) }, actor, plan);
          return writeJson(response, 200, result);
        }
        if (action === 'extraction-eligibility' || action === 'extraction-codes') {
          const copy = action === 'extraction-codes';
          requireAdministrator(
            actor,
            copy ? '当前账号无权复制领用查询码' : '当前账号无权检查隐藏邮箱提取资格'
          );
          const input = await readBody(request, extractionBodyLimit);
          const field = copy ? 'claimIds' : 'aliasIds';
          if (Object.keys(input).length !== 1 || !Object.hasOwn(input, field)) {
            throw new RelayError(
              400,
              copy ? '仅可提交领用明细编号列表' : '仅可提交隐藏邮箱编号列表'
            );
          }
          const result = copy
            ? await extractionCodes(input.claimIds, actor)
            : await checkExtractionEligibility(input.aliasIds, actor);
          return writeJson(response, 200, result);
        }
        if (!provider) throw new RelayError(503, 'Vendure 邮箱服务尚未配置');
        const input = await readBody(request, action === 'code-read' ? 10 * 1024 : 4096);
        if (action === 'mails') return writeJson(response, 200, await listMails(input, actor));
        if (action === 'mail-detail') return writeJson(response, 200, await readMailDetail(input, actor));
        if (action === 'history-preview') {
          return writeJson(response, 200, await previewHistory(input, actor));
        }
        if (action === 'query') return writeJson(response, 200, await queryMails(input, actor));
        if (action === 'code-read')
          return writeJson(response, 200, await (Object.hasOwn(input, 'ids')
            ? readCodePage(input, actor) : readCurrentCode(input, actor)));
        if (action === 'code-reset-prepare')
          return writeJson(response, 200, await codeReset.prepare(input, actor));
        if (action === 'code-reset-confirm')
          return writeJson(response, 200, await codeReset.confirm(input, actor));
        if (action === 'mail-reassign-prepare')
          return writeJson(response, 200, await mailReassignment.prepare(input, actor));
        if (action === 'mail-reassign-confirm')
          return writeJson(response, 200, await mailReassignment.confirm(input, actor));

        if (!boundedId(input.parentId)) throw new RelayError(400, '请选择主邮箱');
        const parent = requireParent(await scopedTargets(await current(), 'parent', [input.parentId]), input.parentId);
        if (action === 'test') {
          const result = await provider.testConnection(parent.remoteId);
          const success = result.success === true;
          await record(success ? 'test' : 'test_failed', actor, parent.local.id);
          return writeJson(response, 200, {
            success,
            message: success ? '主邮箱连接正常' : '主邮箱连接失败，请核对应用专用密码与配置'
          });
        }
        const syncedCount = await sync(parent);
        await record('sync', actor, parent.local.id);
        return writeJson(response, 200, { success: true, syncedCount, message: '主邮箱同步完成' });
      } catch (error) {
        if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        const status = error instanceof RelayError ? error.status : 500;
        const message = error instanceof RelayError ? error.message : '邮箱操作暂时失败，请重试';
        writeJson(response, status, { message, error: message });
      }
    }
  };
}
