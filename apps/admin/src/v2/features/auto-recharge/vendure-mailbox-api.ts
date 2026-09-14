import type {
  BatchCreateV2VendureMailboxAliasesInput,
  CreateV2VendureMailboxAliasInput,
  CreateV2VendureMailboxPrimaryInput,
  UpdateV2VendureMailboxAliasInput,
  UpdateV2VendureMailboxPrimaryInput,
  V2VendureMailboxAlias,
  V2VendureMailboxBatchResult,
  V2VendureMailboxConnectionResult,
  V2VendureMailboxHistoryResult,
  V2VendureMailboxListQuery,
  V2VendureMailboxMail,
  V2VendureMailboxPage,
  V2VendureMailboxPrimaryAccount,
  V2VendureMailboxStatus,
  V2VendureMailboxSyncResult
} from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';

const base = '/id-business-v2/vendure-mailboxes';

export const vendureMailboxApi = {
  status(options: ApiRequestOptions = {}) {
    return request<V2VendureMailboxStatus>(http.get(`${base}/status`, { signal: options.signal }));
  },
  primaryAccounts(query: V2VendureMailboxListQuery, options: ApiRequestOptions = {}) {
    return request<V2VendureMailboxPage<V2VendureMailboxPrimaryAccount>>(
      http.get(`${base}/primary-accounts`, { params: query, signal: options.signal })
    );
  },
  aliases(query: V2VendureMailboxListQuery, options: ApiRequestOptions = {}) {
    return request<V2VendureMailboxPage<V2VendureMailboxAlias>>(
      http.get(`${base}/aliases`, { params: query, signal: options.signal })
    );
  },
  mails(query: V2VendureMailboxListQuery, options: ApiRequestOptions = {}) {
    return request<V2VendureMailboxPage<V2VendureMailboxMail>>(
      http.get(`${base}/mails`, { params: query, signal: options.signal })
    );
  },
  createPrimary(input: CreateV2VendureMailboxPrimaryInput) {
    return request<V2VendureMailboxPrimaryAccount>(http.post(`${base}/primary-accounts`, input));
  },
  updatePrimary(id: string, input: UpdateV2VendureMailboxPrimaryInput) {
    return request<V2VendureMailboxPrimaryAccount>(
      http.patch(`${base}/primary-accounts/${id}`, input)
    );
  },
  deletePrimary(id: string) {
    return request<{ deleted: boolean }>(http.delete(`${base}/primary-accounts/${id}`));
  },
  testPrimary(id: string) {
    return request<V2VendureMailboxConnectionResult>(
      http.post(`${base}/primary-accounts/${id}/test`)
    );
  },
  syncPrimary(id: string) {
    return request<V2VendureMailboxSyncResult>(http.post(`${base}/primary-accounts/${id}/sync`));
  },
  resetPrimaryCode(id: string) {
    return request<V2VendureMailboxPrimaryAccount>(
      http.post(`${base}/primary-accounts/${id}/reset-code`)
    );
  },
  reconcile(id: string, dryRun: boolean) {
    return request<V2VendureMailboxHistoryResult>(
      http.post(`${base}/primary-accounts/${id}/reconcile`, { dryRun })
    );
  },
  createAlias(input: CreateV2VendureMailboxAliasInput) {
    return request<V2VendureMailboxAlias>(http.post(`${base}/aliases`, input));
  },
  batchCreateAliases(input: BatchCreateV2VendureMailboxAliasesInput) {
    return request<V2VendureMailboxBatchResult>(http.post(`${base}/aliases/batch`, input));
  },
  updateAlias(id: string, input: UpdateV2VendureMailboxAliasInput) {
    return request<V2VendureMailboxAlias>(http.patch(`${base}/aliases/${id}`, input));
  },
  deleteAlias(id: string) {
    return request<{ deleted: boolean }>(http.delete(`${base}/aliases/${id}`));
  },
  resetAliasCode(id: string) {
    return request<V2VendureMailboxAlias>(http.post(`${base}/aliases/${id}/reset-code`));
  },
  reassignMail(id: string, virtualEmailId: string) {
    return request<V2VendureMailboxMail>(
      http.post(`${base}/mails/${id}/reassign`, { virtualEmailId })
    );
  },
  deleteMail(id: string) {
    return request<{ deleted: boolean }>(http.delete(`${base}/mails/${id}`));
  }
};
