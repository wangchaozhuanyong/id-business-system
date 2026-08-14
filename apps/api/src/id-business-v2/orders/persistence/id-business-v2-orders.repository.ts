import { Injectable } from '@nestjs/common';
import type { IdBusinessV2BalanceLedger, IdBusinessV2Order, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  mapAmount4,
  mapOptionalAmount4,
  mapRate8,
  type V2CommandTransaction
} from '../../runtime/public-api';
import type { LockedAccountRow, LockedOrderRow } from '../id-business-v2-order-lock-support';
import type {
  IdBusinessV2MatchingAccount,
  IdBusinessV2MatchingContext,
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource,
  IdBusinessV2OrderListRecord,
  IdBusinessV2OrderRecord,
  IdBusinessV2OrderStatus
} from '../id-business-v2-order.types';

const ORDER_INCLUDE = {
  displaySnapshot: true,
  customer: { select: { id: true, name: true } },
  serviceOption: {
    select: {
      id: true,
      code: true,
      name: true,
      parent: { select: { id: true, name: true } }
    }
  },
  account: {
    select: {
      id: true,
      appleIdEncrypted: true,
      appleIdMasked: true,
      countryOption: { select: { id: true, code: true, name: true } }
    }
  },
  sourceSoldOrder: {
    select: {
      id: true,
      orderNo: true,
      customer: { select: { id: true, name: true } }
    }
  },
  settlementPlatform: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, username: true, displayName: true } },
  locks: {
    where: { status: 'active' as const },
    orderBy: { lockedAt: 'desc' as const },
    take: 1
  }
} satisfies Prisma.IdBusinessV2OrderInclude;

const MATCHING_ACCOUNT_SELECT = {
  id: true,
  appleIdEncrypted: true,
  appleIdMasked: true,
  currentBalance: true,
  balanceCostAmount: true,
  purchaseCost: true,
  ownershipTransferredAt: true,
  updatedAt: true,
  countryOption: { select: { id: true, code: true, name: true } },
  statusOption: { select: { id: true, code: true, name: true } },
  soldByOrder: {
    select: {
      id: true,
      orderNo: true,
      customer: { select: { id: true, name: true } }
    }
  }
} satisfies Prisma.IdBusinessV2AccountSelect;

type OrderListPersistenceRow = Prisma.IdBusinessV2OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;
type MatchingAccountPersistenceRow = Prisma.IdBusinessV2AccountGetPayload<{
  select: typeof MATCHING_ACCOUNT_SELECT;
}>;

export type IdBusinessV2OrderSortField =
  | 'orderNo'
  | 'receivedAmount'
  | 'platformFeeAmount'
  | 'accountCostAmount'
  | 'balanceCostAmount'
  | 'refundCostAmount'
  | 'profitAmount'
  | 'balanceAmount'
  | 'status'
  | 'accountDisposition'
  | 'openedAt'
  | 'dueAt'
  | 'createdAt'
  | 'updatedAt';

