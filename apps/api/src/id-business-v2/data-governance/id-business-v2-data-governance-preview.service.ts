import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toIdBusinessV2BusinessDate,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  type CreateCleanupGovernanceJobDto,
  type CreateRestoreGovernanceJobDto,
  GOVERNANCE_APPROVAL_NOT_READY_MESSAGE,
  type GovernanceEligibility,
  type GovernanceJobType,
  type GovernancePreviewItem,
  normalizeIdempotencyKey,
  normalizeRequiredText,
  normalizeUuid,
  parseInteger,
  parseRecycleEntity,
  requireOperator,
  type RecycleEntity
} from './data-governance.types';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

const MAX_RESTORE_ITEMS = 100;
const MAX_CLEANUP_ITEMS = 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

interface GovernanceCommandMetadata {
  requestId?: string;
}

@Injectable()
export class IdBusinessV2DataGovernancePreviewService {
  constructor(
    private readonly repository: IdBusinessV2DataGovernanceRepository,
    private readonly queryRepository: IdBusinessV2DataGovernanceQueryRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly queryService: IdBusinessV2DataGovernanceQueryService
  ) {}

  async createRestoreJob(
    dto: CreateRestoreGovernanceJobDto,
    operator?: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const currentOperator = requireOperator(operator);
    const reason = normalizeRequiredText(dto.reason, '申请原因', { min: 8, max: 1_000 });
    const backupEvidence = normalizeRequiredText(dto.backupEvidence, '备份证据', {
      min: 8,
      max: 2_000
    });
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const selectedItems = this.normalizeRestoreItems(dto.items);
    const requestFingerprint = this.hash({ reason, backupEvidence, items: selectedItems });
    const replay = await this.findReplay(
      idempotencyKey,
      'recycle_restore',
      currentOperator.id,
      requestFingerprint
    );
    if (replay) return replay;
    await this.assertApprovalReady(currentOperator.id);

    const previewItems = await this.buildRestorePreview(selectedItems);
    const eligibleItems = previewItems.filter((item) => item.eligibility.eligible).length;
    if (eligibleItems === 0) throw new BadRequestException('所选记录当前均不满足恢复条件');
    const previewSummary = {
      requestFingerprint,
      selectedItems: previewItems.length,
      eligibleItems,
      ineligibleItems: previewItems.length - eligibleItems,
      entities: this.countEntities(previewItems),
      generalHardDeleteEnabled: false
    };
    return this.createJob(
      {
        type: 'recycle_restore',
        reason,
        backupEvidence,
        idempotencyKey,
        requestFingerprint,
        previewSummary,
        items: previewItems
      },
      currentOperator,
      metadata
    );
  }

  async createCleanupJob(
    dto: CreateCleanupGovernanceJobDto,
    operator?: AuthenticatedUser,
    metadata: GovernanceCommandMetadata = {}
  ) {
    const currentOperator = requireOperator(operator);
    const olderThanDays = parseInteger(dto.olderThanDays, '保留天数', 30, 30, 3_650);
    const reason = normalizeRequiredText(dto.reason, '申请原因', { min: 8, max: 1_000 });
    const backupEvidence = normalizeRequiredText(dto.backupEvidence, '备份证据', {
      min: 8,
      max: 2_000
    });
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const requestFingerprint = this.hash({ reason, backupEvidence, olderThanDays });
    const replay = await this.findReplay(
      idempotencyKey,
      'exchange_rate_cleanup',
      currentOperator.id,
      requestFingerprint
    );
    if (replay) return replay;
    const configuredRetentionDays = await this.queryRepository.exchangeRateRetentionDays();
    if (olderThanDays < configuredRetentionDays) {
      throw new BadRequestException(
        `清理保留天数不得小于汇率设置中的 ${configuredRetentionDays} 天`
      );
    }
    await this.assertApprovalReady(currentOperator.id);

    const cutoff = new Date(Date.now() - olderThanDays * ONE_DAY_MS);
    const { runs, eligibleTotal } = await this.queryRepository.cleanupPreviewRows(
      cutoff,
      MAX_CLEANUP_ITEMS
    );
    if (runs.length === 0) throw new BadRequestException('当前没有符合条件的汇率历史可清理');
    const items: GovernancePreviewItem[] = runs.map((run, index) => ({
      sequence: index + 1,
      entityType: 'exchange_rate_run',
      entityId: run.id,
      safeLabel: `汇率运行 ${run.id.slice(0, 8)} · ${run.status}`,
      sourceDeletedAt: null,
      eligibility: {
        eligible: true,
        code: 'eligible',
        detail: '已超过保留期、运行已结束且没有礼品卡或财务快照引用。',
        expectedStatus: run.status,
        cutoff: cutoff.toISOString(),
        retentionDays: configuredRetentionDays,
        snapshotId: run.snapshot?.id ?? null
      }
    }));
    const previewSummary = {
      requestFingerprint,
      olderThanDays,
      configuredRetentionDays,
      cutoff: cutoff.toISOString(),
      eligibleTotal,
      selectedItems: items.length,
      truncated: eligibleTotal > items.length,
      cleanupScope: 'exchange_rate_history_only',
      generalHardDeleteEnabled: false
    };
    return this.createJob(
      {
        type: 'exchange_rate_cleanup',
        reason,
        backupEvidence,
        idempotencyKey,
        requestFingerprint,
        previewSummary,
        items
      },
      currentOperator,
      metadata
    );
  }

