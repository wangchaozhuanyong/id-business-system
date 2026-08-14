import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
import type { UpdateIdBusinessV2RenewalWarningSettingsDto } from './dto/update-id-business-v2-renewal-warning-settings.dto';
import type {
  IdBusinessV2ActivationStatus,
  RenewalBaseCriteria,
  RenewalDueFilter
} from './id-business-v2-renewal.types';
import { IdBusinessV2RenewalsRepository } from './persistence/id-business-v2-renewals.repository';

export const ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS = 3;
export const ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS = 1;
export const ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS = 365;
export const ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE = 'global';

const DAY_MS = 24 * 60 * 60 * 1000;
@Injectable()
export class IdBusinessV2RenewalWarningService {
  constructor(
    private readonly repository: IdBusinessV2RenewalsRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {}

  async getSettings() {
    const setting = await this.repository.getWarningSetting(ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE);
    const warningDays = setting
      ? this.parseStoredWarningDays(setting.warningDays)
      : ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;

    return {
      warningDays,
      defaultWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
      minWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS,
      maxWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS,
      updatedAt: setting?.updatedAt ?? null
    };
  }

  async updateSettings(
    dto: UpdateIdBusinessV2RenewalWarningSettingsDto,
    operator?: AuthenticatedUser
  ) {
    if (!operator?.id) {
      throw new BadRequestException('无法识别当前操作人');
    }
    const warningDays = this.validateWarningDays(dto.warningDays);

    const updated = await this.transactionManager.execute(
      async (tx) => {
        const existing = await this.repository.getWarningSettingInTransaction(
          tx,
          ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
        );
        const previousWarningDays = existing
          ? this.parseStoredWarningDays(existing.warningDays)
          : ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;
        const setting = await this.repository.upsertWarningSetting(tx, {
          scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE,
          warningDays,
          updatedByUserId: operator.id
        });

        await this.repository.appendAudit(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.renewal.warning_settings.update',
          objectType: 'id_business_v2_renewal_warning_setting',
          objectId: setting.id,
          beforeData: {
            warningDays: previousWarningDays
          },
          afterData: {
            warningDays
          },
          remark: `V2 续费到期预警已设为提前 ${warningDays} 天`
        });
        return setting;
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );

    return {
      warningDays,
      defaultWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
      minWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS,
      maxWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS,
      updatedAt: updated.updatedAt
    };
  }

  async getSummary(operatorOrNow?: AuthenticatedUser | Date) {
    const operator = operatorOrNow instanceof Date ? undefined : operatorOrNow;
    const now = operatorOrNow instanceof Date ? operatorOrNow : new Date();
    const settings = await this.getSettings();
    const [counts, summary] = await Promise.all([
      this.getWarningCounts({}, now, settings.warningDays),
      this.repository.getWarningSummary(now, settings.warningDays)
    ]);
    const displayMode = operator
      ? await this.sensitiveAccessService.resolveDisplayMode(
          operator,
          'account.apple_id',
          'dashboard_notifications'
        )
      : 'masked';
    const { upcoming, expired } = summary;
    const items = [...upcoming, ...expired].slice(0, 5).map((item) => ({
      id: item.id,
      customer: item.customer,
      account: {
        id: item.account.id,
        appleIdMasked: item.account.appleIdMasked,
        displayAppleId:
          displayMode === 'hidden'
            ? null
            : displayMode === 'full'
              ? this.fieldEncryptionService.decrypt(item.account.appleIdEncrypted)
              : item.account.appleIdMasked
      },
      service: item.serviceOption,
      dueAt: item.dueAt,
      warningState: this.resolveWarningState(item.status, item.dueAt, now, settings.warningDays)
    }));

    return {
      ...settings,
      ...counts,
      items,
      evaluatedAt: now,
      revalidateAt: this.getNextRevalidateAt(summary.nextTimedDueAt, now, settings.warningDays)
    };
  }

  private getNextRevalidateAt(dueAt: Date | null, now: Date, warningDays: number) {
    if (!dueAt) return null;
    const nextBoundary = [
      dueAt.getTime() - warningDays * DAY_MS,
      dueAt.getTime() - 7 * DAY_MS,
      dueAt.getTime() - 23 * 60 * 60 * 1000,
      dueAt.getTime() - 60 * 60 * 1000,
      dueAt.getTime()
    ]
      .filter((timestamp) => timestamp > now.getTime())
      .sort((left, right) => left - right)[0];
    return nextBoundary === undefined ? null : new Date(nextBoundary);
  }

  async getWarningCounts(baseCriteria: RenewalBaseCriteria, now: Date, warningDays: number) {
    return this.repository.getWarningCounts(baseCriteria, now, warningDays);
  }

  buildUpcomingWarningFilter(now: Date, warningDays: number): RenewalDueFilter {
    return { kind: 'warning', evaluatedAt: now, warningDays };
  }

  buildDefaultWorkbenchFilter(now: Date, warningDays: number): RenewalDueFilter {
    return { kind: 'default', evaluatedAt: now, warningDays };
  }

  buildAllDueFilter(): RenewalDueFilter {
    return { kind: 'all_due' };
  }

  resolveWarningState(
    status: IdBusinessV2ActivationStatus,
    dueAt: Date | null,
    now: Date,
    warningDays: number
  ): 'upcoming' | 'expired' | null {
    if (status === 'expired' || (status === 'active' && dueAt && dueAt <= now)) {
      return 'expired';
    }
    if (
      status === 'active' &&
      dueAt &&
      dueAt > now &&
      dueAt.getTime() <= now.getTime() + warningDays * DAY_MS
    ) {
      return 'upcoming';
    }
    return null;
  }

  private validateWarningDays(value: unknown) {
    if (
      !Number.isInteger(value) ||
      Number(value) < ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS ||
      Number(value) > ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS
    ) {
      throw new BadRequestException(
        `提前预警天数必须是 ${ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS} 到 ${ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS} 的整数`
      );
    }
    return Number(value);
  }

  private parseStoredWarningDays(warningDays: unknown) {
    try {
      return this.validateWarningDays(warningDays);
    } catch {
      return ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;
    }
  }
}
