import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { GOVERNANCE_APPROVAL_NOT_READY_MESSAGE, requireOperator } from './data-governance.types';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

type RecycleEntity = 'account' | 'customer' | 'option' | 'order';

interface RecycleItem {
  id: string;
  entity: RecycleEntity;
  label: string;
  deletedAt: Date;
  route: string;
  restoreReadiness: 'review_required';
  restoreReason: string;
}

@Injectable()
export class IdBusinessV2DataGovernanceService {
  constructor(private readonly repository: IdBusinessV2DataGovernanceQueryRepository) {}

  async overview(operator?: AuthenticatedUser, now = new Date()) {
    const currentOperator = requireOperator(operator);
    const {
      counts,
      accounts,
      customers,
      options,
      orders,
      latestRetentionAudit,
      approvalReadiness
    } = await this.repository.overviewRows(currentOperator.id);
    const approvalReady = approvalReadiness.eligibleApproverCount > 0;
    const approvalBlockedReason = approvalReady ? null : GOVERNANCE_APPROVAL_NOT_READY_MESSAGE;

    const recentItems: RecycleItem[] = [
      ...accounts.map((item) =>
        this.recycleItem(
          'account',
          item.id,
          item.appleIdMasked,
          item.deletedAt,
          '/v2/accounts',
          '恢复前必须复核报损、销售占用、状态选项和余额流水。'
        )
      ),
      ...customers.map((item) =>
        this.recycleItem(
          'customer',
          item.id,
          item.name,
          item.deletedAt,
          '/v2/customers',
          '恢复前必须复核关联订单、开通记录和来源选项。'
        )
      ),
      ...options.map((item) =>
        this.recycleItem(
          'option',
          item.id,
          item.name,
          item.deletedAt,
          '/v2/options',
          '删除时唯一键已改写，恢复前必须检查编码冲突和关联引用。'
        )
      ),
      ...orders.map((item) =>
        this.recycleItem(
          'order',
          item.id,
          item.orderNo,
          item.deletedAt,
          '/v2/orders',
          '恢复前必须复核订单状态、ID 锁定、余额和财务日记。'
        )
      )
    ]
      .sort((left, right) => right.deletedAt.getTime() - left.deletedAt.getTime())
      .slice(0, 20);

    return {
      recycleBin: {
        total: Object.values(counts).reduce((total, count) => total + count, 0),
        byEntity: counts,
        recentItems: recentItems.map((item) => ({
          ...item,
          deletedAt: item.deletedAt.toISOString()
        }))
      },
      capabilities: [
        {
          key: 'account_import_export',
          title: 'ID 导入导出',
          status: 'available' as const,
          detail: '现有 ID 模块已提供校验导入和脱敏导出，并写入审计。'
        },
        {
          key: 'audit_export',
          title: '审计导出',
          status: 'available' as const,
          detail: '现有审计模块已提供按筛选导出和导出留痕。'
        },
        {
          key: 'recycle_restore',
          title: '回收站恢复',
          status: approvalReady ? ('available' as const) : ('blocked' as const),
          detail: approvalReady
            ? '支持不可变预览、异人审批、分批检查点和逐项审计后恢复。'
            : GOVERNANCE_APPROVAL_NOT_READY_MESSAGE
        },
        {
          key: 'general_cleanup',
          title: '受控清理任务',
          status: approvalReady ? ('available' as const) : ('blocked' as const),
          detail: approvalReady
            ? '仅支持无账务引用的过期汇率历史；通用业务数据硬删除保持关闭。'
            : GOVERNANCE_APPROVAL_NOT_READY_MESSAGE
        },
        {
          key: 'managed_backup',
          title: '托管备份与恢复演练',
          status: 'unknown' as const,
          detail: '仓库有本地脚本，但应用数据库中没有目标环境备份与隔离恢复证据。'
        }
      ],
      existingRetention: {
        scope: 'exchange_rate_history_only',
        configured: true,
        lastAuditedRunAt: latestRetentionAudit?.createdAt.toISOString() ?? null,
        evidenceStatus: latestRetentionAudit ? ('observed' as const) : ('not_observed' as const)
      },
      safety: {
        restoreEnabled: approvalReady,
        cleanupEnabled: approvalReady,
        generalHardDeleteEnabled: false,
        approvalWorkflowConfigured: true
      },
      approvalReadiness: {
        ...approvalReadiness,
        ready: approvalReady,
        blockedReason: approvalBlockedReason
      },
      proposedWorkflow: [
        '生成不可变影响预览',
        '确认目标环境备份证据',
        '由不同管理员审批',
        '分批执行并保存检查点',
        '逐项记录结果和审计编号',
        '执行后重新统计并对比'
      ],
      generatedAt: now.toISOString(),
      timezone: 'Asia/Kuala_Lumpur'
    };
  }

  private recycleItem(
    entity: RecycleEntity,
    id: string,
    label: string,
    deletedAt: Date | null,
    route: string,
    restoreReason: string
  ): RecycleItem {
    if (!deletedAt) throw new Error('Soft-deleted governance item is missing deletedAt');
    return {
      id,
      entity,
      label,
      deletedAt,
      route,
      restoreReadiness: 'review_required',
      restoreReason
    };
  }
}
