import { createHash, randomUUID } from 'node:crypto';
import { RelayError } from './vendure-provider.mjs';

const reviewLifetime = 90_000;

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
          const code = codeFor(kind, result);
          if (
            String(result.id) !== target.remoteId ||
            String(emailFor(kind, result)).toLowerCase() !== target.local.email.toLowerCase() ||
            (kind === 'alias' && String(result.primaryAccountId) !== target.owner.remoteId) ||
            typeof code !== 'string' ||
            !code ||
            code === codeFor(kind, target.remote) ||
            result.codeResetIntervalDays !== validityDays ||
            (validityDays === 0
              ? result.codeExpiresAt != null
              : !(Date.parse(result.codeExpiresAt) > now()))
          )
            throw new Error('Invalid reset result');
          await record(kind, target, actor);
          return {
            queryCode: code,
            codeExpiresAt: result.codeExpiresAt ?? null,
            email: target.local.email
          };
        } catch {
          throw new RelayError(502, '重置结果待核对，请先检查上游邮箱当前查询码，避免重复重置');
        }
      } finally {
        pending.delete(review.key);
      }
    }
  };
}
