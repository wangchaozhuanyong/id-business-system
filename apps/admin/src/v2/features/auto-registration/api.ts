import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  AutoRegistrationStatus,
  AutoRegistrationWorkspaceSession,
  AppleMailboxListQuery,
  AppleMailboxPageResult,
  AppleMailboxMarkInput,
  AppleMailboxTarget,
  AppleMailboxTask,
  AppleMailboxRecord
} from './contracts';

const base = '/id-business-v2/auto-registration';

export const autoRegistrationApi = {
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
    return request<{ updated: number }>(http.post(`${base}/apple-mailboxes/mark`, input));
  },
  startAppleMailbox(input: AppleMailboxTarget) {
    return request<{ taskUuid: string; record: AppleMailboxRecord }>(
      http.post(`${base}/apple-mailboxes/start`, input)
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
