import type {
  CreateV2WorkspaceShortcutInput,
  CreateV2ManagedMailboxInput,
  CreateV2ManagedMailboxResult,
  ReorderV2WorkspaceShortcutsInput,
  UpdateV2ManagedMailboxCredentialInput,
  UpdateV2ManagedMailboxStatusInput,
  UpdateV2WorkspaceShortcutInput,
  V2MailViewerQueryInput,
  V2MailViewerQueryResult,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxListQuery,
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
