import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type IdBusinessV2OptionStatus,
  type IdBusinessV2TopupSupplierLedgerEntryType
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { mapAmount4, mapRate8, type Amount4 } from '../../runtime/public-api';

export type SupplierFundingStatus = 'initialized' | 'uninitialized' | 'negative' | null;

export interface SupplierListCriteria {
  keyword: string | null;
  status: IdBusinessV2OptionStatus | null;
  fundingStatus: SupplierFundingStatus;
  sortBy?: string;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface SupplierPaymentListCriteria {
  keyword: string | null;
  supplierOptionId: string | null;
  status: 'active' | 'reversed' | null;
  paidAt?: { gte?: Date; lte?: Date };
  sortBy?: string;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface SupplierLedgerListCriteria {
  supplierAccountId: string;
  entryType: IdBusinessV2TopupSupplierLedgerEntryType | null;
  createdAt?: { gte?: Date; lte?: Date };
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

interface SupplierAggregatePersistenceRow {
  supplierAccountId: string;
  paymentsCny: unknown;
  topupDeductionsCny: unknown;
  netAdjustmentsCny: unknown;
  lastPaymentAt: Date | null;
  lastTopupAt: Date | null;
}

export interface SupplierAggregateRow extends Omit<
  SupplierAggregatePersistenceRow,
  'paymentsCny' | 'topupDeductionsCny' | 'netAdjustmentsCny'
> {
  paymentsCny: Amount4;
  topupDeductionsCny: Amount4;
  netAdjustmentsCny: Amount4;
}

interface CountryAggregatePersistenceRow {
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  cardCount: bigint;
  faceValue: unknown;
  costCny: unknown;
}

@Injectable()
export class IdBusinessV2TopupSupplierQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listSuppliers(criteria: SupplierListCriteria) {
    const accountWhere =
      criteria.fundingStatus === 'initialized'
        ? { some: { currency: 'CNY' as const, initializedAt: { not: null } } }
        : criteria.fundingStatus === 'uninitialized'
          ? { none: { currency: 'CNY' as const, initializedAt: { not: null } } }
          : criteria.fundingStatus === 'negative'
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
      status: criteria.status ?? undefined,
      name: criteria.keyword ? { contains: criteria.keyword, mode: 'insensitive' } : undefined,
      topupFundAccounts: accountWhere
    };
    const orderBy: Prisma.IdBusinessV2OptionOrderByWithRelationInput[] =
      criteria.sortBy === 'name'
        ? [{ name: criteria.sortDirection }, { id: 'desc' }]
        : criteria.sortBy === 'createdAt'
          ? [{ createdAt: criteria.sortDirection }, { id: 'desc' }]
          : [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'desc' }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.findMany({
        where,
        include: {
          topupFundAccounts: { where: { currency: 'CNY' }, take: 1 }
        },
        skip: criteria.skip,
        take: criteria.take,
        orderBy
      }),
      this.prisma.idBusinessV2Option.count({ where })
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        topupFundAccounts: row.topupFundAccounts.map((account) => ({
          ...account,
          openingBalance: mapAmount4(
            account.openingBalance,
            'id_business_v2_topup_supplier_accounts.opening_balance'
          ),
          currentBalance: mapAmount4(
            account.currentBalance,
            'id_business_v2_topup_supplier_accounts.current_balance'
          ),
          openingBalanceCny: mapAmount4(
            account.openingBalanceCny,
            'id_business_v2_topup_supplier_accounts.opening_balance_cny'
          ),
          currentBalanceCny: mapAmount4(
            account.currentBalanceCny,
            'id_business_v2_topup_supplier_accounts.current_balance_cny'
          )
        }))
      })),
      total
    };
  }

  async listPayments(criteria: SupplierPaymentListCriteria) {
    const where: Prisma.IdBusinessV2TopupSupplierPaymentWhereInput = {
      paidCurrency: 'USDT',
      supplierAccount: criteria.supplierOptionId
        ? { is: { supplierOptionId: criteria.supplierOptionId } }
        : undefined,
      paidAt: criteria.paidAt,
      ledgerEntries:
        criteria.status === 'active'
          ? { some: { entryType: 'payment_credit', reversedBy: null } }
          : criteria.status === 'reversed'
            ? { some: { entryType: 'payment_reversal' } }
            : undefined,
      OR: criteria.keyword
        ? [
            { supplierNameSnapshot: { contains: criteria.keyword, mode: 'insensitive' } },
            { transactionHash: { contains: criteria.keyword, mode: 'insensitive' } },
            { network: { contains: criteria.keyword, mode: 'insensitive' } },
            { remark: { contains: criteria.keyword, mode: 'insensitive' } }
          ]
        : undefined
    };
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
    const sortField = sortable[criteria.sortBy ?? 'paidAt'] ?? 'paidAt';
    const [rows, total, aggregate] = await this.prisma.$transaction([
      this.prisma.idBusinessV2TopupSupplierPayment.findMany({
        where,
        include: {
          supplierAccount: { include: { supplierOption: true } },
          createdBy: { select: { id: true, username: true, displayName: true } },
          ledgerEntries: {
            include: { reversedBy: { select: { id: true, reason: true, createdAt: true } } },
            orderBy: { createdAt: 'asc' }
          }
        },
        skip: criteria.skip,
        take: criteria.take,
        orderBy: [{ [sortField]: criteria.sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierPayment.count({ where }),
      this.prisma.idBusinessV2TopupSupplierPayment.aggregate({
        where: {
          ...where,
          ledgerEntries: { some: { entryType: 'payment_credit', reversedBy: null } }
        },
        _sum: { paidAmount: true, creditedCny: true, networkFeeAmount: true }
      })
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        receivedUsdt: mapAmount4(
          row.receivedUsdt ?? row.paidAmount,
          'id_business_v2_topup_supplier_payments.received_usdt'
        ),
        networkFeeUsdt: mapAmount4(
          row.networkFeeUsdt ?? row.networkFeeAmount,
          'id_business_v2_topup_supplier_payments.network_fee_usdt'
        ),
        settlementRateCnyUsdt: mapRate8(
          row.settlementRateCnyUsdt ?? row.fxRateToCny,
          'id_business_v2_topup_supplier_payments.settlement_rate_cny_usdt'
        ),
        creditedCny: mapAmount4(
          row.creditedCny,
          'id_business_v2_topup_supplier_payments.credited_cny'
        ),
        ledgerEntries: row.ledgerEntries.map((entry) => ({
          ...entry,
          amountCny: mapAmount4(entry.amountCny, 'id_business_v2_topup_supplier_ledger.amount_cny'),
          balanceBeforeCny: mapAmount4(
            entry.balanceBeforeCny,
            'id_business_v2_topup_supplier_ledger.balance_before_cny'
          ),
          balanceAfterCny: mapAmount4(
            entry.balanceAfterCny,
            'id_business_v2_topup_supplier_ledger.balance_after_cny'
          )
        }))
      })),
      total,
      activeReceivedUsdt: mapAmount4(
        aggregate._sum.paidAmount ?? 0,
        'id_business_v2_topup_supplier_payments.paid_amount_sum'
      ),
      activeNetworkFeeUsdt: mapAmount4(
        aggregate._sum.networkFeeAmount ?? 0,
        'id_business_v2_topup_supplier_payments.network_fee_amount_sum'
      ),
      activeCreditedCny: mapAmount4(
        aggregate._sum.creditedCny ?? 0,
        'id_business_v2_topup_supplier_payments.credited_cny_sum'
      )
    };
  }

  async findSupplierLedgerHeader(supplierOptionId: string) {
    const row = await this.prisma.idBusinessV2Option.findFirst({
      where: { id: supplierOptionId, type: 'topup_supplier', deletedAt: null },
      include: { topupFundAccounts: { where: { currency: 'CNY' }, take: 1 } }
    });
    if (!row) return null;
    return {
      ...row,
      topupFundAccounts: row.topupFundAccounts.map((account) => ({
        ...account,
        currentBalanceCny: mapAmount4(
          account.currentBalanceCny,
          'id_business_v2_topup_supplier_accounts.current_balance_cny'
        )
      }))
    };
  }

  async listLedger(criteria: SupplierLedgerListCriteria) {
    const where: Prisma.IdBusinessV2TopupSupplierLedgerWhereInput = {
      supplierAccountId: criteria.supplierAccountId,
      entryType: criteria.entryType ?? undefined,
      createdAt: criteria.createdAt
    };
    const [rows, total, countryStats] = await Promise.all([
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
        skip: criteria.skip,
        take: criteria.take,
        orderBy: [{ createdAt: criteria.sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierLedger.count({ where }),
      this.loadCountryStats(criteria.supplierAccountId)
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        amountCny: mapAmount4(row.amountCny, 'id_business_v2_topup_supplier_ledger.amount_cny'),
        balanceBeforeCny: mapAmount4(
          row.balanceBeforeCny,
          'id_business_v2_topup_supplier_ledger.balance_before_cny'
        ),
        balanceAfterCny: mapAmount4(
          row.balanceAfterCny,
          'id_business_v2_topup_supplier_ledger.balance_after_cny'
        ),
        payment: row.payment
          ? {
              id: row.payment.id,
              receivedUsdt: mapAmount4(
                row.payment.receivedUsdt ?? row.payment.paidAmount,
                'id_business_v2_topup_supplier_payments.received_usdt'
              ),
              settlementRateCnyUsdt: mapRate8(
                row.payment.settlementRateCnyUsdt ?? row.payment.fxRateToCny,
                'id_business_v2_topup_supplier_payments.settlement_rate_cny_usdt'
              ),
              paidAt: row.payment.paidAt
            }
          : null,
        giftCard: row.giftCard
          ? {
              ...row.giftCard,
              faceValue: mapAmount4(row.giftCard.faceValue, 'id_business_v2_gift_cards.face_value'),
              exchangeRate: mapRate8(
                row.giftCard.exchangeRate,
                'id_business_v2_gift_cards.exchange_rate'
              )
            }
          : null
      })),
      total,
      countryStats
    };
  }

  async listBalanceSelectors() {
    const rows = await this.prisma.idBusinessV2Option.findMany({
      where: { type: 'topup_supplier', status: 'active', deletedAt: null },
      include: { topupFundAccounts: { where: { currency: 'CNY' }, take: 1 } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
    return rows.map((row) => ({
      ...row,
      topupFundAccounts: row.topupFundAccounts.map((account) => ({
        ...account,
        currentBalanceCny: mapAmount4(
          account.currentBalanceCny,
          'id_business_v2_topup_supplier_accounts.current_balance_cny'
        )
      }))
    }));
  }

  async listGiftCardPurchaseSources() {
    const [financeAccounts, supplierWallets] = await Promise.all([
      this.prisma.idBusinessV2FinanceAccount.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, currency: true, currentBalance: true },
        orderBy: [{ currency: 'asc' }, { name: 'asc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierAccount.findMany({
        where: {
          status: 'active',
          initializedAt: { not: null },
          supplierOption: { status: 'active', deletedAt: null }
        },
        select: {
          id: true,
          supplierOptionId: true,
          currency: true,
          currentBalance: true,
          supplierOption: { select: { name: true } }
        },
        orderBy: [{ currency: 'asc' }, { supplierOption: { name: 'asc' } }]
      })
    ]);
    return {
      financeAccounts: financeAccounts.map((account) => ({
        ...account,
        currentBalance: mapAmount4(
          account.currentBalance,
          'id_business_v2_finance_accounts.current_balance'
        )
      })),
      supplierWallets: supplierWallets.map((wallet) => ({
        ...wallet,
        currentBalance: mapAmount4(
          wallet.currentBalance,
          'id_business_v2_topup_supplier_accounts.current_balance'
        )
      }))
    };
  }

  async getSupplierSummary() {
    const [accounts, negativeCount, supplierCount] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierAccount.aggregate({
        where: { currency: 'CNY', initializedAt: { not: null } },
        _sum: { currentBalanceCny: true },
        _count: { id: true }
      }),
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
      totalBalanceCny: mapAmount4(
        accounts._sum.currentBalanceCny ?? 0,
        'id_business_v2_topup_supplier_accounts.current_balance_cny_sum'
      ),
      initializedCount: accounts._count.id,
      uninitializedCount: Math.max(0, supplierCount - accounts._count.id),
      negativeCount
    };
  }

  async loadSupplierAggregates(accountIds: string[]) {
    if (!accountIds.length) return new Map<string, SupplierAggregateRow>();
    const rows = await this.prisma.$queryRaw<SupplierAggregatePersistenceRow[]>(Prisma.sql`
      SELECT
        ledger."supplier_account_id" AS "supplierAccountId",
        COALESCE(SUM(CASE WHEN ledger."entry_type" = 'payment_credit' THEN ledger."amount_cny" WHEN ledger."entry_type" = 'payment_reversal' THEN -ledger."amount_cny" ELSE 0 END), 0) AS "paymentsCny",
        COALESCE(SUM(CASE WHEN ledger."entry_type" = 'gift_card_debit' THEN ledger."amount_cny" WHEN ledger."entry_type" = 'gift_card_withdrawal_reversal' THEN -ledger."amount_cny" ELSE 0 END), 0) AS "topupDeductionsCny",
        COALESCE(SUM(CASE WHEN ledger."entry_type" IN ('opening_balance', 'manual_adjustment') THEN ledger."balance_after_cny" - ledger."balance_before_cny" ELSE 0 END), 0) AS "netAdjustmentsCny",
        MAX(ledger."created_at") FILTER (WHERE ledger."entry_type" = 'payment_credit') AS "lastPaymentAt",
        MAX(ledger."created_at") FILTER (WHERE ledger."entry_type" = 'gift_card_debit') AS "lastTopupAt"
      FROM "id_business_v2_topup_supplier_ledger" ledger
      WHERE ledger."supplier_account_id" IN (
        ${Prisma.join(accountIds.map((id) => Prisma.sql`CAST(${id} AS UUID)`))}
      )
      GROUP BY ledger."supplier_account_id"
    `);
    return new Map(
      rows.map((row) => [
        row.supplierAccountId,
        {
          ...row,
          paymentsCny: mapAmount4(
            row.paymentsCny,
            'id_business_v2_topup_supplier_ledger.payments_cny'
          ),
          topupDeductionsCny: mapAmount4(
            row.topupDeductionsCny,
            'id_business_v2_topup_supplier_ledger.topup_deductions_cny'
          ),
          netAdjustmentsCny: mapAmount4(
            row.netAdjustmentsCny,
            'id_business_v2_topup_supplier_ledger.net_adjustments_cny'
          )
        }
      ])
    );
  }

  private async loadCountryStats(accountId: string) {
    const rows = await this.prisma.$queryRaw<CountryAggregatePersistenceRow[]>(Prisma.sql`
      SELECT
        gift_card."country_option_id" AS "countryOptionId",
        gift_card."country_name_snapshot" AS "countryName",
        gift_card."currency_code_snapshot" AS "currencyCode",
        COUNT(*)::bigint AS "cardCount",
        COALESCE(SUM(gift_card."face_value"), 0) AS "faceValue",
        COALESCE(SUM(ledger."amount_cny"), 0) AS "costCny"
      FROM "id_business_v2_topup_supplier_ledger" ledger
      INNER JOIN "id_business_v2_gift_cards" gift_card ON gift_card."id" = ledger."gift_card_id"
      LEFT JOIN "id_business_v2_topup_supplier_ledger" reversal ON reversal."reversal_of_entry_id" = ledger."id"
      WHERE ledger."supplier_account_id" = CAST(${accountId} AS UUID)
        AND ledger."entry_type" = 'gift_card_debit'
        AND reversal."id" IS NULL
      GROUP BY gift_card."country_option_id", gift_card."country_name_snapshot", gift_card."currency_code_snapshot"
      ORDER BY "costCny" DESC, "countryName" ASC
    `);
    return rows.map((row) => ({
      countryOptionId: row.countryOptionId,
      countryName: row.countryName,
      currencyCode: row.currencyCode,
      cardCount: Number(row.cardCount),
      faceValue: mapAmount4(row.faceValue, 'id_business_v2_gift_cards.face_value'),
      costCny: mapAmount4(row.costCny, 'id_business_v2_topup_supplier_ledger.amount_cny')
    }));
  }
}
