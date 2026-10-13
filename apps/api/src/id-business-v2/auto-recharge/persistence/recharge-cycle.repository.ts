import { ConflictException } from '@nestjs/common';
import { toV2JsonDocument, type V2CommandTransaction } from '../../runtime/public-api';
import { rechargeDocumentDigest } from '../recharge-callback-receipts';
import { rechargeOperationIdentifier } from '../recharge-upgrade-protocol';
import type { CycleRecord } from '../recharge-cycle-state';

export function createCycleArchive(
  tx: V2CommandTransaction,
  job: { accountKey: string | null; ownerId: string },
  fileKey: string,
  document: unknown
) {
  if (!job.accountKey || !/^history\/[a-f0-9]{64}\.json$/.test(fileKey))
    throw new ConflictException('旧周期归档键无效');
  return tx.idBusinessV2RechargeRecord.create({
    data: {
      accountKey: job.accountKey,
      ownerId: job.ownerId,
      fileKey,
      revision: 1,
      document: toV2JsonDocument(document)
    }
  });
}

export function closeCycleRecord(
  tx: V2CommandTransaction,
  job: { accountKey: string | null; ownerId: string },
  record: CycleRecord,
  closure: object
) {
  if (record.accountKey !== job.accountKey || record.ownerId !== job.ownerId)
    throw new ConflictException('旧周期记录归属不一致');
  return tx.idBusinessV2RechargeRecord.update({
    where: {
      accountKey_fileKey: {
        accountKey: record.accountKey,
        fileKey: record.fileKey
      }
    },
    data: {
      revision: { increment: 1 },
      document: toV2JsonDocument({ ...(record.document as object), cycle_resolution: closure })
    }
  });
}

export async function closeCycleJobs(
  tx: V2CommandTransaction,
  job: { id: string; ownerId: string; accountKey: string | null; plan: string },
  identifiers: string[],
  reviewDigest: string
) {
  const sources = await tx.idBusinessV2RechargeJob.findMany({
    where: {
      ownerId: job.ownerId,
      accountKey: job.accountKey,
      id: { not: job.id }
    }
  });
  for (const source of sources) {
    const result = source.result as Record<string, unknown>;
    if (!identifiers.includes(String(rechargeOperationIdentifier(result)))) continue;
    if (source.state !== 'finished' && source.leaseUntil.getTime() > Date.now())
      throw new ConflictException('原任务仍在执行，不能转换订阅周期');
    await tx.idBusinessV2RechargeJob.update({
      where: { id: source.id },
      data: {
        result: toV2JsonDocument({
          ...result,
          cycle_resolution: {
            protocol: 1,
            status: 'closed',
            source_job_id: job.id,
            account_key: job.accountKey,
            target_plan: job.plan,
            review_digest: reviewDigest,
            original_document_digest: rechargeDocumentDigest(result),
            closed_at: new Date().toISOString()
          }
        })
      }
    });
  }
}
