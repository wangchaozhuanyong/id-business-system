import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  mapAmount4,
  mapOptionalAmount4,
  mapOptionalRate8,
  mapRate8,
  type Amount4,
  type Rate8,
  type V2CommandTransaction
} from '../../runtime/public-api';
import { IdBusinessV2TopupSupplierAccountRepository } from './id-business-v2-topup-supplier-account.repository';

const LEDGER_SUPPLIER_INCLUDE = {
  supplierAccount: { include: { supplierOption: true } }
} satisfies Prisma.IdBusinessV2TopupSupplierLedgerInclude;

@Injectable()
export class IdBusinessV2TopupSupplierCommandRepository {
  constructor(private readonly accounts: IdBusinessV2TopupSupplierAccountRepository) {}

  findActiveSupplier(tx: V2CommandTransaction, supplierOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: supplierOptionId,
        type: 'topup_supplier',
        status: 'active',
        deletedAt: null
      },
      select: { id: true, code: true, name: true }
    });
  }

  lockSupplierAccount(tx: V2CommandTransaction, supplierOptionId: string) {
    return this.accounts.lockBySupplierOptionId(tx, supplierOptionId);
  }

  lockSupplierAccountById(tx: V2CommandTransaction, accountId: string) {
    return this.accounts.lockById(tx, accountId);
  }

  lockSupplierAccountsByIds(tx: V2CommandTransaction, accountIds: string[]) {
    return this.accounts.lockByIds(tx, accountIds);
  }

  async findLedgerReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2TopupSupplierLedger.findUnique({
      where: { idempotencyKey },
      include: LEDGER_SUPPLIER_INCLUDE
    });
    return row ? mapLedger(row) : null;
  }

  async findLedgerReplayWithoutSupplier(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2TopupSupplierLedger.findUnique({
      where: { idempotencyKey }
    });
    return row ? mapLedger(row) : null;
  }

  async findSupplierAccountRecord(tx: V2CommandTransaction, supplierOptionId: string) {
    const row = await tx.idBusinessV2TopupSupplierAccount.findUnique({
      where: { supplierOptionId_currency: { supplierOptionId, currency: 'CNY' } }
    });
    return row ? mapSupplierAccount(row) : null;
  }

  async initializeSupplierAccount(
    tx: V2CommandTransaction,
    input: {
      id: string;
      existingId?: string;
      supplierOptionId: string;
      balance: string;
      initializedAt: Date;
      operatorId?: string;
    }
  ) {
    const data = {
      openingBalance: input.balance,
      currentBalance: input.balance,
      openingBalanceCny: input.balance,
      currentBalanceCny: input.balance,
      initializedAt: input.initializedAt,
      initializedByUserId: input.operatorId,
      updatedByUserId: input.operatorId
    };
    const row = input.existingId
      ? await tx.idBusinessV2TopupSupplierAccount.update({
          where: { id: input.existingId },
          data
        })
      : await tx.idBusinessV2TopupSupplierAccount.create({
          data: {
            id: input.id,
            supplierOptionId: input.supplierOptionId,
            currency: 'CNY',
            ...data
          }
        });
    return mapSupplierAccount(row);
  }

  async createLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierLedgerUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2TopupSupplierLedger.create({ data });
    return mapLedger(row);
  }

  async createLedgerWithSupplier(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierLedgerUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2TopupSupplierLedger.create({
      data,
      include: LEDGER_SUPPLIER_INCLUDE
    });
    return mapLedger(row);
  }

  updateSupplierAccountBalances(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      currentBalance: string;
      currentBalanceCny: string;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2TopupSupplierAccount.update({
      where: { id: input.accountId },
      data: {
        currentBalance: input.currentBalance,
        currentBalanceCny: input.currentBalanceCny,
        updatedByUserId: input.operatorId
      }
    });
  }

  async findPaymentReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2TopupSupplierPayment.findUnique({
      where: { idempotencyKey },
      include: {
        supplierAccount: { include: { supplierOption: true } },
        ledgerEntries: { where: { entryType: 'payment_credit' }, take: 1 }
      }
    });
    return row ? mapPayment(row) : null;
  }

  async createPayment(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierPaymentUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2TopupSupplierPayment.create({ data });
    return mapPayment(row);
  }

  async findPaymentForReversal(tx: V2CommandTransaction, paymentId: string) {
    const row = await tx.idBusinessV2TopupSupplierPayment.findUnique({
      where: { id: paymentId },
      include: {
        supplierAccount: true,
        ledgerEntries: { include: { reversedBy: true } }
      }
    });
    return row ? mapPayment(row) : null;
  }

  async findFinanceJournalIdForPayment(tx: V2CommandTransaction, paymentId: string) {
    const row = await tx.idBusinessV2FinanceJournal.findFirst({
      where: {
        journalType: 'supplier_deposit',
        sourceType: 'supplier_payment',
        sourceId: paymentId
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' }
    });
    return row?.id ?? null;
  }

  async findActiveGiftCardDebit(tx: V2CommandTransaction, giftCardId: string) {
    const row = await tx.idBusinessV2TopupSupplierLedger.findFirst({
      where: { giftCardId, entryType: 'gift_card_debit', reversedBy: null },
      orderBy: { createdAt: 'desc' }
    });
    return row ? mapLedger(row) : null;
  }

  async findGiftCard(tx: V2CommandTransaction, giftCardId: string) {
    const row = await tx.idBusinessV2GiftCard.findUnique({
      where: { id: giftCardId },
      include: { supplierOption: true }
    });
    return row
      ? {
          ...row,
          faceValue: mapAmount4(row.faceValue, 'id_business_v2_gift_cards.face_value'),
          exchangeRate: mapRate8(row.exchangeRate, 'id_business_v2_gift_cards.exchange_rate'),
          costAmount: mapAmount4(row.costAmount, 'id_business_v2_gift_cards.cost_amount')
        }
      : null;
  }

  async findReassignmentReplays(
    tx: V2CommandTransaction,
    outgoingKey: string,
    incomingKey: string
  ) {
    const [outgoing, incoming] = await Promise.all([
      tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey: outgoingKey },
        include: { supplierAccount: true }
      }),
      tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey: incomingKey },
        include: { supplierAccount: true }
      })
    ]);
    return {
      outgoing: outgoing ? mapLedger(outgoing) : null,
      incoming: incoming ? mapLedger(incoming) : null
    };
  }

  async hasActiveGiftCardDebit(tx: V2CommandTransaction, giftCardId: string) {
    return Boolean(
      await tx.idBusinessV2TopupSupplierLedger.findFirst({
        where: { giftCardId, entryType: 'gift_card_debit', reversedBy: null },
        select: { id: true }
      })
    );
  }

  updateGiftCardSupplier(
    tx: V2CommandTransaction,
    input: {
      giftCardId: string;
      supplierOptionId: string;
      supplierName: string;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2GiftCard.update({
      where: { id: input.giftCardId },
      data: {
        supplierOptionId: input.supplierOptionId,
        supplierNameSnapshot: input.supplierName,
        updatedByUserId: input.operatorId
      }
    });
  }
}

