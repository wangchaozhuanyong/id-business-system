import type { Prisma } from '@prisma/client';
import { toV2DecimalString } from '../decimal-policy';
import { ID_BUSINESS_V2_OPTION_TYPE_MAP } from './id-business-v2-options.constants';

export const OPTION_INCLUDE = {
  parent: {
    select: {
      id: true,
      type: true,
      name: true
    }
  },
  countryOption: {
    select: {
      id: true,
      type: true,
      code: true,
      name: true,
      currencyCode: true
    }
  },
  _count: {
    select: {
      children: {
        where: {
          deletedAt: null
        }
      },
      servicesByCountry: {
        where: {
          deletedAt: null
        }
      },
      accountsByCountry: {
        where: {
          deletedAt: null
        }
      }
    }
  }
} satisfies Prisma.IdBusinessV2OptionInclude;

export type OptionWithRelations = Prisma.IdBusinessV2OptionGetPayload<{
  include: typeof OPTION_INCLUDE;
}>;

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
    businessAmount:
      option.businessAmount === null ? null : toV2DecimalString(option.businessAmount),
    currencyCode:
      option.type === 'service'
        ? (option.countryOption?.currencyCode ?? null)
        : option.currencyCode,
    fixedFee: toV2DecimalString(option.fixedFee),
    percentageFee: toV2DecimalString(option.percentageFee),
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
  return JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
}
