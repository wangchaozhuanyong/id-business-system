import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import { IdBusinessV2TopupSupplierFundsQuerySupport } from './id-business-v2-topup-supplier-funds-query-support';

export interface ListIdBusinessV2TopupSuppliersQuery extends PaginationQuery {
  keyword?: string;
  status?: string;
  fundingStatus?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2TopupSupplierPaymentsQuery extends PaginationQuery {
  keyword?: string;
  supplierOptionId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2TopupSupplierLedgerQuery extends PaginationQuery {
  entryType?: string;
  dateFrom?: string;
  dateTo?: string;
  sortOrder?: string;
}

interface SupplierAggregateRow {
  supplierAccountId: string;
  paymentsCny: PrismaNamespace.Decimal;
  topupDeductionsCny: PrismaNamespace.Decimal;
  netAdjustmentsCny: PrismaNamespace.Decimal;
  lastPaymentAt: Date | null;
  lastTopupAt: Date | null;
}

interface CountryAggregateRow {
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  cardCount: bigint;
  faceValue: PrismaNamespace.Decimal;
  costCny: PrismaNamespace.Decimal;
}

@Injectable()
export class IdBusinessV2TopupSupplierFundsQueryService extends IdBusinessV2TopupSupplierFundsQuerySupport {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listSuppliers(query: ListIdBusinessV2TopupSuppliersQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const status = this.parseOptionStatus(query.status);
    const fundingStatus = this.parseFundingStatus(query.fundingStatus);
    const accountWhere =
      fundingStatus === 'initialized'
        ? { some: { currency: 'CNY' as const, initializedAt: { not: null } } }
        : fundingStatus === 'uninitialized'
          ? { none: { currency: 'CNY' as const, initializedAt: { not: null } } }
          : fundingStatus === 'negative'
            ? {
                some: {
                  currency: 'CNY' as const,
                  initializedAt: { not: null },
                  currentBalanceCny: { lt: 0 }
                }
              }
            : undefined;
    const where: Prisma.IdBusinessV2OptionWhereInput = {
      type: 'topup_supplier',
      deletedAt: null,
      status: status ?? undefined,
      name: keyword ? { contains: keyword, mode: 'insensitive' } : undefined,
      topupFundAccounts: accountWhere
    };
    const sortDirection = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.IdBusinessV2OptionOrderByWithRelationInput[] =
      query.sortBy === 'name'
        ? [{ name: sortDirection }, { id: 'desc' }]
        : query.sortBy === 'createdAt'
          ? [{ createdAt: sortDirection }, { id: 'desc' }]
          : [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'desc' }];

    const [options, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.findMany({
        where,
        include: {
          topupFundAccounts: {
            where: { currency: 'CNY' },
            take: 1
          }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy
      }),
      this.prisma.idBusinessV2Option.count({ where })
    ]);
    const accountIds = options
      .map((option) => option.topupFundAccounts[0]?.id)
      .filter((id): id is string => Boolean(id));
    const aggregateByAccount = await this.loadSupplierAggregates(accountIds);
    const summary = await this.getSupplierSummary();

    return {
      items: options.map((option) => {
        const account = option.topupFundAccounts[0];
        const aggregate = account ? aggregateByAccount.get(account.id) : undefined;
        return {
          supplier: {
            id: option.id,
            code: option.code,
            name: option.name,
            status: option.status
          },
          accountId: account?.id ?? null,
          initialized: Boolean(account?.initializedAt),
          initializedAt: account?.initializedAt ?? null,
          currentBalanceCny: account ? toV2DecimalString(account.currentBalanceCny) : null,
          isNegative: account?.currentBalanceCny.lt(0) ?? false,
          paymentsCny: toV2DecimalString(aggregate?.paymentsCny ?? 0),
          topupDeductionsCny: toV2DecimalString(aggregate?.topupDeductionsCny ?? 0),
          netAdjustmentsCny: toV2DecimalString(aggregate?.netAdjustmentsCny ?? 0),
          lastPaymentAt: aggregate?.lastPaymentAt ?? null,
          lastTopupAt: aggregate?.lastTopupAt ?? null,
          updatedAt: account?.updatedAt ?? option.updatedAt
        };
      }),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary
    };
  }

  async listPaymentRecords(query: ListIdBusinessV2TopupSupplierPaymentsQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const supplierOptionId = this.normalizeOptionalUuid(query.supplierOptionId, '加卡供应商');
    const status = this.parsePaymentStatus(query.status);
    const where: Prisma.IdBusinessV2TopupSupplierPaymentWhereInput = {
      paidCurrency: 'USDT',
      supplierAccount: supplierOptionId ? { is: { supplierOptionId } } : undefined,
      paidAt: this.parseDateRange(query.dateFrom, query.dateTo),
      ledgerEntries:
        status === 'active'
          ? {
              some: {
                entryType: 'payment_credit',
                reversedBy: null
              }
            }
          : status === 'reversed'
            ? { some: { entryType: 'payment_reversal' } }
            : undefined,
      OR: keyword
        ? [
            { supplierNameSnapshot: { contains: keyword, mode: 'insensitive' } },
            { transactionHash: { contains: keyword, mode: 'insensitive' } },
            { network: { contains: keyword, mode: 'insensitive' } },
            { remark: { contains: keyword, mode: 'insensitive' } }
          ]
        : undefined
    };
    const sortDirection = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const sortable: Record<
      string,
      keyof Prisma.IdBusinessV2TopupSupplierPaymentOrderByWithRelationInput
    > = {
      receivedUsdt: 'paidAmount',
      settlementRateCnyUsdt: 'fxRateToCny',
      creditedCny: 'creditedCny',
      paidAt: 'paidAt',
      createdAt: 'createdAt'
    };
    const sortField = sortable[query.sortBy ?? 'paidAt'] ?? 'paidAt';
    const [items, total, activeAggregate] = await this.prisma.$transaction([
      this.prisma.idBusinessV2TopupSupplierPayment.findMany({
        where,
        include: {
          supplierAccount: { include: { supplierOption: true } },
          createdBy: { select: { id: true, username: true, displayName: true } },
          ledgerEntries: {
            include: {
              reversedBy: { select: { id: true, reason: true, createdAt: true } }
            },
            orderBy: { createdAt: 'asc' }
          }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ [sortField]: sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierPayment.count({ where }),
      this.prisma.idBusinessV2TopupSupplierPayment.aggregate({
        where: {
          ...where,
          ledgerEntries: {
            some: {
              entryType: 'payment_credit',
              reversedBy: null
            }
          }
        },
        _sum: {
          paidAmount: true,
          creditedCny: true,
          networkFeeAmount: true
        }
      })
    ]);
    const totalReceivedUsdt = activeAggregate._sum.paidAmount ?? new PrismaNamespace.Decimal(0);
    const totalCreditedCny = activeAggregate._sum.creditedCny ?? new PrismaNamespace.Decimal(0);

    return {
      items: items.map((payment) => {
        const creditEntry = payment.ledgerEntries.find(
          (entry) => entry.entryType === 'payment_credit'
        );
        const reversalEntry = payment.ledgerEntries.find(
          (entry) => entry.entryType === 'payment_reversal'
        );
        return {
          id: payment.id,
          supplier: payment.supplierAccount.supplierOption,
          supplierNameSnapshot: payment.supplierNameSnapshot,
          receivedUsdt: toV2DecimalString(payment.receivedUsdt ?? payment.paidAmount),
          networkFeeUsdt: toV2DecimalString(payment.networkFeeUsdt ?? payment.networkFeeAmount),
          settlementRateCnyUsdt: (payment.settlementRateCnyUsdt ?? payment.fxRateToCny).toString(),
          creditedCny: toV2DecimalString(payment.creditedCny),
          network: payment.network,
          transactionHash: payment.transactionHash,
          paidAt: payment.paidAt,
          postedAt: payment.createdAt,
          remark: payment.remark,
          status: reversalEntry ? ('reversed' as const) : ('active' as const),
          balanceBeforeCny: creditEntry ? toV2DecimalString(creditEntry.balanceBeforeCny) : null,
          balanceAfterCny: creditEntry ? toV2DecimalString(creditEntry.balanceAfterCny) : null,
          reversal: reversalEntry
            ? {
                id: reversalEntry.id,
                reason: reversalEntry.reason,
                createdAt: reversalEntry.createdAt
              }
            : null,
          operator: payment.createdBy
        };
      }),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: {
        activeReceivedUsdt: toV2DecimalString(totalReceivedUsdt),
        activeNetworkFeeUsdt: toV2DecimalString(activeAggregate._sum.networkFeeAmount ?? 0),
        activeCreditedCny: toV2DecimalString(totalCreditedCny),
        weightedAverageRate: totalReceivedUsdt.gt(0)
          ? totalCreditedCny.div(totalReceivedUsdt).toFixed(8)
          : null
      }
    };
  }

  async listLedger(supplierOptionIdValue: string, query: ListIdBusinessV2TopupSupplierLedgerQuery) {
    const supplierOptionId = this.normalizeRequiredUuid(supplierOptionIdValue, '加卡供应商');
    const pagination = getPagination(query);
    const entryType = this.parseLedgerEntryType(query.entryType);
    const supplier = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id: supplierOptionId,
        type: 'topup_supplier',
        deletedAt: null
      },
      include: {
        topupFundAccounts: {
          where: { currency: 'CNY' },
          take: 1
        }
      }
    });
    if (!supplier) throw new NotFoundException('加卡供应商不存在');
    const supplierAccount = supplier.topupFundAccounts[0];
    if (!supplierAccount) {
      return {
        supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
        account: null,
        items: [],
        total: 0,
        page: pagination.page,
        pageSize: pagination.pageSize,
        countryStats: []
      };
    }
    const where: Prisma.IdBusinessV2TopupSupplierLedgerWhereInput = {
      supplierAccountId: supplierAccount.id,
      entryType: entryType ?? undefined,
      createdAt: this.parseDateRange(query.dateFrom, query.dateTo)
    };
    const [items, total, countryStats] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierLedger.findMany({
        where,
        include: {
          payment: {
            select: {
              id: true,
              receivedUsdt: true,
              settlementRateCnyUsdt: true,
              paidAmount: true,
              fxRateToCny: true,
              paidAt: true
            }
          },
          giftCard: {
            select: {
              id: true,
              codeMasked: true,
              faceValue: true,
              exchangeRate: true,
              countryNameSnapshot: true,
              currencyCodeSnapshot: true
            }
          },
          createdBy: { select: { id: true, username: true, displayName: true } },
          reversalOf: { select: { id: true, entryType: true } },
          reversedBy: { select: { id: true, entryType: true, createdAt: true } }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ createdAt: query.sortOrder === 'asc' ? 'asc' : 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierLedger.count({ where }),
      this.loadCountryStats(supplierAccount.id)
    ]);
    return {
      supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
      account: {
        id: supplierAccount.id,
        initialized: Boolean(supplierAccount.initializedAt),
        initializedAt: supplierAccount.initializedAt,
        currentBalanceCny: toV2DecimalString(supplierAccount.currentBalanceCny),
        isNegative: supplierAccount.currentBalanceCny.lt(0)
      },
      items: items.map((entry) => ({
        id: entry.id,
        entryType: entry.entryType,
        direction: entry.direction,
        amountCny: toV2DecimalString(entry.amountCny),
        balanceDeltaCny: toV2DecimalString(entry.balanceAfterCny.sub(entry.balanceBeforeCny)),
        balanceBeforeCny: toV2DecimalString(entry.balanceBeforeCny),
        balanceAfterCny: toV2DecimalString(entry.balanceAfterCny),
        reason: entry.reason,
        payment: entry.payment
          ? {
              id: entry.payment.id,
              receivedUsdt: toV2DecimalString(
                entry.payment.receivedUsdt ?? entry.payment.paidAmount
              ),
              settlementRateCnyUsdt: (
                entry.payment.settlementRateCnyUsdt ?? entry.payment.fxRateToCny
              ).toString(),
              paidAt: entry.payment.paidAt
            }
          : null,
        giftCard: entry.giftCard
          ? {
              ...entry.giftCard,
              faceValue: toV2DecimalString(entry.giftCard.faceValue),
              exchangeRate: entry.giftCard.exchangeRate.toString()
            }
          : null,
        reversalOf: entry.reversalOf,
        reversedBy: entry.reversedBy,
        operator: entry.createdBy,
        createdAt: entry.createdAt
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      countryStats
    };
  }

  async listBalanceSelectors() {
    const suppliers = await this.prisma.idBusinessV2Option.findMany({
      where: {
        type: 'topup_supplier',
        status: 'active',
        deletedAt: null
      },
      include: {
        topupFundAccounts: {
          where: { currency: 'CNY' },
          take: 1
        }
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
    return suppliers.map((supplier) => {
      const account = supplier.topupFundAccounts[0];
      return {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        initialized: Boolean(account?.initializedAt),
        currentBalanceCny: account ? toV2DecimalString(account.currentBalanceCny) : null,
        isNegative: account?.currentBalanceCny.lt(0) ?? false
      };
    });
  }

  async listGiftCardPurchaseSources() {
    const [financeAccounts, supplierWallets] = await Promise.all([
      this.prisma.idBusinessV2FinanceAccount.findMany({
        where: { status: 'active' },
        select: {
          id: true,
          name: true,
          currency: true,
          currentBalance: true
        },
        orderBy: [{ currency: 'asc' }, { name: 'asc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierAccount.findMany({
        where: {
          status: 'active',
          initializedAt: { not: null },
          supplierOption: {
            status: 'active',
            deletedAt: null
          }
        },
        select: {
          id: true,
          supplierOptionId: true,
          currency: true,
          currentBalance: true,
          supplierOption: {
            select: {
              name: true
            }
          }
        },
        orderBy: [{ currency: 'asc' }, { supplierOption: { name: 'asc' } }]
      })
    ]);
    return {
      financeAccounts: financeAccounts.map((account) => ({
        ...account,
        currentBalance: toV2DecimalString(account.currentBalance)
      })),
      supplierWallets: supplierWallets.map((wallet) => ({
        id: wallet.id,
        supplierOptionId: wallet.supplierOptionId,
        supplierName: wallet.supplierOption.name,
        currency: wallet.currency,
        currentBalance: toV2DecimalString(wallet.currentBalance)
      }))
    };
  }

  private async loadSupplierAggregates(accountIds: string[]) {
    if (!accountIds.length) return new Map<string, SupplierAggregateRow>();
    const rows = await this.prisma.$queryRaw<SupplierAggregateRow[]>(PrismaNamespace.sql`
      SELECT
        ledger."supplier_account_id" AS "supplierAccountId",
        COALESCE(SUM(
          CASE
            WHEN ledger."entry_type" = 'payment_credit' THEN ledger."amount_cny"
            WHEN ledger."entry_type" = 'payment_reversal' THEN -ledger."amount_cny"
            ELSE 0
          END
        ), 0) AS "paymentsCny",
        COALESCE(SUM(
          CASE
            WHEN ledger."entry_type" = 'gift_card_debit' THEN ledger."amount_cny"
            WHEN ledger."entry_type" = 'gift_card_withdrawal_reversal' THEN -ledger."amount_cny"
            ELSE 0
          END
        ), 0) AS "topupDeductionsCny",
        COALESCE(SUM(
          CASE
            WHEN ledger."entry_type" IN ('opening_balance', 'manual_adjustment')
              THEN ledger."balance_after_cny" - ledger."balance_before_cny"
            ELSE 0
          END
        ), 0) AS "netAdjustmentsCny",
        MAX(ledger."created_at") FILTER (
          WHERE ledger."entry_type" = 'payment_credit'
        ) AS "lastPaymentAt",
        MAX(ledger."created_at") FILTER (
          WHERE ledger."entry_type" = 'gift_card_debit'
        ) AS "lastTopupAt"
      FROM "id_business_v2_topup_supplier_ledger" ledger
      WHERE ledger."supplier_account_id" IN (
        ${PrismaNamespace.join(accountIds.map((id) => PrismaNamespace.sql`CAST(${id} AS UUID)`))}
      )
      GROUP BY ledger."supplier_account_id"
    `);
    return new Map(rows.map((row) => [row.supplierAccountId, row]));
  }

  private async getSupplierSummary() {
    const accounts = await this.prisma.idBusinessV2TopupSupplierAccount.aggregate({
      where: { currency: 'CNY', initializedAt: { not: null } },
      _sum: { currentBalanceCny: true },
      _count: { id: true }
    });
    const [negativeCount, supplierCount] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierAccount.count({
        where: {
          currency: 'CNY',
          initializedAt: { not: null },
          currentBalanceCny: { lt: 0 }
        }
      }),
      this.prisma.idBusinessV2Option.count({
        where: { type: 'topup_supplier', deletedAt: null }
      })
    ]);
    return {
      totalBalanceCny: toV2DecimalString(accounts._sum.currentBalanceCny ?? 0),
      initializedCount: accounts._count.id,
      uninitializedCount: Math.max(0, supplierCount - accounts._count.id),
      negativeCount
    };
  }

  private async loadCountryStats(accountId: string) {
    const rows = await this.prisma.$queryRaw<CountryAggregateRow[]>(PrismaNamespace.sql`
      SELECT
        gift_card."country_option_id" AS "countryOptionId",
        gift_card."country_name_snapshot" AS "countryName",
        gift_card."currency_code_snapshot" AS "currencyCode",
        COUNT(*)::bigint AS "cardCount",
        COALESCE(SUM(gift_card."face_value"), 0) AS "faceValue",
        COALESCE(SUM(ledger."amount_cny"), 0) AS "costCny"
      FROM "id_business_v2_topup_supplier_ledger" ledger
      INNER JOIN "id_business_v2_gift_cards" gift_card
        ON gift_card."id" = ledger."gift_card_id"
      LEFT JOIN "id_business_v2_topup_supplier_ledger" reversal
        ON reversal."reversal_of_entry_id" = ledger."id"
      WHERE
        ledger."supplier_account_id" = CAST(${accountId} AS UUID)
        AND ledger."entry_type" = 'gift_card_debit'
        AND reversal."id" IS NULL
      GROUP BY
        gift_card."country_option_id",
        gift_card."country_name_snapshot",
        gift_card."currency_code_snapshot"
      ORDER BY "costCny" DESC, "countryName" ASC
    `);
    return rows.map((row) => ({
      countryOptionId: row.countryOptionId,
      countryName: row.countryName,
      currencyCode: row.currencyCode,
      cardCount: Number(row.cardCount),
      faceValue: toV2DecimalString(row.faceValue),
      costCny: toV2DecimalString(row.costCny)
    }));
  }
}
