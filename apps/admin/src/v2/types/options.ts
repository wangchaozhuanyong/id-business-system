export type V2OptionType =
  | 'id_status'
  | 'customer_source'
  | 'customer_tag'
  | 'country'
  | 'business_category'
  | 'service'
  | 'id_supplier'
  | 'topup_supplier'
  | 'gift_card_name'
  | 'settlement_platform'
  | 'expense_category'
  | 'income_category';

export type V2OptionStatus = 'active' | 'disabled';

export interface V2OptionTypeDefinition {
  type: V2OptionType;
  label: string;
  parentType: V2OptionType | null;
  supportsFees: boolean;
  supportsCurrency: boolean;
  requiresCountry: boolean;
  supportsBusinessAmount: boolean;
}

export interface V2OptionParent {
  id: string;
  type: V2OptionType;
  name: string;
}

export interface V2OptionCountry {
  id: string;
  type: 'country';
  code: string;
  name: string;
  currencyCode: string | null;
}

export interface V2Option {
  id: string;
  type: V2OptionType;
  typeLabel: string;
  code: string;
  name: string;
  parentId: string | null;
  parent: V2OptionParent | null;
  countryOptionId: string | null;
  country: V2OptionCountry | null;
  businessAmount: string | null;
  currencyCode: string | null;
  fixedFee: string;
  percentageFee: string;
  sortOrder: number;
  status: V2OptionStatus;
  isSystem: boolean;
  remark: string | null;
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface V2OptionDeletePreview {
  entityId: string;
  entityName: string;
  entityType: V2OptionType;
  canDelete: boolean;
  blockingReasons: string[];
  impact: {
    dependentServiceCount: number;
    accountReferenceCount: number;
    activeAccountCount: number;
    customerReferenceCount: number;
    giftCardReferenceCount: number;
    orderReferenceCount: number;
    activeOrderCount: number;
    activationReferenceCount: number;
    activeActivationCount: number;
    supplierWalletCount: number;
    financeExpenseCount: number;
    financeInflowCount: number;
  };
  fingerprint: string;
}

export interface V2OptionSelector {
  id: string;
  type: V2OptionType;
  code: string;
  name: string;
  status?: V2OptionStatus;
  parentId: string | null;
  parent: Pick<V2OptionParent, 'id' | 'name'> | null;
  countryOptionId: string | null;
  country: Pick<V2OptionCountry, 'id' | 'name' | 'currencyCode'> | null;
  businessAmount: string | null;
  currencyCode: string | null;
}

export type V2OptionListResult = PaginatedResult<V2Option>;

export interface V2OptionTypesResult {
  items: V2OptionTypeDefinition[];
  systemStatusCodes: string[];
}

export type V2OptionListsByType = Record<V2OptionType, V2OptionListResult>;

export interface V2OptionBootstrapResult {
  types: V2OptionTypesResult;
  list: V2OptionListResult;
  listsByType: V2OptionListsByType;
  generatedAt: string;
}

export interface V2OptionListQuery extends V2PageQuery {
  keyword?: string;
  type?: V2OptionType;
  status?: V2OptionStatus | '';
  parentId?: string;
  sortBy?: 'name' | 'sortOrder' | 'status' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateV2OptionInput {
  type: V2OptionType;
  name: string;
  parentId?: string | null;
  countryOptionId?: string | null;
  businessAmount?: string | number | null;
  currencyCode?: string | null;
  fixedFee?: string | number;
  percentageFee?: string | number;
  sortOrder?: number;
  status?: V2OptionStatus;
  remark?: string | null;
}

export type UpdateV2OptionInput = Omit<CreateV2OptionInput, 'type'> & {
  expectedUpdatedAt: string;
};
import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';
