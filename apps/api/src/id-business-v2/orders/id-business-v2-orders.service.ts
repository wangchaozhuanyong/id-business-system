import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IdBusinessV2OrderAccountDisposition } from '@prisma/client';
import type { IdBusinessV2OrderStatus, Prisma } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';

export interface ListIdBusinessV2OrdersQuery extends PaginationQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  settlementPlatformOptionId?: string;
  status?: string;
  accountDisposition?: string;
  openedFrom?: string;
  openedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'waiting_external',
  'processing',
  'completed',
  'refunded',
  'cancelled',
  'failed'
]);
const FULLY_EDITABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>(['draft', 'pending']);
const EDITABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'completed',
  'failed'
]);
const REFUNDABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>(['processing', 'completed']);
const CANCELLABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'failed'
]);
const DELETABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'refunded',
  'cancelled',
  'failed'
]);

const ORDER_INCLUDE = {
  customer: {
    select: {
      id: true,
      name: true
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
  settlementPlatform: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  locks: {
    where: {
      status: 'active' as const
    },
    select: {
      id: true,
      serviceOptionId: true,
      lockScope: true,
      status: true,
      lockedAt: true,
      expiresAt: true,
      endedAt: true,
      endReason: true,
      reason: true
    },
    orderBy: {
      lockedAt: 'desc' as const
    },
    take: 1
  }
} satisfies Prisma.IdBusinessV2OrderInclude;

type OrderRecord = Prisma.IdBusinessV2OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

const ORDER_SORT_FIELDS: Record<string, keyof Prisma.IdBusinessV2OrderOrderByWithRelationInput> = {
  orderNo: 'orderNo',
  receivedAmount: 'receivedAmount',
  platformFeeAmount: 'platformFeeAmount',
  accountCostAmount: 'accountCostAmount',
  balanceCostAmount: 'balanceCostAmount',
  refundCostAmount: 'refundCostAmount',
  profitAmount: 'profitAmount',
  balanceAmount: 'balanceAmount',
  status: 'status',
  accountDisposition: 'accountDisposition',
  openedAt: 'openedAt',
  dueAt: 'dueAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

@Injectable()
export class IdBusinessV2OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService
  ) {}

  async list(query: ListIdBusinessV2OrdersQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const websiteAccountHash = keyword ? this.fieldEncryptionService.hash(keyword) : null;
    const customerId = this.normalizeOptionalUuid(query.customerId, '客户');
    const serviceOptionId = this.normalizeOptionalUuid(query.serviceOptionId, '业务');
    const accountId = this.normalizeOptionalUuid(query.accountId, '使用 ID');
    const settlementPlatformOptionId = this.normalizeOptionalUuid(
      query.settlementPlatformOptionId,
      '结算平台'
    );
    const status = this.parseStatus(query.status);
    const accountDisposition = this.parseAccountDisposition(query.accountDisposition);
    const where: Prisma.IdBusinessV2OrderWhereInput = {
      deletedAt: null,
      customerId: customerId ?? undefined,
      serviceOptionId: serviceOptionId ?? undefined,
      accountId: accountId ?? undefined,
      settlementPlatformOptionId: settlementPlatformOptionId ?? undefined,
      status: status ?? undefined,
      accountDisposition: accountDisposition ?? undefined,
      openedAt: this.parseDateRange(query.openedFrom, query.openedTo),
      OR: keyword
        ? [
            { orderNo: { contains: keyword, mode: 'insensitive' } },
            { platformOrderNo: { contains: keyword, mode: 'insensitive' } },
            { websiteAccountMasked: { contains: keyword, mode: 'insensitive' } },
            { websiteAccountHash: websiteAccountHash ?? undefined },
            { customer: { is: { name: { contains: keyword, mode: 'insensitive' } } } },
            { serviceOption: { is: { name: { contains: keyword, mode: 'insensitive' } } } },
            { account: { is: { appleIdMasked: { contains: keyword, mode: 'insensitive' } } } },
            {
              settlementPlatform: {
                is: { name: { contains: keyword, mode: 'insensitive' } }
              }
            }
          ]
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Order.findMany({
        where,
        include: ORDER_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Order.count({ where })
    ]);

    return {
      items: items.map((order) => this.toResponse(order)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async get(idValue: string) {
    const id = this.normalizeRequiredUuid(idValue, '订单');
    const order = await this.prisma.idBusinessV2Order.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: ORDER_INCLUDE
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toResponse(order);
  }

  private buildOrderBy(query: ListIdBusinessV2OrdersQuery) {
    const field = ORDER_SORT_FIELDS[query.sortBy ?? 'openedAt'] ?? 'openedAt';
    const direction = query.sortOrder === 'asc' ? 'asc' : 'desc';
    if (field === 'openedAt') {
      return [
        { openedAt: { sort: direction, nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' }
      ] satisfies Prisma.IdBusinessV2OrderOrderByWithRelationInput[];
    }
    return [
      { [field]: direction },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2OrderOrderByWithRelationInput[];
  }

  private parseStatus(value: unknown): IdBusinessV2OrderStatus | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (ORDER_STATUSES.has(normalized as IdBusinessV2OrderStatus)) {
      return normalized as IdBusinessV2OrderStatus;
    }
    throw new BadRequestException('订单状态无效');
  }

  private parseAccountDisposition(value: unknown): IdBusinessV2OrderAccountDisposition | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (
      normalized === IdBusinessV2OrderAccountDisposition.retained ||
      normalized === IdBusinessV2OrderAccountDisposition.sold ||
      normalized === IdBusinessV2OrderAccountDisposition.recovered
    ) {
      return normalized;
    }
    throw new BadRequestException('ID 处理状态无效');
  }

  private parseDateRange(fromValue: unknown, toValue: unknown) {
    const from = this.parseDate(fromValue, '开通开始日期', false);
    const to = this.parseDate(toValue, '开通结束日期', true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('开通开始日期不能晚于结束日期');
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

  private toResponse(order: OrderRecord) {
    const activeLock = order.locks?.[0] ?? null;
    return {
      id: order.id,
      orderNo: order.orderNo,
      customer: order.customer,
      service: order.serviceOption,
      account: order.account
        ? {
            id: order.account.id,
            appleIdMasked: order.account.appleIdMasked,
            country: order.account.countryOption
          }
        : null,
      settlementPlatform: order.settlementPlatform,
      platformOrderNo: order.platformOrderNo,
      maskedWebsiteAccount: order.websiteAccountMasked,
      hasWebsiteAccount: Boolean(order.websiteAccountEncrypted),
      receivedAmount: toV2DecimalString(order.receivedAmount),
      receivedOriginalAmount: toV2DecimalString(
        order.receivedOriginalAmount ?? order.receivedAmount
      ),
      receivedCurrency: order.receivedCurrency ?? 'CNY',
      receivedFxRateToCny: toV2DecimalString(order.receivedFxRateToCny ?? 1),
      receivedFxSnapshotId: order.receivedFxSnapshotId ?? null,
      receivedFinanceAccountId: order.receivedFinanceAccountId ?? null,
      receivedAt: order.receivedAt ?? order.openedAt ?? order.createdAt,
      platformFeeAmount: toV2DecimalString(order.platformFeeAmount),
      accountDisposition: order.accountDisposition,
      accountCostAmount: toV2DecimalString(order.accountCostAmount),
      appliedAccountCostAmount: toV2DecimalString(
        order.accountDisposition === IdBusinessV2OrderAccountDisposition.sold
          ? order.accountCostAmount
          : 0
      ),
      balanceAmount: toV2DecimalString(order.balanceAmount),
      balanceCostAmount: toV2DecimalString(order.balanceCostAmount),
      refundCostAmount:
        order.refundCostAmount === null ? null : toV2DecimalString(order.refundCostAmount),
      profitAmount: order.profitAmount === null ? null : toV2DecimalString(order.profitAmount),
      status: order.status,
      statusChangedAt: order.statusChangedAt,
      openedAt: order.openedAt,
      dueAt: order.dueAt,
      remark: order.remark,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      activeLock: activeLock
        ? {
            id: activeLock.id,
            serviceOptionId: activeLock.serviceOptionId,
            lockScope: activeLock.lockScope,
            status: activeLock.status,
            lockedAt: activeLock.lockedAt,
            expiresAt: activeLock.expiresAt,
            endedAt: activeLock.endedAt,
            endReason: activeLock.endReason,
            reason: activeLock.reason
          }
        : null,
      operations: {
        canConsume: order.status === 'pending',
        canComplete: order.status === 'processing',
        canEdit: EDITABLE_ORDER_STATUSES.has(order.status),
        canEditCore: FULLY_EDITABLE_ORDER_STATUSES.has(order.status),
        canRefund: REFUNDABLE_ORDER_STATUSES.has(order.status),
        canCancel: CANCELLABLE_ORDER_STATUSES.has(order.status),
        canDelete: DELETABLE_ORDER_STATUSES.has(order.status)
      }
    };
  }
}
