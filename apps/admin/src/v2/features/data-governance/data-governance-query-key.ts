import { createV2QueryKey } from '@/v2/composables/useV2Query';

type DataGovernanceCollection = 'recycle' | 'jobs';

export function createDataGovernanceQueryKey(collection: DataGovernanceCollection, query: object) {
  return `${collection}:${createV2QueryKey(query)}`;
}
