import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus, Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ID_BUSINESS_V2_DUE_STATUS_CODES,
  IdBusinessV2ActivationStatusService,
  type IdBusinessV2ActivationDueStatus
} from './id-business-v2-activation-status.service';

export interface ListIdBusinessV2ActivationsQuery extends PaginationQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  status?: string;
  dueStatus?: string;
  openedFrom?: string;
  openedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVATION_STATUSES = new Set<IdBusinessV2ActivationStatus>([
  'active',
  'expired',
  'cancelled',
  'abnormal'
]);
const DUE_STATUSES = new Set<IdBusinessV2ActivationDueStatus>(ID_BUSINESS_V2_DUE_STATUS_CODES);

const ACTIVATION_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNo: true,
      status: true,
      websiteAccountMasked: true,
      receivedAmount: true,
      profitAmount: true
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

type ActivationRecord = Prisma.IdBusinessV2ActivationGetPayload<{
  include: typeof ACTIVATION_INCLUDE;
}>;

const SORT_FIELDS: Record<string, keyof Prisma.IdBusinessV2ActivationOrderByWithRelationInput> = {
  openedAt: 'openedAt',
  dueAt: 'dueAt',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

@Injectable()
export class IdBusinessV2ActivationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activationStatusService: IdBusinessV2ActivationStatusService
  ) {}

  async list(query: ListIdBusinessV2ActivationsQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const now = new Date();
    const status = this.parseStoredStatus(query.status);
    const dueStatus = this.parseDueStatus(query.dueStatus);
    const where: Prisma.IdBusinessV2ActivationWhereInput = {
      customerId: this.normalizeOptionalUuid(query.customerId, '客户') ?? undefined,
      serviceOptionId: this.normalizeOptionalUuid(query.serviceOptionId, '业务') ?? undefined,
      accountId: this.normalizeOptionalUuid(query.accountId, '苹果 ID') ?? undefined,
      status: status ?? undefined,
      openedAt: this.parseDateRange(query.openedFrom, query.openedTo, '开通日期'),
      dueAt: this.parseDateRange(query.dueFrom, query.dueTo, '到期日期'),
      AND: dueStatus ? this.buildDueStatusConditions(dueStatus, now) : undefined,
      OR: keyword
        ? [
            { order: { is: { orderNo: { contains: keyword, mode: 'insensitive' } } } },
            { customer: { is: { name: { contains: keyword, mode: 'insensitive' } } } },
            { serviceOption: { is: { name: { contains: keyword, mode: 'insensitive' } } } },
            { account: { is: { appleIdMasked: { contains: keyword, mode: 'insensitive' } } } },
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
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Activation.findMany({
        where,
        include: ACTIVATION_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Activation.count({ where })
    ]);

    return {
      items: items.map((activation) => this.toResponse(activation, now)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      evaluatedAt: now
    };
  }

  async get(idValue: string) {
    const id = this.normalizeRequiredUuid(idValue, '开通记录');
    const activation = await this.prisma.idBusinessV2Activation.findUnique({
      where: { id },
      include: ACTIVATION_INCLUDE
    });
    if (!activation) {
      throw new NotFoundException('开通记录不存在');
    }
    return this.toResponse(activation, new Date());
  }

  private buildOrderBy(query: ListIdBusinessV2ActivationsQuery) {
    const field = SORT_FIELDS[query.sortBy ?? 'dueAt'] ?? 'dueAt';
    const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
    return [
      { [field]: direction },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2ActivationOrderByWithRelationInput[];
  }

  private buildDueStatusConditions(
    dueStatus: IdBusinessV2ActivationDueStatus,
    now: Date
  ): Prisma.IdBusinessV2ActivationWhereInput[] {
    return [this.activationStatusService.buildWhere(dueStatus, now)];
  }

  private parseDateRange(
    fromValue: unknown,
    toValue: unknown,
    label: string
  ): { gte?: Date; lte?: Date } | undefined {
    const from = this.parseDate(fromValue, `${label}开始`, false);
    const to = this.parseDate(toValue, `${label}结束`, true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException(`${label}开始不能晚于结束`);
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

  private parseStoredStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (ACTIVATION_STATUSES.has(normalized as IdBusinessV2ActivationStatus)) {
      return normalized as IdBusinessV2ActivationStatus;
    }
    throw new BadRequestException('开通记录状态无效');
  }

  private parseDueStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (DUE_STATUSES.has(normalized as IdBusinessV2ActivationDueStatus)) {
      return normalized as IdBusinessV2ActivationDueStatus;
    }
    throw new BadRequestException('到期状态无效');
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
    return normalized ? this.normalizeRequiredUuid(normalized, label) : null;
  }

  private normalizeRequiredUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !UUID_PATTERN.test(normalized)) {
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

  private toResponse(activation: ActivationRecord, evaluatedAt: Date) {
    const status = this.activationStatusService.resolve(
      activation.status,
      activation.dueAt,
      evaluatedAt
    );
    return {
      id: activation.id,
      orderId: activation.orderId,
      order: {
        id: activation.order.id,
        orderNo: activation.order.orderNo,
        status: activation.order.status,
        receivedAmount: activation.order.receivedAmount.toString(),
        profitAmount: activation.order.profitAmount?.toString() ?? null
      },
      customer: activation.customer,
      service: activation.serviceOption,
      account: {
        id: activation.account.id,
        appleIdMasked: activation.account.appleIdMasked,
        country: activation.account.countryOption
      },
      maskedWebsiteAccount: activation.order.websiteAccountMasked,
      openedAt: activation.openedAt,
      dueAt: activation.dueAt,
      storedStatus: activation.status,
      status,
      remark: activation.remark,
      statusChangedAt: activation.statusChangedAt,
      createdAt: activation.createdAt,
      updatedAt: activation.updatedAt
    };
  }
}
