import { createHash, randomUUID } from 'node:crypto';
import { RelayError } from './vendure-provider.mjs';

const reviewLifetime = 90_000;
const reviewFields = new Set(['parentId', 'mailId', 'aliasId', 'sourceAliasId']);

function fingerprint({ parent, alias, source, mail }) {
  const binding = (entry) =>
    entry && [entry.local.id, entry.local.version, entry.local.email, entry.remoteId];
  return createHash('sha256')
    .update(
      JSON.stringify([
        binding(parent),
        binding(alias),
        binding(source),
        mail.id,
        mail.primaryAccountId,
        mail.virtualEmailId,
        mail.messageId,
        mail.subject,
        mail.receivedAt,
        mail.updatedAt
      ])
    )
    .digest('hex');
}

export function createRelayMailReassignment({ lookup, mutate, record, now = Date.now }) {
  const reviews = new Map();
  const pending = new Set();

  function clearExpired(time) {
    for (const [token, review] of reviews) {
      if (review.validUntil <= time) reviews.delete(token);
    }
  }

  return {
    async prepare(input, actor) {
      if (!actor?.id) throw new RelayError(401, '请先登录');
      if (Object.keys(input).some((field) => !reviewFields.has(field))) {
        throw new RelayError(400, '邮件归属核对参数无效');
      }
      const target = await lookup(input);
      const key = String(target.mail.id);
      if (pending.has(key)) throw new RelayError(409, '该邮件正在调整归属，请稍后核对');
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
        input,
        actorId: actor.id,
        validUntil,
        fingerprint: fingerprint(target)
      });
      return {
        confirmation,
        validUntil,
        parentEmail: target.parent.local.email,
        aliasEmail: target.alias.local.email,
        sourceAliasEmail: target.source?.local.email ?? '',
        subject: String(target.mail.subject ?? '').slice(0, 500),
        receivedAt: target.receivedAt
      };
    },
    async confirm(input, actor) {
      if (!actor?.id) throw new RelayError(401, '请先登录');
      const { confirmation } = input;
      if (typeof confirmation !== 'string' || Object.keys(input).length !== 1) {
        throw new RelayError(400, '邮件归属确认参数无效');
      }
      clearExpired(now());
      const review = reviews.get(confirmation);
      if (!review || review.actorId !== actor.id) {
        throw new RelayError(409, '归属确认已失效，请重新核对');
      }
      if (pending.has(review.key)) throw new RelayError(409, '该邮件正在调整归属，请稍后核对');
      for (const [token, candidate] of reviews) {
        if (candidate.key === review.key) reviews.delete(token);
      }
      pending.add(review.key);
      try {
        const target = await lookup(review.input);
        if (review.validUntil <= now() || fingerprint(target) !== review.fingerprint) {
          throw new RelayError(409, '邮箱绑定或邮件归属已变化，请重新核对');
        }
        const { parent, alias, mail } = target;
        const mailId = String(mail.id);
        try {
          const result = await mutate(mailId, alias.remoteId);
          if (
            String(result.id) !== mailId ||
            String(result.primaryAccountId) !== parent.remoteId ||
            String(result.virtualEmailId) !== alias.remoteId
          ) {
            throw new Error('Unexpected reassignment result');
          }
          await record(target, actor);
          return { ok: true, parentId: parent.local.id, mailId, aliasId: alias.local.id };
        } catch {
          throw new RelayError(502, '邮件归属结果待核对，请刷新收件记录后查看');
        }
      } finally {
        pending.delete(review.key);
      }
    }
  };
}
