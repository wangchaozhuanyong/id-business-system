import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  V2SensitiveAccessApprovalSummary,
  V2SensitiveAccessContext,
  V2SensitiveAccessPolicy,
  V2SensitiveAccessRequest,
  V2SensitiveAccessRequestList,
  V2SensitiveAccessRequestStatus
} from '@/v2/types/sensitiveAccess';

export interface V2SensitiveAccessRequestQuery extends Partial<V2SensitiveAccessContext> {
  status?: V2SensitiveAccessRequestStatus;
  page?: number;
  pageSize?: number;
}

export const idBusinessV2SensitiveAccessApi = {
  listPolicies(options: ApiRequestOptions = {}) {
    return request<{ items: V2SensitiveAccessPolicy[] }>(
      http.get('/id-business-v2/sensitive-access/policies', { signal: options.signal })
    );
  },
  listMyRequests(params: V2SensitiveAccessRequestQuery, options: ApiRequestOptions = {}) {
    return request<V2SensitiveAccessRequestList>(
      http.get('/id-business-v2/sensitive-access/requests', {
        params,
        signal: options.signal
      })
    );
  },
  createRequest(input: V2SensitiveAccessContext & { reason: string }) {
    return withV2QueryInvalidation(
      request<V2SensitiveAccessRequest>(
        http.post('/id-business-v2/sensitive-access/requests', input)
      ),
      'security'
    );
  },
  getApprovalSummary(options: ApiRequestOptions = {}) {
    return request<V2SensitiveAccessApprovalSummary>(
      http.get('/id-business-v2/sensitive-access/approvals/summary', {
        signal: options.signal
      })
    );
  },
  decide(id: string, decision: 'approved' | 'rejected', decisionNote?: string) {
    return withV2QueryInvalidation(
      request<V2SensitiveAccessRequest>(
        http.patch(`/id-business-v2/sensitive-access/approvals/${id}`, {
          decision,
          decisionNote
        })
      ),
      'security'
    );
  }
};
