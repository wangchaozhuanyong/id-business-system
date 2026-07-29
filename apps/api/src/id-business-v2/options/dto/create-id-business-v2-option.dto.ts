import type { IdBusinessV2OptionStatus, IdBusinessV2OptionType } from '@prisma/client';

export interface CreateIdBusinessV2OptionDto {
  type: IdBusinessV2OptionType;
  name: string;
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
