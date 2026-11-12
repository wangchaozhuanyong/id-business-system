const maximumResponseBytes = 16 * 1024 * 1024;

export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError(503, 'Vendure 邮箱连接地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RelayError(503, '本机邮箱连接仅支持回环地址');
  }
  return url.toString();
}

async function readResponse(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (!response.body || contentLength > maximumResponseBytes) throw new Error('Invalid response');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumResponseBytes) throw new Error('Invalid response');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createVendureMailboxProvider(config, fetchImpl = fetch) {
  const adminUrl = loopbackUrl(config.adminUrl);
  const shopUrl = config.shopUrl ? loopbackUrl(config.shopUrl) : null;
  const apiKey = config.apiKey?.trim();
  const primarySettings = 'id email status note createdAt codeResetIntervalDays codeExpiresAt lastSyncedAt';
  if (!apiKey || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
    throw new RelayError(503, '请配置本机 Vendure 邮箱专用 API Key');
  }

  async function request(url, query, variables, field, timeout = 20_000) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'cache-control': 'no-store',
          'vendure-api-key': apiKey
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeout)
      });
      if ([401, 403].includes(response.status)) {
        throw new RelayError(502, 'Vendure 邮箱授权无效或权限不足');
      }
      if (!response.ok) throw new Error('Vendure HTTP request failed');
      const envelope = await readResponse(response);
      if (
        Array.isArray(envelope.errors) &&
        envelope.errors.some(({ extensions }) =>
          ['FORBIDDEN', 'UNAUTHENTICATED'].includes(extensions?.code)
        )
      ) {
        throw new RelayError(502, 'Vendure 邮箱授权无效或权限不足');
      }
      if (envelope.errors?.length || envelope.data?.[field] == null) {
        throw new Error('Vendure GraphQL request failed');
      }
      return envelope.data[field];
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new RelayError(504, 'Vendure 邮箱服务连接超时，请重试');
      }
      throw new RelayError(502, 'Vendure 邮箱服务暂时不可用，请重试');
    }
  }

  return {
    supportsCodeQuery: Boolean(shopUrl),
    primaryAccounts() {
      return request(
        adminUrl,
        `query IdBusinessPrimaryAccounts { icloudPrimaryAccounts { ${primarySettings} masterQueryCode } }`,
        {},
        'icloudPrimaryAccounts'
      );
    },
    createPrimary(input) {
      return request(
        adminUrl,
        `mutation IdBusinessCreatePrimary($input: CreateIcloudPrimaryAccountInput!) {
          result: createIcloudPrimaryAccount(input: $input) { ${primarySettings} }
        }`,
        { input }, 'result'
      );
    },
    updatePrimary(id, input) {
      return request(
        adminUrl,
        `mutation IdBusinessUpdatePrimary($input: UpdateIcloudPrimaryAccountInput!) {
          result: updateIcloudPrimaryAccount(input: $input) { ${primarySettings} }
        }`,
        { input: { id, ...input } }, 'result'
      );
    },
    virtualEmails() {
      return request(
        adminUrl,
        'query IdBusinessVirtualEmails { icloudVirtualEmails { id primaryAccountId aliasEmail status buyerQueryCode codeExpiresAt codeResetIntervalDays note createdAt } }',
        {},
        'icloudVirtualEmails'
      );
    },
    relayTargets(primaryIds, aliasIds, codeKind) {
      return request(
        adminUrl,
        `query IdBusinessRelayTargets($primaryIds: [ID!]!, $aliasIds: [ID!]!, $includeCodes: Boolean!) {
          icloudRelayTargets(primaryIds: $primaryIds, aliasIds: $aliasIds, includeCodes: $includeCodes) {
            primaries { id email status lastSyncedAt codeExpiresAt ${codeKind === 'parent' ? 'masterQueryCode' : ''} }
            aliases { id primaryAccountId aliasEmail status codeExpiresAt lastQueriedAt mailCount lastMailReceivedAt ${codeKind === 'alias' ? 'buyerQueryCode' : ''} }
          }
        }`,
        { primaryIds, aliasIds, includeCodes: Boolean(codeKind) },
        'icloudRelayTargets'
      );
    },
    relayArrivalSample(primaryId) {
      return request(
        adminUrl,
        `query IdBusinessRelayArrival($primaryId: ID!) {
          icloudMailHealth(sampleArrivalFor: $primaryId) {
            listeners { primaryAccountId state }
            arrivalSample { outcome attempted arrivalToStoreMs newestStoredAt }
          }
        }`,
        { primaryId },
        'icloudMailHealth'
      );
    },
    relayCodeTarget(queryCode, expected = {}) {
      return request(
        adminUrl,
        `query IdBusinessRelayCodeTarget($queryCode: String!, $expectedPrimaryId: ID, $expectedAliasId: ID) {
          icloudRelayCodeTarget(queryCode: $queryCode, expectedPrimaryId: $expectedPrimaryId, expectedAliasId: $expectedAliasId) {
            primary { id email status codeExpiresAt }
            alias { id primaryAccountId aliasEmail status codeExpiresAt }
            retryAfterSeconds
          }
        }`,
        { queryCode, ...expected },
        'icloudRelayCodeTarget'
      );
    },
    relayMailPage(variables) {
      return request(
        adminUrl,
        `query IdBusinessRelayMailPage($primaryAccountId: ID!, $virtualEmailId: ID, $unassignedOnly: Boolean!, $limit: Int!, $mailId: ID) {
          icloudRelayMailPage(primaryAccountId: $primaryAccountId, virtualEmailId: $virtualEmailId,
            unassignedOnly: $unassignedOnly, limit: $limit, mailId: $mailId) {
            primary { id email status lastSyncedAt }
            aliases { id primaryAccountId aliasEmail status }
            items {
              id primaryAccountId virtualEmailId messageId fromAddress fromName subject
              extractedCode receivedAt isRead ${variables.mailId ? 'bodyText' : ''}
            }
            truncated
          }
        }`,
        variables,
        'icloudRelayMailPage'
      );
    },
    createAlias(input) {
      return request(
        adminUrl,
        `mutation IdBusinessCreateAlias($input: CreateIcloudVirtualEmailInput!) {
          result: createIcloudVirtualEmail(input: $input) { id }
        }`,
        { input }, 'result'
      );
    },
    batchCreateAliases(input) {
      return request(
        adminUrl,
        `mutation IdBusinessBatchCreateAliases($input: BatchCreateIcloudVirtualEmailsInput!) {
          result: batchCreateIcloudVirtualEmails(input: $input) { createdCount skippedCount }
        }`,
        { input }, 'result', 60_000
      );
    },
    testConnection(id) {
      return request(
        adminUrl,
        'mutation IdBusinessTestConnection($id: ID!) { result: testIcloudConnection(id: $id) { success } }',
        { id },
        'result'
      );
    },
    syncPrimary(id) {
      return request(
        adminUrl,
        'mutation IdBusinessSyncPrimary($id: ID!) { result: syncIcloudAccount(id: $id) { success syncedCount } }',
        { id },
        'result',
        60_000
      );
    },
    previewHistory(primaryAccountId) {
      return request(
        adminUrl,
        `mutation IdBusinessReconcileHistory($primaryAccountId: ID!, $dryRun: Boolean!) {
          result: reconcileIcloudMailHistory(primaryAccountId: $primaryAccountId, dryRun: $dryRun) {
            scannedCount matchedCount updatedCount unmatchedCount ambiguousCount unresolvedCount skippedCount
          }
        }`,
        { primaryAccountId, dryRun: true },
        'result',
        60_000
      );
    },
    resetPrimaryCode(id, validityDays) {
      return request(
        adminUrl,
        `mutation IdBusinessResetPrimaryCode($id: ID!, $codeResetIntervalDays: Int) {
          result: resetIcloudMasterCode(id: $id, codeResetIntervalDays: $codeResetIntervalDays) {
            id email status masterQueryCode codeExpiresAt codeResetIntervalDays
          }
        }`,
        { id, codeResetIntervalDays: validityDays },
        'result'
      );
    },
    resetAliasCode(id, validityDays) {
      return request(
        adminUrl,
        `mutation IdBusinessResetAliasCode($id: ID!, $codeResetIntervalDays: Int) {
          result: resetIcloudVirtualEmailCode(id: $id, codeResetIntervalDays: $codeResetIntervalDays) {
            id primaryAccountId aliasEmail status buyerQueryCode codeExpiresAt codeResetIntervalDays
          }
        }`,
        { id, codeResetIntervalDays: validityDays },
        'result'
      );
    },
    mailAssignmentCandidates(primaryAccountId) {
      return request(
        adminUrl,
        `query IdBusinessMailAssignmentCandidates($primaryAccountId: ID!, $limit: Int!) {
          icloudReceivedMails(primaryAccountId: $primaryAccountId, limit: $limit) {
            id primaryAccountId virtualEmailId messageId subject receivedAt updatedAt
          }
        }`,
        { primaryAccountId, limit: 200 },
        'icloudReceivedMails'
      );
    },
    reassignMail(mailId, virtualEmailId) {
      return request(
        adminUrl,
        `mutation IdBusinessReassignMail($mailId: ID!, $virtualEmailId: ID!) {
          result: reassignIcloudMail(mailId: $mailId, virtualEmailId: $virtualEmailId) {
            id primaryAccountId virtualEmailId
          }
        }`,
        { mailId, virtualEmailId },
        'result'
      );
    }
  };
}
