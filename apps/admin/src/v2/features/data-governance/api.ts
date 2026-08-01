import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  V2GovernanceCleanupPreviewInput,
  V2GovernanceExecutionResult,
  V2GovernanceJob,
  V2GovernanceJobDetail,
  V2GovernanceJobList,
  V2GovernanceJobQuery,
  V2GovernanceOverview,
  V2GovernanceRecycleList,
  V2GovernanceRecycleQuery,
  V2GovernanceRestorePreviewInput
} from './contracts';

export const v2DataGovernanceApi = {
  overview(options: ApiRequestOptions = {}) {
    return request<V2GovernanceOverview>(
      http.get('/id-business-v2/data-governance/overview', { signal: options.signal })
    );
  },
  recycleBin(params: V2GovernanceRecycleQuery, options: ApiRequestOptions = {}) {
    return request<V2GovernanceRecycleList>(
      http.get('/id-business-v2/data-governance/recycle-bin', {
        params,
        signal: options.signal
      })
    );
  },
  jobs(params: V2GovernanceJobQuery, options: ApiRequestOptions = {}) {
    return request<V2GovernanceJobList>(
      http.get('/id-business-v2/data-governance/jobs', { params, signal: options.signal })
    );
  },
  job(id: string, options: ApiRequestOptions = {}) {
    return request<V2GovernanceJobDetail>(
      http.get(`/id-business-v2/data-governance/jobs/${id}`, { signal: options.signal })
    );
  },
  previewRestore(input: V2GovernanceRestorePreviewInput) {
    return request<V2GovernanceJob>(
      http.post('/id-business-v2/data-governance/restore-jobs/preview', input)
    );
  },
  previewCleanup(input: V2GovernanceCleanupPreviewInput) {
    return request<V2GovernanceJob>(
      http.post('/id-business-v2/data-governance/cleanup-jobs/preview', input)
    );
  },
  decide(id: string, input: { decision: 'approved' | 'rejected'; reason: string }) {
    return request<V2GovernanceJobDetail>(
      http.post(`/id-business-v2/data-governance/jobs/${id}/decision`, input)
    );
  },
  execute(id: string, input: { batchSize: number; idempotencyKey: string }) {
    return request<V2GovernanceExecutionResult>(
      http.post(`/id-business-v2/data-governance/jobs/${id}/execute`, input)
    );
  }
};
