import type { IdBusinessV2OptionStatus } from '@prisma/client';

export interface UpdateIdBusinessV2OptionDto {
  expectedUpdatedAt?: string;
  name?: string;
  parentId?: string | null;
  countryOptionId?: string | null;
  businessAmount?: string | number | null;
  currencyCode?: string | null;
  fixedFee?: string | number;
  percentageFee?: string | number;
  sortOrder?: string | number;
  status?: IdBusinessV2OptionStatus;
  remark?: string | null;
}
