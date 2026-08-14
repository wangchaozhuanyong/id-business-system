import { Injectable, NotFoundException } from '@nestjs/common';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
import { IdBusinessV2TopupSupplierFundsQuerySupport } from './id-business-v2-topup-supplier-funds-query-support';
import { IdBusinessV2TopupSupplierQueryRepository } from './persistence/id-business-v2-topup-supplier-query.repository';

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

@Injectable()
export class IdBusinessV2TopupSupplierFundsQueryService extends IdBusinessV2TopupSupplierFundsQuerySupport {
  constructor(
    private readonly repository: IdBusinessV2TopupSupplierQueryRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {
    super();
  }

  async listSuppliers(query: ListIdBusinessV2TopupSuppliersQuery) {
    const pagination = getPagination(query);
    const result = await this.repository.listSuppliers({
      keyword: this.normalizeKeyword(query.keyword),
      status: this.parseOptionStatus(query.status),
      fundingStatus: this.parseFundingStatus(query.fundingStatus),
      sortBy: query.sortBy,
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });
    const accountIds = result.items
      .map((option) => option.topupFundAccounts[0]?.id)
      .filter((id): id is string => Boolean(id));
    const [aggregateByAccount, summary] = await Promise.all([
      this.repository.loadSupplierAggregates(accountIds),
      this.repository.getSupplierSummary()
    ]);

    return {
      items: result.items.map((option) => {
        const account = option.topupFundAccounts[0];
        const aggregate = account ? aggregateByAccount.get(account.id) : undefined;
        return {
          supplier: { id: option.id, code: option.code, name: option.name, status: option.status },
          accountId: account?.id ?? null,
          initialized: Boolean(account?.initializedAt),
          initializedAt: account?.initializedAt ?? null,
          currentBalanceCny: account?.currentBalanceCny.toString() ?? null,
          isNegative: account?.currentBalanceCny.isNegative() ?? false,
          paymentsCny: (aggregate?.paymentsCny ?? Amount4.zero()).toString(),
          topupDeductionsCny: (aggregate?.topupDeductionsCny ?? Amount4.zero()).toString(),
          netAdjustmentsCny: (aggregate?.netAdjustmentsCny ?? Amount4.zero()).toString(),
          lastPaymentAt: aggregate?.lastPaymentAt ?? null,
          lastTopupAt: aggregate?.lastTopupAt ?? null,
          updatedAt: account?.updatedAt ?? option.updatedAt
        };
      }),
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: { ...summary, totalBalanceCny: summary.totalBalanceCny.toString() }
    };
  }

  async listPaymentRecords(query: ListIdBusinessV2TopupSupplierPaymentsQuery) {
    const pagination = getPagination(query);
    const result = await this.repository.listPayments({
      keyword: this.normalizeKeyword(query.keyword),
      supplierOptionId: this.normalizeOptionalUuid(query.supplierOptionId, '加卡供应商'),
      status: this.parsePaymentStatus(query.status),
      paidAt: this.parseDateRange(query.dateFrom, query.dateTo),
      sortBy: query.sortBy,
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });

    return {
      items: result.items.map((payment) => {
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
          receivedUsdt: payment.receivedUsdt.toString(),
          networkFeeUsdt: payment.networkFeeUsdt.toString(),
          settlementRateCnyUsdt: payment.settlementRateCnyUsdt.toString(),
          creditedCny: payment.creditedCny.toString(),
          network: payment.network,
          transactionHash: payment.transactionHash,
          paidAt: payment.paidAt,
          postedAt: payment.createdAt,
          remark: payment.remark,
          status: reversalEntry ? ('reversed' as const) : ('active' as const),
          balanceBeforeCny: creditEntry?.balanceBeforeCny.toString() ?? null,
          balanceAfterCny: creditEntry?.balanceAfterCny.toString() ?? null,
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
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: {
        activeReceivedUsdt: result.activeReceivedUsdt.toString(),
        activeNetworkFeeUsdt: result.activeNetworkFeeUsdt.toString(),
        activeCreditedCny: result.activeCreditedCny.toString(),
        weightedAverageRate: result.activeReceivedUsdt.gt(0)
          ? result.activeCreditedCny.ratio(result.activeReceivedUsdt).toFixed(8)
          : null
      }
    };
  }

  async listLedger(
    supplierOptionIdValue: string,
    query: ListIdBusinessV2TopupSupplierLedgerQuery,
    operator?: AuthenticatedUser
  ) {
    const supplierOptionId = this.normalizeRequiredUuid(supplierOptionIdValue, '加卡供应商');
    const pagination = getPagination(query);
    const supplier = await this.repository.findSupplierLedgerHeader(supplierOptionId);
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
    const result = await this.repository.listLedger({
      supplierAccountId: supplierAccount.id,
      entryType: this.parseLedgerEntryType(query.entryType),
      createdAt: this.parseDateRange(query.dateFrom, query.dateTo),
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });
    const giftCardDisplayMode = operator
      ? await this.sensitiveAccessService.resolveDisplayMode(
          operator,
          'gift_card.code',
          'business_records'
        )
      : 'masked';
    return {
      supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
      account: {
        id: supplierAccount.id,
        initialized: Boolean(supplierAccount.initializedAt),
        initializedAt: supplierAccount.initializedAt,
        currentBalanceCny: supplierAccount.currentBalanceCny.toString(),
        isNegative: supplierAccount.currentBalanceCny.isNegative()
      },
      items: result.items.map((entry) => ({
        id: entry.id,
        entryType: entry.entryType,
        direction: entry.direction,
        amountCny: entry.amountCny.toString(),
        balanceDeltaCny: entry.balanceAfterCny.sub(entry.balanceBeforeCny).toString(),
        balanceBeforeCny: entry.balanceBeforeCny.toString(),
        balanceAfterCny: entry.balanceAfterCny.toString(),
        reason: entry.reason,
        payment: entry.payment
          ? {
              id: entry.payment.id,
              receivedUsdt: entry.payment.receivedUsdt.toString(),
              settlementRateCnyUsdt: entry.payment.settlementRateCnyUsdt.toString(),
              paidAt: entry.payment.paidAt
            }
          : null,
        giftCard: entry.giftCard
          ? {
              id: entry.giftCard.id,
              codeMasked: entry.giftCard.codeMasked,
              code:
                giftCardDisplayMode === 'hidden'
                  ? null
                  : giftCardDisplayMode === 'full'
                    ? this.fieldEncryptionService.decrypt(entry.giftCard.codeEncrypted)
                    : entry.giftCard.codeMasked,
              countryNameSnapshot: entry.giftCard.countryNameSnapshot,
              currencyCodeSnapshot: entry.giftCard.currencyCodeSnapshot,
              faceValue: entry.giftCard.faceValue.toString(),
              exchangeRate: entry.giftCard.exchangeRate.toString()
            }
          : null,
        reversalOf: entry.reversalOf,
        reversedBy: entry.reversedBy,
        operator: entry.createdBy,
        createdAt: entry.createdAt
      })),
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      countryStats: result.countryStats.map((item) => ({
        ...item,
        faceValue: item.faceValue.toString(),
        costCny: item.costCny.toString()
      }))
    };
  }

  async listBalanceSelectors() {
    const suppliers = await this.repository.listBalanceSelectors();
    return suppliers.map((supplier) => {
      const account = supplier.topupFundAccounts[0];
      return {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        initialized: Boolean(account?.initializedAt),
        currentBalanceCny: account?.currentBalanceCny.toString() ?? null,
        isNegative: account?.currentBalanceCny.isNegative() ?? false
      };
    });
  }

  async listGiftCardPurchaseSources() {
    const result = await this.repository.listGiftCardPurchaseSources();
    return {
      financeAccounts: result.financeAccounts.map((account) => ({
        ...account,
        currentBalance: account.currentBalance.toString()
      })),
      supplierWallets: result.supplierWallets.map((wallet) => ({
        id: wallet.id,
        supplierOptionId: wallet.supplierOptionId,
        supplierName: wallet.supplierOption.name,
        currency: wallet.currency,
        currentBalance: wallet.currentBalance.toString()
      }))
    };
  }
}
