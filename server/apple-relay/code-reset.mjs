import { createHash, randomUUID } from 'node:crypto';
import { RelayError } from './vendure-provider.mjs';
import { checkWriteReceipt, describeWriteOperation } from '../write-operation.mjs';

const reviewLifetime = 90_000;
const relayDeliveryDomain = 'apple-relay-delivery';
const digestCode = code => createHash('sha256').update(String(code || '')).digest('hex');
const relayValidity = 30 * 86_400_000;
const isResetWindow = (expiry, startedAt) => Number.isFinite(Date.parse(expiry)) &&
  Math.abs(Date.parse(expiry) - startedAt - relayValidity) <= 120_000;

// Store only hashes of codes in receipts. The live binding is rechecked before
// returning a code on replay. A reserved write with no response stays pending.
export function createRelayDeliveryJournal({ read, write, transaction, inventoryVersion, audit, now = Date.now }) {
  const receiptKey = (operation, id) => 'write-receipt:' + digestCode(`relay-row\0${operation.domain}\0${id}`);
  const lockKey = id => 'write-receipt:' + digestCode(`relay-lock\0${id}`);
  return {
    start(operation, version, targets) {
      return transaction(() => {
        const current = read(operation.domain);
        if (checkWriteReceipt(current.data, operation))
          return { rows: current.data.rows.map(row => read(receiptKey(operation, row.id)).data || row), replayed: true };
        if (inventoryVersion() !== version) throw new RelayError(409, '隐藏邮箱库存已变化，请刷新后重新选择');
        const rows = targets.map(({ id, email, version }) => ({ id, email: email || '', version: version ?? 0, status: 'queued' }));
        write(operation.domain, 1, { fingerprint: operation.fingerprint, domains: [relayDeliveryDomain], rows });
        return { rows };
      });
    },
    claim(operation, target, remoteId, original, codeExpiresAt, startedAt, lookupAt, version, actor) {
      return transaction(() => {
        const domain = receiptKey(operation, target.id), current = read(domain), row = current.data || target;
        if (row.status !== 'queued') return { ok: false, row };
        const lockDomain = lockKey(remoteId), lock = read(lockDomain);
        let next;
        if (inventoryVersion() !== version) {
          next = { ...row, status: 'skipped', reason: '库存已变化，请重新核对' };
        } else if (lock.data?.operation || (lock.data?.at >= lookupAt && lock.data.digest !== original)) {
          next = { ...row, status: 'pending', reason: '同一邮箱正在更新或查询码已变化，请先核对' };
          const reserved = lock.data?.rowDomain && read(lock.data.rowDomain);
          const pending = reserved?.data;
          if (pending && (pending.status === 'pending' || (pending.status === 'running' && startedAt - pending.startedAt > 20_000)) &&
              pending.id === row.id && pending.email === row.email && pending.original !== original && isResetWindow(codeExpiresAt, pending.startedAt)) {
            write(lock.data.rowDomain, reserved.version + 1, { ...pending, status: 'success', digest: original, codeExpiresAt, reason: '' });
            write(lockDomain, lock.version + 1, { digest: original, at: now() });
            audit(pending.actor || actor, row.id);
            next = { ...row, status: 'skipped', reason: '上一操作已核对，本次未再次重置' };
          }
        } else {
          write(lockDomain, lock.version + 1, { operation: operation.domain, rowDomain: domain });
          next = { ...row, remoteId, original, startedAt, status: 'running', actor: { id: actor.id, name: actor.name, role: actor.role } };
        }
        write(domain, current.version + 1, next);
        return { ok: next.status === 'running', row: next };
      });
    },
    finish(operation, target, result, actor) {
      return transaction(() => {
        const domain = receiptKey(operation, target.id), current = read(domain), row = current.data || target;
        if (row.status === 'success' || (target.status === 'queued' && row.status !== 'queued')) return row;
        const saved = { ...row, ...result, reason: result.reason || '' };
        if (result.status === 'success') {
          const lockDomain = lockKey(row.remoteId), lock = read(lockDomain);
          if (lock.data?.operation !== operation.domain) return row;
          write(lockDomain, lock.version + 1, { digest: result.digest, at: now() });
          audit(row.actor || actor, row.id);
        }
        write(domain, current.version + 1, saved);
        return saved;
      });
    }
  };
}

function codeFor(kind, record) {
  return kind === 'parent' ? record.masterQueryCode : record.buyerQueryCode;
}

function emailFor(kind, record) {
  return kind === 'parent' ? record.email : record.aliasEmail;
}