export interface IdBusinessV2OrderListCriteria {
  keyword: string | null;
  websiteAccountHash: string | null;
  sensitiveAccountIds: string[];
  sensitiveWebsiteOrderIds: string[];
  customerId: string | null;
  serviceOptionId: string | null;
  accountId: string | null;
  settlementPlatformOptionId: string | null;
  status: IdBusinessV2OrderStatus | null;
  accountDisposition: IdBusinessV2OrderAccountDisposition | null;
  accountSource: IdBusinessV2OrderAccountSource | null;
  openedAt?: { gte?: Date; lte?: Date };
  sortField: IdBusinessV2OrderSortField;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface IdBusinessV2MatchingCriteria {
  countryOptionId: string;
  categoryOptionId: string;
  serviceOptionId: string;
  editingOrderId: string | null;
  accountSource: IdBusinessV2OrderAccountSource;
  customerId: string | null;
  requiredBalance: string;
  evaluatedAt: Date;
  keyword: string | null;
  keywordHash: string | null;
  keywordSearchTokens: string[];
  limit: number;
}

interface LockedOrderPersistenceRow {
  id: string;
  orderNo: string;
  customerId: string;
  serviceOptionId: string;
  accountId: string | null;
  accountSource: IdBusinessV2OrderAccountSource;
  sourceSoldOrderId: string | null;
  receivedAmount: unknown;
  platformFeeAmount: unknown;
  accountCostAmount: unknown;
  appliedAccountCostAmount: unknown;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  balanceAmount: unknown;
  balanceCostAmount: unknown;
  transferredBalanceCostAmount: unknown;
  appliedBalanceCostAmount: unknown;
  refundCostAmount: unknown | null;
  profitAmount: unknown | null;
  status: IdBusinessV2OrderStatus;
}

interface LockedAccountPersistenceRow {
  id: string;
  appleIdMasked: string;
  currentBalance: unknown;
  balanceCostAmount: unknown;
  purchaseCost: unknown;
  soldByOrderId: string | null;
  soldByCustomerId: string | null;
  ownershipTransferredAt: Date | null;
  lossReportedAt: Date | null;
  countryOptionId: string;
  statusCode: string;
}

export interface LockedAccountForSale {
  id: string;
  purchaseCost: ReturnType<typeof mapAmount4>;
  soldByOrderId: string | null;
  soldAt: Date | null;
  ownershipTransferredAt: Date | null;
  lossReportedAt: Date | null;
  recordStatus: 'active' | 'disabled';
  disabledReason: string | null;
  disabledAt: Date | null;
  currentBalance: ReturnType<typeof mapAmount4>;
  balanceCostAmount: ReturnType<typeof mapAmount4>;
}

export interface LockedOrderBalanceAccount {
  id: string;
  appleIdMasked: string;
  currentBalance: ReturnType<typeof mapAmount4>;
  balanceCostAmount: ReturnType<typeof mapAmount4>;
  soldByOrderId: string | null;
  ownershipTransferredAt: Date | null;
  lossReportedAt: Date | null;
}

function minNullableDate(...values: Array<Date | null | undefined>) {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return dates.reduce((earliest, value) =>
    value.getTime() < earliest.getTime() ? value : earliest
  );
}

@Injectable()
export class IdBusinessV2OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(criteria: IdBusinessV2OrderListCriteria) {
    const where = this.buildOrderWhere(criteria);
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2Order.findMany({
        where,
        include: ORDER_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: this.buildOrderBy(criteria.sortField, criteria.sortDirection)
      }),
      this.prisma.idBusinessV2Order.count({ where })
    ]);
    return {
      items: rows.map(mapOrderListRow),
      total
    };
  }

  async findSensitiveSearchCandidates(input: {
    appleIdTokens: string[];
    websiteAccountTokens: string[];
  }) {
    const [accounts, orders] = await Promise.all([
      input.appleIdTokens.length
        ? this.prisma.idBusinessV2Account.findMany({
            where: {
              deletedAt: null,
              appleIdSearchTokens: { hasEvery: input.appleIdTokens }
            },
            select: { id: true, appleIdEncrypted: true }
          })
        : Promise.resolve([]),
      input.websiteAccountTokens.length
        ? this.prisma.idBusinessV2Order.findMany({
            where: {
              deletedAt: null,
              websiteAccountEncrypted: { not: null },
              websiteAccountSearchTokens: { hasEvery: input.websiteAccountTokens }
            },
            select: { id: true, websiteAccountEncrypted: true }
          })
        : Promise.resolve([])
    ]);
    return { accounts, orders };
  }

  async findOrder(id: string) {
    const row = await this.prisma.idBusinessV2Order.findFirst({
      where: { id, deletedAt: null },
      include: ORDER_INCLUDE
    });
    return row ? mapOrderListRow(row) : null;
  }

  async getEntryOptions(criteria: {
    customerKeyword: string | null;
    normalizedContact: string | null;
    contactHash: string | null;
    phoneSearchTokens: string[];
    wechatSearchTokens: string[];
    qqSearchTokens: string[];
    whatsappSearchTokens: string[];
    maximumCustomers: number;
  }) {
    const {
      customerKeyword,
      normalizedContact,
      contactHash,
      phoneSearchTokens,
      wechatSearchTokens,
      qqSearchTokens,
      whatsappSearchTokens,
      maximumCustomers
    } = criteria;
    const [customers, countries, categories, services, settlementPlatforms] = await Promise.all([
      this.prisma.idBusinessV2Customer.findMany({
        where: {
          deletedAt: null,
          recordStatus: 'active',
          OR: customerKeyword
            ? [
                { name: { contains: customerKeyword, mode: 'insensitive' } },
                { wechat: { contains: customerKeyword, mode: 'insensitive' } },
                {
                  wechatSearchTokens: wechatSearchTokens.length
                    ? { hasEvery: wechatSearchTokens }
                    : undefined
                },
                { qq: { contains: customerKeyword, mode: 'insensitive' } },
                {
                  qqSearchTokens: qqSearchTokens.length ? { hasEvery: qqSearchTokens } : undefined
                },
                {
                  phoneTail: {
                    contains: normalizedContact?.slice(-8) ?? customerKeyword,
                    mode: 'insensitive'
                  }
                },
                { phoneHash: contactHash ?? undefined },
                {
                  phoneSearchTokens: phoneSearchTokens.length
                    ? { hasEvery: phoneSearchTokens }
                    : undefined
                },
                {
                  whatsappTail: {
                    contains: normalizedContact?.slice(-8) ?? customerKeyword,
                    mode: 'insensitive'
                  }
                },
                { whatsappHash: contactHash ?? undefined },
                {
                  whatsappSearchTokens: whatsappSearchTokens.length
                    ? { hasEvery: whatsappSearchTokens }
                    : undefined
                }
              ]
            : undefined
        },
        select: {
          id: true,
          name: true,
          wechat: true,
          wechatEncrypted: true,
          wechatMasked: true,
          qq: true,
          qqEncrypted: true,
          qqMasked: true,
          phoneEncrypted: true,
          phoneMasked: true,
          whatsappEncrypted: true,
          whatsappMasked: true
        },
        take: maximumCustomers,
        orderBy: [{ name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'country', status: 'active', deletedAt: null },
        select: { id: true, code: true, name: true, currencyCode: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'business_category',
          status: 'active',
          deletedAt: null,
          parentId: null
        },
        select: { id: true, code: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'service',
          status: 'active',
          deletedAt: null,
          businessAmount: { gt: 0 },
          parent: {
            is: { type: 'business_category', status: 'active', deletedAt: null }
          },
          countryOption: { is: { type: 'country', status: 'active', deletedAt: null } }
        },
        select: {
          id: true,
          code: true,
          name: true,
          parentId: true,
          countryOptionId: true,
          businessAmount: true,
          countryOption: { select: { currencyCode: true } }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'settlement_platform', status: 'active', deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          fixedFee: true,
          percentageFee: true
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);

    return {
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        wechat: customer.wechatMasked ?? (customer.wechat ? '已保存微信' : null),
        qq: customer.qqMasked ?? (customer.qq ? '已保存 QQ' : null),
        maskedPhone: customer.phoneMasked,
        maskedWhatsapp: customer.whatsappMasked,
        sensitiveValues: {
          phoneEncrypted: customer.phoneEncrypted,
          wechatEncrypted: customer.wechatEncrypted,
          legacyWechat: customer.wechat,
          qqEncrypted: customer.qqEncrypted,
          legacyQq: customer.qq,
          whatsappEncrypted: customer.whatsappEncrypted
        }
      })),
      countries: countries.map((country) => ({
        ...country,
        children: categories
          .map((category) => ({
            ...category,
            children: services
              .filter(
                (service) =>
                  service.countryOptionId === country.id && service.parentId === category.id
              )
              .map((service) => ({
                id: service.id,
                code: service.code,
                name: service.name,
                businessAmount:
                  service.businessAmount === null
                    ? '0'
                    : mapAmount4(
                        service.businessAmount,
                        'id_business_v2_options.business_amount'
                      ).toString(),
                currencyCode: service.countryOption?.currencyCode ?? country.currencyCode
              }))
          }))
          .filter((category) => category.children.length > 0)
      })),
      settlementPlatforms: settlementPlatforms.map((platform) => ({
        id: platform.id,
        code: platform.code,
        name: platform.name,
        fixedFee: mapAmount4(platform.fixedFee, 'id_business_v2_options.fixed_fee').toString(),
        percentageFee: mapRate8(
          platform.percentageFee,
          'id_business_v2_options.percentage_fee'
        ).toString()
      }))
    };
  }

  async findMatchingContext(serviceOptionId: string): Promise<IdBusinessV2MatchingContext | null> {
    const service = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: { gt: 0 },
        parent: { is: { type: 'business_category', status: 'active', deletedAt: null } },
        countryOption: { is: { type: 'country', status: 'active', deletedAt: null } }
      },
      select: {
        id: true,
        code: true,
        name: true,
        parent: { select: { id: true, code: true, name: true } },
        countryOption: { select: { id: true, code: true, name: true } }
      }
    });
    if (!service?.parent || !service.countryOption) return null;
    return {
      service: { id: service.id, code: service.code, name: service.name },
      category: service.parent,
      country: service.countryOption
    };
  }

  async findMatchingCandidates(criteria: IdBusinessV2MatchingCriteria) {
    const activeCategoryActivationWhere = this.buildActiveCategoryActivationWhere({
      categoryOptionId: criteria.categoryOptionId,
      evaluatedAt: criteria.evaluatedAt,
      editingOrderId: criteria.editingOrderId
    });
    const ownershipWhere: Prisma.IdBusinessV2AccountWhereInput =
      criteria.accountSource === 'customer_owned'
        ? {
            soldByOrderId: { not: null },
            soldByOrder: {
              is: { customerId: criteria.customerId ?? undefined, deletedAt: null }
            }
          }
        : criteria.editingOrderId
          ? { OR: [{ soldByOrderId: null }, { soldByOrderId: criteria.editingOrderId }] }
          : { soldByOrderId: null };
    const activeInCountryWhere: Prisma.IdBusinessV2AccountWhereInput = {
      deletedAt: null,
      recordStatus: 'active',
      lossReportedAt: null,
      countryOptionId: criteria.countryOptionId,
      AND: [ownershipWhere]
    };
    const normalStatusWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...activeInCountryWhere,
      statusOption: {
        is: { type: 'id_status', code: 'normal', status: 'active', deletedAt: null }
      }
    };
    const sufficientBalanceWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...normalStatusWhere,
      currentBalance: { gte: criteria.requiredBalance }
    };
    const availableWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...sufficientBalanceWhere,
      locks: {
        none: {
          status: 'active',
          expiresAt: { gt: criteria.evaluatedAt },
          OR: [
            { lockScope: 'global' },
            { lockScope: 'by_service', serviceOptionId: criteria.serviceOptionId }
          ],
          orderId: criteria.editingOrderId ? { not: criteria.editingOrderId } : undefined
        }
      },
      activations: {
        none: activeCategoryActivationWhere
      }
    };
    const candidateWhere: Prisma.IdBusinessV2AccountWhereInput = criteria.keyword
      ? {
          ...availableWhere,
          OR: [
            { appleIdMasked: { contains: criteria.keyword, mode: 'insensitive' } },
            { appleIdHash: criteria.keywordHash ?? undefined },
            {
              appleIdSearchTokens: criteria.keywordSearchTokens.length
                ? { hasEvery: criteria.keywordSearchTokens }
                : undefined
            },
            {
              soldByOrder: {
                is: { orderNo: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            }
          ]
        }
      : availableWhere;
    const [
      activeInCountry,
      normalStatus,
      sufficientBalance,
      available,
      rows,
      nextLock,
      nextCategoryActivation
    ] = await Promise.all([
      this.prisma.idBusinessV2Account.count({ where: activeInCountryWhere }),
      this.prisma.idBusinessV2Account.count({ where: normalStatusWhere }),
      this.prisma.idBusinessV2Account.count({ where: sufficientBalanceWhere }),
      this.prisma.idBusinessV2Account.count({ where: availableWhere }),
      this.prisma.idBusinessV2Account.findMany({
        where: candidateWhere,
        select: MATCHING_ACCOUNT_SELECT,
        take: criteria.limit,
        orderBy: [{ currentBalance: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2AccountLock.findFirst({
        where: {
          status: 'active',
          expiresAt: { gt: criteria.evaluatedAt },
          OR: [
            { lockScope: 'global' },
            { lockScope: 'by_service', serviceOptionId: criteria.serviceOptionId }
          ],
          orderId: criteria.editingOrderId ? { not: criteria.editingOrderId } : undefined,
          account: { is: sufficientBalanceWhere }
        },
        select: { expiresAt: true },
        orderBy: { expiresAt: 'asc' }
      }),
      this.prisma.idBusinessV2Activation.findFirst({
        where: {
          ...this.buildActiveCategoryActivationWhere({
            categoryOptionId: criteria.categoryOptionId,
            evaluatedAt: criteria.evaluatedAt,
            editingOrderId: criteria.editingOrderId,
            expiringOnly: true
          }),
          account: { is: sufficientBalanceWhere }
        },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      })
    ]);
    return {
      counts: { activeInCountry, normalStatus, sufficientBalance, available },
      accounts: rows.map(mapMatchingAccount),
      nextAvailabilityChangesAt: minNullableDate(nextLock?.expiresAt, nextCategoryActivation?.dueAt)
    };
  }

  findActiveCategoryActivationForAccount(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      categoryOptionId: string;
      evaluatedAt: Date;
      editingOrderId: string | null;
    }
  ) {
    return tx.idBusinessV2Activation.findFirst({
      where: this.buildActiveCategoryActivationWhere(input),
      select: { id: true, dueAt: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }]
    });
  }

  async findOrderInTransaction(tx: V2CommandTransaction, orderId: string) {
    const row = await tx.idBusinessV2Order.findUnique({ where: { id: orderId } });
    return row ? mapOrderRow(row) : null;
  }

  async findOrderEntryReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2Order.findUnique({
      where: { idempotencyKey },
      include: { locks: { orderBy: { lockedAt: 'desc' }, take: 1 } }
    });
    return row
      ? {
          ...mapOrderRow(row),
          locks: row.locks
        }
      : null;
  }

  async findSoldAccountOwnership(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2Account.findFirst({
      where: { id: accountId, deletedAt: null, soldByOrderId: { not: null } },
      select: {
        id: true,
        soldByOrder: {
          select: { id: true, orderNo: true, customerId: true, deletedAt: true }
        }
      }
    });
  }

  async createOrder(tx: V2CommandTransaction, data: Prisma.IdBusinessV2OrderUncheckedCreateInput) {
    return tx.idBusinessV2Order.create({ data }).then(mapOrderRow);
  }

  async updateOrder(
    tx: V2CommandTransaction,
    orderId: string,
    data: Prisma.IdBusinessV2OrderUncheckedUpdateInput
  ) {
    return tx.idBusinessV2Order.update({ where: { id: orderId }, data }).then(mapOrderRow);
  }

  async updateAccount(
    tx: V2CommandTransaction,
    accountId: string,
    data: Prisma.IdBusinessV2AccountUncheckedUpdateInput
  ) {
    return tx.idBusinessV2Account.update({ where: { id: accountId }, data });
  }

  async releaseSoldAccount(
    tx: V2CommandTransaction,
    input: { accountId: string; orderId: string; updatedByUserId?: string }
  ) {
    return tx.idBusinessV2Account.updateMany({
      where: {
        id: input.accountId,
        soldByOrderId: input.orderId,
        lossReportedAt: null
      },
      data: {
        soldByOrderId: null,
        soldAt: null,
        ownershipTransferredAt: null,
        updatedByUserId: input.updatedByUserId
      }
    });
  }

  findLostSoldAccount(tx: V2CommandTransaction, accountId: string, orderId: string) {
    return tx.idBusinessV2Account.findFirst({
      where: { id: accountId, soldByOrderId: orderId, lossReportedAt: { not: null } },
      select: { id: true }
    });
  }

  markAccountSold(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      orderId: string;
      soldAt?: Date;
      updatedByUserId?: string;
    }
  ) {
    return tx.idBusinessV2Account.update({
      where: { id: input.accountId },
      data: {
        soldByOrderId: input.orderId,
        soldAt: input.soldAt,
        updatedByUserId: input.updatedByUserId
      }
    });
  }

  transferSoldAccountOwnership(
    tx: V2CommandTransaction,
    input: { accountId: string; orderId: string; transferredAt: Date; updatedByUserId?: string }
  ) {
    return tx.idBusinessV2Account.updateMany({
      where: {
        id: input.accountId,
        soldByOrderId: input.orderId,
        ownershipTransferredAt: null,
        lossReportedAt: null
      },
      data: {
        ownershipTransferredAt: input.transferredAt,
        updatedByUserId: input.updatedByUserId
      }
    });
  }

  appendAudit(tx: V2CommandTransaction, data: Prisma.AuditLogUncheckedCreateInput) {
    return tx.auditLog.create({ data });
  }

  async findActivationByOrder(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2Activation.findUnique({ where: { orderId } });
  }

  async hasActivationByOrder(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2Activation.findUnique({
      where: { orderId },
      select: { id: true }
    });
  }

  async createActivation(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ActivationUncheckedCreateInput
  ) {
    return tx.idBusinessV2Activation.create({ data });
  }

  async updateActivation(
    tx: V2CommandTransaction,
    orderId: string,
    data: Prisma.IdBusinessV2ActivationUncheckedUpdateInput
  ) {
    return tx.idBusinessV2Activation.update({ where: { orderId }, data });
  }

  findActiveLockForOrder(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: { orderId, status: 'active' },
      orderBy: { lockedAt: 'desc' }
    });
  }

  findValidLockForOrder(tx: V2CommandTransaction, orderId: string, now: Date) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: { orderId, status: 'active', expiresAt: { gt: now } },
      orderBy: { lockedAt: 'desc' }
    });
  }

  findValidLockForOrderAccount(
    tx: V2CommandTransaction,
    input: { orderId: string; accountId: string; now: Date }
  ) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: {
        orderId: input.orderId,
        accountId: input.accountId,
        status: 'active',
        expiresAt: { gt: input.now }
      },
      orderBy: { lockedAt: 'desc' }
    });
  }

  findReservationConflict(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      orderId: string;
      serviceOptionId: string;
      lockScope: IdBusinessV2AccountLockScope;
      now: Date;
    }
  ) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: {
        accountId: input.accountId,
        orderId: { not: input.orderId },
        status: 'active',
        expiresAt: { gt: input.now },
        OR:
          input.lockScope === 'global'
            ? undefined
            : [
                { lockScope: 'global' },
                { lockScope: 'by_service', serviceOptionId: input.serviceOptionId }
              ]
      },
      select: { id: true, lockScope: true, serviceOptionId: true }
    });
  }

  findLatestLockForOrder(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: { orderId },
      orderBy: { lockedAt: 'desc' }
    });
  }

  findConflictingLock(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      orderId: string;
      serviceOptionId: string;
      expiresAfter: Date;
    }
  ) {
    return tx.idBusinessV2AccountLock.findFirst({
      where: {
        accountId: input.accountId,
        status: 'active',
        expiresAt: { gt: input.expiresAfter },
        orderId: { not: input.orderId },
        OR: [
          { lockScope: 'global' },
          { lockScope: 'by_service', serviceOptionId: input.serviceOptionId }
        ]
      },
      orderBy: { expiresAt: 'asc' }
    });
  }

  createAccountLock(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2AccountLockUncheckedCreateInput
  ) {
    return tx.idBusinessV2AccountLock.create({ data });
  }

  updateAccountLock(
    tx: V2CommandTransaction,
    lockId: string,
    data: Prisma.IdBusinessV2AccountLockUncheckedUpdateInput
  ) {
    return tx.idBusinessV2AccountLock.update({ where: { id: lockId }, data });
  }

  releaseActiveLocksForOrder(
    tx: V2CommandTransaction,
    input: { orderId: string; endedAt: Date; endReason: string }
  ) {
    return tx.idBusinessV2AccountLock.updateMany({
      where: { orderId: input.orderId, status: 'active' },
      data: { status: 'released', endedAt: input.endedAt, endReason: input.endReason }
    });
  }

  findLedgerByIdempotencyKey(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2BalanceLedger
      .findUnique({ where: { idempotencyKey } })
      .then((row) => (row ? mapBalanceLedgerRow(row) : null));
  }

  findLockScopeService(tx: V2CommandTransaction, serviceOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null
      },
      select: { id: true, countryOptionId: true }
    });
  }

  findEligibleLockService(tx: V2CommandTransaction, serviceOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: { gt: 0 },
        parent: {
          is: { type: 'business_category', status: 'active', deletedAt: null }
        },
        countryOption: {
          is: { type: 'country', status: 'active', deletedAt: null }
        }
      },
      select: { countryOptionId: true, parent: { select: { id: true } } }
    });
  }

  private buildActiveCategoryActivationWhere(input: {
    accountId?: string;
    categoryOptionId: string;
    evaluatedAt: Date;
    editingOrderId: string | null;
    expiringOnly?: boolean;
  }): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      accountId: input.accountId,
      status: 'active',
      renewedBy: { is: null },
      orderId: input.editingOrderId ? { not: input.editingOrderId } : undefined,
      serviceOption: {
        is: {
          type: 'service',
          parentId: input.categoryOptionId
        }
      },
      dueAt: input.expiringOnly ? { gt: input.evaluatedAt } : undefined,
      OR: input.expiringOnly ? undefined : [{ dueAt: null }, { dueAt: { gt: input.evaluatedAt } }]
    };
  }

  findStaleLocks(tx: V2CommandTransaction, now: Date, take: number) {
    return tx.idBusinessV2AccountLock.findMany({
      where: { status: 'active', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take
    });
  }

  findStaleLocksForOrderOrAccount(
    tx: V2CommandTransaction,
    input: { orderId: string; accountId: string; now: Date }
  ) {
    return tx.idBusinessV2AccountLock.findMany({
      where: {
        status: 'active',
        expiresAt: { lte: input.now },
        OR: [{ orderId: input.orderId }, { accountId: input.accountId }]
      },
      select: { id: true, orderId: true, accountId: true, expiresAt: true }
    });
  }

  expireSelectedLocks(
    tx: V2CommandTransaction,
    input: { lockIds: string[]; endedAt: Date; endedByUserId?: string }
  ) {
    return tx.idBusinessV2AccountLock.updateMany({
      where: { id: { in: input.lockIds }, status: 'active' },
      data: {
        status: 'expired',
        endedAt: input.endedAt,
        endReason: '到期后由订单事务自动结束',
        endedByUserId: input.endedByUserId
      }
    });
  }

  expireAccountLocks(tx: V2CommandTransaction, lockIds: string[], endedAt: Date) {
    return tx.idBusinessV2AccountLock.updateMany({
      where: { id: { in: lockIds }, status: 'active' },
      data: { status: 'expired', endedAt, endReason: '锁定超时自动释放' }
    });
  }

  async requireOrderInTransaction(tx: V2CommandTransaction, orderId: string) {
    const row = await tx.idBusinessV2Order.findUniqueOrThrow({ where: { id: orderId } });
    return mapOrderRow(row);
  }

  async findLedgerByOrderAndType(
    tx: V2CommandTransaction,
    orderId: string,
    entryType: 'order_consumption' | 'order_consumption_reversal'
  ) {
    const row = await tx.idBusinessV2BalanceLedger.findUnique({
      where: { orderId_entryType: { orderId, entryType } }
    });
    return row ? mapBalanceLedgerRow(row) : null;
  }

  createBalanceLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2BalanceLedgerUncheckedCreateInput
  ) {
    return tx.idBusinessV2BalanceLedger.create({ data }).then(mapBalanceLedgerRow);
  }

  async findActiveCustomer(tx: V2CommandTransaction, customerId: string) {
    return tx.idBusinessV2Customer.findFirst({
      where: { id: customerId, recordStatus: 'active', deletedAt: null },
      select: { id: true }
    });
  }

  async findActiveService(tx: V2CommandTransaction, serviceOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: { id: serviceOptionId, type: 'service', status: 'active', deletedAt: null },
      select: { id: true }
    });
  }

  async findEligibleOrderEntryService(tx: V2CommandTransaction, serviceOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: { gt: 0 },
        parent: { is: { type: 'business_category', status: 'active', deletedAt: null } },
        countryOption: {
          is: {
            type: 'country',
            status: 'active',
            deletedAt: null,
            currencyCode: { not: null }
          }
        }
      },
      select: { id: true }
    });
  }

  async findActiveSettlementPlatform(tx: V2CommandTransaction, platformId: string) {
    const row = await tx.idBusinessV2Option.findFirst({
      where: {
        id: platformId,
        type: 'settlement_platform',
        status: 'active',
        deletedAt: null
      },
      select: { id: true, fixedFee: true, percentageFee: true }
    });
    return row
      ? {
          id: row.id,
          fixedFee: mapAmount4(row.fixedFee, 'id_business_v2_options.fixed_fee'),
          percentageFee: mapRate8(row.percentageFee, 'id_business_v2_options.percentage_fee')
        }
      : null;
  }

  async findSettlementPlatform(
    tx: V2CommandTransaction,
    platformId: string,
    allowDisabledExisting: boolean
  ) {
    const row = await tx.idBusinessV2Option.findFirst({
      where: {
        id: platformId,
        type: 'settlement_platform',
        status: allowDisabledExisting ? undefined : 'active',
        deletedAt: null
      },
      select: { fixedFee: true, percentageFee: true }
    });
    return row
      ? {
          fixedFee: mapAmount4(row.fixedFee, 'id_business_v2_options.fixed_fee'),
          percentageFee: mapRate8(row.percentageFee, 'id_business_v2_options.percentage_fee')
        }
      : null;
  }

  private buildOrderWhere(
    criteria: IdBusinessV2OrderListCriteria
  ): Prisma.IdBusinessV2OrderWhereInput {
    return {
      deletedAt: null,
      customerId: criteria.customerId ?? undefined,
      serviceOptionId: criteria.serviceOptionId ?? undefined,
      accountId: criteria.accountId ?? undefined,
      settlementPlatformOptionId: criteria.settlementPlatformOptionId ?? undefined,
      status: criteria.status ?? undefined,
      accountDisposition: criteria.accountDisposition ?? undefined,
      accountSource: criteria.accountSource ?? undefined,
      openedAt: criteria.openedAt,
      OR: criteria.keyword
        ? [
            { orderNo: { contains: criteria.keyword, mode: 'insensitive' } },
            { platformOrderNo: { contains: criteria.keyword, mode: 'insensitive' } },
            { websiteAccountMasked: { contains: criteria.keyword, mode: 'insensitive' } },
            { websiteAccountHash: criteria.websiteAccountHash ?? undefined },
            { customer: { is: { name: { contains: criteria.keyword, mode: 'insensitive' } } } },
            {
              serviceOption: {
                is: { name: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            },
            {
              account: {
                is: { appleIdMasked: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            },
            {
              account: {
                is: { appleIdHash: criteria.websiteAccountHash ?? undefined }
              }
            },
            ...(criteria.sensitiveAccountIds.length
              ? [{ accountId: { in: criteria.sensitiveAccountIds } }]
              : []),
            ...(criteria.sensitiveWebsiteOrderIds.length
              ? [{ id: { in: criteria.sensitiveWebsiteOrderIds } }]
              : []),
            {
              settlementPlatform: {
                is: { name: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            },
            {
              displaySnapshot: {
                is: {
                  OR: [
                    { customerName: { contains: criteria.keyword, mode: 'insensitive' } },
                    { serviceName: { contains: criteria.keyword, mode: 'insensitive' } },
                    { serviceCategoryName: { contains: criteria.keyword, mode: 'insensitive' } },
                    { accountLabel: { contains: criteria.keyword, mode: 'insensitive' } },
                    {
                      settlementPlatformName: {
                        contains: criteria.keyword,
                        mode: 'insensitive'
                      }
                    }
                  ]
                }
              }
            }
          ]
        : undefined
    };
  }

  private buildOrderBy(
    field: IdBusinessV2OrderSortField,
    direction: 'asc' | 'desc'
  ): Prisma.IdBusinessV2OrderOrderByWithRelationInput[] {
    if (field === 'openedAt') {
      return [
        { openedAt: { sort: direction, nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' }
      ];
    }
    return [{ [field]: direction }, { id: 'desc' }];
  }

  async lockOrder(tx: V2CommandTransaction, orderId: string): Promise<LockedOrderRow | null> {
    const rows = await tx.$queryRaw<LockedOrderPersistenceRow[]>`
      SELECT
        "id",
        "order_no" AS "orderNo",
        "customer_id" AS "customerId",
        "service_option_id" AS "serviceOptionId",
        "account_id" AS "accountId",
        "account_source" AS "accountSource",
        "source_sold_order_id" AS "sourceSoldOrderId",
        "received_amount" AS "receivedAmount",
        "platform_fee_amount" AS "platformFeeAmount",
        "account_cost_amount" AS "accountCostAmount",
        "applied_account_cost_amount" AS "appliedAccountCostAmount",
        "account_disposition" AS "accountDisposition",
        "balance_amount" AS "balanceAmount",
        "balance_cost_amount" AS "balanceCostAmount",
        "transferred_balance_cost_amount" AS "transferredBalanceCostAmount",
        "applied_balance_cost_amount" AS "appliedBalanceCostAmount",
        "refund_cost_amount" AS "refundCostAmount",
        "profit_amount" AS "profitAmount",
        "status"
      FROM "id_business_v2_orders"
      WHERE
        "id" = CAST(${orderId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `;
    return rows[0] ? mapLockedOrder(rows[0]) : null;
  }

  async lockAccount(tx: V2CommandTransaction, accountId: string): Promise<LockedAccountRow | null> {
    const rows = await tx.$queryRaw<LockedAccountPersistenceRow[]>`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."purchase_cost" AS "purchaseCost",
        account."sold_by_order_id" AS "soldByOrderId",
        sold_order."customer_id" AS "soldByCustomerId",
        account."ownership_transferred_at" AS "ownershipTransferredAt",
        account."loss_reported_at" AS "lossReportedAt",
        account."country_option_id" AS "countryOptionId",
        status."code" AS "statusCode"
      FROM "id_business_v2_accounts" account
      INNER JOIN "id_business_v2_options" country
        ON country."id" = account."country_option_id"
        AND country."type" = 'country'
        AND country."status" = 'active'
        AND country."deleted_at" IS NULL
      INNER JOIN "id_business_v2_options" status
        ON status."id" = account."status_option_id"
        AND status."type" = 'id_status'
        AND status."status" = 'active'
        AND status."deleted_at" IS NULL
      LEFT JOIN "id_business_v2_orders" sold_order
        ON sold_order."id" = account."sold_by_order_id"
        AND sold_order."deleted_at" IS NULL
      WHERE
        account."id" = CAST(${accountId} AS UUID)
        AND account."deleted_at" IS NULL
        AND account."record_status" = 'active'
        AND account."loss_reported_at" IS NULL
      FOR UPDATE OF account
    `;
    return rows[0] ? mapLockedAccount(rows[0]) : null;
  }

  async lockAccountForSale(
    tx: V2CommandTransaction,
    accountId: string
  ): Promise<LockedAccountForSale | null> {
    return lockAccountForSale(tx, accountId);
  }

  async findSoldAccountRecoveryBlockers(
    tx: V2CommandTransaction,
    input: { accountId: string; sourceOrderId: string; evaluatedAt: Date }
  ) {
    const [pendingAfterSalesOrders, activeActivations, activeLocks] = await Promise.all([
      tx.idBusinessV2Order.count({
        where: {
          accountId: input.accountId,
          accountSource: 'customer_owned',
          sourceSoldOrderId: input.sourceOrderId,
          deletedAt: null,
          status: { in: ['draft', 'pending', 'waiting_external', 'processing', 'completed'] }
        }
      }),
      tx.idBusinessV2Activation.count({
        where: {
          accountId: input.accountId,
          orderId: { not: input.sourceOrderId },
          status: 'active',
          renewedBy: { is: null },
          OR: [{ dueAt: null }, { dueAt: { gt: input.evaluatedAt } }]
        }
      }),
      tx.idBusinessV2AccountLock.count({
        where: {
          accountId: input.accountId,
          orderId: { not: input.sourceOrderId },
          status: 'active',
          expiresAt: { gt: input.evaluatedAt }
        }
      })
    ]);
    return { pendingAfterSalesOrders, activeActivations, activeLocks };
  }

  async findRecoveredCustomerOwnedSource(
    tx: V2CommandTransaction,
    input: { sourceOrderId: string; accountId: string; customerId: string }
  ) {
    return tx.idBusinessV2Order.findFirst({
      where: {
        id: input.sourceOrderId,
        accountId: input.accountId,
        customerId: input.customerId,
        accountDisposition: 'recovered',
        status: { in: ['completed', 'refunded'] },
        deletedAt: null
      },
      select: { id: true }
    });
  }

  async findPostedOrderCompletionIdCost(tx: V2CommandTransaction, orderId: string) {
    const journal = await tx.idBusinessV2FinanceJournal.findFirst({
      where: {
        sourceType: 'order',
        sourceId: orderId,
        journalType: 'order_completed',
        status: 'posted'
      },
      select: {
        id: true,
        lines: {
          where: { accountCode: 'id_cost', direction: 'debit' },
          select: { amountCny: true },
          take: 1
        }
      }
    });
    const line = journal?.lines[0];
    return journal && line
      ? {
          journalId: journal.id,
          amount: mapAmount4(line.amountCny, 'id_business_v2_finance_journal_lines.amount_cny')
        }
      : null;
  }

  async lockOrderId(tx: V2CommandTransaction, orderId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "id_business_v2_orders"
          WHERE "id" = CAST(${orderId} AS UUID)
          FOR UPDATE
        `
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "id_business_v2_orders"
          WHERE "id" = CAST(${orderId} AS UUID) AND "deleted_at" IS NULL
          FOR UPDATE
        `;
    return rows[0] ?? null;
  }

  async lockOrderBalanceAccount(
    tx: V2CommandTransaction,
    accountId: string
  ): Promise<LockedOrderBalanceAccount | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        appleIdMasked: string;
        currentBalance: unknown;
        balanceCostAmount: unknown;
        soldByOrderId: string | null;
        ownershipTransferredAt: Date | null;
        lossReportedAt: Date | null;
      }>
    >`
      SELECT
        "id",
        "apple_id_masked" AS "appleIdMasked",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "sold_by_order_id" AS "soldByOrderId",
        "ownership_transferred_at" AS "ownershipTransferredAt",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE "id" = CAST(${accountId} AS UUID) AND "deleted_at" IS NULL
      FOR UPDATE
    `;
    const account = rows[0];
    return account
      ? {
          ...account,
          currentBalance: mapAmount4(
            account.currentBalance,
            'id_business_v2_accounts.current_balance'
          ),
          balanceCostAmount: mapAmount4(
            account.balanceCostAmount,
            'id_business_v2_accounts.balance_cost_amount'
          )
        }
      : null;
  }
}

export async function lockAccountForSale(
  tx: V2CommandTransaction,
  accountId: string
): Promise<LockedAccountForSale | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      purchaseCost: unknown;
      soldByOrderId: string | null;
      soldAt: Date | null;
      ownershipTransferredAt: Date | null;
      lossReportedAt: Date | null;
      recordStatus: 'active' | 'disabled';
      disabledReason: string | null;
      disabledAt: Date | null;
      currentBalance: unknown;
      balanceCostAmount: unknown;
    }>
  >`
      SELECT
        "id",
        "purchase_cost" AS "purchaseCost",
        "sold_by_order_id" AS "soldByOrderId",
        "sold_at" AS "soldAt",
        "ownership_transferred_at" AS "ownershipTransferredAt",
        "loss_reported_at" AS "lossReportedAt",
        "record_status" AS "recordStatus",
        "disabled_reason" AS "disabledReason",
        "disabled_at" AS "disabledAt",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `;
  const account = rows[0];
  return account
    ? {
        ...account,
        soldAt: account.soldAt ?? null,
        lossReportedAt: account.lossReportedAt ?? null,
        recordStatus: account.recordStatus ?? 'active',
        disabledReason: account.disabledReason ?? null,
        disabledAt: account.disabledAt ?? null,
        purchaseCost: mapAmount4(account.purchaseCost, 'id_business_v2_accounts.purchase_cost'),
        currentBalance: mapAmount4(
          account.currentBalance ?? 0,
          'id_business_v2_accounts.current_balance'
        ),
        balanceCostAmount: mapAmount4(
          account.balanceCostAmount ?? 0,
          'id_business_v2_accounts.balance_cost_amount'
        )
      }
    : null;
}

function mapLockedOrder(row: LockedOrderPersistenceRow): LockedOrderRow {
  const accountCostAmount = mapAmount4(
    row.accountCostAmount,
    'id_business_v2_orders.account_cost_amount'
  );
  return {
    ...row,
    customerId: row.customerId ?? '',
    accountSource: row.accountSource ?? 'inventory',
    sourceSoldOrderId: row.sourceSoldOrderId ?? null,
    receivedAmount: mapAmount4(row.receivedAmount, 'id_business_v2_orders.received_amount'),
    platformFeeAmount: mapAmount4(
      row.platformFeeAmount,
      'id_business_v2_orders.platform_fee_amount'
    ),
    accountCostAmount,
    appliedAccountCostAmount:
      row.appliedAccountCostAmount === undefined
        ? row.accountDisposition === 'sold'
          ? accountCostAmount
          : mapAmount4(0, 'id_business_v2_orders.applied_account_cost_amount')
        : mapAmount4(
            row.appliedAccountCostAmount,
            'id_business_v2_orders.applied_account_cost_amount'
          ),
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_orders.balance_amount'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_orders.balance_cost_amount'
    ),
    transferredBalanceCostAmount: mapAmount4(
      row.transferredBalanceCostAmount ?? 0,
      'id_business_v2_orders.transferred_balance_cost_amount'
    ),
    appliedBalanceCostAmount: mapAmount4(
      row.appliedBalanceCostAmount ?? 0,
      'id_business_v2_orders.applied_balance_cost_amount'
    ),
    refundCostAmount: mapOptionalAmount4(
      row.refundCostAmount,
      'id_business_v2_orders.refund_cost_amount'
    ),
    profitAmount: mapOptionalAmount4(row.profitAmount, 'id_business_v2_orders.profit_amount')
  };
}

function mapLockedAccount(row: LockedAccountPersistenceRow): LockedAccountRow {
  return {
    ...row,
    soldByCustomerId: row.soldByCustomerId ?? null,
    currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_accounts.balance_cost_amount'
    ),
    purchaseCost: mapAmount4(row.purchaseCost, 'id_business_v2_accounts.purchase_cost')
  };
}

function mapOrderRow(row: IdBusinessV2Order): IdBusinessV2OrderRecord {
  const accountCostAmount = mapAmount4(
    row.accountCostAmount,
    'id_business_v2_orders.account_cost_amount'
  );
  return {
    ...row,
    accountSource: row.accountSource ?? 'inventory',
    sourceSoldOrderId: row.sourceSoldOrderId ?? null,
    receivedAmount: mapAmount4(row.receivedAmount, 'id_business_v2_orders.received_amount'),
    receivedOriginalAmount: mapAmount4(
      row.receivedOriginalAmount,
      'id_business_v2_orders.received_original_amount'
    ),
    receivedFxRateToCny: mapRate8(
      row.receivedFxRateToCny,
      'id_business_v2_orders.received_fx_rate_to_cny'
    ),
    platformFeeAmount: mapAmount4(
      row.platformFeeAmount,
      'id_business_v2_orders.platform_fee_amount'
    ),
    accountCostAmount,
    appliedAccountCostAmount:
      row.appliedAccountCostAmount === undefined
        ? row.accountDisposition === 'sold'
          ? accountCostAmount
          : mapAmount4(0, 'id_business_v2_orders.applied_account_cost_amount')
        : mapAmount4(
            row.appliedAccountCostAmount,
            'id_business_v2_orders.applied_account_cost_amount'
          ),
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_orders.balance_amount'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_orders.balance_cost_amount'
    ),
    transferredBalanceCostAmount: mapAmount4(
      row.transferredBalanceCostAmount ?? 0,
      'id_business_v2_orders.transferred_balance_cost_amount'
    ),
    appliedBalanceCostAmount: mapAmount4(
      row.appliedBalanceCostAmount ?? 0,
      'id_business_v2_orders.applied_balance_cost_amount'
    ),
    refundCostAmount: mapOptionalAmount4(
      row.refundCostAmount,
      'id_business_v2_orders.refund_cost_amount'
    ),
    profitAmount: mapOptionalAmount4(row.profitAmount, 'id_business_v2_orders.profit_amount')
  };
}

