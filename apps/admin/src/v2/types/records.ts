import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';
import type { V2OptionSelector } from './options';

export type V2RecordStatus = 'active' | 'disabled';

export interface V2Customer {
  id: string;
  name: string;
  maskedPhone: string | null;
  phoneTail: string | null;
  hasPhone: boolean;
  wechat: string | null;
  sourceOptionId: string | null;
  source: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  tagOptionIds: string[];
  tags: Array<Pick<V2OptionSelector, 'id' | 'code' | 'name'>>;
  serviceOptionIds: string[];
  services: Array<
    Pick<V2OptionSelector, 'id' | 'code' | 'name'> & {
      parent: { id: string; name: string } | null;
    }
  >;
  recordStatus: V2RecordStatus;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export type V2CustomerListResult = PaginatedResult<V2Customer>;

export interface V2CustomerListQuery extends V2PageQuery {
  keyword?: string;
  sourceOptionId?: string;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus?: V2RecordStatus | '';
  sortBy?: 'name' | 'wechat' | 'recordStatus' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateV2CustomerInput {
  name: string;
  phone?: string | null;
  wechat?: string | null;
  sourceOptionId?: string | null;
  tagOptionIds?: string[];
  serviceOptionIds?: string[];
  recordStatus?: V2RecordStatus;
  remark?: string | null;
}

export type UpdateV2CustomerInput = Partial<CreateV2CustomerInput>;

export interface V2Account {
  id: string;
  appleIdMasked: string;
  hasPassword: boolean;
  hasPhone: boolean;
  maskedPhone: string | null;
  phoneTail: string | null;
  hasSecurityInfo: boolean;
  countryOptionId: string;
  country: Pick<V2OptionSelector, 'id' | 'code' | 'name'>;
  statusOptionId: string;
  status: Pick<V2OptionSelector, 'id' | 'code' | 'name'> & { isSystem: boolean };
  supplierOptionId: string | null;
  supplier: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  currentBalance: string;
  balanceCostAmount: string;
  purchaseCost: string;
  recordStatus: V2RecordStatus;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export type V2AccountListResult = PaginatedResult<V2Account>;

export interface V2AccountListQuery extends V2PageQuery {
  keyword?: string;
  countryOptionId?: string;
  statusOptionId?: string;
  supplierOptionId?: string;
  recordStatus?: V2RecordStatus | '';
  sortBy?:
    | 'appleId'
    | 'currentBalance'
    | 'balanceCostAmount'
    | 'purchaseCost'
    | 'recordStatus'
    | 'createdAt'
    | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateV2AccountInput {
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
  recordStatus?: V2RecordStatus;
  remark?: string | null;
}

export interface UpdateV2AccountInput extends Partial<CreateV2AccountInput> {
  expectedCurrentBalance?: string | number;
  expectedBalanceCostAmount?: string | number;
  balanceAdjustmentReason?: string;
  balanceAdjustmentIdempotencyKey?: string;
}

export interface ImportV2AccountRowInput extends CreateV2AccountInput {
  rowNumber: number;
}

export interface V2AccountImportResult {
  totalCount: number;
  successCount: number;
  failedCount: number;
  failures: Array<{
    rowNumber: number;
    reason: string;
  }>;
}

export interface V2AccountExportResult {
  items: V2Account[];
  total: number;
  containsSensitiveFields: false;
  exportedAt: string;
}

export type V2AccountSecretField = 'appleId' | 'password' | 'phone' | 'securityInfo';

export interface V2RevealInput {
  reason: string;
  approvalId?: string | null;
}
