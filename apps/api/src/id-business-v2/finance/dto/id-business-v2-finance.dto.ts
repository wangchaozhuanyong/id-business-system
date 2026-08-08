import type {
  IdBusinessV2FinanceAccountStatus,
  IdBusinessV2FinanceAccountType,
  IdBusinessV2FinanceCurrency
} from '@prisma/client';

export interface CreateIdBusinessV2FinanceAccountDto {
  name: string;
  accountType: IdBusinessV2FinanceAccountType;
  currency: IdBusinessV2FinanceCurrency;
  openingBalance?: string | number;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  remark?: string | null;
  idempotencyKey: string;
}

export interface UpdateIdBusinessV2FinanceAccountDto {
  name?: string;
  status?: IdBusinessV2FinanceAccountStatus;
  remark?: string | null;
}

export interface CreateIdBusinessV2FinanceExpenseDto {
  categoryOptionId: string;
  financeAccountId: string;
  amount: string | number;
  currency: IdBusinessV2FinanceCurrency;
  occurredAt: string;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  payee?: string | null;
  receiptAttachmentId?: string | null;
  remark?: string | null;
  idempotencyKey: string;
}

export interface CorrectIdBusinessV2FinanceExpenseDto extends CreateIdBusinessV2FinanceExpenseDto {
  reason: string;
}

export interface CreateIdBusinessV2SupplierDepositDto {
  financeAccountId: string;
  paidAmount: string | number;
  creditedAmount?: string | number;
  networkFeeAmount?: string | number;
  paidAt: string;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  network?: string | null;
  transactionHash?: string | null;
  remark?: string | null;
  idempotencyKey: string;
}

export interface CreateIdBusinessV2SupplierWalletDto {
  supplierOptionId: string;
  currency: IdBusinessV2FinanceCurrency;
  openingBalance?: string | number;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  reason: string;
  idempotencyKey: string;
}

export interface CreateIdBusinessV2SupplierRefundDto {
  financeAccountId: string;
  amount: string | number;
  receivedAt: string;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  reason: string;
  idempotencyKey: string;
}

export interface AdjustIdBusinessV2SupplierWalletDto {
  targetBalance: string | number;
  fxRateToCny?: string | number;
  fxRateSnapshotId?: string | null;
  manualRateReason?: string | null;
  reason: string;
  idempotencyKey: string;
}

export interface ReverseIdBusinessV2FinanceJournalDto {
  reason: string;
  idempotencyKey: string;
}

export interface CloseIdBusinessV2GiftCardRefundDto {
  receivedAt?: string | null;
  reason: string;
  idempotencyKey: string;
}

export interface ReopenIdBusinessV2FinancePeriodDto {
  reason: string;
}

export interface ManualIdBusinessV2FinanceFxRateDto {
  currency: IdBusinessV2FinanceCurrency;
  rateToCny: string | number;
  businessDate: string;
  reason: string;
  sourceReference?: string | null;
}

export interface ConfirmIdBusinessV2FinanceHistoryDto {
  confirmed: boolean;
  financeAccountsConfirmed: boolean;
  supplierBalancesConfirmed: boolean;
  historicalExpensesConfirmed: boolean;
  previewFingerprint: string;
  note: string;
}

export interface ReopenIdBusinessV2FinanceHistoryDto {
  reason: string;
}

export interface BackfillIdBusinessV2FinanceHistoryDto {
  previewFingerprint: string;
  previewAsOf: string;
}
