import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  V2VendureMailboxMail,
  V2VendureMailboxPrimaryAccount,
  V2VendureMailboxPublicQueryResult,
  V2VendureMailboxSyncResult
} from '@apple-business/shared';

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: unknown }>;
}

const PRIMARY_FIELDS = `
  id createdAt updatedAt email note status imapHost imapPort masterQueryCode codeExpiresAt
  codeResetIntervalDays remainingDays lastQueriedAt lastQueriedIp lastSyncedAt lastSyncError
  virtualEmailCount
`;
const ALIAS_FIELDS = `
  id createdAt updatedAt primaryAccountId primaryAccountEmail aliasEmail note status buyerQueryCode
  codeExpiresAt codeResetIntervalDays remainingDays lastQueriedAt lastQueriedIp mailCount lastMailReceivedAt
`;
const MAIL_FIELDS = `
  id createdAt updatedAt primaryAccountId virtualEmailId messageId fromAddress fromName subject bodyText
  extractedCode receivedAt isRead isStarred
`;

@Injectable()
export class IdBusinessV2VendureMailboxClient {
  constructor(private readonly config: ConfigService) {}

  isConfigured() {
    return Boolean(this.adminUrl() && this.apiKey());
  }

  async primaryAccounts() {
    const data = await this.admin<{ icloudPrimaryAccounts: V2VendureMailboxPrimaryAccount[] }>(
      `query IdBusinessPrimaryAccounts { icloudPrimaryAccounts { ${PRIMARY_FIELDS} } }`
    );
    return data.icloudPrimaryAccounts;
  }

  async virtualEmails(primaryAccountId?: string) {
    const data = await this.admin<{ icloudVirtualEmails: V2VendureMailboxAlias[] }>(
      `query IdBusinessVirtualEmails($primaryAccountId: ID) {
        icloudVirtualEmails(primaryAccountId: $primaryAccountId) { ${ALIAS_FIELDS} }
      }`,
      { primaryAccountId }
    );
    return data.icloudVirtualEmails;
  }

  async receivedMails(input: {
    primaryAccountId?: string;
    virtualEmailId?: string;
    unassignedOnly?: boolean;
    limit?: number;
  }) {
    const data = await this.admin<{ icloudReceivedMails: V2VendureMailboxMail[] }>(
      `query IdBusinessReceivedMails(
        $primaryAccountId: ID, $virtualEmailId: ID, $unassignedOnly: Boolean, $limit: Int
      ) {
        icloudReceivedMails(
          primaryAccountId: $primaryAccountId,
          virtualEmailId: $virtualEmailId,
          unassignedOnly: $unassignedOnly,
          limit: $limit
        ) { ${MAIL_FIELDS} }
      }`,
      input
    );
    return data.icloudReceivedMails;
  }

  createPrimary(input: CreateV2VendureMailboxPrimaryInput) {
    return this.adminMutation<V2VendureMailboxPrimaryAccount>(
      `mutation IdBusinessCreatePrimary($input: CreateIcloudPrimaryAccountInput!) {
        result: createIcloudPrimaryAccount(input: $input) { ${PRIMARY_FIELDS} }
      }`,
      { input }
    );
  }

  updatePrimary(id: string, input: UpdateV2VendureMailboxPrimaryInput) {
    return this.adminMutation<V2VendureMailboxPrimaryAccount>(
      `mutation IdBusinessUpdatePrimary($input: UpdateIcloudPrimaryAccountInput!) {
        result: updateIcloudPrimaryAccount(input: $input) { ${PRIMARY_FIELDS} }
      }`,
      { input: { id, ...input } }
    );
  }

  deletePrimary(id: string) {
    return this.adminMutation<boolean>(
      `mutation IdBusinessDeletePrimary($id: ID!) { result: deleteIcloudPrimaryAccount(id: $id) }`,
      { id }
    );
  }

  testConnection(id: string) {
    return this.adminMutation<V2VendureMailboxConnectionResult>(
      `mutation IdBusinessTestConnection($id: ID!) {
        result: testIcloudConnection(id: $id) { success message }
      }`,
      { id }
    );
  }

  syncPrimary(id: string) {
    return this.adminMutation<V2VendureMailboxSyncResult>(
      `mutation IdBusinessSyncPrimary($id: ID!) {
        result: syncIcloudAccount(id: $id) { success syncedCount error }
      }`,
      { id },
      60_000
    );
  }

  resetPrimaryCode(id: string) {
    return this.adminMutation<V2VendureMailboxPrimaryAccount>(
      `mutation IdBusinessResetPrimaryCode($id: ID!) {
        result: resetIcloudMasterCode(id: $id) { ${PRIMARY_FIELDS} }
      }`,
      { id }
    );
  }

  reconcileHistory(primaryAccountId: string, dryRun: boolean) {
    return this.adminMutation<V2VendureMailboxHistoryResult>(
      `mutation IdBusinessReconcileHistory($primaryAccountId: ID!, $dryRun: Boolean!) {
        result: reconcileIcloudMailHistory(primaryAccountId: $primaryAccountId, dryRun: $dryRun) {
          scannedCount matchedCount updatedCount unmatchedCount ambiguousCount unresolvedCount skippedCount
        }
      }`,
      { primaryAccountId, dryRun },
      60_000
    );
  }

