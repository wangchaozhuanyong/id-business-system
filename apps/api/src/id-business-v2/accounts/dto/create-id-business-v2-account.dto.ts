import type { IdBusinessV2RecordStatus } from '@prisma/client';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';

export interface CreateIdBusinessV2AccountDto {
  appleId: string;
  password?: string | null;
  phone?: string | null;
  securityInfo?: string | null;
  countryOptionId: string;
  statusOptionId: string;
  supplierOptionId?: string | null;
  currentBalance?: string | number;
  balanceCostAmount?: string | number;
  purchaseCost?: string | number;
  purchaseOriginalAmount?: string | number;
  purchaseCurrency?: IdBusinessV2FinanceCurrency;
  purchaseFxRateToCny?: string | number;
  purchaseFxSnapshotId?: string | null;
  purchaseFinanceAccountId?: string | null;
  purchaseSupplierAccountId?: string | null;
  purchaseManualRateReason?: string | null;
  purchasedAt?: string | null;
  recordStatus?: IdBusinessV2RecordStatus | string;
  remark?: string | null;
}
