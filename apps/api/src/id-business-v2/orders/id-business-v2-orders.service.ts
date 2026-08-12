import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { Amount4 } from '../runtime/public-api';
import type {
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource,
  IdBusinessV2OrderListRecord,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';
import {
  IdBusinessV2OrdersRepository,
  type IdBusinessV2OrderSortField
} from './persistence/id-business-v2-orders.repository';

export interface ListIdBusinessV2OrdersQuery extends PaginationQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  settlementPlatformOptionId?: string;
  status?: string;
  accountDisposition?: string;
  accountSource?: string;
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
const PRICING_EDITABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'failed'
]);
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

const ORDER_SORT_FIELDS: Record<string, IdBusinessV2OrderSortField> = {
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
    private readonly repository: IdBusinessV2OrdersRepository,
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
    const accountSource = this.parseAccountSource(query.accountSource);
    const { items, total } = await this.repository.listOrders({
      keyword,
      websiteAccountHash,
      customerId,
      serviceOptionId,
      accountId,
      settlementPlatformOptionId,
      status,
      accountDisposition,
      accountSource,
      openedAt: this.parseDateRange(query.openedFrom, query.openedTo),
      sortField: this.parseSortField(query.sortBy),
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });

    return {
      items: items.map((order) => this.toResponse(order)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async get(idValue: string) {
    const id = this.normalizeRequiredUuid(idValue, '订单');
    const order = await this.repository.findOrder(id);
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toResponse(order);
  }

  private parseSortField(value: unknown): IdBusinessV2OrderSortField {
    const normalized = this.normalizeNullableString(value) ?? 'openedAt';
    return ORDER_SORT_FIELDS[normalized] ?? 'openedAt';
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
    if (normalized === 'retained' || normalized === 'sold' || normalized === 'recovered') {
      return normalized;
    }
    throw new BadRequestException('ID 处理状态无效');
  }

  private parseAccountSource(value: unknown): IdBusinessV2OrderAccountSource | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (normalized === 'inventory' || normalized === 'customer_owned') return normalized;
    throw new BadRequestException('ID 来源无效');
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

  private toResponse(order: IdBusinessV2OrderListRecord) {
    const activeLock = order.locks?.[0] ?? null;
    const receivedAmount = order.receivedAmount;
    const receivedOriginalAmount = order.receivedOriginalAmount;
    const receivedFxRateToCny = order.receivedFxRateToCny;
    const platformFeeAmount = order.platformFeeAmount;
    const accountCostAmount = order.accountCostAmount;
    const balanceAmount = order.balanceAmount;
    const balanceCostAmount = order.balanceCostAmount;
    const refundCostAmount = order.refundCostAmount;
    const profitAmount = order.profitAmount;
    const profitRate =
      profitAmount === null || receivedAmount.lte(0)
        ? null
        : Amount4.from(profitAmount.ratio(receivedAmount).mul(100));
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
      receivedAmount: receivedAmount.toString(),
      receivedOriginalAmount: receivedOriginalAmount.toString(),
      receivedCurrency: order.receivedCurrency,
      receivedFxRateToCny: receivedFxRateToCny.toString(),
      receivedFxSnapshotId: order.receivedFxSnapshotId,
      receivedFinanceAccountId: order.receivedFinanceAccountId,
      receivedAt: order.receivedAt ?? order.openedAt ?? order.createdAt,
      platformFeeAmount: platformFeeAmount.toString(),
      accountDisposition: order.accountDisposition,
      accountSource: order.accountSource ?? 'inventory',
      sourceSoldOrderId: order.sourceSoldOrderId ?? null,
      sourceSoldOrder: order.sourceSoldOrder ?? null,
      accountCostAmount: accountCostAmount.toString(),
      appliedAccountCostAmount: (
        order.appliedAccountCostAmount ??
        (order.accountDisposition === 'sold' ? accountCostAmount : Amount4.zero())
      ).toString(),
      balanceAmount: balanceAmount.toString(),
      balanceCostAmount: balanceCostAmount.toString(),
      refundCostAmount: refundCostAmount?.toString() ?? null,
      profitAmount: profitAmount?.toString() ?? null,
      profitRate: profitRate?.toString() ?? null,
      status: order.status,
      statusChangedAt: order.statusChangedAt,
      openedAt: order.openedAt,
      dueAt: order.dueAt,
      remark: order.remark,
      createdBy: order.createdBy,
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
        canEditPricing: PRICING_EDITABLE_ORDER_STATUSES.has(order.status),
        canRefund: REFUNDABLE_ORDER_STATUSES.has(order.status),
        canCancel: CANCELLABLE_ORDER_STATUSES.has(order.status),
        canDelete: DELETABLE_ORDER_STATUSES.has(order.status)
      }
    };
  }
}
