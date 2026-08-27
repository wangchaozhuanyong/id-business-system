export type IdBusinessV2OptionType =
  | 'id_status'
  | 'id_region'
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

export type IdBusinessV2OptionStatus = 'active' | 'disabled';

export interface IdBusinessV2OptionTypeDefinition {
  type: IdBusinessV2OptionType;
  label: string;
  parentType: IdBusinessV2OptionType | null;
  supportsFees: boolean;
  supportsCurrency: boolean;
  requiresCountry: boolean;
  supportsBusinessAmount: boolean;
}

export const ID_BUSINESS_V2_OPTION_TYPES: readonly IdBusinessV2OptionTypeDefinition[] = [
  {
    type: 'id_status',
    label: 'ID状态',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'customer_source',
    label: '客户来源',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'customer_tag',
    label: '客户标签',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'country',
    label: '国家',
    parentType: null,
    supportsFees: false,
    supportsCurrency: true,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'business_category',
    label: '业务分类',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'service',
    label: '开通业务',
    parentType: 'business_category',
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: true,
    supportsBusinessAmount: true
  },
  {
    type: 'id_supplier',
    label: 'ID供应商',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'topup_supplier',
    label: '加卡供应商',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'gift_card_name',
    label: '卡片名称',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'settlement_platform',
    label: '结算平台',
    parentType: null,
    supportsFees: true,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'expense_category',
    label: '开支分类',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  },
  {
    type: 'income_category',
    label: '收入分类',
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false
  }
] as const;

export const ID_BUSINESS_V2_OPTION_TYPE_MAP = new Map(
  ID_BUSINESS_V2_OPTION_TYPES.map((definition) => [definition.type, definition])
);

export const ID_BUSINESS_V2_SYSTEM_STATUS_CODES = ['normal', 'frozen'] as const;
