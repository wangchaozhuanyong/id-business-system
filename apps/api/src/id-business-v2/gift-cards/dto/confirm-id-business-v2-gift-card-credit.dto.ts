import type { IdBusinessV2FinanceCurrency } from '@prisma/client';

export interface ConfirmIdBusinessV2GiftCardCreditDto {
  code: string;
  faceValue: string | number;
  cardNameOptionId?: string;
  countryOptionId?: string;
  exchangeRate?: string | number;
  exchangeRateSnapshotId?: string | null;
  exchangeRatePrefilledValue?: string | number | null;
  supplierOptionId: string;
  creditedAt?: string | null;
  purchaseOriginalAmount?: string | number;
  purchaseCurrency?: IdBusinessV2FinanceCurrency;
  purchaseFxRateToCny?: string | number;
  purchaseFxSnapshotId?: string | null;
  purchaseFinanceAccountId?: string | null;
  purchaseSupplierAccountId?: string | null;
  purchaseManualRateReason?: string | null;
  paidAt?: string | null;
  idempotencyKey: string;
  confirmedSoldByOrderId?: string;
  remark?: string | null;
}
