import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  type ExecuteGovernanceJobDto,
  normalizeIdempotencyKey,
  normalizeUuid,
  parseInteger,
  requireOperator
} from './data-governance.types';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import {
  IdBusinessV2DataGovernanceRepository,
  type GovernanceItemCounts
} from './persistence/id-business-v2-data-governance.repository';

const STALE_RUNNING_MS = 15 * 60 * 1_000;

interface GovernanceCommandMetadata {
  requestId?: string;
}

@Injectable()
export class IdBusinessV2DataGovernanceExecutionService {
  constructor(
    private readonly repository: IdBusinessV2DataGovernanceRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly itemExecutor: IdBusinessV2DataGovernanceItemExecutorService,
    private readonly queryService: IdBusinessV2DataGovernanceQueryService
  ) {}

  async execute(
    jobIdValue: string,
    dto: ExecuteGovernanceJobDto,
    operator?: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const currentOperator = requireOperator(operator);
    const jobId = normalizeUuid(jobIdValue, '数据治理任务');
    const batchSize = parseInteger(dto.batchSize, '批次数量', 50, 1, 100);
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const requestId = metadata.requestId ?? randomUUID();
    const replay = await this.repository.findCheckpointByIdempotencyKey(idempotencyKey);
    if (replay) {
      if (replay.jobId !== jobId) throw new ConflictException('幂等键已被其他执行批次占用');
      return {
        idempotentReplay: true,
        checkpoint: replay,
        job: await this.queryService.job(jobId)
      };
    }

    const claimed = await this.claimBatch(
      jobId,
      batchSize,
      idempotencyKey,
      currentOperator,
      requestId
    );
    for (const item of claimed.items) {
      await this.itemExecutor.process(item, claimed.job, currentOperator, { requestId });
    }
    if (claimed.items.length > 0) {
      await this.finalizeBatch(
        claimed.job.id,
        claimed.checkpointId,
        claimed.items.map((item) => item.id),
        currentOperator,
        requestId
      );
    }
    return {
      idempotentReplay: false,
      checkpoint: await this.repository.findCheckpointOrThrow(claimed.checkpointId),
      job: await this.queryService.job(jobId)
    };
  }

