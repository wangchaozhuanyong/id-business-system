import type {
  CreateV2SavedTotpAccountInput,
  CreateV2ManagedMailboxBatchInput,
  CreateV2ManagedMailboxBatchResult,
  CreateV2WorkspaceShortcutInput,
  CreateV2ManagedMailboxInput,
  CreateV2ManagedMailboxResult,
  CreateV2RelayJobInput,
  ReorderV2WorkspaceShortcutsInput,
  LoginV2RelayCloudBridgeInput,
  LoginV2RelayCloudBridgeResult,
  SaveV2RelayGoogleOAuthInput,
  StartV2MicrosoftMailboxAuthorizationInput,
  StartV2MicrosoftMailboxAuthorizationResult,
  StartV2RelayGoogleAuthorizationResult,
  UpdateV2ManagedMailboxCredentialInput,
  UpdateV2ManagedMailboxQueryCodeSettingsInput,
  UpdateV2ManagedMailboxQueryCodeSettingsResult,
  UpdateV2ManagedMailboxStatusInput,
  UpdateV2SavedTotpAccountInput,
  UpdateV2WorkspaceShortcutInput,
  V2MailViewerQueryInput,
  V2MailViewerQueryResult,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxListQuery,
  V2ManagedMailboxQueryCodeSettings,
  V2MicrosoftMailboxAuthorizationStatus,
  V2RelayConnectionStatus,
  V2RelayDeploymentOptions,
  V2RelayJob,
  V2RelayJobList,
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
  getManagedMailboxQueryCodeSettings(options: ApiRequestOptions = {}) {
    return request<V2ManagedMailboxQueryCodeSettings>(
      http.get('/id-business-v2/workspace-mailboxes/query-code-settings', {
        signal: options.signal
      })
    );
  },
  updateManagedMailboxQueryCodeSettings(input: UpdateV2ManagedMailboxQueryCodeSettingsInput) {
    return request<UpdateV2ManagedMailboxQueryCodeSettingsResult>(
      http.patch('/id-business-v2/workspace-mailboxes/query-code-settings', input)
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
  },
  getRelayConnection(options: ApiRequestOptions = {}) {
    return request<V2RelayConnectionStatus>(
      http.get('/id-business-v2/workspace-relay/connection', { signal: options.signal })
    );
  },
  saveRelayGoogleOAuth(input: SaveV2RelayGoogleOAuthInput) {
    return request<V2RelayConnectionStatus>(
      http.put('/id-business-v2/workspace-relay/google-oauth', input)
    );
  },
  startRelayGoogleAuthorization() {
    return request<StartV2RelayGoogleAuthorizationResult>(
      http.post('/id-business-v2/workspace-relay/google-oauth/authorizations')
    );
  },
  loginRelayCloudBridge(input: LoginV2RelayCloudBridgeInput) {
    return request<LoginV2RelayCloudBridgeResult>(
      http.post('/id-business-v2/workspace-relay/cloudbridge/sessions', input)
    );
  },
  getRelayDeploymentOptions(options: ApiRequestOptions = {}) {
    return request<V2RelayDeploymentOptions>(
      http.get('/id-business-v2/workspace-relay/options', { signal: options.signal })
    );
  },
  listRelayJobs(options: ApiRequestOptions = {}) {
    return request<V2RelayJobList>(
      http.get('/id-business-v2/workspace-relay/jobs', { signal: options.signal })
    );
  },
  createRelayJob(input: CreateV2RelayJobInput) {
    return request<V2RelayJob>(http.post('/id-business-v2/workspace-relay/jobs', input));
  },
  runRelayJob(jobId: string) {
    return request<V2RelayJob>(
      http.post(`/id-business-v2/workspace-relay/jobs/${encodeURIComponent(jobId)}/run`)
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