function mapSupplierAccount<
  TRow extends {
    openingBalance: unknown;
    currentBalance: unknown;
    openingBalanceCny: unknown;
    currentBalanceCny: unknown;
  }
>(row: TRow) {
  const { openingBalance, currentBalance, openingBalanceCny, currentBalanceCny, ...rest } = row;
  return {
    ...rest,
    openingBalance: mapAmount4(
      openingBalance,
      'id_business_v2_topup_supplier_accounts.opening_balance'
    ),
    currentBalance: mapAmount4(
      currentBalance,
      'id_business_v2_topup_supplier_accounts.current_balance'
    ),
    openingBalanceCny: mapAmount4(
      openingBalanceCny,
      'id_business_v2_topup_supplier_accounts.opening_balance_cny'
    ),
    currentBalanceCny: mapAmount4(
      currentBalanceCny,
      'id_business_v2_topup_supplier_accounts.current_balance_cny'
    )
  };
}

interface LedgerAmountFields {
  amount: unknown;
  balanceBefore: unknown;
  balanceAfter: unknown;
  amountCny: unknown;
  balanceBeforeCny: unknown;
  balanceAfterCny: unknown;
}

type MappedLedger<TRow extends LedgerAmountFields> = Omit<TRow, keyof LedgerAmountFields> & {
  amount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  amountCny: Amount4;
  balanceBeforeCny: Amount4;
  balanceAfterCny: Amount4;
};

