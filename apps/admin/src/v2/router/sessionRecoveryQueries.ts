import { V2_DATA_SCOPES } from '@apple-business/shared';
import { invalidateV2Queries } from '@/v2/composables/useV2Query';

export function invalidateV2SessionRecoveryQueries() {
  invalidateV2Queries(V2_DATA_SCOPES);
}
