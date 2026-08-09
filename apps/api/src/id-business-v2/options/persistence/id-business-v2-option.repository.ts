import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
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
            { name: { contains: criteria.keyword, mode: 'insensitive' } },
            { code: { contains: criteria.keyword, mode: 'insensitive' } },
            { remark: { contains: criteria.keyword, mode: 'insensitive' } }
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

  async update(tx: V2CommandTransaction, id: string, input: PersistOptionInput) {
    const row = await tx.idBusinessV2Option.update({
      where: { id },
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
    input: { id: string; uniqueKey: string; deletedAt: Date; operatorId?: string }
  ) {
    return tx.idBusinessV2Option.update({
      where: { id: input.id },
      data: {
        uniqueKey: `deleted:${input.id}:${input.uniqueKey}`,
        deletedAt: input.deletedAt,
        updatedByUserId: input.operatorId
      }
    });
  }

  softDeleteDependentServices(
    tx: V2CommandTransaction,
    input: {
      optionId: string;
      optionType: IdBusinessV2OptionType;
      deletedAt: Date;
      operatorId?: string;
    }
  ) {
    if (input.optionType !== 'country' && input.optionType !== 'business_category') {
      return Promise.resolve({ count: 0 });
    }
    return tx.idBusinessV2Option.updateMany({
      where: {
        type: 'service',
        deletedAt: null,
        ...(input.optionType === 'country'
          ? { countryOptionId: input.optionId }
          : { parentId: input.optionId })
      },
      data: {
        status: 'disabled',
        deletedAt: input.deletedAt,
        updatedByUserId: input.operatorId
      }
    });
  }

  disableDependentSupplierWallets(
    tx: V2CommandTransaction,
    input: { optionId: string; optionType: IdBusinessV2OptionType; operatorId?: string }
  ) {
    if (input.optionType !== 'topup_supplier') return Promise.resolve({ count: 0 });
    return tx.idBusinessV2TopupSupplierAccount.updateMany({
      where: { supplierOptionId: input.optionId, status: 'active' },
      data: { status: 'disabled', updatedByUserId: input.operatorId }
    });
  }
}
