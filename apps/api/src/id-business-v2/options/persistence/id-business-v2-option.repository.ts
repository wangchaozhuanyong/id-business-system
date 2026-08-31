import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildIdBusinessV2EffectiveActivationWhere } from '../../activations/public-api';
import {
  mapAmount4,
  mapOptionalAmount4,
  type V2CommandTransaction
} from '../../runtime/public-api';
import type {
  IdBusinessV2OptionStatus,
  IdBusinessV2OptionType
} from '../id-business-v2-options.constants';
import type { OptionWithRelations } from '../id-business-v2-option-support';
import { buildOptionOrderBy } from '../id-business-v2-option-input';

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

export type OptionPersistenceRow = Prisma.IdBusinessV2OptionGetPayload<{
  include: typeof OPTION_INCLUDE;
}>;

export interface PersistOptionInput {
  name: string;
  uniqueKey: string;
  parentId: string | null;
  countryOptionId: string | null;
  businessAmount: string | null;
  currencyCode: string | null;
  fixedFee: string;
  percentageFee: string;
  sortOrder: number;
  status: IdBusinessV2OptionStatus;
  remark: string | null;
  operatorId?: string;
}

export interface CreateOptionInput extends PersistOptionInput {
  type: IdBusinessV2OptionType;
  code: string;
}

export interface OptionListCriteria {
  type?: IdBusinessV2OptionType;
  status?: IdBusinessV2OptionStatus;
  parentId?: string | null;
  keyword: string | null;
  sortBy?: string;
  sortOrder?: string;
  skip: number;
  take: number;
}

export interface OptionSelectorRow {
  id: string;
  type: IdBusinessV2OptionType;
  code: string;
  name: string;
  status: IdBusinessV2OptionStatus;
  parentId: string | null;
  countryOptionId: string | null;
  businessAmount: import('../../runtime/public-api').Amount4 | null;
  currencyCode: string | null;
  parent: { id: string; name: string } | null;
  countryOption: { id: string; name: string; currencyCode: string | null } | null;
}

export interface OptionDeleteImpact {
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
}

export function mapOptionPersistenceRow(row: OptionPersistenceRow): OptionWithRelations {
  return {
    ...row,
    businessAmount: mapOptionalAmount4(
      row.businessAmount,
      'id_business_v2_options.business_amount'
    ),
    fixedFee: mapAmount4(row.fixedFee, 'id_business_v2_options.fixed_fee'),
    percentageFee: mapAmount4(row.percentageFee, 'id_business_v2_options.percentage_fee')
  };
}

