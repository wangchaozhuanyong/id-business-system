import type { ComputedRef, InjectionKey } from 'vue';

export const V2_ASYNC_REGION_PREVIOUS_DATA: InjectionKey<ComputedRef<boolean>> = Symbol(
  'V2AsyncRegionPreviousData'
);
