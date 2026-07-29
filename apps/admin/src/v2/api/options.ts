import { http, request, type ApiRequestOptions } from '@/api/client';
import {
  fetchV2Query,
  invalidateV2Queries,
  primeV2Query,
  type V2QueryContext
} from '@/v2/composables/useV2Query';
import type {
  CreateV2OptionInput,
  UpdateV2OptionInput,
  V2Option,
  V2OptionBootstrapResult,
  V2OptionListQuery,
  V2OptionListResult,
  V2OptionSelector,
  V2OptionType,
  V2OptionTypesResult
} from '@/v2/types/options';

interface V2OptionListRequestOptions extends ApiRequestOptions {
  force?: boolean;
  useSharedCache?: boolean;
}

export const idBusinessV2OptionsApi = {
  list(params: V2OptionListQuery, options: V2OptionListRequestOptions = {}) {
    if (options.useSharedCache === false) {
      return request<V2OptionListResult>(
        http.get('/id-business-v2/options', {
          params,
          signal: options.signal
        })
      );
    }
    return fetchV2Query(
      {
        scope: 'options',
        key: getOptionListCacheKey(params),
        tier: 'reference',
        query: ({ signal }: V2QueryContext) =>
          request<V2OptionListResult>(
            http.get('/id-business-v2/options', {
              params,
              signal
            })
          )
      },
      { force: options.force }
    );
  },
  async bootstrap(params: V2OptionListQuery, options: ApiRequestOptions = {}) {
    const result = await request<V2OptionBootstrapResult>(
      http.get('/id-business-v2/options/bootstrap', {
        params,
        signal: options.signal
      })
    );
    const updatedAt = Date.now();
    primeV2Query({
      scope: 'options-reference',
      key: 'types',
      data: result.types,
      updatedAt
    });
    for (const definition of result.types.items) {
      primeV2Query({
        scope: 'options',
        key: getOptionListCacheKey(getDefaultOptionListQuery(definition.type)),
        data: result.listsByType[definition.type],
        updatedAt
      });
    }
    primeV2Query({
      scope: 'options',
      key: getOptionListCacheKey(params),
      data: result.list,
      updatedAt
    });
    return result;
  },
  listTypes() {
    return fetchV2Query({
      scope: 'options-reference',
      key: 'types',
      tier: 'reference',
      query: ({ signal }: V2QueryContext) =>
        request<V2OptionTypesResult>(http.get('/id-business-v2/options/types', { signal }))
    });
  },
  listSelectors(type: V2OptionType, parentId?: string) {
    return fetchV2Query({
      scope: 'options-reference',
      key: `selectors:${type}:${parentId ?? ''}`,
      tier: 'reference',
      query: ({ signal }: V2QueryContext) =>
        request<{ items: V2OptionSelector[] }>(
          http.get('/id-business-v2/options/selectors', {
            params: {
              type,
              parentId
            },
            signal
          })
        )
    });
  },
  async create(payload: CreateV2OptionInput) {
    const result = await request<V2Option>(http.post('/id-business-v2/options', payload));
    invalidateV2Queries(OPTION_MUTATION_SCOPES);
    return result;
  },
  async update(id: string, payload: UpdateV2OptionInput) {
    const result = await request<V2Option>(http.patch(`/id-business-v2/options/${id}`, payload));
    invalidateV2Queries(OPTION_MUTATION_SCOPES);
    return result;
  },
  async remove(id: string) {
    const result = await request<{ deleted: true }>(http.delete(`/id-business-v2/options/${id}`));
    invalidateV2Queries(OPTION_MUTATION_SCOPES);
    return result;
  }
};

const OPTION_MUTATION_SCOPES = [
  'options',
  'options-reference',
  'order-entry-options',
  'accounts',
  'customers',
  'orders',
  'balances',
  'balance-records',
  'renewals',
  'orders-options',
  'renewals-options',
  'accounts-options',
  'customers-options',
  'balances-options',
  'balance-record-options',
  'options-page',
  'order-entry-matching'
];

const DEFAULT_OPTION_PAGE_SIZE = 20;

function getDefaultOptionListQuery(type: V2OptionType): V2OptionListQuery {
  return {
    page: 1,
    pageSize: DEFAULT_OPTION_PAGE_SIZE,
    type,
    status: '',
    sortBy: 'sortOrder',
    sortOrder: 'asc'
  };
}

function getOptionListCacheKey(params: V2OptionListQuery) {
  return JSON.stringify({
    page: params.page ?? 1,
    pageSize: params.pageSize ?? DEFAULT_OPTION_PAGE_SIZE,
    keyword: params.keyword?.trim() ?? '',
    type: params.type ?? '',
    status: params.status ?? '',
    parentId: params.parentId ?? '',
    sortBy: params.sortBy ?? '',
    sortOrder: params.sortOrder ?? ''
  });
}
