import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { toV2JsonDocument, type V2CommandTransaction } from '../../runtime/public-api';
import { object } from '../recharge-validation';

/** Caller must hold the original recharge transaction lock throughout reconciliation. */
export function findManualSettlementJobs(
  tx: V2CommandTransaction,
  source: IdBusinessV2RechargeJob
) {
  return tx.idBusinessV2RechargeJob.findMany({
    where: { ownerId: source.ownerId, accountKey: source.accountKey, plan: source.plan },
    take: 501
  });
}
export function writeManualSettlementRecord(
  tx: V2CommandTransaction,
  record: { accountKey: string; fileKey: string; document: unknown },
  settlement: Record<string, unknown>
) {
  return tx.idBusinessV2RechargeRecord.update({
    where: { accountKey_fileKey: { accountKey: record.accountKey, fileKey: record.fileKey } },
    data: {
      revision: { increment: 1 },
      document: toV2JsonDocument({ ...object(record.document), manual_settlement: settlement })
    }
  });
}
