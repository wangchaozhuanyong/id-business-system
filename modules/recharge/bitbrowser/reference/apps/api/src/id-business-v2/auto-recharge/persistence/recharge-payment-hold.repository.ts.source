import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../../runtime/public-api';
import { lockSharedBankCards, type BitBrowserCardAttempt } from '../../bank-card-pool/public-api';
import type { RechargeRepository } from './recharge.repository';
import type { BankRechargeCardService } from '../bank-recharge-card.service';
import { object } from '../recharge-validation';
import { resolvedDeclinedPayment, resolvedUnknownPayment } from '../recharge-noncharge-proof';
import { rechargeOperationIdentifier } from '../recharge-upgrade-protocol';

export const CARD_ATTEMPT_KEY = '_shared_card_attempt_v1';
export const PAYMENT_HOLD_MS = 120000;
export class NoRechargeHoldChanges extends Error {}

export function rechargeCardAttempt(
  job: Pick<IdBusinessV2RechargeJob, 'result'>
): BitBrowserCardAttempt | undefined {
  const result = object(job.result);
  if (!Object.hasOwn(result, CARD_ATTEMPT_KEY)) return;
  const value = object(result[CARD_ATTEMPT_KEY]);
  if (
    typeof value.cardId !== 'string' ||
    !value.cardId ||
    typeof value.authorizedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.authorizedAt)) ||
    !['pending', 'paid', 'declined', 'resolved'].includes(String(value.outcome))
  )
    throw new ConflictException('原付款的银行卡占用记录未核实');
  return value as BitBrowserCardAttempt;
}

export function rechargePaymentHoldDeadline(job: Pick<IdBusinessV2RechargeJob, 'result'>) {
  const attempt = rechargeCardAttempt(job);
  if (attempt) return new Date(Date.parse(attempt.authorizedAt) + PAYMENT_HOLD_MS);
  const previous = object(job.result),
    confirmation = object(previous._direct_confirmation_v1 ?? {});
  if (
    previous.manual_confirmation_accepted === true &&
    confirmation.consumed === true &&
    typeof confirmation.consumedAt === 'string' &&
    Number.isFinite(Date.parse(confirmation.consumedAt))
  )
    return new Date(Date.parse(confirmation.consumedAt) + PAYMENT_HOLD_MS);
}

// Legacy timestamps are accepted only from the API-consumed authorization or its unique audit.
export async function recoverRechargeCardAttempt(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  cards?: BankRechargeCardService
): Promise<BitBrowserCardAttempt | undefined> {
  const existing = rechargeCardAttempt(job);
  if (existing || !cards || job.action !== 'bitbrowser') return existing;
  const result = object(job.result),
    confirmation = object(result._direct_confirmation_v1 ?? {});
  if (
    result.payment_attempted !== true ||
    result.manual_confirmation_accepted !== true ||
    confirmation.consumed !== true ||
    confirmation.checkoutIdentifier !== rechargeOperationIdentifier(result) ||
    confirmation.quoteDigest !== result.quote_digest
  )
    return;
  let authorizedAt =
    typeof confirmation.consumedAt === 'string' ? confirmation.consumedAt : undefined;
  if (!authorizedAt) {
    const audits = await tx.auditLog.findMany({
      where: {
        objectId: job.id,
        action: 'id_business_v2.auto_recharge.web_direct.confirm',
        userId: job.ownerId
      },
      take: 2
    });
    if (
      audits.length !== 1 ||
      object(audits[0]!.afterData).checkoutIdentifier !== confirmation.checkoutIdentifier ||
      object(audits[0]!.afterData).quoteDigest !== confirmation.quoteDigest
    )
      return;
    authorizedAt = audits[0]!.createdAt.toISOString();
  }
  if (
    !Number.isFinite(Date.parse(authorizedAt)) ||
    Date.parse(authorizedAt) < job.createdAt.getTime() ||
    Date.parse(authorizedAt) > Date.now()
  )
    return;
  const attempt = await cards.recoverSharedAttempt(tx, job.id, authorizedAt, job.cardId);
  if (attempt) job.result = toV2JsonDocument({ ...result, [CARD_ATTEMPT_KEY]: attempt });
  return attempt;
}

