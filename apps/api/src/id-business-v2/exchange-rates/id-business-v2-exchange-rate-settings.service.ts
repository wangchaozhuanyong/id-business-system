import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  V2_DECIMAL_PATTERN,
  V2_DECIMAL_PLACES,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import type { UpdateIdBusinessV2ExchangeRateSettingsDto } from './dto/update-id-business-v2-exchange-rate-settings.dto';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

const ALLOWED_INTERVALS = new Set([5, 15, 30, 60, 180, 360, 720, 1440]);
const MAX_TARGET_AMOUNT = Amount4.from('1000000');
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;

interface ClaimedSettings {
  targetAmountRmb: Amount4;
  intervalMinutes: number;
  nextRunAt: Date;
}

@Injectable()
export class IdBusinessV2ExchangeRateSettingsService {
  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  isNetworkEnabled() {
    return process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED !== 'false';
  }

  async get() {
    const settings = await this.ensureSettings();
    return this.toResponse(settings);
  }

  async getRecord() {
    return this.ensureSettings();
  }

  async update(
    dto: UpdateIdBusinessV2ExchangeRateSettingsDto,
    operator?: AuthenticatedUser,
    requestId = 'exchange-rate-settings'
  ) {
    if (!operator?.id) {
      throw new BadRequestException('无法识别当前操作人');
    }
    if (typeof dto.autoEnabled !== 'boolean') {
      throw new BadRequestException('自动采集开关格式无效');
    }
    if (dto.autoEnabled && !this.isNetworkEnabled()) {
      throw new ServiceUnavailableException('当前运行模式未启用自动汇率采集');
    }
    if (!Number.isInteger(dto.intervalMinutes) || !ALLOWED_INTERVALS.has(dto.intervalMinutes)) {
      throw new BadRequestException('采集周期必须是允许的分钟数');
    }
    const targetAmountRmb = this.parseTargetAmount(dto.targetAmountRmb);
    const retentionDays = this.parseRetentionDays(dto.retentionDays);
    const now = new Date();

    const settings = await this.transactionManager.execute(
      async (tx) => {
        const updated = await this.repository.upsertSettings(tx, {
          autoEnabled: dto.autoEnabled,
          intervalMinutes: dto.intervalMinutes,
          targetAmountRmb: targetAmountRmb.toString(),
          retentionDays,
          nextRunAt: dto.autoEnabled ? now : null,
          updatedByUserId: operator.id
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.settings.update',
          objectType: 'id_business_v2_exchange_rate_settings',
          afterData: {
            autoEnabled: updated.autoEnabled,
            intervalMinutes: updated.intervalMinutes,
            targetAmountRmb: updated.targetAmountRmb.toString(),
            retentionDays: updated.retentionDays,
            nextRunAt: updated.nextRunAt?.toISOString() ?? null
          },
          remark: updated.autoEnabled
            ? 'V2 汇率设置已保存，并安排立即采集'
            : 'V2 汇率自动采集已关闭'
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(settings);
  }

  async claimDueSchedule(
    requestId = 'exchange-rate-schedule-claim'
  ): Promise<ClaimedSettings | null> {
    return this.transactionManager.execute(
      async (tx) => {
        const row = await this.repository.claimDueSchedule(tx);
        if (!row) return null;
        await this.audit.append(tx, {
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.schedule.claim',
          objectType: 'id_business_v2_exchange_rate_settings',
          afterData: {
            intervalMinutes: row.intervalMinutes,
            targetAmountRmb: row.targetAmountRmb.toString(),
            nextRunAt: row.nextRunAt.toISOString()
          },
          remark: 'V2 汇率定时任务已原子领取'
        });
        return row;
      },
      { requestId, retryMode: 'none' }
    );
  }

  private async ensureSettings() {
    const existing = await this.repository.findSettings();
    if (existing) return existing;
    try {
      const created = await this.transactionManager.execute(
        async (tx) => {
          const row = await this.repository.createDefaultSettings(tx, new Date());
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.settings.initialize',
            objectType: 'id_business_v2_exchange_rate_settings',
            afterData: {
              autoEnabled: true,
              intervalMinutes: 30,
              targetAmountRmb: '5000',
              retentionDays: 30
            },
            remark: 'V2 汇率设置初始化'
          });
          return row;
        },
        { requestId: 'exchange-rate-settings-initialize', retryMode: 'none' }
      );
      return created;
    } catch {
      const raced = await this.repository.findSettings();
      if (raced) return raced;
      throw new ServiceUnavailableException('汇率设置暂时无法初始化');
    }
  }

  private parseTargetAmount(value: unknown) {
    const normalized =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`目标成交额必须是最多 ${V2_DECIMAL_PLACES} 位小数的正数`);
    }
    let amount: Amount4;
    try {
      amount = Amount4.from(normalized);
    } catch {
      throw new BadRequestException('目标成交额格式无效');
    }
    if (amount.lte(0) || amount.gt(MAX_TARGET_AMOUNT)) {
      throw new BadRequestException('目标成交额必须大于 0 且不超过 1,000,000 元');
    }
    return Amount4.from(amount.toFixed(2));
  }

  private parseRetentionDays(value: unknown) {
    if (value === undefined || value === null || value === '') return 30;
    const days = Number(value);
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      throw new BadRequestException(
        `数据保留天数必须是 ${MIN_RETENTION_DAYS} 到 ${MAX_RETENTION_DAYS} 之间的整数`
      );
    }
    return days;
  }

  private toResponse(settings: {
    autoEnabled: boolean;
    intervalMinutes: number;
    targetAmountRmb: Amount4;
    retentionDays: number;
    nextRunAt: Date | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      autoEnabled: settings.autoEnabled,
      intervalMinutes: settings.intervalMinutes,
      targetAmountRmb: settings.targetAmountRmb.toString(),
      retentionDays: settings.retentionDays,
      nextRunAt: settings.nextRunAt,
      emergencyNetworkEnabled: this.isNetworkEnabled(),
      updatedByUserId: settings.updatedByUserId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      allowedIntervals: [...ALLOWED_INTERVALS],
      allowedRetentionDays: {
        min: MIN_RETENTION_DAYS,
        max: MAX_RETENTION_DAYS
      }
    };
  }
}
