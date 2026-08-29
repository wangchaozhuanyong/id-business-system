import type {
  CreateV2SavedTotpAccountInput,
  CreateV2ManagedMailboxBatchInput,
  CreateV2ManagedMailboxBatchResult,
  CreateV2WorkspaceShortcutInput,
  CreateV2ManagedMailboxInput,
  CreateV2ManagedMailboxResult,
  ReorderV2WorkspaceShortcutsInput,
  StartV2MicrosoftMailboxAuthorizationInput,
  StartV2MicrosoftMailboxAuthorizationResult,
  UpdateV2ManagedMailboxCredentialInput,
  UpdateV2ManagedMailboxStatusInput,
  UpdateV2SavedTotpAccountInput,
  UpdateV2WorkspaceShortcutInput,
  V2MailViewerQueryInput,
  V2MailViewerQueryResult,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxListQuery,
  V2MicrosoftMailboxAuthorizationStatus,
  V2SavedTotpAccount,
  V2SavedTotpAccountList,
  V2WorkspaceShortcut,
  V2WorkspaceShortcutList
} from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';

export const idBusinessV2WorkspaceApi = {
  list(options: ApiRequestOptions = {}) {
    return request<V2WorkspaceShortcutList>(
      http.get('/id-business-v2/workspace-shortcuts', { signal: options.signal })
    );
  },
  create(input: CreateV2WorkspaceShortcutInput) {
    return request<V2WorkspaceShortcut>(http.post('/id-business-v2/workspace-shortcuts', input));
  },
  update(shortcutId: string, input: UpdateV2WorkspaceShortcutInput) {
    return request<V2WorkspaceShortcut>(
      http.patch(`/id-business-v2/workspace-shortcuts/${encodeURIComponent(shortcutId)}`, input)
    );
  },
  remove(shortcutId: string) {
    return request<{ id: string; deleted: true }>(
      http.delete(`/id-business-v2/workspace-shortcuts/${encodeURIComponent(shortcutId)}`)
    );
  },
  reorder(input: ReorderV2WorkspaceShortcutsInput) {
    return request<V2WorkspaceShortcutList>(
      http.put('/id-business-v2/workspace-shortcuts/order', input)
    );
  },
  listTotpAccounts(options: ApiRequestOptions = {}) {
    return request<V2SavedTotpAccountList>(
      http.get('/id-business-v2/workspace-totp-accounts', { signal: options.signal })
    );
  },
  createTotpAccount(input: CreateV2SavedTotpAccountInput) {
    return request<V2SavedTotpAccount>(http.post('/id-business-v2/workspace-totp-accounts', input));
  },
  updateTotpAccount(accountId: string, input: UpdateV2SavedTotpAccountInput) {
    return request<V2SavedTotpAccount>(
      http.put(`/id-business-v2/workspace-totp-accounts/${encodeURIComponent(accountId)}`, input)
    );
  },
  removeTotpAccount(accountId: string) {
    return request<{ id: string; deleted: true }>(
      http.delete(`/id-business-v2/workspace-totp-accounts/${encodeURIComponent(accountId)}`)
    );
  },
  listManagedMailboxes(query: V2ManagedMailboxListQuery, options: ApiRequestOptions = {}) {
    return request<V2ManagedMailboxList>(
      http.get('/id-business-v2/workspace-mailboxes', { params: query, signal: options.signal })
    );
  },
  createManagedMailbox(input: CreateV2ManagedMailboxInput) {
    return request<CreateV2ManagedMailboxResult>(
      http.post('/id-business-v2/workspace-mailboxes', input)
    );
  },
  createManagedMailboxBatch(input: CreateV2ManagedMailboxBatchInput) {
    return request<CreateV2ManagedMailboxBatchResult>(
      http.post('/id-business-v2/workspace-mailboxes/batch', input)
    );
  },
  startMicrosoftMailboxAuthorization(input: StartV2MicrosoftMailboxAuthorizationInput) {
    return request<StartV2MicrosoftMailboxAuthorizationResult>(
      http.post('/id-business-v2/workspace-mailboxes/microsoft/authorizations', input)
    );
  },
  getMicrosoftMailboxAuthorizationStatus(authorizationId: string) {
    return request<V2MicrosoftMailboxAuthorizationStatus>(
      http.get(
        `/id-business-v2/workspace-mailboxes/microsoft/authorizations/${encodeURIComponent(authorizationId)}`
      )
    );
  },
  updateManagedMailboxStatus(mailboxId: string, input: UpdateV2ManagedMailboxStatusInput) {
    return request<V2ManagedMailbox>(
      http.patch(
        `/id-business-v2/workspace-mailboxes/${encodeURIComponent(mailboxId)}/status`,
        input
      )
    );
  },
  updateManagedMailboxCredential(mailboxId: string, input: UpdateV2ManagedMailboxCredentialInput) {
    return request<V2ManagedMailbox>(
      http.put(
        `/id-business-v2/workspace-mailboxes/${encodeURIComponent(mailboxId)}/credential`,
        input
      )
    );
  },
  rotateManagedMailboxQueryCode(mailboxId: string) {
    return request<CreateV2ManagedMailboxResult>(
      http.post(`/id-business-v2/workspace-mailboxes/${encodeURIComponent(mailboxId)}/query-code`)
    );
  }
};

export const idBusinessV2PublicMailboxApi = {
  query(input: V2MailViewerQueryInput, options: ApiRequestOptions = {}) {
    return request<V2MailViewerQueryResult>(
      http.post('/public/mailbox/query', input, {
        signal: options.signal
      })
    );
  }
};
