import { BadRequestException, Injectable } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { UpdateIdBusinessV2RenewalWarningSettingsDto } from './dto/update-id-business-v2-renewal-warning-settings.dto';

export const ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS = 3;
export const ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS = 1;
export const ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS = 365;
export const ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE = 'global';

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_ITEM_SELECT = {
  id: true,
  dueAt: true,
  status: true,
  customer: {
    select: {
      id: true,
      name: true
    }
  },
  account: {
    select: {
      id: true,
      appleIdMasked: true
    }
  },
  serviceOption: {
    select: {
      id: true,
      name: true
    }
  }
} satisfies Prisma.IdBusinessV2ActivationSelect;

@Injectable()
export class IdBusinessV2RenewalWarningService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings() {
    const setting = await this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: {
        scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
      },
      select: {
        warningDays: true,
        updatedAt: true
      }
    });
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.idBusinessV2RenewalWarningSetting.findUnique({
        where: {
          scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
        },
        select: {
          id: true,
          warningDays: true
        }
      });
      const previousWarningDays = existing
        ? this.parseStoredWarningDays(existing.warningDays)
        : ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;
      const setting = await tx.idBusinessV2RenewalWarningSetting.upsert({
        where: {
          scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
        },
        create: {
          scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE,
          warningDays,
          updatedByUserId: operator.id
        },
        update: {
          warningDays,
          updatedByUserId: operator.id
        }
      });

      await tx.auditLog.create({
        data: {
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
        }
      });
      return setting;
    });

    return {
      warningDays,
      defaultWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
      minWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MIN_DAYS,
      maxWarningDays: ID_BUSINESS_V2_RENEWAL_WARNING_MAX_DAYS,
      updatedAt: updated.updatedAt
    };
  }

  async getSummary(now = new Date()) {
    const settings = await this.getSettings();
    const [counts, upcoming, expired] = await Promise.all([
      this.getWarningCounts({}, now, settings.warningDays),
      this.prisma.idBusinessV2Activation.findMany({
        where: this.buildUpcomingWarningWhere(now, settings.warningDays),
        select: SUMMARY_ITEM_SELECT,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 5
      }),
      this.prisma.idBusinessV2Activation.findMany({
        where: this.buildExpiredWhere(now),
        select: SUMMARY_ITEM_SELECT,
        orderBy: [{ dueAt: 'desc' }, { id: 'asc' }],
        take: 5
      })
    ]);
    const items = [...upcoming, ...expired].slice(0, 5).map((item) => ({
      id: item.id,
      customer: item.customer,
      account: item.account,
      service: item.serviceOption,
      dueAt: item.dueAt,
      warningState: this.resolveWarningState(item.status, item.dueAt, now, settings.warningDays)
    }));

    return {
      ...settings,
      ...counts,
      items,
      evaluatedAt: now
    };
  }

  async getWarningCounts(
    baseWhere: Prisma.IdBusinessV2ActivationWhereInput,
    now: Date,
    warningDays: number
  ) {
    const [upcomingCount, expiredCount] = await Promise.all([
      this.prisma.idBusinessV2Activation.count({
        where: {
          AND: [baseWhere, this.buildUpcomingWarningWhere(now, warningDays)]
        }
      }),
      this.prisma.idBusinessV2Activation.count({
        where: {
          AND: [baseWhere, this.buildExpiredWhere(now)]
        }
      })
    ]);
    return {
      upcomingCount,
      expiredCount,
      totalCount: upcomingCount + expiredCount
    };
  }

  buildUpcomingWarningWhere(
    now: Date,
    warningDays: number
  ): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      AND: [
        {
          renewedBy: {
            is: null
          }
        },
        {
          status: 'active',
          dueAt: {
            gt: now,
            lte: new Date(now.getTime() + warningDays * DAY_MS)
          }
        }
      ]
    };
  }

  buildExpiredWhere(now: Date): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      AND: [
        {
          renewedBy: {
            is: null
          }
        },
        {
          OR: [
            { status: 'expired' },
            {
              status: 'active',
              dueAt: {
                lte: now
              }
            }
          ]
        }
      ]
    };
  }

  buildDefaultWorkbenchWhere(
    now: Date,
    warningDays: number
  ): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      AND: [
        {
          renewedBy: {
            is: null
          }
        },
        {
          OR: [
            { status: 'expired' },
            {
              status: 'active',
              dueAt: {
                not: null,
                lte: new Date(now.getTime() + warningDays * DAY_MS)
              }
            }
          ]
        }
      ]
    };
  }

  buildAllDueWhere(): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      AND: [
        {
          renewedBy: {
            is: null
          }
        },
        {
          OR: [
            { status: 'expired' },
            {
              status: 'active',
              dueAt: {
                not: null
              }
            }
          ]
        }
      ]
    };
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
