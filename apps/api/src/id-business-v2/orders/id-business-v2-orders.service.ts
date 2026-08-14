import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  Amount4,
  buildIdBusinessV2DateRange,
  buildIdBusinessV2BlindQueryTokens,
  matchesIdBusinessV2BlindSearch
} from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
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
const REFUNDABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>(['completed']);
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
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {}

  async list(query: ListIdBusinessV2OrdersQuery, operator?: AuthenticatedUser) {
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
    const sensitiveMatches = await this.resolveSensitiveMatches(keyword);
    const { items, total } = await this.repository.listOrders({
      keyword,
      websiteAccountHash,
      sensitiveAccountIds: sensitiveMatches.accountIds,
      sensitiveWebsiteOrderIds: sensitiveMatches.orderIds,
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
      items: await this.presentOrders(items, operator),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async get(idValue: string, operator?: AuthenticatedUser) {
    const id = this.normalizeRequiredUuid(idValue, '订单');
    const order = await this.repository.findOrder(id);
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return (await this.presentOrders([order], operator))[0];
  }

  private async presentOrders(orders: IdBusinessV2OrderListRecord[], operator?: AuthenticatedUser) {
    if (!operator) return orders.map((order) => this.toResponse(order));
    const modes = await this.sensitiveAccessService.resolveDisplayModes(
      operator,
      ['account.apple_id', 'order.website_account'],
      'business_records'
    );
    return orders.map((order) =>
      this.toResponse(order, {
        appleId:
          modes['account.apple_id'] === 'hidden'
            ? null
            : modes['account.apple_id'] === 'full' && order.account
              ? this.fieldEncryptionService.decrypt(order.account.appleIdEncrypted)
              : (order.account?.appleIdMasked ?? null),
        websiteAccount:
          modes['order.website_account'] === 'hidden'
            ? null
            : modes['order.website_account'] === 'full'
              ? this.fieldEncryptionService.decrypt(order.websiteAccountEncrypted)
              : order.websiteAccountMasked
      })
    );
  }

  private async resolveSensitiveMatches(keyword: string | null) {
    if (!keyword) return { accountIds: [], orderIds: [] };
    const appleIdTokens = buildIdBusinessV2BlindQueryTokens(keyword, 'apple-id', (value) =>
      this.fieldEncryptionService.hash(value)
    );
    const websiteAccountTokens = buildIdBusinessV2BlindQueryTokens(
      keyword,
      'website-account',
      (value) => this.fieldEncryptionService.hash(value)
    );
    if (appleIdTokens.length === 0 && websiteAccountTokens.length === 0) {
      return { accountIds: [], orderIds: [] };
    }

    const candidates = await this.repository.findSensitiveSearchCandidates({
      appleIdTokens,
      websiteAccountTokens
    });
    return {
      accountIds: candidates.accounts
        .filter((account) => {
          const value = this.fieldEncryptionService.decrypt(account.appleIdEncrypted);
          return value ? matchesIdBusinessV2BlindSearch(value, keyword) : false;
        })
        .map((account) => account.id),
      orderIds: candidates.orders
        .filter((order) => {
          const value = this.fieldEncryptionService.decrypt(order.websiteAccountEncrypted);
          return value ? matchesIdBusinessV2BlindSearch(value, keyword) : false;
        })
        .map((order) => order.id)
    };
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
    return buildIdBusinessV2DateRange(fromValue, toValue, {
      from: '开通开始日期',
      to: '开通结束日期',
      invalidRange: '开通开始日期不能晚于结束日期'
    });
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

  private toResponse(
    order: IdBusinessV2OrderListRecord,
    presentation?: { appleId: string | null; websiteAccount: string | null }
  ) {
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
            displayAppleId: presentation ? presentation.appleId : order.account.appleIdMasked,
            country: order.account.countryOption
          }
        : null,
      settlementPlatform: order.settlementPlatform,
      platformOrderNo: order.platformOrderNo,
      maskedWebsiteAccount: order.websiteAccountMasked,
      displayWebsiteAccount: presentation
        ? presentation.websiteAccount
        : order.websiteAccountMasked,
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
