export interface UpdateIdBusinessV2AccountDto {
  expectedUpdatedAt?: string;
  appleId?: string;
  password?: string | null;
  phone?: string | null;
  securityInfo?: string | null;
  countryOptionId?: string;
  statusOptionId?: string;
  supplierOptionId?: string | null;
  currentBalance?: string | number;
  balanceCostAmount?: string | number;
  expectedCurrentBalance?: string | number;
  expectedBalanceCostAmount?: string | number;
  balanceAdjustmentReason?: string;
  balanceAdjustmentIdempotencyKey?: string;
  purchaseCost?: string | number;
  recordStatus?: 'active' | 'disabled' | string;
  remark?: string | null;
}
