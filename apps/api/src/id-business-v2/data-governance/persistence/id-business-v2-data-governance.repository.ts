import { Injectable } from '@nestjs/common';
import { Prisma, type IdBusinessV2GovernanceJobItem } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type {
  GovernanceApprovalDecision,
  GovernanceJobType,
  GovernancePreviewItem
} from '../data-governance.types';

export type GovernanceJobItem = IdBusinessV2GovernanceJobItem;

export interface GovernanceItemCounts {
  pending: number;
  processing: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class IdBusinessV2DataGovernanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  findJobReplay(idempotencyKey: string, tx?: V2CommandTransaction) {
    return (tx ?? this.prisma).idBusinessV2GovernanceJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, type: true, requestedByUserId: true, previewSummary: true }
    });
  }

  createJob(
    tx: V2CommandTransaction,
    input: {
      id: string;
      jobNo: string;
      type: GovernanceJobType;
      reason: string;
      backupEvidence: string;
      previewHash: string;
      previewSummary: Record<string, unknown>;
      requestedByUserId: string;
      idempotencyKey: string;
      items: GovernancePreviewItem[];
    }
  ) {
    return tx.idBusinessV2GovernanceJob.create({
      data: {
        id: input.id,
        jobNo: input.jobNo,
        type: input.type,
        reason: input.reason,
        backupEvidence: input.backupEvidence,
        previewHash: input.previewHash,
        previewSummary: input.previewSummary as Prisma.InputJsonValue,
        requestedByUserId: input.requestedByUserId,
        totalItems: input.items.length,
        idempotencyKey: input.idempotencyKey,
        items: {
          create: input.items.map((item) => ({
            sequence: item.sequence,
            entityType: item.entityType,
            entityId: item.entityId,
            safeLabel: item.safeLabel,
            sourceDeletedAt: item.sourceDeletedAt,
            eligibility: item.eligibility as unknown as Prisma.InputJsonValue
          }))
        }
      }
    });
  }

  findApprovalJob(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2GovernanceJob.findUnique({
      where: { id },
      include: { approval: true }
    });
  }

  createApproval(
    tx: V2CommandTransaction,
    input: {
      jobId: string;
      approverUserId: string;
      decision: GovernanceApprovalDecision;
      reason: string;
      previewHash: string;
      decidedAt: Date;
    }
  ) {
    return tx.idBusinessV2GovernanceApproval.create({ data: input });
  }

  decideJob(
    tx: V2CommandTransaction,
    input: {
      jobId: string;
      status: 'approved' | 'rejected';
      decidedAt: Date;
    }
  ) {
    return tx.idBusinessV2GovernanceJob.updateMany({
      where: { id: input.jobId, status: 'pending_approval' },
      data: {
        status: input.status,
        approvedAt: input.status === 'approved' ? input.decidedAt : null,
        completedAt: input.status === 'rejected' ? input.decidedAt : null
      }
    });
  }

  cancelJob(
    tx: V2CommandTransaction,
    input: { jobId: string; requestedByUserId: string; completedAt: Date }
  ) {
    return tx.idBusinessV2GovernanceJob.updateMany({
      where: {
        id: input.jobId,
        requestedByUserId: input.requestedByUserId,
        status: 'pending_approval',
        approval: null
      },
      data: { status: 'cancelled', completedAt: input.completedAt }
    });
  }

  findCheckpointByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.idBusinessV2GovernanceCheckpoint.findUnique({
      where: { idempotencyKey }
    });
  }

  findCheckpointOrThrow(id: string) {
    return this.prisma.idBusinessV2GovernanceCheckpoint.findUniqueOrThrow({ where: { id } });
  }

  findClaimJob(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2GovernanceJob.findUnique({
      where: { id },
      include: { approval: true }
    });
  }

  resetProcessingItems(tx: V2CommandTransaction, jobId: string) {
    return tx.idBusinessV2GovernanceJobItem.updateMany({
      where: { jobId, status: 'processing' },
      data: { status: 'pending', resultCode: null, resultMessage: null }
    });
  }

  failRunningCheckpoints(tx: V2CommandTransaction, jobId: string, completedAt: Date) {
    return tx.idBusinessV2GovernanceCheckpoint.updateMany({
      where: { jobId, status: 'running' },
      data: { status: 'failed', errorCode: 'stale_execution_recovered', completedAt }
    });
  }

  setJobApproved(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2GovernanceJob.update({
      where: { id },
      data: { status: 'approved' }
    });
  }

  claimJob(tx: V2CommandTransaction, id: string, operatorId: string, startedAt: Date) {
    return tx.idBusinessV2GovernanceJob.updateMany({
      where: { id, status: 'approved' },
      data: { status: 'running', executedByUserId: operatorId, startedAt }
    });
  }

  findLatestCheckpoint(tx: V2CommandTransaction, jobId: string) {
    return tx.idBusinessV2GovernanceCheckpoint.findFirst({
      where: { jobId },
      select: { batchNo: true },
      orderBy: [{ batchNo: 'desc' }, { id: 'desc' }]
    });
  }

  findPendingItems(tx: V2CommandTransaction, jobId: string, take: number) {
    return tx.idBusinessV2GovernanceJobItem.findMany({
      where: { jobId, status: 'pending' },
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      take
    });
  }

  createCheckpoint(
    tx: V2CommandTransaction,
    input: {
      jobId: string;
      batchNo: number;
      idempotencyKey: string;
      status: 'running' | 'completed';
      cursorSequence: number;
      attemptedItems?: number;
      completedAt?: Date;
    }
  ) {
    return tx.idBusinessV2GovernanceCheckpoint.create({ data: input });
  }

  completeJobFromCounts(
    tx: V2CommandTransaction,
    input: {
      id: string;
      status: 'succeeded' | 'partially_succeeded' | 'failed';
      counts: GovernanceItemCounts;
      completedAt: Date;
    }
  ) {
    return tx.idBusinessV2GovernanceJob.update({
      where: { id: input.id },
      data: {
        status: input.status,
        succeededItems: input.counts.succeeded,
        skippedItems: input.counts.skipped,
        failedItems: input.counts.failed,
        completedAt: input.completedAt
      }
    });
  }

  claimItems(tx: V2CommandTransaction, itemIds: string[]) {
    return tx.idBusinessV2GovernanceJobItem.updateMany({
      where: { id: { in: itemIds }, status: 'pending' },
      data: { status: 'processing' }
    });
  }

  findJobForFinalize(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2GovernanceJob.findUnique({ where: { id } });
  }

  completeCheckpoint(
    tx: V2CommandTransaction,
    input: { id: string; counts: GovernanceItemCounts; completedAt: Date }
  ) {
    return tx.idBusinessV2GovernanceCheckpoint.update({
      where: { id: input.id },
      data: {
        status: 'completed',
        succeededItems: input.counts.succeeded,
        skippedItems: input.counts.skipped,
        failedItems: input.counts.failed,
        completedAt: input.completedAt
      }
    });
  }

  updateJobProgress(
    tx: V2CommandTransaction,
    input: {
      id: string;
      status: 'approved' | 'succeeded' | 'partially_succeeded' | 'failed';
      counts: GovernanceItemCounts;
      completedAt: Date | null;
    }
  ) {
    return tx.idBusinessV2GovernanceJob.update({
      where: { id: input.id },
      data: {
        status: input.status,
        succeededItems: input.counts.succeeded,
        skippedItems: input.counts.skipped,
        failedItems: input.counts.failed,
        completedAt: input.completedAt
      }
    });
  }

  async countJobItems(tx: V2CommandTransaction, jobId: string, itemIds?: string[]) {
    const baseWhere: Prisma.IdBusinessV2GovernanceJobItemWhereInput = {
      jobId,
      ...(itemIds ? { id: { in: itemIds } } : {})
    };
    const [pending, processing, succeeded, skipped, failed] = await Promise.all([
      tx.idBusinessV2GovernanceJobItem.count({ where: { ...baseWhere, status: 'pending' } }),
      tx.idBusinessV2GovernanceJobItem.count({ where: { ...baseWhere, status: 'processing' } }),
      tx.idBusinessV2GovernanceJobItem.count({ where: { ...baseWhere, status: 'succeeded' } }),
      tx.idBusinessV2GovernanceJobItem.count({ where: { ...baseWhere, status: 'skipped' } }),
      tx.idBusinessV2GovernanceJobItem.count({ where: { ...baseWhere, status: 'failed' } })
    ]);
    return { pending, processing, succeeded, skipped, failed };
  }

  findAccountRestoreState(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2Account.findUnique({
      where: { id },
      select: { deletedAt: true, lossReportedAt: true, soldByOrderId: true }
    });
  }

  restoreAccount(
    tx: V2CommandTransaction,
    input: { id: string; sourceDeletedAt: Date; operatorId: string }
  ) {
    return tx.idBusinessV2Account.updateMany({
      where: {
        id: input.id,
        deletedAt: input.sourceDeletedAt,
        lossReportedAt: null,
        soldByOrderId: null
      },
      data: { deletedAt: null, recordStatus: 'disabled', updatedByUserId: input.operatorId }
    });
  }

  restoreCustomer(
    tx: V2CommandTransaction,
    input: { id: string; sourceDeletedAt: Date; operatorId: string }
  ) {
    return tx.idBusinessV2Customer.updateMany({
      where: { id: input.id, deletedAt: input.sourceDeletedAt },
      data: { deletedAt: null, updatedByUserId: input.operatorId }
    });
  }

  findOptionRestoreState(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2Option.findUnique({
      where: { id },
      select: { deletedAt: true, uniqueKey: true }
    });
  }

  findOptionConflict(tx: V2CommandTransaction, uniqueKey: string) {
    return tx.idBusinessV2Option.findUnique({ where: { uniqueKey }, select: { id: true } });
  }

  restoreOption(
    tx: V2CommandTransaction,
    input: {
      id: string;
      sourceDeletedAt: Date;
      currentUniqueKey: string;
      originalUniqueKey: string;
      operatorId: string;
    }
  ) {
    return tx.idBusinessV2Option.updateMany({
      where: {
        id: input.id,
        deletedAt: input.sourceDeletedAt,
        uniqueKey: input.currentUniqueKey
      },
      data: {
        uniqueKey: input.originalUniqueKey,
        deletedAt: null,
        updatedByUserId: input.operatorId
      }
    });
  }

  restoreOrder(
    tx: V2CommandTransaction,
    input: {
      id: string;
      sourceDeletedAt: Date;
      expectedStatus: 'refunded' | 'cancelled' | 'failed';
      operatorId: string;
    }
  ) {
    return tx.idBusinessV2Order.updateMany({
      where: {
        id: input.id,
        deletedAt: input.sourceDeletedAt,
        status: input.expectedStatus
      },
      data: { deletedAt: null, updatedByUserId: input.operatorId }
    });
  }

  findExchangeRateRunForCleanup(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ExchangeRateRun.findUnique({
      where: { id },
      select: {
        status: true,
        startedAt: true,
        snapshot: {
          select: {
            id: true,
            _count: { select: { giftCards: true, providerSnapshots: true } }
          }
        }
      }
    });
  }

  async deleteExchangeRateRun(
    tx: V2CommandTransaction,
    input: { runId: string; snapshotId: string | null }
  ) {
    let deletedQuoteSamples = 0;
    let deletedProviderSnapshots = 0;
    let deletedSnapshots = 0;
    if (input.snapshotId) {
      const quotes = await tx.idBusinessV2ExchangeRateQuoteSample.deleteMany({
        where: { providerSnapshot: { snapshotId: input.snapshotId } }
      });
      const providers = await tx.idBusinessV2ExchangeRateProviderSnapshot.deleteMany({
        where: { snapshotId: input.snapshotId }
      });
      await tx.idBusinessV2ExchangeRateSnapshot.delete({ where: { id: input.snapshotId } });
      deletedQuoteSamples = quotes.count;
      deletedProviderSnapshots = providers.count;
      deletedSnapshots = 1;
    }
    await tx.idBusinessV2ExchangeRateRun.delete({ where: { id: input.runId } });
    return { deletedQuoteSamples, deletedProviderSnapshots, deletedSnapshots };
  }

  completeItem(
    tx: V2CommandTransaction,
    input: {
      id: string;
      status: 'succeeded' | 'skipped';
      resultCode: string;
      resultMessage: string;
      resultAuditLogId: string;
      processedAt: Date;
    }
  ) {
    return tx.idBusinessV2GovernanceJobItem.update({
      where: { id: input.id },
      data: {
        status: input.status,
        resultCode: input.resultCode,
        resultMessage: input.resultMessage,
        resultAuditLogId: input.resultAuditLogId,
        processedAt: input.processedAt
      }
    });
  }

  markItemFailed(
    tx: V2CommandTransaction,
    input: { id: string; resultAuditLogId: string; processedAt: Date }
  ) {
    return tx.idBusinessV2GovernanceJobItem.updateMany({
      where: { id: input.id, status: 'processing' },
      data: {
        status: 'failed',
        resultCode: 'execution_error',
        resultMessage: '执行失败，请根据审计编号排查后重新生成治理任务。',
        resultAuditLogId: input.resultAuditLogId,
        processedAt: input.processedAt
      }
    });
  }
}
