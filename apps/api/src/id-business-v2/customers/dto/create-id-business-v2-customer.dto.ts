import type { IdBusinessV2RecordStatus } from '@prisma/client';

export interface CreateIdBusinessV2CustomerDto {
  name: string;
  phone?: string | null;
  wechat?: string | null;
  sourceOptionId?: string | null;
  tagOptionIds?: string[];
  serviceOptionIds?: string[];
  recordStatus?: IdBusinessV2RecordStatus | string;
  remark?: string | null;
}
