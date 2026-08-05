import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import {
  type CancelGovernanceJobDto,
  type DecideGovernanceJobDto,
  normalizeRequiredText,
  normalizeUuid,
  parseDecision,
  requireOperator
} from './data-governance.types';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';

interface GovernanceCommandMetadata {
  requestId?: string;
}

@Injectable()
export class IdBusinessV2DataGovernanceApprovalService {
  constructor(
    private readonly repository: IdBusinessV2DataGovernanceRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly queryService: IdBusinessV2DataGovernanceQueryService
  ) {}

  async decide(
    jobIdValue: string,
    dto: DecideGovernanceJobDto,
    operator?: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const currentOperator = requireOperator(operator);
    const jobId = normalizeUuid(jobIdValue, '数据治理任务');
    const decision = parseDecision(dto.decision);
    const reason = normalizeRequiredText(dto.reason, '审批意见', { min: 4, max: 1_000 });
    await this.transactionManager.execute(
      async (tx, context) => {
        const job = await this.repository.findApprovalJob(tx, jobId);
        if (!job) throw new NotFoundException('数据治理任务不存在');
        if (job.approval) {
          throw new ConflictException('该数据治理任务已经完成审批');
        }
        if (job.status !== 'pending_approval') {
          throw new ConflictException('该数据治理任务已不在待审批状态');
        }
        if (job.requestedByUserId === currentOperator.id) {
          throw new ConflictException('申请人不能审批自己的数据治理任务');
        }

        await this.repository.createApproval(tx, {
          jobId: job.id,
          approverUserId: currentOperator.id,
          decision,
          reason,
          previewHash: job.previewHash,
          decidedAt: context.businessTime
        });
        const status = decision === 'approved' ? 'approved' : 'rejected';
        const updated = await this.repository.decideJob(tx, {
          jobId: job.id,
          status,
          decidedAt: context.businessTime
        });
        if (updated.count !== 1) throw new ConflictException('任务状态已变化，请刷新后重试');
        await this.transactionalAudit.append(tx, {
          userId: currentOperator.id,
          module: 'id_business_v2_data_governance',
          action: 'id_business_v2.data_governance.approval_decided',
          objectType: 'id_business_v2_governance_job',
          objectId: job.id,
          beforeData: { status: job.status, previewHash: job.previewHash },
          afterData: { status, decision, previewHash: job.previewHash },
          remark: `数据治理审批：${job.jobNo} / ${decision}`
        });
      },
      {
        requestId: metadata.requestId ?? randomUUID(),
        operator: currentOperator,
        retryMode: 'none',
        uniqueConflictMessage: '该数据治理任务已完成审批'
      }
    );

    return this.queryService.job(jobId);
  }

  async cancel(
    jobIdValue: string,
    dto: CancelGovernanceJobDto,
    operator?: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const currentOperator = requireOperator(operator);
    const jobId = normalizeUuid(jobIdValue, '数据治理任务');
    const reason = normalizeRequiredText(dto.reason, '取消原因', { min: 4, max: 1_000 });
    await this.transactionManager.execute(
      async (tx, context) => {
        const job = await this.repository.findApprovalJob(tx, jobId);
        if (!job) throw new NotFoundException('数据治理任务不存在');
        if (job.requestedByUserId !== currentOperator.id) {
          throw new ConflictException('只有申请人可以取消数据治理任务');
        }
        if (job.approval || job.status !== 'pending_approval') {
          throw new ConflictException('只有待审批的数据治理任务可以取消');
        }

        const updated = await this.repository.cancelJob(tx, {
          jobId: job.id,
          requestedByUserId: currentOperator.id,
          completedAt: context.businessTime
        });
        if (updated.count !== 1) throw new ConflictException('任务状态已变化，请刷新后重试');
        await this.transactionalAudit.append(tx, {
          userId: currentOperator.id,
          module: 'id_business_v2_data_governance',
          action: 'id_business_v2.data_governance.job_cancelled',
          objectType: 'id_business_v2_governance_job',
          objectId: job.id,
          beforeData: { status: job.status, previewHash: job.previewHash },
          afterData: { status: 'cancelled', previewHash: job.previewHash, reason },
          remark: `取消数据治理任务：${job.jobNo}`
        });
      },
      {
        requestId: metadata.requestId ?? randomUUID(),
        operator: currentOperator,
        retryMode: 'none',
        uniqueConflictMessage: '该数据治理任务无法取消'
      }
    );

    return this.queryService.job(jobId);
  }
}