function mapLedger<TRow extends LedgerAmountFields>(row: TRow): MappedLedger<TRow> {
  const {
    amount,
    balanceBefore,
    balanceAfter,
    amountCny,
    balanceBeforeCny,
    balanceAfterCny,
    ...rest
  } = row;
  return {
    ...rest,
    amount: mapAmount4(amount, 'id_business_v2_topup_supplier_ledger.amount'),
    balanceBefore: mapAmount4(balanceBefore, 'id_business_v2_topup_supplier_ledger.balance_before'),
    balanceAfter: mapAmount4(balanceAfter, 'id_business_v2_topup_supplier_ledger.balance_after'),
    amountCny: mapAmount4(amountCny, 'id_business_v2_topup_supplier_ledger.amount_cny'),
    balanceBeforeCny: mapAmount4(
      balanceBeforeCny,
      'id_business_v2_topup_supplier_ledger.balance_before_cny'
    ),
    balanceAfterCny: mapAmount4(
      balanceAfterCny,
      'id_business_v2_topup_supplier_ledger.balance_after_cny'
    )
  } as MappedLedger<TRow>;
}

interface PaymentAmountFields {
  paidAmount: unknown;
  networkFeeAmount: unknown;
  fxRateToCny: unknown;
  creditedAmount: unknown;
  receivedUsdt: unknown | null;
  networkFeeUsdt: unknown | null;
  settlementRateCnyUsdt: unknown | null;
  creditedCny: unknown;
}

type PaymentPersistenceShape = PaymentAmountFields & {
  ledgerEntries?: LedgerAmountFields[];
};

type PaymentLedgerRow<TRow extends PaymentPersistenceShape> = NonNullable<
  TRow['ledgerEntries']
>[number];

type MappedPayment<TRow extends PaymentPersistenceShape> = Omit<
  TRow,
  keyof PaymentAmountFields | 'ledgerEntries'
> & {
  paidAmount: Amount4;
  networkFeeAmount: Amount4;
  fxRateToCny: Rate8;
  creditedAmount: Amount4;
  receivedUsdt: Amount4 | null;
  networkFeeUsdt: Amount4 | null;
  settlementRateCnyUsdt: Rate8 | null;
  creditedCny: Amount4;
  ledgerEntries: MappedLedger<PaymentLedgerRow<TRow>>[];
};

function mapPayment<TRow extends PaymentPersistenceShape>(row: TRow): MappedPayment<TRow> {
  const {
    paidAmount,
    networkFeeAmount,
    fxRateToCny,
    creditedAmount,
    receivedUsdt,
    networkFeeUsdt,
    settlementRateCnyUsdt,
    creditedCny,
    ledgerEntries,
    ...rest
  } = row;
  return {
    ...rest,
    paidAmount: mapAmount4(paidAmount, 'id_business_v2_topup_supplier_payments.paid_amount'),
    networkFeeAmount: mapAmount4(
      networkFeeAmount,
      'id_business_v2_topup_supplier_payments.network_fee_amount'
    ),
    fxRateToCny: mapRate8(fxRateToCny, 'id_business_v2_topup_supplier_payments.fx_rate_to_cny'),
    creditedAmount: mapAmount4(
      creditedAmount,
      'id_business_v2_topup_supplier_payments.credited_amount'
    ),
    receivedUsdt: mapOptionalAmount4(
      receivedUsdt,
      'id_business_v2_topup_supplier_payments.received_usdt'
    ),
    networkFeeUsdt: mapOptionalAmount4(
      networkFeeUsdt,
      'id_business_v2_topup_supplier_payments.network_fee_usdt'
    ),
    settlementRateCnyUsdt: mapOptionalRate8(
      settlementRateCnyUsdt,
      'id_business_v2_topup_supplier_payments.settlement_rate_cny_usdt'
    ),
    creditedCny: mapAmount4(creditedCny, 'id_business_v2_topup_supplier_payments.credited_cny'),
    ledgerEntries: ledgerEntries?.map(mapLedger) ?? []
  } as MappedPayment<TRow>;
}