function mapOrderListRow(row: OrderListPersistenceRow): IdBusinessV2OrderListRecord {
  const {
    displaySnapshot: snapshot,
    customer,
    serviceOption,
    account,
    sourceSoldOrder,
    settlementPlatform,
    createdBy,
    locks,
    ...order
  } = row;
  return {
    ...mapOrderRow(order),
    customer: {
      ...customer,
      name: snapshot?.customerName ?? customer.name
    },
    serviceOption: {
      ...serviceOption,
      name: snapshot?.serviceName ?? serviceOption.name,
      parent: serviceOption.parent
        ? {
            ...serviceOption.parent,
            name: snapshot?.serviceCategoryName ?? serviceOption.parent.name
          }
        : null
    },
    account: account
      ? {
          ...account,
          appleIdMasked: snapshot?.accountLabel ?? account.appleIdMasked,
          countryOption: {
            ...account.countryOption,
            name: snapshot?.accountCountryName ?? account.countryOption.name
          }
        }
      : null,
    sourceSoldOrder: sourceSoldOrder ?? null,
    settlementPlatform: settlementPlatform
      ? {
          ...settlementPlatform,
          name: snapshot?.settlementPlatformName ?? settlementPlatform.name
        }
      : null,
    createdBy,
    locks
  };
}

