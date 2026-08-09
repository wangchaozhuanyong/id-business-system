import { Injectable } from '@nestjs/common';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  ID_BUSINESS_V2_OPTION_TYPES,
  ID_BUSINESS_V2_SYSTEM_STATUS_CODES,
  type IdBusinessV2OptionType
} from './id-business-v2-options.constants';
import {
  normalizeNullableString,
  parseOptionStatus,
  parseOptionType
} from './id-business-v2-option-input';
import { toOptionResponse } from './id-business-v2-option-support';
import { IdBusinessV2OptionRepository } from './persistence/id-business-v2-option.repository';
import type { OptionSelectorRow } from './persistence/id-business-v2-option.repository';

export interface ListIdBusinessV2OptionsQuery extends PaginationQuery {
  keyword?: string;
  type?: string;
  status?: string;
  parentId?: string;
  sortBy?: string;
  sortOrder?: string;
}

const DEFAULT_OPTION_PAGE_SIZE = 20;

@Injectable()
export class IdBusinessV2OptionQuery {
  constructor(private readonly repository: IdBusinessV2OptionRepository) {}

  async list(query: ListIdBusinessV2OptionsQuery) {
    const pagination = getPagination(query);
    const type = parseOptionType(query.type, false);
    const status = parseOptionStatus(query.status, false);
    const keyword = normalizeNullableString(query.keyword);
    const result = await this.repository.list({
      type,
      status,
      parentId:
        query.parentId === 'root' ? null : (normalizeNullableString(query.parentId) ?? undefined),
      keyword,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      skip: pagination.skip,
      take: pagination.take
    });
    return {
      items: result.items.map(toOptionResponse),
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async listDefaultPages() {
    const types = ID_BUSINESS_V2_OPTION_TYPES.map((definition) => definition.type);
    const result = await this.repository.listDefaultPages(types, DEFAULT_OPTION_PAGE_SIZE);
    return Object.fromEntries(
      ID_BUSINESS_V2_OPTION_TYPES.map((definition, index) => [
        definition.type,
        {
          items: (result.pages[index] ?? []).map(toOptionResponse),
          total: result.countByType.get(definition.type) ?? 0,
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
    if (!parentId) {
      const groups = await this.listSelectorGroups([type]);
      return groups[type];
    }
    return this.listSelectorsUncached(type, parentId);
  }

  async listSelectorGroups<T extends IdBusinessV2OptionType>(
    typeValues: readonly T[]
  ): Promise<Record<T, { items: ReturnType<IdBusinessV2OptionQuery['mapSelector']>[] }>> {
    const types = [...new Set(typeValues.map((value) => parseOptionType(value, true)))] as T[];
    const rows = await this.repository.listSelectorGroups(types);
    const groups = {} as Record<T, { items: ReturnType<IdBusinessV2OptionQuery['mapSelector']>[] }>;
    for (const type of types) groups[type] = { items: [] };
    for (const row of rows) {
      if (row.type in groups) groups[row.type as T].items.push(this.mapSelector(row));
    }
    return groups;
  }

  async getBusinessTree() {
    const { countries, categories, services } = await this.repository.loadBusinessTreeRows();
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
    const items = await this.repository.listSelectors(type, parentId);
    return {
      items: items.map((item) => this.mapSelector(item))
    };
  }

  private mapSelector(item: OptionSelectorRow) {
    return {
      ...item,
      businessAmount: item.businessAmount?.toString() ?? null,
      currencyCode:
        item.type === 'service' ? (item.countryOption?.currencyCode ?? null) : item.currencyCode,
      country: item.countryOption
    };
  }
}
