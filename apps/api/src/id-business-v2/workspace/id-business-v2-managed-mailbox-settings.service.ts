import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY,
  type UpdateV2ManagedMailboxQueryCodeSettingsResult,
  type V2ManagedMailboxQueryCodeSettings
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type { UpdateIdBusinessV2ManagedMailboxQueryCodeSettingsDto } from './dto/id-business-v2-managed-mailbox.dto';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';

const SETTINGS_SCOPE = 'global';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdBusinessV2ManagedMailboxSettingsService {
  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async getSettings(operator?: AuthenticatedUser): Promise<V2ManagedMailboxQueryCodeSettings> {
    this.requireAdmin(operator);
    const setting = await this.repository.getQueryCodeSettings(SETTINGS_SCOPE);
    return this.toResponse(setting);
  }

  async getValidityDays() {
    const setting = await this.repository.getQueryCodeSettings(SETTINGS_SCOPE);
    return this.normalizeStoredValidityDays(setting?.queryCodeValidityDays);
  }

  expiresAt(issuedAt: Date, validityDays: number) {
    return new Date(issuedAt.getTime() + validityDays * DAY_MS);
  }

  async updateSettings(
    dto: UpdateIdBusinessV2ManagedMailboxQueryCodeSettingsDto,
    operator?: AuthenticatedUser,
    requestId = 'managed-mailbox-query-code-settings'
  ): Promise<UpdateV2ManagedMailboxQueryCodeSettingsResult> {
    const userId = this.requireAdmin(operator);
    const validityDays = this.normalizeValidityDays(dto.validityDays);
    const applyToExisting = this.normalizeApplyToExisting(dto.applyToExisting);

    const result = await this.transactionManager.execute(
      async (tx, context) => {
        const before = await this.repository.getQueryCodeSettings(SETTINGS_SCOPE, tx);
        const previousValidityDays = this.normalizeStoredValidityDays(
          before?.queryCodeValidityDays
        );
        const setting = await this.repository.upsertQueryCodeSettings(tx, {
          queryCodeValidityDays: validityDays,
          scope: SETTINGS_SCOPE,
          updatedByUserId: userId
        });
        const updatedExistingCount = applyToExisting
          ? (
              await this.repository.updateAllQueryCodeExpirations(
                tx,
                this.expiresAt(context.businessTime, validityDays),
                userId
              )
            ).count
          : 0;
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.managed_mailbox.query_code_settings_update',
          objectType: 'id_business_v2_managed_mailbox_setting',
          objectId: setting.id,
          beforeData: toV2JsonDocument({ validityDays: previousValidityDays }),
          afterData: toV2JsonDocument({
            applyToExisting,
            updatedExistingCount,
            validityDays
          }),
          remark: applyToExisting
            ? `邮箱查询码有效期已设为 ${validityDays} 天，并同步现有查询码`
            : `邮箱查询码有效期已设为 ${validityDays} 天`
        });
        return { setting, updatedExistingCount };
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );

    return {
      ...this.toResponse(result.setting),
      updatedExistingCount: result.updatedExistingCount
    };
  }

  private toResponse(
    setting?: { queryCodeValidityDays: number; updatedAt: Date } | null
  ): V2ManagedMailboxQueryCodeSettings {
    return {
      validityDays: this.normalizeStoredValidityDays(setting?.queryCodeValidityDays),
      defaultValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.defaultDays,
      minValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.minDays,
      maxValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.maxDays,
      rotationMode: 'manual',
      updatedAt: setting?.updatedAt.toISOString() ?? null
    };
  }

  private normalizeValidityDays(value: unknown) {
    const parsed = Number(value);
    if (
      !Number.isInteger(parsed) ||
      parsed < V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.minDays ||
      parsed > V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.maxDays
    ) {
      throw new BadRequestException(
        `查询码有效期必须是 ${V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.minDays} 至 ${V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.maxDays} 天的整数`
      );
    }
    return parsed;
  }

  private normalizeStoredValidityDays(value: unknown) {
    const parsed = Number(value);
    return Number.isInteger(parsed) &&
      parsed >= V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.minDays &&
      parsed <= V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.maxDays
      ? parsed
      : V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.defaultDays;
  }

  private normalizeApplyToExisting(value: unknown) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException('请选择是否同步现有查询码有效期');
    }
    return value;
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin')) throw new ForbiddenException('只有管理员可以管理邮箱池');
    return operator.id;
  }
}