function fingerprint(kind, target) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.local.id,
        target.local.version,
        target.local.email,
        target.remoteId,
        target.owner?.remoteId,
        codeFor(kind, target.remote),
        target.remote.codeExpiresAt ?? null
      ])
    )
    .digest('hex');
}

function verifiedReset(kind, target, result, validityDays, now) {
  const code = codeFor(kind, result);
  if (String(result.id) !== target.remoteId ||
      String(emailFor(kind, result)).toLowerCase() !== target.local.email.toLowerCase() ||
      (kind === 'alias' && String(result.primaryAccountId) !== target.owner.remoteId) ||
      typeof code !== 'string' || !code || code === codeFor(kind, target.remote) ||
      result.codeResetIntervalDays !== validityDays ||
      (validityDays === 0 ? result.codeExpiresAt != null : !(Date.parse(result.codeExpiresAt) > now)))
    throw new Error('Invalid reset result');
  return { queryCode: code, codeExpiresAt: result.codeExpiresAt ?? null, email: target.local.email };
}

export function createRelayDeliveryReset({ lookup, mutate, journal, readAliases, now = Date.now }) {
  return async (body, actor, operationId) => {
    const { mode, ids, inventoryVersion } = body;
    if (!['single', 'selected', 'all'].includes(mode) || !Number.isSafeInteger(inventoryVersion) || inventoryVersion < 0 ||
        (mode !== 'all' && (!Array.isArray(ids) || !ids.length || ids.length > 10000 ||
          (mode === 'single' && ids.length !== 1) || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !/^[\w.:-]{1,180}$/.test(id)))))
      throw new RelayError(400, '请选择要重置的隐藏邮箱');
    let operation;
    try { operation = describeWriteOperation(operationId, actor, [relayDeliveryDomain, mode, ids || [], inventoryVersion]); }
    catch (error) { throw new RelayError(error.status, error.message); }
    if (!operation || !journal) throw new RelayError(400, '重置操作编号无效，请重新打开页面');
    const { aliases, lookupBatch } = await readAliases();
    const targets = mode === 'all' ? [...aliases.values()] : ids.map(id => aliases.get(id) || { id });
    const started = journal.start(operation, inventoryVersion, targets);
    const receipts = started.rows.slice();
    const reply = row => ({ id: row.id, email: row.email, status: row.status === 'queued' || row.status === 'running' ? 'pending' : row.status,
      ...(row.reason && { reason: row.reason }), ...(row.codeExpiresAt && { expiresAt: row.codeExpiresAt }) });
    const eligible = ({ local, owner }) => (!local.health || local.health === 'normal') &&
      (!local.status || local.status === '正常') && owner.remote.status === 'ACTIVE';
    if (started.replayed) {
      for (let offset = 0; offset < receipts.length; offset += 4) await Promise.all(receipts.slice(offset, offset + 4).map(async (row, index) => {
        if ((row.status !== 'pending' && !(row.status === 'running' && now() - row.startedAt > 20_000)) ||
            !row.original || !row.remoteId) return;
        try {
          const target = await lookup('alias', row.id);
          if (row.remoteId !== target.remoteId || digestCode(target.remote.buyerQueryCode) === row.original ||
              !target.remote.buyerQueryCode || !isResetWindow(target.remote.codeExpiresAt, row.startedAt)) return;
          receipts[offset + index] = journal.finish(operation, row, { status: 'success', digest: digestCode(target.remote.buyerQueryCode),
            codeExpiresAt: target.remote.codeExpiresAt }, actor);
        } catch { /* A failed read back leaves the original result pending. */ }
      }));
    }
    let issued;
    async function reset(row, read, lookupAt) {
      let target;
      try { target = await read(row.id); }
      catch (error) {
        return journal.finish(operation, row, { status: error.status === 409 ? 'skipped' : 'failed',
          reason: error.status === 409 ? error.message : '邮箱资料未能核对，未提交重置' }, actor);
      }
      if ((target.local.version ?? 0) !== row.version || target.local.email !== row.email ||
          !target.remote.buyerQueryCode || !eligible(target))
        return journal.finish(operation, row, { status: 'skipped', reason: '邮箱状态、归属或收信授权待核对' }, actor);
      const claim = journal.claim(operation, row, target.remoteId, digestCode(target.remote.buyerQueryCode),
        target.remote.codeExpiresAt, now(), lookupAt, inventoryVersion, actor);
      if (!claim.ok) return claim.row;
      let result;
      try {
        result = verifiedReset('alias', target, await mutate('alias', target.remoteId, 30), 30, now());
        if (!isResetWindow(result.codeExpiresAt, now())) throw new Error('Invalid reset validity');
      }
      catch {
        return journal.finish(operation, claim.row, { status: 'pending', reason: '收信服务结果待核对' }, actor);
      }
      const saved = journal.finish(operation, claim.row, { status: 'success', digest: digestCode(result.queryCode),
        codeExpiresAt: result.codeExpiresAt }, actor);
      if (mode === 'single' && saved.status === 'success' && saved.digest === digestCode(result.queryCode)) issued = result;
      return saved;
    }
    const queued = receipts.flatMap((row, index) => row.status === 'queued' ? [{ row, index }] : []);
    for (let offset = 0; offset < queued.length; offset += 4) {
      const batch = queued.slice(offset, offset + 4), lookupAt = now();
      const targets = lookupBatch?.(batch.map(({ row }) => row.id));
      const read = id => targets ? targets.then(result => result(id)) : lookup('alias', id);
      await Promise.all(batch.map(async ({ row, index }) => { receipts[index] = await reset(row, read, lookupAt); }));
    }
    const row = receipts[0];
    if (started.replayed && !issued && mode === 'single' && row?.status === 'success') {
      try {
        const target = await lookup('alias', row.id);
        if (target.remoteId === row.remoteId && eligible(target) && digestCode(target.remote.buyerQueryCode) === row.digest)
          issued = { queryCode: target.remote.buyerQueryCode, codeExpiresAt: target.remote.codeExpiresAt, email: row.email };
      } catch { /* No code is returned if the binding cannot be checked. */ }
    }
    return { results: receipts.map(reply), ...(issued && { issued }), ...(started.replayed && { replayed: true }) };
  };
}

