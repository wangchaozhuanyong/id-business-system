import type { IdBusinessV2RecordStatus } from '@prisma/client';

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
  recordStatus?: IdBusinessV2RecordStatus | string;
  remark?: string | null;
}
