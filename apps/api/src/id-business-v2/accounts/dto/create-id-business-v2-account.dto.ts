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
  purchaseCurrency?: 'CNY' | 'MYR' | 'USDT';
  purchaseFxRateToCny?: string | number;
  purchaseFxSnapshotId?: string | null;
  purchaseFinanceAccountId?: string | null;
  purchaseSupplierAccountId?: string | null;
  purchaseManualRateReason?: string | null;
  purchasedAt?: string | null;
  recordStatus?: 'active' | 'disabled' | string;
  remark?: string | null;
}