  private claimBatch(
    jobId: string,
    batchSize: number,
    idempotencyKey: string,
    operator: AuthenticatedUser,
    requestId: string
  ) {
    return this.transactionManager.execute(
      async (tx, context) => {
        let job = await this.repository.findClaimJob(tx, jobId);
        if (!job) throw new NotFoundException('数据治理任务不存在');
        if (job.status === 'running') {
          const staleBefore = new Date(context.businessTime.getTime() - STALE_RUNNING_MS);
          if (job.updatedAt > staleBefore) throw new ConflictException('任务正在执行，请稍后刷新');
          await this.repository.resetProcessingItems(tx, job.id);
          await this.repository.failRunningCheckpoints(tx, job.id, context.businessTime);
          await this.repository.setJobApproved(tx, job.id);
          await this.transactionalAudit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2_data_governance',
            action: 'id_business_v2.data_governance.stale_execution_recovered',
            objectType: 'id_business_v2_governance_job',
            objectId: job.id,
            afterData: { jobNo: job.jobNo, staleBefore: staleBefore.toISOString() },
            remark: `恢复超时的数据治理任务：${job.jobNo}`
          });
          job = await this.repository.findClaimJob(tx, job.id);
          if (!job) throw new NotFoundException('数据治理任务不存在');
        }
        if (
          job.status !== 'approved' ||
          job.approval?.decision !== 'approved' ||
          job.approval.previewHash !== job.previewHash
        ) {
          throw new ConflictException('任务未通过有效审批，不能执行');
        }

        const claimedJob = await this.repository.claimJob(
          tx,
          job.id,
          operator.id,
          job.startedAt ?? context.businessTime
        );
        if (claimedJob.count !== 1) throw new ConflictException('任务状态已变化，请刷新后重试');
        const previousCheckpoint = await this.repository.findLatestCheckpoint(tx, job.id);
        const batchNo = (previousCheckpoint?.batchNo ?? 0) + 1;
        const items = await this.repository.findPendingItems(tx, job.id, batchSize);
        if (items.length === 0) {
          const totals = await this.repository.countJobItems(tx, job.id);
          const terminalStatus = this.terminalStatus(totals);
          const checkpoint = await this.repository.createCheckpoint(tx, {
            jobId: job.id,
            batchNo,
            idempotencyKey,
            status: 'completed',
            cursorSequence: 0,
            completedAt: context.businessTime
          });
          await this.repository.completeJobFromCounts(tx, {
            id: job.id,
            status: terminalStatus,
            counts: totals,
            completedAt: context.businessTime
          });
          await this.writeBatchAudit(tx, job, checkpoint.id, totals, operator, true);
          return {
            job: { id: job.id, jobNo: job.jobNo, type: job.type },
            checkpointId: checkpoint.id,
            items
          };
        }
        const checkpoint = await this.repository.createCheckpoint(tx, {
          jobId: job.id,
          batchNo,
          idempotencyKey,
          status: 'running',
          cursorSequence: items.at(-1)?.sequence ?? 0,
          attemptedItems: items.length
        });
        const itemClaim = await this.repository.claimItems(
          tx,
          items.map((item) => item.id)
        );
        if (itemClaim.count !== items.length) {
          throw new ConflictException('治理明细已被其他批次认领，请刷新后重试');
        }
        return {
          job: { id: job.id, jobNo: job.jobNo, type: job.type },
          checkpointId: checkpoint.id,
          items: items.map((item) => ({ ...item, status: 'processing' as const }))
        };
      },
      {
        changedScopes: ['data-governance'],
        requestId,
        operator,
        retryMode: 'none',
        isolationLevel: 'Serializable',
        uniqueConflictMessage: '幂等键已被其他执行批次占用'
      }
    );
  }

  private async finalizeBatch(
    jobId: string,
    checkpointId: string,
    itemIds: string[],
    operator: AuthenticatedUser,
    requestId: string
  ) {
    await this.transactionManager.execute(
      async (tx, context) => {
        const [job, batchCounts, totals] = await Promise.all([
          this.repository.findJobForFinalize(tx, jobId),
          this.repository.countJobItems(tx, jobId, itemIds),
          this.repository.countJobItems(tx, jobId)
        ]);
        if (!job) throw new NotFoundException('数据治理任务不存在');
        const hasRemaining = totals.pending > 0 || totals.processing > 0;
        const status = hasRemaining ? 'approved' : this.terminalStatus(totals);
        await this.repository.completeCheckpoint(tx, {
          id: checkpointId,
          counts: batchCounts,
          completedAt: context.businessTime
        });
        await this.repository.updateJobProgress(tx, {
          id: job.id,
          status,
          counts: totals,
          completedAt: hasRemaining ? null : context.businessTime
        });
        await this.writeBatchAudit(tx, job, checkpointId, batchCounts, operator, false);
      },
      {
        changedScopes: ['data-governance'],
        requestId,
        operator,
        retryMode: 'none',
        isolationLevel: 'Serializable'
      }
    );
  }

  private terminalStatus(counts: Pick<GovernanceItemCounts, 'succeeded' | 'skipped' | 'failed'>) {
    if (counts.failed > 0 && counts.succeeded === 0 && counts.skipped === 0) {
      return 'failed' as const;
    }
    if (counts.failed > 0 || counts.skipped > 0) return 'partially_succeeded' as const;
    return 'succeeded' as const;
  }

  private async writeBatchAudit(
    tx: V2CommandTransaction,
    job: { id: string; jobNo: string },
    checkpointId: string,
    counts: Pick<GovernanceItemCounts, 'succeeded' | 'skipped' | 'failed'>,
    operator: AuthenticatedUser,
    reconciliation: boolean
  ) {
    await this.transactionalAudit.append(tx, {
      userId: operator.id,
      module: 'id_business_v2_data_governance',
      action: 'id_business_v2.data_governance.batch_completed',
      objectType: 'id_business_v2_governance_job',
      objectId: job.id,
      afterData: {
        jobNo: job.jobNo,
        checkpointId,
        succeededItems: counts.succeeded,
        skippedItems: counts.skipped,
        failedItems: counts.failed,
        reconciliation
      },
      remark: `完成数据治理批次：${job.jobNo}`
    });
  }
}
