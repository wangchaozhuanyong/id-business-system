import type {
  CheckV2WebsiteInput,
  CreateV2SavedTotpAccountInput,
  CreateV2ManagedMailboxBatchInput,
  CreateV2ManagedMailboxBatchResult,
  CreateV2WorkspaceShortcutInput,
  CreateV2ManagedMailboxInput,
  CreateV2ManagedMailboxResult,
  CreateV2RelayJobInput,
  RunV2GoogleSheetsSyncResult,
  SaveV2GoogleSheetsSyncConfigInput,
  CompleteV2RelaySubscriptionAuthorizationInput,
  ReorderV2WorkspaceShortcutsInput,
  LoginV2RelayCloudBridgeInput,
  LoginV2RelayCloudBridgeResult,
  SaveV2RelayGoogleOAuthInput,
  ResolveV2MediaInput,
  StartV2MicrosoftMailboxAuthorizationInput,
  StartV2MicrosoftMailboxAuthorizationResult,
  StartV2RelayGoogleAuthorizationResult,
  StartV2GoogleSheetsAuthorizationResult,
  StartV2RelaySubscriptionAuthorizationResult,
  UpdateV2ManagedMailboxCredentialInput,
  UpdateV2ManagedMailboxQueryCodeSettingsInput,
  UpdateV2ManagedMailboxQueryCodeSettingsResult,
  UpdateV2ManagedMailboxStatusInput,
  UpdateV2GoogleSheetsSyncStateInput,
  UpdateV2SavedTotpAccountInput,
  UpdateV2WorkspaceShortcutInput,
  V2MailViewerQueryInput,
  V2MailViewerQueryResult,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxListQuery,
  V2ManagedMailboxQueryCodeSettings,
  V2MicrosoftMailboxAuthorizationStatus,
  V2MediaResolveResult,
  V2RelayConnectionStatus,
  V2RelayDeploymentOptions,
  V2RelayJob,
  V2RelayJobList,
  V2GoogleSheetsSyncStatus,
  V2SavedTotpAccount,
  V2SavedTotpAccountList,
  V2WebsiteMonitorResult,
  V2WebsiteAnalyticsDays,
  V2WebsiteAnalyticsReport,
  V2WebsiteVisitReport,
  V2WebsiteVisitSearch,
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
  checkWebsite(input: CheckV2WebsiteInput, options: ApiRequestOptions = {}) {
    return request<V2WebsiteMonitorResult>(
      http.post('/id-business-v2/workspace-website-monitor/check', input, {
        signal: options.signal,
        timeout: 85_000
      })
    );
  },
  getWebsiteAnalytics(days: V2WebsiteAnalyticsDays, options: ApiRequestOptions = {}) {
    return request<V2WebsiteAnalyticsReport>(
      http.get('/id-business-v2/workspace-website-monitor/analytics', {
        params: { days },
        signal: options.signal,
        timeout: 30_000
      })
    );
  },
  searchWebsiteVisits(input: V2WebsiteVisitSearch, options: ApiRequestOptions = {}) {
    return request<V2WebsiteVisitReport>(
      http.post('/id-business-v2/workspace-website-monitor/visits/search', input, {
        signal: options.signal,
        timeout: 30_000
      })
    );
  },
  revealWebsiteVisitIp(id: string) {
    return request<{ ip: string }>(
      http.post(`/id-business-v2/workspace-website-monitor/visits/${encodeURIComponent(id)}/reveal`)
    );
  },
  resolveMedia(input: ResolveV2MediaInput, options: ApiRequestOptions = {}) {
    return request<V2MediaResolveResult>(
      http.post('/id-business-v2/workspace-media/resolve', input, {
        signal: options.signal,
        timeout: 45_000
      })
    );
  },
  async downloadMedia(
    downloadToken: string,
    options: ApiRequestOptions & {
      onDownloadProgress?: (loaded: number, total?: number) => void;
    } = {}
  ) {
    const response = await http.get<Blob>('/id-business-v2/workspace-media/download', {
      params: { token: downloadToken },
      responseType: 'blob',
      signal: options.signal,
      onDownloadProgress: (event) => options.onDownloadProgress?.(event.loaded, event.total),
      timeout: 390_000
    });
    return response.data;
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
  },
  getGoogleSheetsSyncStatus(options: ApiRequestOptions = {}) {
    return request<V2GoogleSheetsSyncStatus>(
      http.get('/id-business-v2/google-sheets-sync', { signal: options.signal })
    );
  },
  saveGoogleSheetsSyncConfig(input: SaveV2GoogleSheetsSyncConfigInput) {
    return request<V2GoogleSheetsSyncStatus>(
      http.put('/id-business-v2/google-sheets-sync/config', input)
    );
  },
  startGoogleSheetsAuthorization() {
    return request<StartV2GoogleSheetsAuthorizationResult>(
      http.post('/id-business-v2/google-sheets-sync/authorizations')
    );
  },
  updateGoogleSheetsSyncState(input: UpdateV2GoogleSheetsSyncStateInput) {
    return request<V2GoogleSheetsSyncStatus>(
      http.patch('/id-business-v2/google-sheets-sync/state', input)
    );
  },
  runGoogleSheetsSync() {
    return request<RunV2GoogleSheetsSyncResult>(
      http.post('/id-business-v2/google-sheets-sync/runs')
    );
  },
  disconnectGoogleSheetsSync() {
    return request<V2GoogleSheetsSyncStatus>(
      http.delete('/id-business-v2/google-sheets-sync/connection')
    );
  },
  startRelaySubscriptionAuthorization(jobId: string) {
    return request<StartV2RelaySubscriptionAuthorizationResult>(
      http.post(
        `/id-business-v2/workspace-relay/jobs/${encodeURIComponent(jobId)}/subscription-authorization`
      )
    );
  },
  completeRelaySubscriptionAuthorization(
    jobId: string,
    input: CompleteV2RelaySubscriptionAuthorizationInput
  ) {
    return request<V2RelayJob>(
      http.post(
        `/id-business-v2/workspace-relay/jobs/${encodeURIComponent(jobId)}/subscription-authorization/callback`,
        input
      )
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
