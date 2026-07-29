import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { idBusinessV2BalancesApi } from './api';
import type {
  V2OptionSelector,
  V2TopupWorkbenchListQuery,
  V2TopupWorkbenchListResult
} from './contracts';

interface TopupReferenceOptions {
  countries: V2OptionSelector[];
  suppliers: V2OptionSelector[];
}

interface TopupPageSnapshot {
  list: V2TopupWorkbenchListResult;
  options: TopupReferenceOptions;
}

const TOPUP_OPTIONS_SCOPE = 'balances-options';
const TOPUP_OPTIONS_KEY = 'selectors';

export function useTopupListQuery(getParams: () => V2TopupWorkbenchListQuery) {
  return useV2ModuleQuery<TopupPageSnapshot>({
    moduleKey: 'topup-workbench',
    scope: 'balances',
    key: () => createV2QueryKey(getParams()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getParams();
      const cachedOptions = getV2QueryData<TopupReferenceOptions>(
        TOPUP_OPTIONS_SCOPE,
        TOPUP_OPTIONS_KEY,
        {}
      );
      if (cachedOptions) {
        return {
          list: await idBusinessV2BalancesApi.listTopupWorkbench(params, { signal }),
          options: cachedOptions
        };
      }
      const result = await idBusinessV2BalancesApi.bootstrapTopupWorkbench(params, { signal });
      primeV2Query({
        scope: TOPUP_OPTIONS_SCOPE,
        key: TOPUP_OPTIONS_KEY,
        data: result.options
      });
      return { list: result.list, options: result.options };
    }
  });
}
