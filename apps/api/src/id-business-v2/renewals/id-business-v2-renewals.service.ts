import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IdBusinessV2ActivationStatusService,
  type IdBusinessV2ActivationDueStatus
} from '../activations/public-api';
import { IdBusinessV2RenewalWarningService } from './id-business-v2-renewal-warning.service';

export type IdBusinessV2RenewalDueStatus = Extract<
  IdBusinessV2ActivationDueStatus,
  'due_within_1_hour' | 'due_within_23_hours' | 'due_within_7_days' | 'expired'
>;

export interface ListIdBusinessV2RenewalsQuery extends PaginationQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  dueStatus?: string;
  dueFrom?: string;
  dueTo?: string;
  warningOnly?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RENEWAL_DUE_STATUSES = new Set<IdBusinessV2RenewalDueStatus>([
  'due_within_1_hour',
  'due_within_23_hours',
  'due_within_7_days',
  'expired'
]);

const RENEWAL_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNo: true,
      websiteAccountMasked: true
    }
  },
  customer: {
    select: {
      id: true,
      name: true
    }
  },
  account: {
    select: {
      id: true,
      appleIdMasked: true,
      currentBalance: true,
      recordStatus: true,
      countryOption: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  },
  serviceOption: {
    select: {
      id: true,
      code: true,
      name: true,
      parent: {
        select: {
          id: true,
          name: true
        }
      }
    }
  }
} satisfies Prisma.IdBusinessV2ActivationInclude;

type RenewalRecord = Prisma.IdBusinessV2ActivationGetPayload<{
  include: typeof RENEWAL_INCLUDE;
}>;

