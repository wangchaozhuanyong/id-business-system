import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  AutoRegistrationStatus,
  AutoRegistrationWorkspaceSession,
  AppleMailboxListQuery,
  AppleMailboxPageResult,
  AppleMailboxMarkInput,
  AppleMailboxTarget,
  AppleMailboxTask,
  AppleMailboxRecord,
  AppleMailboxStartInput,
  AppleMailboxBatchInput,
  AppleMailboxBatch,
  AppleMailboxConsoleOptions,
  AppleMailboxSyncStatus,
  AppleMailboxManualSyncPreview,
  AppleMailboxManualSyncResult
} from './contracts';

const base = '/id-business-v2/auto-registration';

export const autoRegistrationApi = {
  resumeAppleMailboxTasks(options: ApiRequestOptions = {}) {
    return request<{ resumed: number; synchronized: number }>(
      http.post(`${base}/apple-mailboxes/resume`, {}, { signal: options.signal })
    );
  },
  status(options: ApiRequestOptions = {}) {
    return request<AutoRegistrationStatus>(http.get(`${base}/status`, { signal: options.signal }));
  },
  workspaceSession(options: ApiRequestOptions = {}) {
    return request<AutoRegistrationWorkspaceSession>(
      http.post(`${base}/workspace-session`, {}, { signal: options.signal })
    );
  },
  appleMailboxes(query: AppleMailboxListQuery, options: ApiRequestOptions = {}) {
    return request<AppleMailboxPageResult>(
      http.get(`${base}/apple-mailboxes`, {
        params: query,
        signal: options.signal
      })
    );
  },
  markAppleMailboxes(input: AppleMailboxMarkInput) {
    return request<{ updated: number; synchronization?: AppleMailboxManualSyncResult }>(
      http.post(`${base}/apple-mailboxes/mark`, input)
    );
  },
  previewManualMailboxSync(items: AppleMailboxTarget[], options: ApiRequestOptions = {}) {
    return request<AppleMailboxManualSyncPreview>(
      http.post(
        `${base}/apple-mailboxes/manual-sync-preview`,
        { items },
        { signal: options.signal }
      )
    );
  },
  syncManualMailboxes(items: AppleMailboxTarget[]) {
    return request<AppleMailboxManualSyncResult>(
      http.post(`${base}/apple-mailboxes/manual-sync`, { items })
    );
  },
  appleMailboxCandidates(options: ApiRequestOptions = {}) {
    return request<AppleMailboxConsoleOptions>(
      http.get(`${base}/apple-mailboxes/candidates`, { signal: options.signal })
    );
  },
  startAppleMailbox(input: AppleMailboxStartInput) {
    return request<{ taskUuid: string; record: AppleMailboxRecord }>(
      http.post(`${base}/apple-mailboxes/start`, input)
    );
  },
  startAppleMailboxBatch(input: AppleMailboxBatchInput) {
    return request<AppleMailboxBatch>(http.post(`${base}/apple-mailboxes/batch`, input));
  },
  appleMailboxBatch(batchId: string, options: ApiRequestOptions = {}) {
    return request<AppleMailboxBatch>(
      http.get(`${base}/apple-mailboxes/batches/${encodeURIComponent(batchId)}`, {
        signal: options.signal
      })
    );
  },
  cancelAppleMailboxBatch(batchId: string) {
    return request<{ accepted: true }>(
      http.post(`${base}/apple-mailboxes/batches/${encodeURIComponent(batchId)}/cancel`)
    );
  },
  syncAppleMailboxTask(taskUuid: string) {
    return request<{ accountId: string | null; syncStatus: AppleMailboxSyncStatus }>(
      http.post(`${base}/apple-mailboxes/tasks/${encodeURIComponent(taskUuid)}/sync`)
    );
  },
  resumeAppleMailboxAuthorization(taskUuid: string) {
    return request<{ taskUuid: string; record: AppleMailboxRecord; task: AppleMailboxTask }>(
      http.post(
        `${base}/apple-mailboxes/tasks/${encodeURIComponent(taskUuid)}/authorization-resume`
      )
    );
  },
  saveAppleMailboxLocalAccount(taskUuid: string) {
    return request<{ localSaveStatus: 'saved' | 'failed' }>(
      http.post(`${base}/apple-mailboxes/tasks/${encodeURIComponent(taskUuid)}/local-save`)
    );
  },
  appleMailboxTask(taskUuid: string, options: ApiRequestOptions = {}) {
    return request<AppleMailboxTask>(
      http.get(`${base}/apple-mailboxes/tasks/${encodeURIComponent(taskUuid)}`, {
        signal: options.signal
      })
    );
  },
  cancelAppleMailboxTask(taskUuid: string) {
    return request<{ accepted: true }>(
      http.post(`${base}/apple-mailboxes/tasks/${encodeURIComponent(taskUuid)}/cancel`)
    );
  },
  recoverAppleMailbox(input: AppleMailboxTarget) {
    return request<AppleMailboxRecord>(http.post(`${base}/apple-mailboxes/recover`, input));
  }
};
