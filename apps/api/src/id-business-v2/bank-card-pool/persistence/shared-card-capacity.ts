import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isMysqlRuntimeDatabase } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

const ATTEMPT_LIMIT = 500;
const OUTCOMES = new Set(['pending', 'paid', 'declined', 'resolved']);
const READ_CONFLICT = '银行卡付款额度正在核对，请稍后重新核对';

export class SharedCardBusyConflict extends ConflictException {
  constructor() {
    super('银行卡资料正在被核对，请稍后重试');
  }
}

export function sharedCardReadConflict(error: unknown): ConflictException {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const meta =
    value.meta && typeof value.meta === 'object' ? (value.meta as Record<string, unknown>) : {};
  return value.errno === 3572 ||
    (value.code === 'P2010' && (meta.code === '3572' || meta.code === 3572))
    ? new SharedCardBusyConflict()
    : new ConflictException(READ_CONFLICT);
}

function mysqlJobs(value: unknown): { id: string; result: Record<string, unknown> }[] {
  if (!Array.isArray(value)) throw new ConflictException(READ_CONFLICT);
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new ConflictException(READ_CONFLICT);
    const row = item as Record<string, unknown>;
    const result: unknown = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result)
    )
      throw new ConflictException(READ_CONFLICT);
    return { id: row.id, result: result as Record<string, unknown> };
  });
}

/** Read only; callers must hold the shared bank card lock while allocating capacity. */
export async function bitBrowserPendingCapacity(
  tx: V2CommandTransaction,
  cardId: string,
  excludeJobId?: string
): Promise<number> {
  const mysql = isMysqlRuntimeDatabase();
  let jobs: { id: string; result: unknown }[];
  try {
    jobs = mysql
      ? mysqlJobs(
          await tx.$queryRaw(Prisma.sql`
          SELECT j.id, j.result
          FROM online_recharge_cards s
          STRAIGHT_JOIN id_business_v2_bank_recharge_cards l ON l.number_hash = s.number_hash
          STRAIGHT_JOIN id_business_v2_recharge_jobs j FORCE INDEX (id_business_v2_recharge_jobs_card_id_idx) ON j.card_id = l.id
          WHERE s.id = ${cardId}
            AND j.id <> ${excludeJobId ?? ''}
          ORDER BY j.id
          LIMIT 501
          FOR SHARE NOWAIT
        `)
        )
      : await tx.idBusinessV2RechargeJob.findMany({
          where: {
            result: { path: '$._shared_card_attempt_v1.cardId', equals: cardId },
            ...(excludeJobId ? { id: { not: excludeJobId } } : {})
          },
          select: { id: true, result: true },
          orderBy: { id: 'asc' },
          take: ATTEMPT_LIMIT + 1
        });
  } catch (error) {
    throw mysql ? sharedCardReadConflict(error) : new ConflictException(READ_CONFLICT);
  }
  if (jobs.length > ATTEMPT_LIMIT)
    throw new ConflictException('银行卡待核对付款记录过多，暂不能分配');
  let pending = 0;
  for (const job of jobs) {
    if (job.id === excludeJobId) continue;
    const result = job.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    const value = (result as Record<string, unknown>)._shared_card_attempt_v1;
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (mysql) throw new ConflictException(READ_CONFLICT);
      continue;
    }
    const attempt = value as Record<string, unknown>;
    if (attempt.cardId !== cardId) {
      if (mysql) throw new ConflictException(READ_CONFLICT);
      continue;
    }
    const authorizedAt =
      typeof attempt.authorizedAt === 'string' ? Date.parse(attempt.authorizedAt) : NaN;
    if (
      !Number.isFinite(authorizedAt) ||
      new Date(authorizedAt).toISOString() !== attempt.authorizedAt ||
      typeof attempt.outcome !== 'string' ||
      !OUTCOMES.has(attempt.outcome)
    )
      throw new ConflictException('银行卡付款额度记录不完整，暂不能分配');
    if (attempt.outcome === 'pending') pending++;
  }
  return pending;
}