@Injectable()
export class IdBusinessV2OptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const row = await this.prisma.idBusinessV2Option.findFirst({
      where: { id, deletedAt: null },
      include: OPTION_INCLUDE
    });
    return row ? mapOptionPersistenceRow(row) : null;
  }

  async list(criteria: OptionListCriteria) {
    const where: Prisma.IdBusinessV2OptionWhereInput = {
      deletedAt: null,
      type: criteria.type,
      status: criteria.status,
      parentId: criteria.parentId,
      OR: criteria.keyword
        ? [
            { name: { contains: criteria.keyword } },
            { code: { contains: criteria.keyword } },
            { remark: { contains: criteria.keyword } }
          ]
        : undefined
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.findMany({
        where,
        include: OPTION_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: buildOptionOrderBy(criteria.sortBy, criteria.sortOrder)
      }),
      this.prisma.idBusinessV2Option.count({ where })
    ]);
    return { items: rows.map(mapOptionPersistenceRow), total };
  }

  async listDefaultPages(types: IdBusinessV2OptionType[], pageSize: number) {
    const pageQueries = types.map((type) =>
      this.prisma.idBusinessV2Option.findMany({
        where: { type, deletedAt: null },
        include: OPTION_INCLUDE,
        take: pageSize,
        orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }]
      })
    );
    const countQuery = this.prisma.idBusinessV2Option.groupBy({
      by: ['type'],
      where: { deletedAt: null },
      _count: { _all: true }
    });
    const results = await this.prisma.$transaction([...pageQueries, countQuery]);
    const pages = results.slice(0, types.length) as OptionPersistenceRow[][];
    const counts = results.at(-1) as Array<{
      type: IdBusinessV2OptionType;
      _count: { _all: number };
    }>;
    return {
      pages: pages.map((page) => page.map(mapOptionPersistenceRow)),
      countByType: new Map(counts.map((item) => [item.type, item._count._all]))
    };
  }

  async loadBusinessTreeRows() {
    const [countries, categories, services] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'country', status: 'active', deletedAt: null },
        select: { id: true, code: true, name: true, currencyCode: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'business_category',
          status: 'active',
          deletedAt: null,
          parentId: null
        },
        select: { id: true, code: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'service',
          status: 'active',
          deletedAt: null,
          parent: {
            is: { type: 'business_category', status: 'active', deletedAt: null }
          },
          countryOption: { is: { type: 'country', status: 'active', deletedAt: null } }
        },
        select: {
          id: true,
          code: true,
          name: true,
          parentId: true,
          countryOptionId: true,
          businessAmount: true,
          countryOption: { select: { currencyCode: true } }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);
    return {
      countries,
      categories,
      services: services.map((service) => ({
        ...service,
        businessAmount: mapOptionalAmount4(
          service.businessAmount,
          'id_business_v2_options.business_amount'
        )
      }))
    };
  }

  async listSelectors(
    type: IdBusinessV2OptionType,
    parentId: string | null,
    includeDisabled = false
  ) {
    const rows = await this.prisma.idBusinessV2Option.findMany({
      where: {
        type,
        parentId: parentId ?? undefined,
        status: includeDisabled ? undefined : 'active',
        deletedAt: null,
        businessAmount: type === 'service' ? { gt: 0 } : undefined,
        parent:
          type === 'service'
            ? { is: { type: 'business_category', status: 'active', deletedAt: null } }
            : undefined,
        countryOption:
          type === 'service'
            ? {
                is: {
                  type: 'country',
                  status: 'active',
                  deletedAt: null,
                  currencyCode: { not: null }
                }
              }
            : undefined
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true,
        status: true,
        parentId: true,
        countryOptionId: true,
        businessAmount: true,
        currencyCode: true,
        parent: { select: { id: true, name: true } },
        countryOption: { select: { id: true, name: true, currencyCode: true } }
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
    return rows.map<OptionSelectorRow>((row) => ({
      ...row,
      businessAmount: mapOptionalAmount4(
        row.businessAmount,
        'id_business_v2_options.business_amount'
      )
    }));
  }

  async listSelectorGroups(types: readonly IdBusinessV2OptionType[]) {
    const uniqueTypes = [...new Set(types)];
    if (!uniqueTypes.length) return [];

    const rows = await this.prisma.idBusinessV2Option.findMany({
      where: {
        status: 'active',
        deletedAt: null,
        OR: uniqueTypes.map((type) => ({
          type,
          businessAmount: type === 'service' ? { gt: 0 } : undefined,
          parent:
            type === 'service'
              ? { is: { type: 'business_category', status: 'active', deletedAt: null } }
              : undefined,
          countryOption:
            type === 'service'
              ? {
                  is: {
                    type: 'country',
                    status: 'active',
                    deletedAt: null,
                    currencyCode: { not: null }
                  }
                }
              : undefined
        }))
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true,
        status: true,
        parentId: true,
        countryOptionId: true,
        businessAmount: true,
        currencyCode: true,
        parent: { select: { id: true, name: true } },
        countryOption: { select: { id: true, name: true, currencyCode: true } }
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });

    return rows.map<OptionSelectorRow>((row) => ({
      ...row,
      businessAmount: mapOptionalAmount4(
        row.businessAmount,
        'id_business_v2_options.business_amount'
      )
    }));
  }

  async findByIdInTransaction(tx: V2CommandTransaction, id: string) {
    const row = await tx.idBusinessV2Option.findFirst({
      where: { id, deletedAt: null },
      include: OPTION_INCLUDE
    });
    return row ? mapOptionPersistenceRow(row) : null;
  }

  findActiveOption(id: string, type: IdBusinessV2OptionType, tx?: V2CommandTransaction) {
    return (tx ?? this.prisma).idBusinessV2Option.findFirst({
      where: { id, type, status: 'active', deletedAt: null },
      select: { id: true, type: true, code: true, name: true, parentId: true }
    });
  }

  findActiveOptions(ids: string[], type: IdBusinessV2OptionType, tx?: V2CommandTransaction) {
    return (tx ?? this.prisma).idBusinessV2Option.findMany({
      where: { id: { in: ids }, type, status: 'active', deletedAt: null },
      select: { id: true, type: true, code: true, name: true, parentId: true }
    });
  }

  findActiveParent(tx: V2CommandTransaction, id: string, type: IdBusinessV2OptionType) {
    return tx.idBusinessV2Option.findFirst({
      where: { id, type, status: 'active', deletedAt: null },
      select: { id: true, type: true, name: true }
    });
  }

  findActiveCountry(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2Option.findFirst({
      where: { id, type: 'country', status: 'active', deletedAt: null },
      select: { id: true, type: true, code: true, name: true, currencyCode: true }
    });
  }

  findDuplicate(tx: V2CommandTransaction, uniqueKey: string, excludeId?: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        uniqueKey,
        deletedAt: null,
        id: excludeId ? { not: excludeId } : undefined
      },
      select: { id: true }
    });
  }

  async countDependencies(tx: V2CommandTransaction, id: string, activeOnly: boolean) {
    const [childCount, accountCount] = await Promise.all([
      tx.idBusinessV2Option.count({
        where: {
          OR: [{ parentId: id }, { countryOptionId: id }],
          status: activeOnly ? 'active' : undefined,
          deletedAt: null
        }
      }),
      tx.idBusinessV2Account.count({
        where: {
          countryOptionId: id,
          recordStatus: activeOnly ? 'active' : undefined,
          deletedAt: null
        }
      })
    ]);
    return { childCount, accountCount };
  }

  async getDeleteImpact(
    option: Pick<OptionWithRelations, 'id' | 'type'>,
    tx?: V2CommandTransaction
  ): Promise<OptionDeleteImpact> {
    const client = tx ?? this.prisma;
    const dependentServices =
      option.type === 'country' || option.type === 'business_category'
        ? await client.idBusinessV2Option.findMany({
            where: {
              type: 'service',
              deletedAt: null,
              ...(option.type === 'country'
                ? { countryOptionId: option.id }
                : { parentId: option.id })
            },
            select: { id: true }
          })
        : [];
    const affectedServiceIds = [
      ...(option.type === 'service' ? [option.id] : []),
      ...dependentServices.map((service) => service.id)
    ];
    const accountWhere: Prisma.IdBusinessV2AccountWhereInput = {
      deletedAt: null,
      OR: [
        { countryOptionId: option.id },
        { statusOptionId: option.id },
        { supplierOptionId: option.id }
      ]
    };
    const orderWhere: Prisma.IdBusinessV2OrderWhereInput = {
      deletedAt: null,
      OR: [
        ...(affectedServiceIds.length ? [{ serviceOptionId: { in: affectedServiceIds } }] : []),
        { settlementPlatformOptionId: option.id }
      ]
    };
    const activationWhere: Prisma.IdBusinessV2ActivationWhereInput = affectedServiceIds.length
      ? { serviceOptionId: { in: affectedServiceIds } }
      : { id: { in: [] } };
    const customerWhere: Prisma.IdBusinessV2CustomerWhereInput = {
      deletedAt: null,
      OR: [
        { sourceOptionId: option.id },
        { tags: { some: { optionId: option.id } } },
        { services: { some: { optionId: option.id } } }
      ]
    };
    const giftCardWhere: Prisma.IdBusinessV2GiftCardWhereInput = {
      OR: [
        { supplierOptionId: option.id },
        { countryOptionId: option.id },
        { cardNameOptionId: option.id }
      ]
    };
    const [
      accountReferenceCount,
      activeAccountCount,
      customerReferenceCount,
      giftCardReferenceCount,
      orderReferenceCount,
      activeOrderCount,
      activationReferenceCount,
      activeActivationCount,
      supplierWalletCount,
      financeExpenseCount,
      financeInflowCount
    ] = await Promise.all([
      client.idBusinessV2Account.count({ where: accountWhere }),
      client.idBusinessV2Account.count({ where: { ...accountWhere, recordStatus: 'active' } }),
      client.idBusinessV2Customer.count({ where: customerWhere }),
      client.idBusinessV2GiftCard.count({ where: giftCardWhere }),
      client.idBusinessV2Order.count({ where: orderWhere }),
      client.idBusinessV2Order.count({
        where: {
          ...orderWhere,
          status: { in: ['draft', 'pending', 'waiting_external', 'processing'] }
        }
      }),
      client.idBusinessV2Activation.count({ where: activationWhere }),
      client.idBusinessV2Activation.count({
        where: {
          ...activationWhere,
          status: 'active',
          ...buildIdBusinessV2EffectiveActivationWhere()
        }
      }),
      client.idBusinessV2TopupSupplierAccount.count({
        where: { supplierOptionId: option.id }
      }),
      client.idBusinessV2FinanceExpense.count({ where: { categoryOptionId: option.id } }),
      client.idBusinessV2FinanceInflow.count({ where: { categoryOptionId: option.id } })
    ]);
    return {
      dependentServiceCount: dependentServices.length,
      accountReferenceCount,
      activeAccountCount,
      customerReferenceCount,
      giftCardReferenceCount,
      orderReferenceCount,
      activeOrderCount,
      activationReferenceCount,
      activeActivationCount,
      supplierWalletCount,
      financeExpenseCount,
      financeInflowCount
    };
  }

  async create(tx: V2CommandTransaction, input: CreateOptionInput) {
    const row = await tx.idBusinessV2Option.create({
      data: {
        type: input.type,
        code: input.code,
        name: input.name,
        uniqueKey: input.uniqueKey,
        parentId: input.parentId,
        countryOptionId: input.countryOptionId,
        businessAmount: input.businessAmount,
        currencyCode: input.currencyCode,
        fixedFee: input.fixedFee,
        percentageFee: input.percentageFee,
        sortOrder: input.sortOrder,
        status: input.status,
        remark: input.remark,
        createdByUserId: input.operatorId,
        updatedByUserId: input.operatorId
      },
      include: OPTION_INCLUDE
    });
    return mapOptionPersistenceRow(row);
  }

  async update(
    tx: V2CommandTransaction,
    id: string,
    expectedUpdatedAt: Date,
    input: PersistOptionInput
  ) {
    const row = await tx.idBusinessV2Option.update({
      where: { id, updatedAt: expectedUpdatedAt },
      data: {
        name: input.name,
        uniqueKey: input.uniqueKey,
        parentId: input.parentId,
        countryOptionId: input.countryOptionId,
        businessAmount: input.businessAmount,
        currencyCode: input.currencyCode,
        fixedFee: input.fixedFee,
        percentageFee: input.percentageFee,
        sortOrder: input.sortOrder,
        status: input.status,
        remark: input.remark,
        updatedByUserId: input.operatorId
      },
      include: OPTION_INCLUDE
    });
    return mapOptionPersistenceRow(row);
  }

  softDelete(
    tx: V2CommandTransaction,
    input: {
      id: string;
      uniqueKey: string;
      status: 'active' | 'disabled';
      deletedAt: Date;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2Option.update({
      where: { id: input.id },
      data: {
        uniqueKey: `deleted:${input.id}:${input.uniqueKey}`,
        statusBeforeDeletion: input.status,
        deletedAt: input.deletedAt,
        updatedByUserId: input.operatorId
      }
    });
  }

  async softDeleteDependentServices(
    tx: V2CommandTransaction,
    input: {
      optionId: string;
      optionType: IdBusinessV2OptionType;
      deletedAt: Date;
      operatorId?: string;
    }
  ) {
    if (input.optionType !== 'country' && input.optionType !== 'business_category') {
      return [];
    }
    const rows = await tx.idBusinessV2Option.findMany({
      where: {
        type: 'service',
        deletedAt: null,
        ...(input.optionType === 'country'
          ? { countryOptionId: input.optionId }
          : { parentId: input.optionId })
      },
      include: OPTION_INCLUDE,
      orderBy: [{ id: 'asc' }]
    });
    for (const row of rows) {
      await tx.idBusinessV2Option.update({
        where: { id: row.id },
        data: {
          uniqueKey: `deleted:${row.id}:${row.uniqueKey}`,
          statusBeforeDeletion: row.status,
          deletedByParentOptionId: input.optionId,
          status: 'disabled',
          deletedAt: input.deletedAt,
          updatedByUserId: input.operatorId
        }
      });
    }
    return rows.map(mapOptionPersistenceRow);
  }

  disableDependentSupplierWallets(
    tx: V2CommandTransaction,
    input: {
      optionId: string;
      optionType: IdBusinessV2OptionType;
      deletedAt: Date;
      operatorId?: string;
    }
  ) {
    if (input.optionType !== 'topup_supplier') return Promise.resolve({ count: 0 });
    return tx.idBusinessV2TopupSupplierAccount.updateMany({
      where: { supplierOptionId: input.optionId, status: 'active' },
      data: {
        status: 'disabled',
        disabledByOptionDeletionAt: input.deletedAt,
        updatedByUserId: input.operatorId
      }
    });
  }
}
