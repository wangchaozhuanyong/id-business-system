import type { IdBusinessV2OptionType, Prisma } from '@prisma/client';
import { TimedMemoryCache } from '../../common/cache/timed-memory-cache';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  ID_BUSINESS_V2_OPTION_TYPES,
  ID_BUSINESS_V2_SYSTEM_STATUS_CODES
} from './id-business-v2-options.constants';
import {
  buildOptionOrderBy,
  normalizeNullableString,
  parseOptionStatus,
  parseOptionType
} from './id-business-v2-option-input';
import {
  OPTION_INCLUDE,
  toOptionResponse,
  type OptionWithRelations
} from './id-business-v2-option-support';

export interface ListIdBusinessV2OptionsQuery extends PaginationQuery {
  keyword?: string;
  type?: string;
  status?: string;
  parentId?: string;
  sortBy?: string;
  sortOrder?: string;
}

const OPTION_SELECTOR_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_OPTION_PAGE_SIZE = 20;

export class IdBusinessV2OptionQuery {
  private readonly selectorCache = new TimedMemoryCache();

  constructor(private readonly prisma: PrismaService) {}

  clearCache() {
    this.selectorCache.clear();
  }

  async list(query: ListIdBusinessV2OptionsQuery) {
    const pagination = getPagination(query);
    const type = parseOptionType(query.type, false);
    const status = parseOptionStatus(query.status, false);
    const keyword = normalizeNullableString(query.keyword);
    const where: Prisma.IdBusinessV2OptionWhereInput = {
      deletedAt: null,
      type: type ?? undefined,
      status: status ?? undefined,
      parentId:
        query.parentId === 'root' ? null : (normalizeNullableString(query.parentId) ?? undefined),
      OR: keyword
        ? [
            { name: { contains: keyword, mode: 'insensitive' } },
            { code: { contains: keyword, mode: 'insensitive' } },
            { remark: { contains: keyword, mode: 'insensitive' } }
          ]
        : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.findMany({
        where,
        include: OPTION_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: buildOptionOrderBy(query.sortBy, query.sortOrder)
      }),
      this.prisma.idBusinessV2Option.count({ where })
    ]);
    return {
      items: items.map(toOptionResponse),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async listDefaultPages() {
    const pageQueries = ID_BUSINESS_V2_OPTION_TYPES.map((definition) =>
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: definition.type,
          deletedAt: null
        },
        include: OPTION_INCLUDE,
        take: DEFAULT_OPTION_PAGE_SIZE,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
      })
    );
    const countQuery = this.prisma.idBusinessV2Option.groupBy({
      by: ['type'],
      where: { deletedAt: null },
      _count: { _all: true }
    });
    const results = await this.prisma.$transaction([...pageQueries, countQuery]);
    const pages = results.slice(0, ID_BUSINESS_V2_OPTION_TYPES.length) as OptionWithRelations[][];
    const counts = results.at(-1) as Array<{
      type: IdBusinessV2OptionType;
      _count: { _all: number };
    }>;
    const countByType = new Map(counts.map((item) => [item.type, item._count._all]));
    return Object.fromEntries(
      ID_BUSINESS_V2_OPTION_TYPES.map((definition, index) => [
        definition.type,
        {
          items: (pages[index] ?? []).map(toOptionResponse),
          total: countByType.get(definition.type) ?? 0,
          page: 1,
          pageSize: DEFAULT_OPTION_PAGE_SIZE
        }
      ])
    ) as Record<
      IdBusinessV2OptionType,
      {
        items: ReturnType<typeof toOptionResponse>[];
        total: number;
        page: number;
        pageSize: number;
      }
    >;
  }

  listTypes() {
    return {
      items: ID_BUSINESS_V2_OPTION_TYPES,
      systemStatusCodes: ID_BUSINESS_V2_SYSTEM_STATUS_CODES
    };
  }

  async listSelectors(typeValue?: string, parentIdValue?: string) {
    const type = parseOptionType(typeValue, true);
    const parentId = normalizeNullableString(parentIdValue);
    return this.selectorCache.getOrSet(
      `${type}:${parentId ?? ''}`,
      OPTION_SELECTOR_CACHE_TTL_MS,
      () => this.listSelectorsUncached(type, parentId)
    );
  }

  async getBusinessTree() {
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
          countryOption: {
            is: { type: 'country', status: 'active', deletedAt: null }
          }
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
      items: countries.map((country) => ({
        ...country,
        children: categories
          .map((category) => ({
            ...category,
            children: services
              .filter(
                (service) =>
                  service.countryOptionId === country.id && service.parentId === category.id
              )
              .map((service) => ({
                id: service.id,
                code: service.code,
                name: service.name,
                businessAmount: service.businessAmount?.toString() ?? '0',
                currencyCode: service.countryOption?.currencyCode ?? null
              }))
          }))
          .filter((category) => category.children.length > 0)
      }))
    };
  }

  private async listSelectorsUncached(type: IdBusinessV2OptionType, parentId: string | null) {
    const items = await this.prisma.idBusinessV2Option.findMany({
      where: {
        type,
        parentId: parentId ?? undefined,
        status: 'active',
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
        parentId: true,
        countryOptionId: true,
        businessAmount: true,
        currencyCode: true,
        parent: { select: { id: true, name: true } },
        countryOption: { select: { id: true, name: true, currencyCode: true } }
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
    return {
      items: items.map((item) => ({
        ...item,
        businessAmount: item.businessAmount?.toString() ?? null,
        currencyCode:
          item.type === 'service' ? (item.countryOption?.currencyCode ?? null) : item.currencyCode,
        country: item.countryOption
      }))
    };
  }
}