@Injectable()
export class IdBusinessV2RenewalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activationStatusService: IdBusinessV2ActivationStatusService,
    private readonly renewalWarningService: IdBusinessV2RenewalWarningService
  ) {}

  async listWorkbench(query: ListIdBusinessV2RenewalsQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const dueStatus = this.parseDueStatus(query.dueStatus);
    const warningOnly = this.parseBooleanFlag(query.warningOnly, '仅看预警');
    const now = new Date();
    const dueDateRange = this.parseDateRange(query.dueFrom, query.dueTo);
    const warningSettings = await this.renewalWarningService.getSettings();
    const dueCondition = dueStatus
      ? ({
          AND: [
            {
              renewedBy: {
                is: null
              }
            },
            this.activationStatusService.buildWhere(dueStatus, now)
          ]
        } satisfies Prisma.IdBusinessV2ActivationWhereInput)
      : dueDateRange
        ? this.renewalWarningService.buildAllDueWhere()
        : warningOnly
          ? this.renewalWarningService.buildUpcomingWarningWhere(now, warningSettings.warningDays)
          : this.renewalWarningService.buildDefaultWorkbenchWhere(now, warningSettings.warningDays);
    const baseWhere: Prisma.IdBusinessV2ActivationWhereInput = {
      customerId: this.normalizeOptionalUuid(query.customerId, '客户') ?? undefined,
      serviceOptionId: this.normalizeOptionalUuid(query.serviceOptionId, '业务') ?? undefined,
      accountId: this.normalizeOptionalUuid(query.accountId, '苹果 ID') ?? undefined,
      AND: [
        ...(keyword
          ? [
              {
                OR: [
                  { order: { is: { orderNo: { contains: keyword, mode: 'insensitive' } } } },
                  { customer: { is: { name: { contains: keyword, mode: 'insensitive' } } } },
                  {
                    serviceOption: {
                      is: { name: { contains: keyword, mode: 'insensitive' } }
                    }
                  },
                  {
                    account: {
                      is: { appleIdMasked: { contains: keyword, mode: 'insensitive' } }
                    }
                  },
                  {
                    order: {
                      is: {
                        websiteAccountMasked: {
                          contains: keyword,
                          mode: 'insensitive'
                        }
                      }
                    }
                  }
                ]
              } satisfies Prisma.IdBusinessV2ActivationWhereInput
            ]
          : [])
      ]
    };
    const where: Prisma.IdBusinessV2ActivationWhereInput = {
      AND: [
        baseWhere,
        dueCondition,
        ...(dueDateRange
          ? [
              {
                dueAt: dueDateRange
              } satisfies Prisma.IdBusinessV2ActivationWhereInput
            ]
          : [])
      ]
    };

    const [items, total, warningCounts] = await Promise.all([
      this.prisma.idBusinessV2Activation.findMany({
        where,
        include: RENEWAL_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Activation.count({ where }),
      this.renewalWarningService.getWarningCounts(baseWhere, now, warningSettings.warningDays)
    ]);

    return {
      items: items.map((item) => this.toResponse(item, now, warningSettings.warningDays)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      warningSummary: {
        warningDays: warningSettings.warningDays,
        ...warningCounts
      },
      evaluatedAt: now
    };
  }

  async listFilterOptions() {
    const actionableWhere = this.renewalWarningService.buildAllDueWhere();
    const [customers, accounts, services] = await Promise.all([
      this.prisma.idBusinessV2Customer.findMany({
        where: {
          activations: {
            some: actionableWhere
          }
        },
        select: {
          id: true,
          name: true
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Account.findMany({
        where: {
          activations: {
            some: actionableWhere
          }
        },
        select: {
          id: true,
          appleIdMasked: true
        },
        orderBy: [{ appleIdMasked: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'service',
          activationsByService: {
            some: actionableWhere
          }
        },
        select: {
          id: true,
          code: true,
          name: true,
          parent: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);

    return {
      customers,
      accounts,
      services
    };
  }

  private buildOrderBy(
    query: ListIdBusinessV2RenewalsQuery
  ): Prisma.IdBusinessV2ActivationOrderByWithRelationInput[] {
    const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
    const field = query.sortBy ?? 'dueAt';
    const supported: Record<string, Prisma.IdBusinessV2ActivationOrderByWithRelationInput> = {
      customer: { customer: { name: direction } },
      account: { account: { appleIdMasked: direction } },
      currentBalance: { account: { currentBalance: direction } },
      service: { serviceOption: { name: direction } },
      openedAt: { openedAt: direction },
      dueAt: { dueAt: direction }
    };
    return [supported[field] ?? supported.dueAt, { id: 'asc' }];
  }

  private parseDueStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (RENEWAL_DUE_STATUSES.has(normalized as IdBusinessV2RenewalDueStatus)) {
      return normalized as IdBusinessV2RenewalDueStatus;
    }
    throw new BadRequestException('续费到期状态无效');
  }

  private parseBooleanFlag(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || normalized === 'false') return false;
    if (normalized === 'true') return true;
    throw new BadRequestException(`${label}参数格式无效`);
  }

  private parseDateRange(
    fromValue: unknown,
    toValue: unknown
  ): { gte?: Date; lte?: Date } | undefined {
    const from = this.parseDate(fromValue, '到期日期开始', false);
    const to = this.parseDate(toValue, '到期日期结束', true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('到期日期开始不能晚于结束');
    }
    if (!from && !to) return undefined;
    return {
      gte: from ?? undefined,
      lte: to ?? undefined
    };
  }

  private parseDate(value: unknown, label: string, endOfDay: boolean) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (!DATE_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    const date = new Date(`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return date;
  }

  private normalizeKeyword(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > 160) {
      throw new BadRequestException('搜索关键词不能超过 160 个字符');
    }
    return normalized;
  }

  private normalizeOptionalUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('参数格式无效');
    }
    return String(value).trim() || null;
  }

  private toResponse(item: RenewalRecord, evaluatedAt: Date, warningDays: number) {
    const status = this.activationStatusService.resolve(item.status, item.dueAt, evaluatedAt);
    return {
      id: item.id,
      orderId: item.orderId,
      orderNo: item.order.orderNo,
      customer: item.customer,
      account: {
        id: item.account.id,
        appleIdMasked: item.account.appleIdMasked,
        currentBalance: item.account.currentBalance.toString(),
        recordStatus: item.account.recordStatus,
        country: item.account.countryOption
      },
      service: item.serviceOption,
      maskedWebsiteAccount: item.order.websiteAccountMasked,
      openedAt: item.openedAt,
      dueAt: item.dueAt,
      status,
      warningState: this.renewalWarningService.resolveWarningState(
        item.status,
        item.dueAt,
        evaluatedAt,
        warningDays
      ),
      withinActionWindow: status.code !== 'active',
      updatedAt: item.updatedAt
    };
  }
}
