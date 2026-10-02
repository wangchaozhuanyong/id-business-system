import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  auditRestoreSnapshot,
  buildAuditRestorePreview,
  getAuditRestoreConfig
} from './audit-field-restore-preview';
import type { AuditRestorePatch, RestoreAuditFieldsDto } from './audit-field-restore.types';
import { IdBusinessV2AuditRestoreRepository } from './persistence/id-business-v2-audit-restore.repository';

@Injectable()
export class IdBusinessV2AuditRestoreService {
  constructor(
    private readonly repository: IdBusinessV2AuditRestoreRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async preview(id: string, operator?: AuthenticatedUser) {
    const admin = this.requireAdmin(operator);
    const loaded = await this.load(id, admin.id);
    return loaded.preview;
  }

  async restore(
    id: string,
    input: RestoreAuditFieldsDto,
    operator?: AuthenticatedUser,
    metadata: { requestId?: string; ip?: string; userAgent?: string } = {}
  ) {
    const admin = this.requireAdmin(operator);
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500)
      throw new BadRequestException('请填写恢复原因，最多 500 个字。');
    if (
      !Array.isArray(input?.fields) ||
      !input.fields.length ||
      input.fields.length > 3 ||
      input.fields.some((field) => typeof field !== 'string') ||
      new Set(input.fields).size !== input.fields.length
    )
      throw new BadRequestException('请选择需要恢复的资料项目。');
    if (!/^[a-f0-9]{64}$/.test(input.previewFingerprint ?? ''))
      throw new BadRequestException('请先核对恢复预览，再确认恢复。');
    const source = await this.repository.findSource(id);
    if (!source) throw new NotFoundException('操作记录不存在。');
    const config = getAuditRestoreConfig(source);
    const result = await this.transactions.execute(
      async (tx, context) => {
        const loaded = await this.load(id, admin.id, tx);
        const { preview, current } = loaded;
        if (!preview.canRestore || !current)
          throw new ConflictException(preview.blockers.join(' '));
        if (preview.previewFingerprint !== input.previewFingerprint)
          throw new ConflictException('恢复预览已变化，请重新核对后再确认。');
        const selected = input.fields!.map((key) =>
          preview.fields.find((field) => field.key === key)
        );
        if (selected.some((field) => !field))
          throw new BadRequestException('所选项目没有完整旧值，或不支持从日志恢复。');
        const blockedField = selected.find((field) => field!.blockedReason);
        if (blockedField) throw new ConflictException(blockedField.blockedReason);
        const patch: AuditRestorePatch = {};
        for (const field of selected) patch[field!.key] = field!.restoreValue;
        const updatedAt = new Date(
          Math.max(context.businessTime.getTime(), current.updatedAt.getTime() + 1)
        );
        const restored = await this.repository.restore(
          tx,
          config.entity,
          current,
          patch,
          admin.id,
          updatedAt
        );
        const labels = selected.map((field) => field!.label);
        const log = await this.audit.append(tx, {
          userId: admin.id,
          module: config.module,
          action: `id_business_v2.${config.entity}.restore_fields`,
          objectType: config.objectType,
          objectId: current.id,
          beforeData: toV2JsonDocument(auditRestoreSnapshot(current, config)),
          afterData: toV2JsonDocument({
            ...auditRestoreSnapshot(restored, config),
            restoredFromAuditId: id,
            restoredFieldLabels: labels,
            restoreReason: reason
          }),
          ip: metadata.ip,
          userAgent: metadata.userAgent,
          remark: `恢复${preview.objectLabel}的${labels.join('、')}；原因：${reason}`
        });
        return {
          auditId: log.id,
          sourceAuditId: id,
          objectId: current.id,
          restoredFields: input.fields!,
          message: '所选资料已恢复，已保存新的操作记录。'
        };
      },
      {
        changedScopes: [config.scope],
        requestId: metadata.requestId ?? randomUUID(),
        operator: admin,
        retryMode: 'none',
        isolationLevel: 'Serializable',
        uniqueConflictMessage: '原名称已被占用，请到业务选项页面核对。'
      }
    );
    return result;
  }

  private async load(id: string, operatorId: string, tx?: V2CommandTransaction) {
    const source = await this.repository.findSource(id, tx);
    if (!source) throw new NotFoundException('操作记录不存在。');
    const config = getAuditRestoreConfig(source);
    const current = await this.repository.findCurrent(config.entity, source.objectId!, tx);
    let preview = buildAuditRestorePreview(source, config, current, operatorId);
    const name = preview.fields.find((field) => field.key === 'name')?.restoreValue;
    if (
      config.entity === 'option' &&
      current &&
      typeof name === 'string' &&
      (await this.repository.findOptionNameConflict(current, name, tx))
    ) {
      preview = buildAuditRestorePreview(source, config, current, operatorId, [], {
        name: '原名称已被其他业务选项使用，不能恢复名称。'
      });
    }
    return { config, current, preview };
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.roles.includes('admin'))
      throw new ForbiddenException('只有管理员可以恢复资料。');
    return operator;
  }
}
