import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { GovernanceEligibility, GovernanceJobType } from './data-governance.types';
import {
  IdBusinessV2DataGovernanceRepository,
  type GovernanceJobItem
} from './persistence/id-business-v2-data-governance.repository';

interface ExecutionOutcome {
  status: 'succeeded' | 'skipped';
  code: string;
  message: string;
  evidence?: Record<string, string | number | boolean | null>;
}

interface ExecutionJob {
  id: string;
  jobNo: string;
  type: GovernanceJobType;
}

interface GovernanceCommandMetadata {
  requestId?: string;
}

@Injectable()
export class IdBusinessV2DataGovernanceItemExecutorService {
  constructor(
    private readonly repository: IdBusinessV2DataGovernanceRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

  async process(
    item: GovernanceJobItem,
    job: ExecutionJob,
    operator: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const requestId = metadata.requestId ?? randomUUID();
    try {
      return await this.transactionManager.execute(
        async (tx, context) => {
          const eligibility = this.parseEligibility(item.eligibility);
          const outcome = eligibility.eligible
            ? await this.executeEligibleItem(tx, item, job.type, eligibility, operator.id)
            : {
                status: 'skipped' as const,
                code: eligibility.code || 'preview_ineligible',
                message: eligibility.detail || '预览时已判定为不满足执行条件。'
              };
          const audit = await this.transactionalAudit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2_data_governance',
            action: `id_business_v2.data_governance.item_${outcome.status}`,
            objectType: `id_business_v2_${item.entityType}`,
            objectId: item.entityId,
            afterData: {
              jobId: job.id,
              jobNo: job.jobNo,
              entityType: item.entityType,
              entityId: item.entityId,
              resultCode: outcome.code,
              ...outcome.evidence
            },
            remark: `数据治理明细${outcome.status === 'succeeded' ? '执行成功' : '跳过'}：${job.jobNo} / #${item.sequence}`
          });
          await this.repository.completeItem(tx, {
            id: item.id,
            status: outcome.status,
            resultCode: outcome.code,
            resultMessage: outcome.message,
            resultAuditLogId: audit.id,
            processedAt: context.businessTime
          });
          return outcome.status;
        },
        { requestId, operator, retryMode: 'none', isolationLevel: 'Serializable' }
      );
    } catch {
      await this.markFailed(item, job, operator, requestId);
      return 'failed' as const;
    }
  }

  private async executeEligibleItem(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    jobType: GovernanceJobType,
    eligibility: GovernanceEligibility,
    operatorId: string
  ): Promise<ExecutionOutcome> {
    if (jobType === 'exchange_rate_cleanup') {
      return this.cleanupExchangeRateRun(tx, item, eligibility);
    }
    if (item.entityType === 'account') return this.restoreAccount(tx, item, operatorId);
    if (item.entityType === 'customer') return this.restoreCustomer(tx, item, operatorId);
    if (item.entityType === 'option') {
      return this.restoreOption(tx, item, eligibility, operatorId);
    }
    if (item.entityType === 'order') return this.restoreOrder(tx, item, eligibility, operatorId);
    return { status: 'skipped', code: 'unsupported_entity', message: '不支持该恢复类型。' };
  }

  private async restoreAccount(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    operatorId: string
  ): Promise<ExecutionOutcome> {
    if (!item.sourceDeletedAt) return this.missingPreviewSnapshot();
    const current = await this.repository.findAccountRestoreState(tx, item.entityId);
    if (!current) return this.notFound();
    if (!this.sameDate(current.deletedAt, item.sourceDeletedAt)) return this.sourceChanged();
    if (current.lossReportedAt) {
      return { status: 'skipped', code: 'loss_reported', message: '已报损 ID 不允许恢复。' };
    }
    if (current.soldByOrderId) {
      return { status: 'skipped', code: 'sold', message: '已卖出 ID 不允许直接恢复。' };
    }
    const result = await this.repository.restoreAccount(tx, {
      id: item.entityId,
      sourceDeletedAt: item.sourceDeletedAt,
      operatorId
    });
    return result.count === 1
      ? {
          status: 'succeeded',
          code: 'account_restored_disabled',
          message: 'ID 已恢复并保持停用。',
          evidence: { recordStatus: 'disabled' }
        }
      : this.sourceChanged();
  }

  private async restoreCustomer(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    operatorId: string
  ): Promise<ExecutionOutcome> {
    if (!item.sourceDeletedAt) return this.missingPreviewSnapshot();
    const result = await this.repository.restoreCustomer(tx, {
      id: item.entityId,
      sourceDeletedAt: item.sourceDeletedAt,
      operatorId
    });
    return result.count === 1
      ? { status: 'succeeded', code: 'customer_restored', message: '客户已恢复。' }
      : this.sourceChanged();
  }

  private async restoreOption(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    eligibility: GovernanceEligibility,
    operatorId: string
  ): Promise<ExecutionOutcome> {
    if (!item.sourceDeletedAt || !eligibility.originalUniqueKey) {
      return this.missingPreviewSnapshot();
    }
    const current = await this.repository.findOptionRestoreState(tx, item.entityId);
    if (!current) return this.notFound();
    if (!this.sameDate(current.deletedAt, item.sourceDeletedAt)) return this.sourceChanged();
    const deletedPrefix = `deleted:${item.entityId}:`;
    if (!current.uniqueKey.startsWith(deletedPrefix)) {
      return { status: 'skipped', code: 'invalid_deleted_key', message: '删除唯一键已变化。' };
    }
    const conflict = await this.repository.findOptionConflict(tx, eligibility.originalUniqueKey);
    if (conflict && conflict.id !== item.entityId) {
      return {
        status: 'skipped',
        code: 'unique_key_conflict',
        message: '原唯一键已被其他选项占用。'
      };
    }
    const result = await this.repository.restoreOption(tx, {
      id: item.entityId,
      sourceDeletedAt: item.sourceDeletedAt,
      currentUniqueKey: current.uniqueKey,
      originalUniqueKey: eligibility.originalUniqueKey,
      operatorId
    });
    return result.count === 1
      ? { status: 'succeeded', code: 'option_restored', message: '选项已恢复。' }
      : this.sourceChanged();
  }

  private async restoreOrder(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    eligibility: GovernanceEligibility,
    operatorId: string
  ): Promise<ExecutionOutcome> {
    if (!item.sourceDeletedAt || !eligibility.expectedStatus) {
      return this.missingPreviewSnapshot();
    }
    if (!['refunded', 'cancelled', 'failed'].includes(eligibility.expectedStatus)) {
      return { status: 'skipped', code: 'unsafe_status', message: '预览状态不允许恢复。' };
    }
    const result = await this.repository.restoreOrder(tx, {
      id: item.entityId,
      sourceDeletedAt: item.sourceDeletedAt,
      expectedStatus: eligibility.expectedStatus as 'refunded' | 'cancelled' | 'failed',
      operatorId
    });
    return result.count === 1
      ? {
          status: 'succeeded',
          code: 'order_visibility_restored',
          message: '订单可见性已恢复，未重建 ID 锁和财务动作。',
          evidence: { lockRecreated: false, financialMutation: false }
        }
      : this.sourceChanged();
  }

  private async cleanupExchangeRateRun(
    tx: V2CommandTransaction,
    item: GovernanceJobItem,
    eligibility: GovernanceEligibility
  ): Promise<ExecutionOutcome> {
    const cutoff = eligibility.cutoff ? new Date(eligibility.cutoff) : null;
    if (!cutoff || Number.isNaN(cutoff.getTime()) || !eligibility.expectedStatus) {
      return this.missingPreviewSnapshot();
    }
    const run = await this.repository.findExchangeRateRunForCleanup(tx, item.entityId);
    if (!run) return this.notFound();
    if (
      run.status === 'running' ||
      run.status !== eligibility.expectedStatus ||
      run.startedAt >= cutoff ||
      (run.snapshot?.id ?? null) !== (eligibility.snapshotId ?? null) ||
      (run.snapshot?._count.giftCards ?? 0) > 0
    ) {
      return { status: 'skipped', code: 'retention_guard_changed', message: '保留条件已变化。' };
    }

    const deleted = await this.repository.deleteExchangeRateRun(tx, {
      runId: item.entityId,
      snapshotId: run.snapshot?.id ?? null
    });
    return {
      status: 'succeeded',
      code: 'exchange_rate_run_cleaned',
      message: '汇率历史已按审批范围清理。',
      evidence: { deletedRuns: 1, ...deleted }
    };
  }

  private async markFailed(
    item: GovernanceJobItem,
    job: ExecutionJob,
    operator: AuthenticatedUser,
    requestId: string
  ) {
    await this.transactionManager.execute(
      async (tx, context) => {
        const audit = await this.transactionalAudit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2_data_governance',
          action: 'id_business_v2.data_governance.item_failed',
          objectType: `id_business_v2_${item.entityType}`,
          objectId: item.entityId,
          afterData: {
            jobId: job.id,
            jobNo: job.jobNo,
            entityType: item.entityType,
            entityId: item.entityId,
            resultCode: 'execution_error'
          },
          remark: `数据治理明细执行失败：${job.jobNo} / #${item.sequence}`
        });
        await this.repository.markItemFailed(tx, {
          id: item.id,
          resultAuditLogId: audit.id,
          processedAt: context.businessTime
        });
      },
      { requestId, operator, retryMode: 'none', isolationLevel: 'Serializable' }
    );
  }

  private parseEligibility(value: unknown): GovernanceEligibility {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { eligible: false, code: 'invalid_preview', detail: '预览证据格式无效。' };
    }
    const record = value as Record<string, unknown>;
    return {
      eligible: record.eligible === true,
      code: typeof record.code === 'string' ? record.code : 'invalid_preview',
      detail: typeof record.detail === 'string' ? record.detail : '预览证据缺失。',
      originalUniqueKey:
        typeof record.originalUniqueKey === 'string' ? record.originalUniqueKey : undefined,
      expectedStatus: typeof record.expectedStatus === 'string' ? record.expectedStatus : undefined,
      cutoff: typeof record.cutoff === 'string' ? record.cutoff : undefined,
      snapshotId:
        typeof record.snapshotId === 'string' || record.snapshotId === null
          ? record.snapshotId
          : undefined
    };
  }

  private sameDate(left: Date | null, right: Date) {
    return Boolean(left && left.getTime() === right.getTime());
  }

  private notFound(): ExecutionOutcome {
    return { status: 'skipped', code: 'not_found', message: '目标记录已不存在。' };
  }

  private sourceChanged(): ExecutionOutcome {
    return { status: 'skipped', code: 'source_changed', message: '源记录已变化，未执行。' };
  }

  private missingPreviewSnapshot(): ExecutionOutcome {
    return { status: 'skipped', code: 'invalid_preview', message: '预览快照不完整，未执行。' };
  }
}
