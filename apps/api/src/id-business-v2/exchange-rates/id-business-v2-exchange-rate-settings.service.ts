import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { UpdateIdBusinessV2ExchangeRateSettingsDto } from './dto/update-id-business-v2-exchange-rate-settings.dto';

const SETTINGS_ID = 1;
const ALLOWED_INTERVALS = new Set([5, 15, 30, 60, 180, 360, 720, 1440]);
const MAX_TARGET_AMOUNT = new Prisma.Decimal('1000000');

interface ClaimedSettings {
  targetAmountRmb: Prisma.Decimal;
  intervalMinutes: number;
  nextRunAt: Date;
}

@Injectable()
export class IdBusinessV2ExchangeRateSettingsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async update(dto: UpdateIdBusinessV2ExchangeRateSettingsDto, operator?: AuthenticatedUser) {
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
    const now = new Date();

    const settings = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.idBusinessV2ExchangeRateSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          autoEnabled: dto.autoEnabled,
          intervalMinutes: dto.intervalMinutes,
          targetAmountRmb,
          nextRunAt: dto.autoEnabled ? now : null,
          updatedByUserId: operator.id
        },
        update: {
          autoEnabled: dto.autoEnabled,
          intervalMinutes: dto.intervalMinutes,
          targetAmountRmb,
          nextRunAt: dto.autoEnabled ? now : null,
          updatedByUserId: operator.id
        }
      });

      await tx.auditLog.create({
        data: {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.settings.update',
          objectType: 'id_business_v2_exchange_rate_settings',
          afterData: {
            autoEnabled: updated.autoEnabled,
            intervalMinutes: updated.intervalMinutes,
            targetAmountRmb: updated.targetAmountRmb.toString(),
            nextRunAt: updated.nextRunAt
          },
          remark: updated.autoEnabled
            ? 'V2 汇率设置已保存，并安排立即采集'
            : 'V2 汇率自动采集已关闭'
        }
      });
      return updated;
    });

    return this.toResponse(settings);
  }

  async claimDueSchedule(): Promise<ClaimedSettings | null> {
    const rows = await this.prisma.$queryRaw<ClaimedSettings[]>(Prisma.sql`
      UPDATE "id_business_v2_exchange_rate_settings"
      SET
        "next_run_at" = to_timestamp(
          (
            FLOOR(
              EXTRACT(EPOCH FROM clock_timestamp())
              / ("interval_minutes" * 60)
            ) + 1
          ) * ("interval_minutes" * 60)
        ),
        "updated_at" = clock_timestamp()
      WHERE
        "id" = 1
        AND "auto_enabled" = true
        AND "next_run_at" <= clock_timestamp()
      RETURNING
        "target_amount_rmb" AS "targetAmountRmb",
        "interval_minutes" AS "intervalMinutes",
        "next_run_at" AS "nextRunAt"
    `);
    return rows[0] ?? null;
  }

  private async ensureSettings() {
    return this.prisma.idBusinessV2ExchangeRateSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        autoEnabled: true,
        intervalMinutes: 30,
        targetAmountRmb: new Prisma.Decimal('5000'),
        nextRunAt: new Date()
      },
      update: {}
    });
  }

  private parseTargetAmount(value: unknown) {
    const normalized =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(normalized);
    } catch {
      throw new BadRequestException('目标成交额格式无效');
    }
    const rounded = amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if (!rounded.isFinite() || rounded.lte(0) || rounded.gt(MAX_TARGET_AMOUNT)) {
      throw new BadRequestException('目标成交额必须大于 0 且不超过 1,000,000 元');
    }
    return rounded;
  }

  private toResponse(settings: {
    autoEnabled: boolean;
    intervalMinutes: number;
    targetAmountRmb: Prisma.Decimal;
    nextRunAt: Date | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      autoEnabled: settings.autoEnabled,
      intervalMinutes: settings.intervalMinutes,
      targetAmountRmb: settings.targetAmountRmb.toString(),
      nextRunAt: settings.nextRunAt,
      emergencyNetworkEnabled: this.isNetworkEnabled(),
      updatedByUserId: settings.updatedByUserId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      allowedIntervals: [...ALLOWED_INTERVALS]
    };
  }
}