export async function reconcileRechargePaymentHolds(input: {
  tx: V2CommandTransaction;
  repository: RechargeRepository;
  cards?: BankRechargeCardService;
  audit: V2TransactionalAuditService;
  ownerId: string;
}) {
  if (!input.cards) return false;
  const { tx, repository, cards, audit, ownerId } = input;
  // Reconcile actual held cards, never a recent-history slice that can hide an old lease.
  await lockSharedBankCards(tx);
  const held = await tx.onlineRechargeCard.findMany({
    where: { leaseOwner: { not: null } },
    select: { leaseOwner: true },
    orderBy: { id: 'asc' },
    take: 501
  });
  if (held.length > 500) throw new ConflictException('待核对银行卡占用过多，请定向处理原任务');
  const owners = [
    ...new Set(held.map((card) => card.leaseOwner).filter((id): id is string => Boolean(id)))
  ];
  if (!owners.length) return false;
  const jobs = await tx.idBusinessV2RechargeJob.findMany({
    where: { ownerId, action: 'bitbrowser', id: { in: owners } },
    take: 501
  });
  let changed = false;
  for (const job of jobs) {
    if (resolvedDeclinedPayment(job.result) || resolvedUnknownPayment(job)) {
      await settleResolvedRechargeCard(tx, job, cards);
      await repository.updateJob(tx, job.id, {
        state: 'finished',
        leaseUntil: new Date(),
        result: toV2JsonDocument(object(job.result))
      });
      changed = true;
      continue;
    }
    const before = JSON.stringify(job.result);
    const attempt = await recoverRechargeCardAttempt(tx, job, cards);
    if (!attempt || attempt.outcome !== 'pending' || attempt.holdReleasedAt) continue;
    const deadline = new Date(Date.parse(attempt.authorizedAt) + PAYMENT_HOLD_MS);
    if (deadline.getTime() > Date.now()) {
      if (before !== JSON.stringify(job.result) || job.leaseUntil.getTime() > deadline.getTime()) {
        await repository.updateJob(tx, job.id, {
          leaseUntil: new Date(Math.min(job.leaseUntil.getTime(), deadline.getTime())),
          result: toV2JsonDocument(object(job.result))
        });
        changed = true;
      }
      continue;
    }
    await cards.releaseSharedHold(tx, job.id);
    await repository.updateJob(tx, job.id, {
      state: 'finished',
      leaseUntil: new Date(),
      result: toV2JsonDocument({
        ...object(job.result),
        [CARD_ATTEMPT_KEY]: { ...attempt, holdReleasedAt: new Date().toISOString() }
      })
    });
    await audit.append(tx, {
      userId: ownerId,
      module: 'id_business_v2',
      action: 'id_business_v2.auto_recharge.payment_hold.release',
      objectType: 'recharge_job',
      objectId: job.id,
      afterData: {
        cardId: attempt.cardId,
        paymentUnresolved: true,
        subscriptionCapacityReserved: true
      },
      remark: '付款等待已达两分钟，仅释放执行和原卡独占；原单防重及未决订阅额度保留'
    });
    changed = true;
  }
  return changed;
}

export async function settleResolvedRechargeCard(
  tx: V2CommandTransaction,
  source: IdBusinessV2RechargeJob,
  cards?: BankRechargeCardService
) {
  if (!cards) return;
  const attempt = await recoverRechargeCardAttempt(tx, source, cards);
  const report = {
    payment_attempted: false,
    payment_requests_sent: 0,
    ...(object(source.result).payment_status === 'declined' ? { payment_status: 'declined' } : {})
  };
  const settled = attempt
    ? await cards.finishSharedCard(tx, source.id, report, false, attempt)
    : await cards.finishSharedCard(tx, source.id, report, false);
  if (settled)
    source.result = toV2JsonDocument({ ...object(source.result), [CARD_ATTEMPT_KEY]: settled });
}