  private normalizeRestoreItems(items: CreateRestoreGovernanceJobDto['items']) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_RESTORE_ITEMS) {
      throw new BadRequestException(`每次必须选择 1-${MAX_RESTORE_ITEMS} 条回收站记录`);
    }
    const normalized = items.map((item) => ({
      entity: parseRecycleEntity(item?.entity) as RecycleEntity,
      id: normalizeUuid(item?.id, '回收站记录')
    }));
    const keys = normalized.map((item) => `${item.entity}:${item.id}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('不能重复选择同一条记录');
    return normalized;
  }

  private async buildRestorePreview(selected: Array<{ entity: RecycleEntity; id: string }>) {
    const ids = (entity: RecycleEntity) =>
      selected.filter((item) => item.entity === entity).map((item) => item.id);
    const { accounts, customers, options, orders } =
      await this.queryRepository.restorePreviewSources({
        account: ids('account'),
        customer: ids('customer'),
        option: ids('option'),
        order: ids('order')
      });
    const accountMap = new Map(accounts.map((item) => [item.id, item]));
    const customerMap = new Map(customers.map((item) => [item.id, item]));
    const optionMap = new Map(options.map((item) => [item.id, item]));
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const optionOriginalKeys = options
      .map((item) => this.originalOptionKey(item.id, item.uniqueKey))
      .filter((value): value is string => Boolean(value));
    const dependentServices = (
      await Promise.all(
        options
          .filter(
            (
              item
            ): item is typeof item & {
              type: 'country' | 'business_category';
              deletedAt: Date;
            } =>
              (item.type === 'country' || item.type === 'business_category') &&
              item.deletedAt instanceof Date
          )
          .map(async (item) => ({
            parentId: item.id,
            rows: await this.queryRepository.findDependentServicesForRestore(item)
          }))
      )
    ).flatMap((group) =>
      group.rows.map((service) => ({
        parentId: group.parentId,
        id: service.id,
        currentUniqueKey: service.uniqueKey,
        originalUniqueKey: this.originalOptionKey(service.id, service.uniqueKey),
        originalStatus: service.statusBeforeDeletion
      }))
    );
    const allOriginalKeys = [
      ...optionOriginalKeys,
      ...dependentServices
        .map((service) => service.originalUniqueKey)
        .filter((value): value is string => Boolean(value))
    ];
    const conflicts = await this.queryRepository.findOptionUniqueKeys(allOriginalKeys);
    const conflictKeys = new Set(conflicts.map((item) => item.uniqueKey));

    return selected.map<GovernancePreviewItem>((selectedItem, index) => {
      const sequence = index + 1;
      if (selectedItem.entity === 'account') {
        const item = accountMap.get(selectedItem.id);
        return this.restoreItem(
          sequence,
          selectedItem,
          item?.appleIdMasked,
          item?.deletedAt,
          !item
            ? this.ineligible('not_found', 'ID 记录不存在。')
            : !item.deletedAt
              ? this.ineligible('not_deleted', 'ID 已不在回收站。')
              : item.lossReportedAt
                ? this.ineligible('loss_reported', '已报损 ID 必须永久保留历史。')
                : item.soldByOrderId
                  ? this.ineligible('sold', '已卖出 ID 不能直接恢复。')
                  : this.eligible('恢复后保持停用，需人工复核后再启用。')
        );
      }
      if (selectedItem.entity === 'customer') {
        const item = customerMap.get(selectedItem.id);
        return this.restoreItem(
          sequence,
          selectedItem,
          item?.name,
          item?.deletedAt,
          !item
            ? this.ineligible('not_found', '客户记录不存在。')
            : item.deletedAt
              ? this.eligible('恢复客户资料，不改写原业务状态。')
              : this.ineligible('not_deleted', '客户已不在回收站。')
        );
      }
      if (selectedItem.entity === 'option') {
        const item = optionMap.get(selectedItem.id);
        const originalUniqueKey = item ? this.originalOptionKey(item.id, item.uniqueKey) : null;
        const dependent = dependentServices.filter((service) => service.parentId === item?.id);
        const invalidDependent = dependent.find(
          (service) => !service.originalUniqueKey || !service.originalStatus
        );
        const conflictingDependent = dependent.find(
          (service) => service.originalUniqueKey && conflictKeys.has(service.originalUniqueKey)
        );
        const eligibility = !item
          ? this.ineligible('not_found', '选项记录不存在。')
          : !item.deletedAt
            ? this.ineligible('not_deleted', '选项已不在回收站。')
            : !originalUniqueKey
              ? this.ineligible('invalid_deleted_key', '删除唯一键格式无效，不能自动恢复。')
              : invalidDependent
                ? this.ineligible('invalid_dependent_snapshot', '关联业务的删除快照不完整。')
                : conflictKeys.has(originalUniqueKey)
                  ? this.ineligible('unique_key_conflict', '原唯一键已被其他选项占用。')
                  : conflictingDependent
                    ? this.ineligible(
                        'dependent_unique_key_conflict',
                        '关联业务的原唯一键已被其他选项占用。'
                      )
                    : this.eligible(
                        dependent.length > 0
                          ? `恢复原唯一键和软删除状态，并恢复 ${dependent.length} 个关联业务。`
                          : '恢复原唯一键和软删除状态。',
                        {
                          originalUniqueKey,
                          originalStatus: item.statusBeforeDeletion ?? item.status,
                          dependentServices: dependent.map((service) => ({
                            id: service.id,
                            currentUniqueKey: service.currentUniqueKey,
                            originalUniqueKey: service.originalUniqueKey!,
                            originalStatus: service.originalStatus!
                          }))
                        }
                      );
        return this.restoreItem(sequence, selectedItem, item?.name, item?.deletedAt, eligibility);
      }
      const item = orderMap.get(selectedItem.id);
      const deletableStatus = item && ['refunded', 'cancelled', 'failed'].includes(item.status);
      return this.restoreItem(
        sequence,
        selectedItem,
        item?.orderNo,
        item?.deletedAt,
        !item
          ? this.ineligible('not_found', '订单记录不存在。')
          : !item.deletedAt
            ? this.ineligible('not_deleted', '订单已不在回收站。')
            : !deletableStatus
              ? this.ineligible('status_changed', '订单状态已不符合安全恢复条件。')
              : this.eligible('仅恢复可见性，不重建已释放的 ID 锁或财务动作。', {
                  expectedStatus: item.status
                })
      );
    });
  }

  private restoreItem(
    sequence: number,
    selected: { entity: RecycleEntity; id: string },
    label: string | undefined,
    deletedAt: Date | null | undefined,
    eligibility: GovernanceEligibility
  ): GovernancePreviewItem {
    return {
      sequence,
      entityType: selected.entity,
      entityId: selected.id,
      safeLabel: label ?? `记录 ${selected.id.slice(0, 8)}`,
      sourceDeletedAt: deletedAt ?? null,
      eligibility
    };
  }

  private eligible(detail: string, extra: Partial<GovernanceEligibility> = {}) {
    return { eligible: true, code: 'eligible', detail, ...extra };
  }

  private ineligible(code: string, detail: string) {
    return { eligible: false, code, detail };
  }

  private originalOptionKey(id: string, uniqueKey: string) {
    const prefix = `deleted:${id}:`;
    return uniqueKey.startsWith(prefix) ? uniqueKey.slice(prefix.length) : null;
  }

  private countEntities(items: GovernancePreviewItem[]) {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.entityType] = (counts[item.entityType] ?? 0) + 1;
    return counts;
  }

  private async findReplay(
    idempotencyKey: string,
    type: GovernanceJobType,
    requesterId: string,
    requestFingerprint: string
  ) {
    const existing = await this.repository.findJobReplay(idempotencyKey);
    if (!existing) return null;
    this.assertReplayMatches(existing, type, requesterId, requestFingerprint);
    return this.queryService.job(existing.id);
  }

  private async createJob(
    input: {
      type: GovernanceJobType;
      reason: string;
      backupEvidence: string;
      idempotencyKey: string;
      requestFingerprint: string;
      previewSummary: Record<string, unknown>;
      items: GovernancePreviewItem[];
    },
    operator: AuthenticatedUser,
    metadata: GovernanceCommandMetadata
  ) {
    const previewHash = this.hash({
      type: input.type,
      summary: input.previewSummary,
      items: input.items
    });
    const jobId = randomUUID();
    const result = await this.transactionManager.execute(
      async (tx, context) => {
        await this.assertApprovalReady(operator.id, tx);
        const jobNo = `GOV-${toIdBusinessV2BusinessDate(context.businessTime).text.replaceAll('-', '')}-${jobId.slice(0, 8)}`;
        await this.repository.createJob(tx, {
          id: jobId,
          jobNo,
          type: input.type,
          reason: input.reason,
          backupEvidence: input.backupEvidence,
          previewHash,
          previewSummary: input.previewSummary,
          requestedByUserId: operator.id,
          idempotencyKey: input.idempotencyKey,
          items: input.items
        });
        await this.transactionalAudit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2_data_governance',
          action: 'id_business_v2.data_governance.preview_created',
          objectType: 'id_business_v2_governance_job',
          objectId: jobId,
          afterData: {
            jobNo,
            type: input.type,
            previewHash,
            totalItems: input.items.length,
            eligibleItems: input.items.filter((item) => item.eligibility.eligible).length,
            backupEvidenceProvided: true
          },
          remark: `创建数据治理预览：${jobNo}`
        });
        return { jobId };
      },
      {
        requestId: metadata.requestId ?? randomUUID(),
        operator,
        retryMode: 'fullReplay',
        idempotencyKey: input.idempotencyKey,
        replay: async (tx) => ({
          jobId: await this.requireReplayId(
            tx,
            input.idempotencyKey,
            input.type,
            operator.id,
            input.requestFingerprint
          )
        }),
        uniqueConflictMessage: '数据治理预览已被其他操作创建，请刷新后核对'
      }
    );
    return this.queryService.job(result.jobId);
  }

  private async assertApprovalReady(requesterUserId: string, tx?: V2CommandTransaction) {
    const readiness = await this.queryRepository.approvalReadiness(requesterUserId, tx);
    if (readiness.eligibleApproverCount < 1) {
      throw new ConflictException(GOVERNANCE_APPROVAL_NOT_READY_MESSAGE);
    }
  }

  private async requireReplayId(
    tx: V2CommandTransaction,
    idempotencyKey: string,
    type: GovernanceJobType,
    requesterId: string,
    requestFingerprint: string
  ) {
    const existing = await this.repository.findJobReplay(idempotencyKey, tx);
    if (!existing) throw new ConflictException('数据治理预览冲突，请刷新后核对');
    this.assertReplayMatches(existing, type, requesterId, requestFingerprint);
    return existing.id;
  }

  private assertReplayMatches(
    existing: {
      type: GovernanceJobType;
      requestedByUserId: string;
      previewSummary: unknown;
    },
    type: GovernanceJobType,
    requesterId: string,
    requestFingerprint: string
  ) {
    const summary = this.jsonRecord(existing.previewSummary);
    if (
      existing.type !== type ||
      existing.requestedByUserId !== requesterId ||
      summary.requestFingerprint !== requestFingerprint
    ) {
      throw new ConflictException('幂等键已被其他数据治理申请占用');
    }
  }

  private jsonRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