  createAlias(input: CreateV2VendureMailboxAliasInput) {
    return this.adminMutation<V2VendureMailboxAlias>(
      `mutation IdBusinessCreateAlias($input: CreateIcloudVirtualEmailInput!) {
        result: createIcloudVirtualEmail(input: $input) { ${ALIAS_FIELDS} }
      }`,
      { input }
    );
  }

  batchCreateAliases(input: BatchCreateV2VendureMailboxAliasesInput) {
    return this.adminMutation<V2VendureMailboxBatchResult>(
      `mutation IdBusinessBatchCreateAliases($input: BatchCreateVirtualEmailsInput!) {
        result: batchCreateIcloudVirtualEmails(input: $input) { createdCount skippedCount errors }
      }`,
      { input },
      60_000
    );
  }

  updateAlias(id: string, input: UpdateV2VendureMailboxAliasInput) {
    return this.adminMutation<V2VendureMailboxAlias>(
      `mutation IdBusinessUpdateAlias($input: UpdateIcloudVirtualEmailInput!) {
        result: updateIcloudVirtualEmail(input: $input) { ${ALIAS_FIELDS} }
      }`,
      { input: { id, ...input } }
    );
  }

  deleteAlias(id: string) {
    return this.adminMutation<boolean>(
      `mutation IdBusinessDeleteAlias($id: ID!) { result: deleteIcloudVirtualEmail(id: $id) }`,
      { id }
    );
  }

  resetAliasCode(id: string) {
    return this.adminMutation<V2VendureMailboxAlias>(
      `mutation IdBusinessResetAliasCode($id: ID!) {
        result: resetIcloudVirtualEmailCode(id: $id) { ${ALIAS_FIELDS} }
      }`,
      { id }
    );
  }

  reassignMail(mailId: string, virtualEmailId: string) {
    return this.adminMutation<V2VendureMailboxMail>(
      `mutation IdBusinessReassignMail($mailId: ID!, $virtualEmailId: ID!) {
        result: reassignIcloudMail(mailId: $mailId, virtualEmailId: $virtualEmailId) { ${MAIL_FIELDS} }
      }`,
      { mailId, virtualEmailId }
    );
  }

  deleteMail(mailId: string) {
    return this.adminMutation<boolean>(
      `mutation IdBusinessDeleteMail($mailId: ID!) { result: deleteIcloudMail(mailId: $mailId) }`,
      { mailId }
    );
  }

  async publicQuery(queryCode: string, clientIp?: string) {
    const data = await this.shop<{ icloudQueryMails: V2VendureMailboxPublicQueryResult }>(
      `query IdBusinessPublicMailboxQuery($queryCode: String!) {
        icloudQueryMails(queryCode: $queryCode) {
          success message targetType aliasEmail primaryEmail codeExpiresAt remainingDays totalEmails
          items { id virtualEmailId fromAddress fromName subject receivedAt extractedCode bodyText targetEmail }
          virtualEmailsList { id aliasEmail note }
        }
      }`,
      { queryCode },
      clientIp
    );
    return data.icloudQueryMails;
  }

  private async adminMutation<T>(
    query: string,
    variables: Record<string, unknown>,
    timeoutMs = 20_000
  ) {
    const data = await this.admin<{ result: T }>(query, variables, timeoutMs);
    return data.result;
  }

  private admin<T>(query: string, variables: Record<string, unknown> = {}, timeoutMs = 20_000) {
    const url = this.adminUrl();
    const apiKey = this.apiKey();
    if (!url || !apiKey) throw new ServiceUnavailableException('Vendure 邮箱互通尚未配置');
    return this.request<T>(url, query, variables, { 'vendure-api-key': apiKey }, timeoutMs);
  }

  private shop<T>(query: string, variables: Record<string, unknown>, clientIp?: string) {
    const url = this.validUrl(this.config.get<string>('VENDURE_MAILBOX_SHOP_API_URL'));
    const apiKey = this.apiKey();
    if (!url || !apiKey) throw new ServiceUnavailableException('Vendure 邮箱查询入口尚未配置');
    return this.request<T>(url, query, variables, {
      'vendure-api-key': apiKey,
      ...(clientIp ? { 'x-id-business-client-ip': clientIp } : {})
    });
  }

  private async request<T>(
    url: string,
    query: string,
    variables: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    timeoutMs = 20_000
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'cache-control': 'no-store',
          ...extraHeaders
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const envelope = (await response.json()) as GraphqlEnvelope<T>;
      if (envelope.errors?.length || !envelope.data) throw new Error('GraphQL request failed');
      return envelope.data;
    } catch {
      throw new ServiceUnavailableException('Vendure 邮箱服务暂时不可用，请稍后刷新重试');
    } finally {
      clearTimeout(timer);
    }
  }

  private adminUrl() {
    return this.validUrl(this.config.get<string>('VENDURE_MAILBOX_ADMIN_API_URL'));
  }

  private apiKey() {
    return this.config.get<string>('VENDURE_MAILBOX_API_KEY')?.trim() || null;
  }

  private validUrl(raw: string | undefined) {
    try {
      const value = raw?.trim();
      if (!value) return null;
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
}
