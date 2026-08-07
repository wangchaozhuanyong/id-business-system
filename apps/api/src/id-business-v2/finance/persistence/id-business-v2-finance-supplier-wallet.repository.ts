import { Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4, mapRate8 } from '../../runtime/public-api';

export interface LockedFinanceSupplierWallet {
  id: string;
  currency: 'CNY' | 'MYR' | 'USD' | 'USDT';
  currentBalance: ReturnType<typeof mapAmount4>;
  currentBalanceCny: ReturnType<typeof mapAmount4>;
  supplierName: string;
}

@Injectable()
export class IdBusinessV2FinanceSupplierWalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lock(tx: V2CommandTransaction, walletId: string): Promise<LockedFinanceSupplierWallet> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        currency: 'CNY' | 'MYR' | 'USD' | 'USDT';
        currentBalance: unknown;
        currentBalanceCny: unknown;
        supplierName: string;
      }>
    >`
      SELECT
        account."id",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        supplier."name" AS "supplierName"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE account."id" = ${walletId}::uuid
      FOR UPDATE OF account
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('供应商钱包不存在');
    return {
      ...row,
      currentBalance: mapAmount4(row.currentBalance, 'supplier wallet currentBalance'),
      currentBalanceCny: mapAmount4(row.currentBalanceCny, 'supplier wallet currentBalanceCny')
    };
  }

  list(currency?: 'CNY' | 'MYR' | 'USD' | 'USDT', supplierOptionId?: string) {
    return this.prisma.idBusinessV2TopupSupplierAccount
      .findMany({
        where: { currency, supplierOptionId },
        include: { supplierOption: true },
        orderBy: [{ supplierOption: { name: 'asc' } }, { currency: 'asc' }]
      })
      .then((rows) => rows.map(mapSupplierWallet));
  }

  async findWalletAndFinanceAccount(walletId: string, financeAccountId: string) {
    const [wallet, financeAccount] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierAccount.findUnique({
        where: { id: walletId },
        include: { supplierOption: true }
      }),
      this.prisma.idBusinessV2FinanceAccount.findUnique({
        where: { id: financeAccountId },
        select: { id: true, name: true, status: true, currency: true }
      })
    ]);
    return { wallet: wallet ? mapSupplierWallet(wallet) : null, financeAccount };
  }

  findWallet(walletId: string) {
    return this.prisma.idBusinessV2TopupSupplierAccount
      .findUnique({ where: { id: walletId }, include: { supplierOption: true } })
      .then((row) => (row ? mapSupplierWallet(row) : null));
  }

  findWalletBySupplierCurrency(
    tx: V2CommandTransaction,
    supplierOptionId: string,
    currency: 'CNY' | 'MYR' | 'USD' | 'USDT'
  ) {
    return tx.idBusinessV2TopupSupplierAccount
      .findUnique({
        where: { supplierOptionId_currency: { supplierOptionId, currency } },
        include: { supplierOption: true }
      })
      .then((row) => (row ? mapSupplierWallet(row) : null));
  }

  findActiveSupplier(tx: V2CommandTransaction, supplierOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: supplierOptionId,
        type: { in: ['topup_supplier', 'id_supplier'] },
        status: 'active',
        deletedAt: null
      },
      select: { id: true, name: true }
    });
  }

  createWallet(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierAccountUncheckedCreateInput
  ) {
    return tx.idBusinessV2TopupSupplierAccount
      .create({ data, include: { supplierOption: true } })
      .then(mapSupplierWallet);
  }

  createLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierLedgerUncheckedCreateInput
  ) {
    return tx.idBusinessV2TopupSupplierLedger.create({ data }).then(mapSupplierLedger);
  }

  findLedgerReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2TopupSupplierLedger
      .findUnique({ where: { idempotencyKey } })
      .then((row) => (row ? mapSupplierLedger(row) : null));
  }

  createPayment(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierPaymentUncheckedCreateInput
  ) {
    return tx.idBusinessV2TopupSupplierPayment
      .create({ data, include: { supplierAccount: { include: { supplierOption: true } } } })
      .then(mapSupplierPayment);
  }

  findPaymentReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2TopupSupplierPayment
      .findUnique({
        where: { idempotencyKey },
        include: { supplierAccount: { include: { supplierOption: true } } }
      })
      .then((row) => (row ? mapSupplierPayment(row) : null));
  }

  updateBalances(
    tx: V2CommandTransaction,
    id: string,
    currentBalance: string,
    currentBalanceCny: string,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2TopupSupplierAccount.update({
      where: { id },
      data: { currentBalance, currentBalanceCny, updatedByUserId }
    });
  }

  async listLedger(walletId: string, skip: number, take: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2TopupSupplierLedger.findMany({
        where: { supplierAccountId: walletId },
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierLedger.count({
        where: { supplierAccountId: walletId }
      })
    ]);
    return { items: items.map(mapSupplierLedger), total };
  }
}

export function mapSupplierWallet<
  T extends {
    id: string;
    supplierOptionId: string;
    currency: IdBusinessV2FinanceCurrency;
    openingBalance: unknown;
    currentBalance: unknown;
    openingBalanceCny: unknown;
    currentBalanceCny: unknown;
    status: string;
    initializedAt: Date | null;
    updatedAt: Date;
    supplierOption: { name: string };
  }
>(row: T) {
  return {
    id: row.id,
    supplierOptionId: row.supplierOptionId,
    supplierName: row.supplierOption.name,
    currency: row.currency,
    openingBalance: mapAmount4(row.openingBalance, 'supplier_accounts.opening_balance').toString(),
    currentBalance: mapAmount4(row.currentBalance, 'supplier_accounts.current_balance').toString(),
    openingBalanceCny: mapAmount4(
      row.openingBalanceCny,
      'supplier_accounts.opening_balance_cny'
    ).toString(),
    currentBalanceCny: mapAmount4(
      row.currentBalanceCny,
      'supplier_accounts.current_balance_cny'
    ).toString(),
    status: row.status,
    initializedAt: row.initializedAt,
    updatedAt: row.updatedAt
  };
}

export function mapSupplierPayment<
  T extends {
    id: string;
    supplierAccountId: string;
    paidCurrency: string;
    paidAmount: unknown;
    networkFeeAmount: unknown;
    fxRateToCny: unknown;
    creditedAmount: unknown;
    creditedCny: unknown;
    paidAt: Date;
    createdAt: Date;
    supplierAccount: { supplierOption: { name: string } };
  }
>(row: T) {
  return {
    id: row.id,
    supplierAccountId: row.supplierAccountId,
    supplierName: row.supplierAccount.supplierOption.name,
    paidCurrency: row.paidCurrency,
    paidAmount: mapAmount4(row.paidAmount, 'supplier_payments.paid_amount').toString(),
    networkFeeAmount: mapAmount4(
      row.networkFeeAmount,
      'supplier_payments.network_fee_amount'
    ).toString(),
    fxRateToCny: mapRate8(row.fxRateToCny, 'supplier_payments.fx_rate_to_cny').toString(),
    creditedAmount: mapAmount4(row.creditedAmount, 'supplier_payments.credited_amount').toString(),
    creditedCny: mapAmount4(row.creditedCny, 'supplier_payments.credited_cny').toString(),
    paidAt: row.paidAt,
    createdAt: row.createdAt
  };
}

export function mapSupplierLedger<
  T extends {
    amount: unknown;
    balanceBefore: unknown;
    balanceAfter: unknown;
    amountCny: unknown;
    balanceBeforeCny: unknown;
    balanceAfterCny: unknown;
  }
>(row: T) {
  return {
    ...row,
    amount: mapAmount4(row.amount, 'supplier_ledgers.amount').toString(),
    balanceBefore: mapAmount4(row.balanceBefore, 'supplier_ledgers.balance_before').toString(),
    balanceAfter: mapAmount4(row.balanceAfter, 'supplier_ledgers.balance_after').toString(),
    amountCny: mapAmount4(row.amountCny, 'supplier_ledgers.amount_cny').toString(),
    balanceBeforeCny: mapAmount4(
      row.balanceBeforeCny,
      'supplier_ledgers.balance_before_cny'
    ).toString(),
    balanceAfterCny: mapAmount4(
      row.balanceAfterCny,
      'supplier_ledgers.balance_after_cny'
    ).toString()
  };
}