function mapMatchingAccount(row: MatchingAccountPersistenceRow): IdBusinessV2MatchingAccount {
  return {
    ...row,
    soldByOrder: row.soldByOrder ?? null,
    currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_accounts.balance_cost_amount'
    ),
    purchaseCost: mapAmount4(row.purchaseCost, 'id_business_v2_accounts.purchase_cost')
  };
}

function mapBalanceLedgerRow(row: IdBusinessV2BalanceLedger) {
  return {
    ...row,
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_balance_ledgers.balance_amount'),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_balance_ledgers.cost_amount'),
    balanceBefore: mapAmount4(row.balanceBefore, 'id_business_v2_balance_ledgers.balance_before'),
    balanceAfter: mapAmount4(row.balanceAfter, 'id_business_v2_balance_ledgers.balance_after'),
    costBefore: mapAmount4(row.costBefore, 'id_business_v2_balance_ledgers.cost_before'),
    costAfter: mapAmount4(row.costAfter, 'id_business_v2_balance_ledgers.cost_after'),
    averageCostBefore: mapRate8(
      row.averageCostBefore,
      'id_business_v2_balance_ledgers.average_cost_before'
    ),
    averageCostAfter: mapRate8(
      row.averageCostAfter,
      'id_business_v2_balance_ledgers.average_cost_after'
    )
  };
}
