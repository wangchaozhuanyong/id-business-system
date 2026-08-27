import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  divideDecimalStrings,
  multiplyDecimalStrings,
  v2UnsignedDecimalPattern
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import type { UpdateIdBusinessV2PurchaseRateSettingsDto } from './dto/update-id-business-v2-purchase-rate-settings.dto';
import { IdBusinessV2PurchaseRateAutomationRepository } from './persistence/id-business-v2-purchase-rate-automation.repository';

const DAILY_INTERVAL_MINUTES = 1440;
const DEFAULT_STALE_MINUTES = 1800;
const MIN_STALE_MINUTES = 1440;
const MAX_STALE_MINUTES = 4320;
const PERCENT_PATTERN = v2UnsignedDecimalPattern(8);

@Injectable()
export class IdBusinessV2PurchaseRateSettingsService {
  constructor(
    private readonly repository: IdBusinessV2PurchaseRateAutomationRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async get() {
    return this.toResponse(await this.ensureSettings());
  }

  async getRecord() {
    return this.ensureSettings();
  }

  async update(
    dto: UpdateIdBusinessV2PurchaseRateSettingsDto,
    operator?: AuthenticatedUser,
    requestId = 'purchase-rate-settings-update'
  ) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (typeof dto.autoEnabled !== 'boolean') throw new BadRequestException('自动采集状态格式无效');
    const staleMinutes = Number(dto.staleMinutes);
    if (
      !Number.isInteger(staleMinutes) ||
      staleMinutes < MIN_STALE_MINUTES ||
      staleMinutes > MAX_STALE_MINUTES
    ) {
      throw new BadRequestException(
        `过期提醒时间必须是 ${MIN_STALE_MINUTES} 到 ${MAX_STALE_MINUTES} 分钟之间的整数`
      );
    }
    const abnormalChangeRate = this.parseAbnormalPercent(dto.abnormalChangePercent);
    const now = new Date();

    const row = await this.transactionManager.execute(
      async (tx) => {
        const updated = await this.repository.updateSettings(tx, {
          autoEnabled: dto.autoEnabled,
          intervalMinutes: DAILY_INTERVAL_MINUTES,
          staleMinutes,
          abnormalChangeRate: abnormalChangeRate.toString(),
          nextRunAt: dto.autoEnabled ? this.nextDailyRun(now) : null,
          updatedBy: { connect: { id: operator.id } }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.purchase_rate.settings.update',
          objectType: 'id_business_v2_purchase_rate_settings',
          objectId: '1',
          afterData: {
            autoEnabled: updated.autoEnabled,
            intervalMinutes: updated.intervalMinutes,
            staleMinutes: updated.staleMinutes,
            abnormalChangeRate: updated.abnormalChangeRate.toString(),
            nextRunAt: updated.nextRunAt?.toISOString() ?? null
          },
          remark: dto.autoEnabled ? '收购汇率自动采集设置已更新' : '收购汇率自动采集已关闭'
        });
        return updated;
      },
      { changedScopes: ['exchange-rates'], requestId, operator, retryMode: 'none' }
    );
    return this.toResponse({
      ...row,
      abnormalChangeRate: Rate8.from(row.abnormalChangeRate.toString())
    });
  }

  private async ensureSettings() {
    const existing = await this.repository.findSettings();
    if (existing) return existing;
    try {
      const row = await this.transactionManager.execute(
        async (tx) => {
          const created = await this.repository.createDefaultSettings(
            tx,
            this.nextDailyRun(new Date())
          );
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.purchase_rate.settings.initialize',
            objectType: 'id_business_v2_purchase_rate_settings',
            objectId: '1',
            afterData: {
              autoEnabled: true,
              intervalMinutes: DAILY_INTERVAL_MINUTES,
              staleMinutes: DEFAULT_STALE_MINUTES,
              abnormalChangeRate: '0.1'
            },
            remark: '收购汇率自动采集设置初始化'
          });
          return created;
        },
        {
          changedScopes: ['exchange-rates'],
          requestId: 'purchase-rate-settings-initialize',
          retryMode: 'none'
        }
      );
      return {
        ...row,
        abnormalChangeRate: Rate8.from(row.abnormalChangeRate.toString())
      };
    } catch {
      const raced = await this.repository.findSettings();
      if (raced) return raced;
      throw new ServiceUnavailableException('收购汇率设置暂时无法初始化');
    }
  }

  private parseAbnormalPercent(value: unknown) {
    const normalized = String(value ?? '').trim();
    if (!PERCENT_PATTERN.test(normalized)) {
      throw new BadRequestException('异常波动阈值必须是最多 8 位小数的百分比');
    }
    const percent = Rate8.from(normalized);
    if (percent.lte(0) || percent.gt(100)) {
      throw new BadRequestException('异常波动阈值必须大于 0% 且不超过 100%');
    }
    return Rate8.from(divideDecimalStrings(percent.toString(), '100', 8));
  }

  private nextDailyRun(now: Date) {
    const next = new Date(now);
    next.setUTCHours(1, 5, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  private toResponse(settings: {
    autoEnabled: boolean;
    intervalMinutes: number;
    staleMinutes: number;
    abnormalChangeRate: Rate8;
    nextRunAt: Date | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      autoEnabled: settings.autoEnabled,
      intervalMinutes: settings.intervalMinutes,
      staleMinutes: settings.staleMinutes,
      abnormalChangeRate: settings.abnormalChangeRate.toString(),
      abnormalChangePercent: multiplyDecimalStrings(
        settings.abnormalChangeRate.toString(),
        '100',
        8
      ),
      nextRunAt: settings.nextRunAt,
      updatedByUserId: settings.updatedByUserId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      allowedStaleMinutes: { min: MIN_STALE_MINUTES, max: MAX_STALE_MINUTES }
    };
  }
}