export function createRelayCodeReset({ lookup, mutate, record, now = Date.now }) {
  const reviews = new Map();
  const pending = new Set();

  function clearExpired(time) {
    for (const [key, review] of reviews) {
      if (review.validUntil <= time) reviews.delete(key);
    }
  }

  return {
    async prepare({ kind, id, validityDays }, actor) {
      if (!actor?.id) throw new RelayError(401, '请先登录');
      if (
        !['parent', 'alias'].includes(kind) ||
        typeof id !== 'string' ||
        !id ||
        !Number.isInteger(validityDays) ||
        validityDays < 0 ||
        validityDays > 36500
      ) {
        throw new RelayError(400, '请选择邮箱和有效天数');
      }
      const target = await lookup(kind, id);
      const key = kind + ':' + target.remoteId;
      if (pending.has(key)) throw new RelayError(409, '该邮箱正在重置，请稍后核对');
      const time = now();
      clearExpired(time);
      for (const [token, review] of reviews) {
        if (review.key === key && review.actorId === actor.id) reviews.delete(token);
      }
      if (reviews.size >= 128) throw new RelayError(429, '正在核对的操作过多，请稍后重试');
      const confirmation = randomUUID();
      const validUntil = time + reviewLifetime;
      reviews.set(confirmation, {
        key,
        kind,
        id,
        validityDays,
        actorId: actor.id,
        validUntil,
        fingerprint: fingerprint(kind, target)
      });
      return { confirmation, email: target.local.email, validityDays, validUntil };
    },
    async confirm({ confirmation }, actor) {
      if (!actor?.id) throw new RelayError(401, '请先登录');
      clearExpired(now());
      const review = reviews.get(confirmation);
      if (!review || review.actorId !== actor.id)
        throw new RelayError(409, '重置确认已失效，请重新核对');
      if (pending.has(review.key)) throw new RelayError(409, '该邮箱正在重置，请稍后核对');
      reviews.delete(confirmation);
      pending.add(review.key);
      try {
        const { kind, id, validityDays } = review;
        const target = await lookup(kind, id);
        if (review.validUntil <= now() || fingerprint(kind, target) !== review.fingerprint) {
          throw new RelayError(409, '邮箱绑定或查询码已变化，请重新核对');
        }
        let result;
        try {
          result = await mutate(kind, target.remoteId, validityDays);
          const verified = verifiedReset(kind, target, result, validityDays, now());
          await record(kind, target, actor);
          return verified;
        } catch {
          throw new RelayError(502, '重置结果待核对，请先检查上游邮箱当前查询码，避免重复重置');
        }
      } finally {
        pending.delete(review.key);
      }
    }
  };
}
