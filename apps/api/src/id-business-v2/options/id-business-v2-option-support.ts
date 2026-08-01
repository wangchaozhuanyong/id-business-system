import type { Amount4 } from '../runtime/public-api';
import { toV2JsonDocument } from '../runtime/public-api';
import type {
  IdBusinessV2OptionStatus,
  IdBusinessV2OptionType
} from './id-business-v2-options.constants';
import { ID_BUSINESS_V2_OPTION_TYPE_MAP } from './id-business-v2-options.constants';

export interface OptionWithRelations {
  id: string;
  type: IdBusinessV2OptionType;
  code: string;
  name: string;
  uniqueKey: string;
  parentId: string | null;
  countryOptionId: string | null;
  businessAmount: Amount4 | null;
  currencyCode: string | null;
  fixedFee: Amount4;
  percentageFee: Amount4;
  sortOrder: number;
  status: IdBusinessV2OptionStatus;
  isSystem: boolean;
  remark: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  parent: { id: string; type: IdBusinessV2OptionType; name: string } | null;
  countryOption: {
    id: string;
    type: IdBusinessV2OptionType;
    code: string;
    name: string;
    currencyCode: string | null;
  } | null;
  _count: { children: number; servicesByCountry: number; accountsByCountry: number };
}

export function toOptionResponse(option: OptionWithRelations) {
  const typeDefinition = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(option.type);
  return {
    id: option.id,
    type: option.type,
    typeLabel: typeDefinition?.label ?? option.type,
    code: option.code,
    name: option.name,
    parentId: option.parentId,
    parent: option.parent,
    countryOptionId: option.countryOptionId,
    country: option.countryOption,
    businessAmount: option.businessAmount?.toString() ?? null,
    currencyCode:
      option.type === 'service'
        ? (option.countryOption?.currencyCode ?? null)
        : option.currencyCode,
    fixedFee: option.fixedFee.toString(),
    percentageFee: option.percentageFee.toString(),
    sortOrder: option.sortOrder,
    status: option.status,
    isSystem: option.isSystem,
    remark: option.remark,
    childCount:
      option._count.children + option._count.servicesByCountry + option._count.accountsByCountry,
    createdAt: option.createdAt.toISOString(),
    updatedAt: option.updatedAt.toISOString()
  };
}

export function toOptionAuditJson(data: unknown) {
  return toV2JsonDocument(data);
}
