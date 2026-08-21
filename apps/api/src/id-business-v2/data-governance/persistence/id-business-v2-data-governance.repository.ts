import { Injectable } from '@nestjs/common';
import { Prisma, type IdBusinessV2GovernanceJobItem } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isV2MysqlDatabase, type V2CommandTransaction } from '../../runtime/public-api';
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
      data: {
        deletedAt: null,
        recordStatus: 'disabled',
        disabledReason: '数据治理恢复，待人工复核',
        disabledAt: new Date(),
        updatedByUserId: input.operatorId
      }
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
      select: {
        deletedAt: true,
        uniqueKey: true,
        type: true,
        status: true,
        statusBeforeDeletion: true,
        deletedByParentOptionId: true
      }
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
      originalStatus: 'active' | 'disabled';
      operatorId: string;
    }
  ) {
    return tx.idBusinessV2Option.updateMany({
      where: {
        id: input.id,
        deletedAt: input.sourceDeletedAt,
        uniqueKey: input.currentUniqueKey,
        statusBeforeDeletion: input.originalStatus
      },
      data: {
        uniqueKey: input.originalUniqueKey,
        status: input.originalStatus,
        statusBeforeDeletion: null,
        deletedByParentOptionId: null,
        deletedAt: null,
        updatedByUserId: input.operatorId
      }
    });
  }

  restoreDependentService(
    tx: V2CommandTransaction,
    input: {
      id: string;
      sourceDeletedAt: Date;
      currentUniqueKey: string;
      originalUniqueKey: string;
      originalStatus: 'active' | 'disabled';
      parentOptionId: string;
      operatorId: string;
    }
  ) {
    return tx.idBusinessV2Option.updateMany({
      where: {
        id: input.id,
        type: 'service',
        deletedAt: input.sourceDeletedAt,
        uniqueKey: input.currentUniqueKey,
        statusBeforeDeletion: input.originalStatus,
        deletedByParentOptionId: input.parentOptionId
      },
      data: {
        uniqueKey: input.originalUniqueKey,
        status: input.originalStatus,
        statusBeforeDeletion: null,
        deletedByParentOptionId: null,
        deletedAt: null,
        updatedByUserId: input.operatorId
      }
    });
  }

  restoreSupplierWallets(
    tx: V2CommandTransaction,
    input: { supplierOptionId: string; sourceDeletedAt: Date; operatorId: string }
  ) {
    return tx.idBusinessV2TopupSupplierAccount.updateMany({
      where: {
        supplierOptionId: input.supplierOptionId,
        status: 'disabled',
        disabledByOptionDeletionAt: input.sourceDeletedAt
      },
      data: {
        status: 'active',
        disabledByOptionDeletionAt: null,
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

  async findExchangeRateRunForCleanup(tx: V2CommandTransaction, id: string) {
    const run = await tx.idBusinessV2ExchangeRateRun.findUnique({
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
    if (!run) return null;
    const [financeReferenceCount, settings] = await Promise.all([
      run.snapshot
        ? tx.idBusinessV2FinanceFxRateSnapshot.count({
            where: { source: 'combined_p2p', sourceReference: run.snapshot.id }
          })
        : 0,
      tx.idBusinessV2ExchangeRateSettings.findUnique({
        where: { id: 1 },
        select: { retentionDays: true }
      })
    ]);
    return {
      ...run,
      financeReferenceCount,
      retentionDays: settings?.retentionDays ?? 30
    };
  }

  async deleteExchangeRateRun(tx: V2CommandTransaction, input: { itemId: string; runId: string }) {
    if (!isV2MysqlDatabase()) {
      const rows = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT public.execute_id_business_v2_governance_exchange_rate_cleanup(
          ${input.itemId}::UUID,
          ${input.runId}::UUID
        ) AS "result"
      `);
      const result = rows[0]?.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('汇率治理清理返回格式无效');
      }
      return {
        deletedQuoteSamples: this.cleanupResultCount(result, 'deletedQuoteSamples'),
        deletedProviderSnapshots: this.cleanupResultCount(result, 'deletedProviderSnapshots'),
        deletedSnapshots: this.cleanupResultCount(result, 'deletedSnapshots')
      };
    }

    const item = await tx.idBusinessV2GovernanceJobItem.findUnique({
      where: { id: input.itemId },
      include: { job: { include: { approval: true } } }
    });
    const approval = item?.job.approval;
    const eligibility = item?.eligibility;
    if (
      !item ||
      item.entityType !== 'exchange_rate_run' ||
      item.entityId !== input.runId ||
      item.status !== 'processing' ||
      item.job.type !== 'exchange_rate_cleanup' ||
      item.job.status !== 'running' ||
      !approval ||
      approval.decision !== 'approved' ||
      approval.approverUserId === item.job.requestedByUserId ||
      approval.previewHash !== item.job.previewHash ||
      !item.job.executedByUserId ||
      item.job.backupEvidence.trim().length < 8 ||
      !eligibility ||
      typeof eligibility !== 'object' ||
      Array.isArray(eligibility) ||
      eligibility.eligible !== true
    ) {
      throw new Error('汇率治理清理审批证据无效');
    }

    const snapshot = await tx.idBusinessV2ExchangeRateSnapshot.findUnique({
      where: { runId: input.runId },
      select: { id: true }
    });
    const providerSnapshots = snapshot
      ? await tx.idBusinessV2ExchangeRateProviderSnapshot.findMany({
          where: { snapshotId: snapshot.id },
          select: { id: true }
        })
      : [];
    const providerSnapshotIds = providerSnapshots.map((row) => row.id);
    const deletedQuoteSamples = providerSnapshotIds.length
      ? (
          await tx.idBusinessV2ExchangeRateQuoteSample.deleteMany({
            where: { providerSnapshotId: { in: providerSnapshotIds } }
          })
        ).count
      : 0;
    const deletedProviderSnapshots = snapshot
      ? (
          await tx.idBusinessV2ExchangeRateProviderSnapshot.deleteMany({
            where: { snapshotId: snapshot.id }
          })
        ).count
      : 0;
    const deletedSnapshots = snapshot
      ? (
          await tx.idBusinessV2ExchangeRateSnapshot.deleteMany({
            where: { id: snapshot.id }
          })
        ).count
      : 0;
    const deletedRuns = (
      await tx.idBusinessV2ExchangeRateRun.deleteMany({ where: { id: input.runId } })
    ).count;
    if (deletedRuns !== 1) {
      throw new Error('汇率治理清理源数据已变化');
    }
    return {
      deletedQuoteSamples,
      deletedProviderSnapshots,
      deletedSnapshots
    };
  }

  private cleanupResultCount(result: Prisma.JsonObject, key: string) {
    const value = result[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('汇率治理清理返回格式无效');
    }
    return value;
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
