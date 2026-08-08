import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { idBusinessV2AccountsApi } from './api';
import type {
  V2AccountListQuery,
  V2AccountListResult,
  V2OptionSelector,
  V2RecordStatus
} from './contracts';

interface AccountsReferenceOptions {
  countries: V2OptionSelector[];
  statuses: V2OptionSelector[];
  suppliers: V2OptionSelector[];
}

interface AccountsPageSnapshot {
  list: V2AccountListResult;
  options: AccountsReferenceOptions;
}

const ACCOUNTS_OPTIONS_SCOPE = 'accounts-options';
const ACCOUNTS_OPTIONS_KEY = 'selectors';

export type AccountsListQueryDraft = Omit<
  V2AccountListQuery,
  | 'keyword'
  | 'countryOptionId'
  | 'statusOptionId'
  | 'supplierOptionId'
  | 'recordStatus'
  | 'saleState'
> & {
  keyword: string;
  countryOptionId: string;
  statusOptionId: string;
  supplierOptionId: string;
  recordStatus: V2RecordStatus | '';
  saleState: 'available' | 'sold' | '';
};

export function countActiveAccountsFilters(query: AccountsListQueryDraft) {
  return [
    query.keyword.trim(),
    query.countryOptionId,
    query.statusOptionId,
    query.supplierOptionId,
    query.recordStatus,
    query.saleState
  ].filter(Boolean).length;
}

export function resetAccountsListFilters(query: AccountsListQueryDraft) {
  Object.assign(query, {
    keyword: '',
    countryOptionId: '',
    statusOptionId: '',
    supplierOptionId: '',
    recordStatus: '',
    saleState: '',
    page: 1
  });
}

export function normalizeAccountsListQuery(query: AccountsListQueryDraft): V2AccountListQuery {
  return {
    ...query,
    keyword: query.keyword.trim() || undefined,
    countryOptionId: query.countryOptionId || undefined,
    statusOptionId: query.statusOptionId || undefined,
    supplierOptionId: query.supplierOptionId || undefined,
    recordStatus: query.recordStatus || undefined,
    saleState: query.saleState || undefined
  };
}

export function useAccountsListQuery(getParams: () => V2AccountListQuery) {
  return useV2ModuleQuery<AccountsPageSnapshot>({
    moduleKey: 'accounts',
    scope: 'accounts',
    key: () => createV2QueryKey(getParams()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getParams();
      const cachedOptions = getV2QueryData<AccountsReferenceOptions>(
        ACCOUNTS_OPTIONS_SCOPE,
        ACCOUNTS_OPTIONS_KEY,
        {}
      );
      if (cachedOptions) {
        return {
          list: await idBusinessV2AccountsApi.list(params, { signal }),
          options: cachedOptions
        };
      }
      const result = await idBusinessV2AccountsApi.bootstrap(params, { signal });
      primeV2Query({
        scope: ACCOUNTS_OPTIONS_SCOPE,
        key: ACCOUNTS_OPTIONS_KEY,
        data: result.options
      });
      return { list: result.list, options: result.options };
    }
  });
}
