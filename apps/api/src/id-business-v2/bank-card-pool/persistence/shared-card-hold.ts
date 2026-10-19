import type { OnlineRechargeCard } from '@prisma/client';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { V2TransactionalAuditService } from '../../runtime/public-api';
import { isMysqlRuntimeDatabase } from '../../../common/prisma/mysql-transaction-lock';
import { sharedCardReadConflict } from './shared-card-capacity';

/** Caller holds shared-bank-card-pool. Never takes an auto/name lock or writes a job. */
export async function releaseExpiredBitBrowserCardHold(
  tx: V2CommandTransaction,
  card: Pick<OnlineRechargeCard, 'id' | 'leaseOwner' | 'leaseExpiresAt'>
) {
  if (!card.leaseOwner || !card.leaseExpiresAt || card.leaseExpiresAt.getTime() > Date.now())
    return false;
  let job: { id: string; action: string; result: unknown; leaseUntil: Date } | null;
  if (isMysqlRuntimeDatabase()) {
    try {
      const rows = await tx.$queryRaw<
        { id: string; action: string; result: unknown; leaseUntil: Date }[]
      >`
        SELECT id, action, result, lease_until AS leaseUntil FROM id_business_v2_recharge_jobs
        WHERE id = ${card.leaseOwner} LIMIT 1 FOR SHARE NOWAIT
      `;
      if (!Array.isArray(rows)) throw new Error('Invalid hold projection');
      job = rows[0] ?? null;
      if (job && typeof job.result === 'string') job.result = JSON.parse(job.result);
    } catch (error) {
      throw sharedCardReadConflict(error);
    }
  } else job = await tx.idBusinessV2RechargeJob.findUnique({ where: { id: card.leaseOwner } });
  if (
    !job ||
    job.action !== 'bitbrowser' ||
    !(job.leaseUntil instanceof Date) ||
    job.leaseUntil.getTime() > Date.now()
  )
    return false;
  const result =
    job.result && typeof job.result === 'object' && !Array.isArray(job.result)
      ? (job.result as Record<string, unknown>)
      : {};
  const value = result._shared_card_attempt_v1;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  if (
    attempt.cardId !== card.id ||
    attempt.outcome !== 'pending' ||
    typeof attempt.authorizedAt !== 'string' ||
    !Number.isFinite(Date.parse(attempt.authorizedAt)) ||
    new Date(Date.parse(attempt.authorizedAt)).toISOString() !== attempt.authorizedAt ||
    Date.parse(attempt.authorizedAt) + 120000 > Date.now() ||
    result.payment_attempted !== true
  )
    return false;
  const released = await tx.onlineRechargeCard.updateMany({
    where: { id: card.id, leaseOwner: card.leaseOwner, leaseExpiresAt: card.leaseExpiresAt },
    data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
  });
  if (released.count === 1)
    await new V2TransactionalAuditService().append(tx, {
      module: 'id_business_v2',
      action: 'id_business_v2.bank_card_pool.payment_hold.release',
      objectType: 'recharge_job',
      objectId: card.leaseOwner,
      afterData: { cardId: card.id, paymentUnresolved: true, subscriptionCapacityReserved: true },
      remark: '原付款授权等待已达两分钟，仅释放原卡独占；原账号防重与未决额度保留'
    });
  return released.count === 1;
}
