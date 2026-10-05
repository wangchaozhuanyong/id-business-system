import { createHash } from 'node:crypto';

export const HISTORY_POLICY_ID = 'historical-finance-20261005';
export const HISTORY_BASELINE = 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22';
export const HISTORY_CONTINUATION_POLICY_ID =
  'historical-finance-20261005-registration-continuation';
export const HISTORY_CONTINUATION_BASELINE = 'd0f359dc78b2d2b166893bfec8545609f5baa16d';
const policySha256 = '58be04eac7b385fdcd7386746358e1c02ff2b925a92b635cf6afe588495fd4ca';
const continuationPolicySha256 = '7407cc7c5676657b3f24b6e5649f1316cd3c64adb5aeb8f47006cfda58124137';
export const HISTORY_DIAGNOSTICS_POLICY_ID = 'historical-finance-20261005-recharge-diagnostics';
export const HISTORY_DIAGNOSTICS_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
// Pinned to the independently verified successful 6a receipts and exact candidate.
const diagnosticsPolicySha256 = '0682cb5ec0f95dabc49bcd3ba4d38384d1353ddfe275dd6dcf122f540d1dbcba';
const historyPolicyIdentities = new Map([
  [HISTORY_POLICY_ID, { baseline: HISTORY_BASELINE, sha256: policySha256, continuation: false }],
  [
    HISTORY_CONTINUATION_POLICY_ID,
    {
      baseline: HISTORY_CONTINUATION_BASELINE,
      sha256: continuationPolicySha256,
      continuation: true
    }
  ],
  [
    HISTORY_DIAGNOSTICS_POLICY_ID,
    { baseline: HISTORY_DIAGNOSTICS_BASELINE, sha256: diagnosticsPolicySha256, continuation: true }
  ]
]);
const diagnosticsCandidateSourceSha256 = Object.freeze({
  'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py':
    '9c3c0d7b7d60ae26729486943fb7d4eec15154fb1331646fa755a6a014ebde6a',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py':
    '2ccb8e3b0e6b3ba9ff2cfc55e1fb96c5352ce6c0767ae7594aab2f5fa30d948f',
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py':
    '1734bacb68549f8dcc28a35426d659069b7aefc8070b110adb5c0bfd70c140a9',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py':
    'ac459b9a00eaeb482efc54cc7eecf23fc003c993e6d5991ecf45034c5e1c0696',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py':
    '1327c9fdd8e88807e8ba69bbd288c9b2e62edf015352250e2d54f8d4e9a69173',
  'docs/V2_TASKS.md': 'f2eb5c6520c246b7585934935672af8f328415453286c08fca5e71c5aa8b7449',
  'scripts/ci-recharge-check.mjs':
    '86c143e33a862fc31610b68f013d32236447548c9ee238cf58a3393f088f53cc'
});
function historyPolicyIdentity(policy) {
  const identity = historyPolicyIdentities.get(policy?.id);
  if (!identity) throw new Error('Unknown historical release policy');
  return identity;
}
const allowedRules = new Set([
  'finance_cash_source_currency_mismatch',
  'cash_historical_cost_evidence_mismatch'
]);

export function fingerprint(value) {
  const normalize = (item) => {
    if (item instanceof Date) return item.toISOString();
    if (typeof item === 'bigint') return String(item);
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])])
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}

export function fingerprintRows(rows) {
  return fingerprint([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en')));
}

export function serializeHistoricalAuditReport(report) {
  return JSON.stringify(report, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

export function validateHistoryPolicy(policy, definitions, expectedCurrent) {
  if (policy?.id === HISTORY_POST_CLEANUP_POLICY_ID)
    throw new Error('Post-cleanup history policy requires a separately reviewed release seal');
  const { continuation, baseline, sha256 } = historyPolicyIdentity(policy);
  if (
    fingerprint(policy) !== sha256 ||
    policy.version !== 1 ||
    policy.expectedCurrent !== baseline ||
    expectedCurrent !== baseline ||
    policy.userApproved !== true ||
    policy.checkCount !== 48 ||
    definitions.length !== 48 ||
    policy.rulesSha256 !== fingerprint(definitions)
  )
    throw new Error('Historical release policy identity, baseline or rules changed');
  if (continuation) {
    const original = { ...policy, id: HISTORY_POLICY_ID, expectedCurrent: HISTORY_BASELINE };
    delete original.continuation;
    delete original.candidateSourceSha256;
    if (
      fingerprint(original) !== policySha256 ||
      policy.continuation.continuationOf !== HISTORY_POLICY_ID ||
      policy.continuation.originPolicySha256 !== policySha256 ||
      policy.continuation.fixedCurrent !== baseline ||
      policy.continuation.manifest.commit !== baseline
    )
      throw new Error('Historical continuation changed the original approved scope');
  }
  if (
    policy.id === HISTORY_DIAGNOSTICS_POLICY_ID &&
    fingerprint(policy.candidateSourceSha256) !== fingerprint(diagnosticsCandidateSourceSha256)
  )
    throw new Error('Historical diagnostics changed the approved seven source files');
  const codes = new Set(policy.exceptions.map((item) => item.code));
  if (codes.size !== 2 || [...codes].some((code) => !allowedRules.has(code)))
    throw new Error('Historical release exception scope changed');
  for (const item of policy.exceptions) {
    const expected = item.code === 'finance_cash_source_currency_mismatch' ? 4 : 6;
    if (item.entityIds.length !== expected || new Set(item.entityIds).size !== expected)
      throw new Error('Historical release entity set changed');
  }
  for (const group of Object.values(policy.sources)) {
    if (
      !Array.isArray(group.ids) ||
      !group.ids.length ||
      group.ids.length > 100 ||
      group.ids.some((id) => !/^[a-f0-9-]{36}$/.test(id)) ||
      !/^[a-f0-9]{64}$/.test(group.sha256)
    )
      throw new Error('Invalid frozen historical source');
  }
}

export function acceptHistoricalAudit({
  policy,
  definitions,
  expectedCurrent,
  stage,
  checks,
  sources,
  metadata,
  before,
  identity
}) {
  validateHistoryPolicy(policy, definitions, expectedCurrent);
  const { continuation } = historyPolicyIdentity(policy);
  if (
    !['before', 'after'].includes(stage) ||
    !/^id_business_audit@/.test(identity.currentUser) ||
    identity.transactionIsolation !== 'REPEATABLE-READ' ||
    String(identity.foreignKeyChecks) !== '1'
  )
    throw new Error('Historical release audit stage or read-only identity invalid');
  const expectedCodes = definitions.map((item) => item.code).sort();
  if (JSON.stringify(checks.map((item) => item.code).sort()) !== JSON.stringify(expectedCodes))
    throw new Error('Historical release audit rule coverage changed');
  const unavailable = new Set([
    'bank_subscription_projection_mismatch',
    'bank_soft_delete_safety_mismatch'
  ]);
  const exceptions = new Map(
    policy.exceptions.map((item) => [item.code, [...item.entityIds].sort()])
  );
  for (const check of checks) {
    if (continuation && check.status !== 'EXECUTED')
      throw new Error('Historical continuation requires all rules to execute');
    if (check.status === 'SCHEMA_NOT_DEPLOYED') {
      if (
        stage !== 'before' ||
        !unavailable.has(check.code) ||
        check.databaseCode !== '1054' ||
        check.field !== 'o.deleted_at'
      )
        throw new Error('Historical release audit rule unavailable');
      continue;
    }
    if (!Number.isSafeInteger(check.count) || check.count < 0 || !Array.isArray(check.samples))
      throw new Error('Historical release audit rule did not execute');
    const expected = exceptions.get(check.code) ?? [];
    const actual = check.samples.map((sample) => sample.entityId).sort();
    if (check.count !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('New, missing or changed financial integrity exception');
  }
  if (
    JSON.stringify(Object.keys(sources).sort()) !==
    JSON.stringify(Object.keys(policy.sources).sort())
  )
    throw new Error('Historical source coverage changed');
  for (const [name, group] of Object.entries(policy.sources))
    if (sources[name] !== group.sha256)
      throw new Error('Frozen historical financial source changed');
  if (
    JSON.stringify(metadata.map((item) => item.id).sort()) !==
      JSON.stringify([...policy.sources.journals.ids].sort()) ||
    metadata.some((item) => !/^[a-f0-9]{64}$/.test(item.metadataSha256))
  )
    throw new Error('Historical journal metadata coverage changed');
  const metadataSha256 = fingerprintRows(metadata);
  if (continuation && metadataSha256 !== policy.continuation.metadataSha256)
    throw new Error('Historical metadata changed since the approved release');
  if (
    stage === 'after' &&
    (before?.gate?.policyId !== policy.id ||
      before.gate.expectedCurrent !== expectedCurrent ||
      before.gate.stage !== 'before' ||
      before.gate.accepted !== true ||
      before.gate.metadataSha256 !== metadataSha256 ||
      JSON.stringify(before.gate.sources) !== JSON.stringify(sources) ||
      (continuation &&
        (before.gate.checkCount !== 48 ||
          before.gate.executedCheckCount !== 48 ||
          before.gate.unavailableCheckCount !== 0 ||
          before.gate.violationCount !== 10 ||
          before.gate.status !== 'APPROVED_HISTORICAL_EXCEPTIONS' ||
          before.gate.continuationOf !== HISTORY_POLICY_ID ||
          before.gate.fixedCurrent !== expectedCurrent ||
          fingerprint(before.gate.continuation) !== fingerprint(policy.continuation))))
  )
    throw new Error('Historical source or metadata changed during release');
  return {
    accepted: true,
    status: 'APPROVED_HISTORICAL_EXCEPTIONS',
    policyId: policy.id,
    expectedCurrent,
    stage,
    checkCount: checks.length,
    violationCount: 10,
    executedCheckCount: checks.filter((item) => item.status !== 'SCHEMA_NOT_DEPLOYED').length,
    unavailableCheckCount: checks.filter((item) => item.status === 'SCHEMA_NOT_DEPLOYED').length,
    sources,
    metadataSha256,
    ...(continuation
      ? {
          continuationOf: HISTORY_POLICY_ID,
          fixedCurrent: expectedCurrent,
          continuation: policy.continuation
        }
      : {})
  };
}

export const historySourceQueries = {
  accounts: `SELECT id, currency, status, CAST(opening_balance AS CHAR) AS openingBalance,
    CAST(opening_balance_cny AS CHAR) AS openingBalanceCny, CAST(current_balance AS CHAR) AS currentBalance,
    CAST(current_balance_cny AS CHAR) AS currentBalanceCny, created_at AS createdAt, updated_at AS updatedAt
    FROM id_business_v2_finance_accounts WHERE id IN (IDS)`,
  journals: `SELECT id, journal_no AS journalNo, journal_type AS journalType, source_type AS sourceType,
    source_id AS sourceId, status, reversal_of_journal_id AS reversalOfJournalId, occurred_at AS occurredAt,
    created_at AS createdAt, business_date AS businessDate,
    JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.cashHistoricalCost.version')) AS cashCostEvidenceVersion
    FROM id_business_v2_finance_journals WHERE id IN (IDS)`,
  lines: `SELECT id, journal_id AS journalId, line_no AS lineNo, account_code AS accountCode, direction, currency,
    CAST(amount_original AS CHAR) AS amountOriginal, CAST(amount_cny AS CHAR) AS amountCny,
    CAST(fx_rate_to_cny AS CHAR) AS fxRateToCny, fx_rate_snapshot_id AS fxSnapshotId,
    finance_account_id AS financeAccountId, supplier_account_id AS supplierAccountId, created_at AS createdAt
    FROM id_business_v2_finance_journal_lines WHERE journal_id IN (IDS)`,
  expenses: `SELECT id, journal_id AS journalId, finance_account_id AS financeAccountId, currency,
    CAST(amount_original AS CHAR) AS amountOriginal, CAST(amount_cny AS CHAR) AS amountCny,
    CAST(fx_rate_to_cny AS CHAR) AS fxRateToCny, fx_rate_snapshot_id AS fxSnapshotId,
    occurred_at AS occurredAt, created_at AS createdAt FROM id_business_v2_finance_expenses WHERE id IN (IDS)`,
  orders: `SELECT id, order_no AS orderNo, status, deleted_at AS deletedAt,
    received_finance_account_id AS receivedFinanceAccountId, received_currency AS receivedCurrency,
    CAST(received_amount AS CHAR) AS receivedAmount, CAST(received_original_amount AS CHAR) AS receivedOriginalAmount,
    CAST(received_fx_rate_to_cny AS CHAR) AS receivedFxRateToCny, CAST(platform_fee_amount AS CHAR) AS platformFeeAmount,
    CAST(profit_amount AS CHAR) AS profitAmount, CAST(refund_cost_amount AS CHAR) AS refundCostAmount,
    created_at AS createdAt, updated_at AS updatedAt FROM id_business_v2_orders WHERE id IN (IDS)`
};

export const HISTORY_POST_CLEANUP_POLICY_ID = 'historical-finance-20261005-post-cleanup';
export const HISTORY_POST_CLEANUP_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
export const HISTORY_POST_CLEANUP_DATABASE = 'id_business_v2_partial_cleanup_20261005_v1';
export const HISTORY_POST_CLEANUP_RECEIPT_SHA256 =
  'f788c9328fd9f8eed17aa058a449d1f427f7ebadce97b2f29a0a321dc792315f';
// Independently captured source anchor; activation still requires an external reviewed runtime seal.
export const HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256 =
  '39dd801292f081560fdaf7db2feb6cdd6f3c1bc8b730ca9add4d33a472466920';
export const POST_CLEANUP_CAPTURE_EVIDENCE = Object.freeze({
  ssmCommandId: '2fd1410d-3e61-43a3-a150-5bbaa4e1ca14',
  captureReportSha256: 'd2fcba5524314e6ba8ce04444945fff16edbb3e3241626e67b050c2f4a082104',
  captureBundleSha256: 'b42f27e5506593441b893d3e213a3b366b8cf28c9fcd17b9eabce4694a024031',
  captureHelperSha256: '4c79b00c5f43283e3cdf53bccd0fc3aa9fffb970cc2b2d4c50cdb8674d1d5ca7',
  captureSpecSha256: 'dea961fde0502d7fe9a21eda9ba6acfd0722d11f3400a408f2df2b4ee9d52973',
  captureAuditModuleSha256: '2f248582dc54d96d25cea6b065312b6dc7fc8497da9b0886ce77ede411c5811e'
});
export const POST_CLEANUP_REQUIRED_SOURCE_FILES = Object.freeze([
  'apps/api/src/id-business-v2/finance/id-business-v2-historical-cash.types.ts',
  'apps/api/src/id-business-v2/finance/id-business-v2-historical-cash.service.ts',
  'apps/api/src/id-business-v2/finance/id-business-v2-historical-cash.service.spec.ts',
  'apps/api/src/id-business-v2/finance/persistence/id-business-v2-historical-cash.repository.ts',
  'apps/api/src/id-business-v2/finance/id-business-v2-finance.module.ts',
  'apps/api/src/id-business-v2/finance/public-api.ts',
  'apps/api/src/id-business-v2/finance/id-business-v2-finance-posting.service.ts',
  'apps/api/src/id-business-v2/finance/persistence/id-business-v2-finance-historical-reversal.repository.ts',
  'apps/api/src/id-business-v2/finance/historical-cash-mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/finance/persistence/historical-cash-mysql.fixtures.ts',
  'scripts/lib/v2-data-integrity-audit.mjs',
  'scripts/lib/v2-historical-cash-adjustment-audit.mjs',
  'scripts/v2-data-integrity-audit.test.mjs',
  'scripts/acceptance-v2-financial-integrity.mjs',
  'scripts/historical-cash-audit-mysql.test.mjs',
  'scripts/historical-cash-runner.mjs',
  'scripts/historical-cash-runner.test.mjs',
  'scripts/historical-cash-chain.mjs',
  'scripts/historical-cash-package.mjs',
  'scripts/historical-cash-package.test.mjs',
  'scripts/historical-cash-runner-mysql.test.mjs',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-lifecycle-support.ts',
  'apps/api/src/id-business-v2/orders/persistence/id-business-v2-orders.repository.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-lifecycle.service.spec.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-entry.service.spec.ts',
  'scripts/backup-aws-mysql.sh'
]);
export const POST_CLEANUP_COMPILED_FILES = Object.freeze([
  'apps/api/dist/id-business-v2/finance/public-api.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-historical-cash.service.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-historical-cash.types.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-historical-cash.repository.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-historical-reversal.repository.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-posting.service.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-cash-cost.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-command.repository.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-posting.repository.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-input.js',
  'apps/api/dist/id-business-v2/runtime/public-api.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-decimal.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-row-mapper.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-prisma-error.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-time.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-command-transaction.service.js',
  'apps/api/dist/id-business-v2/runtime/persistence/id-business-v2-transactional-audit.repository.js',
  'apps/api/dist/common/prisma/mysql-transaction-lock.js',
  'apps/api/dist/common/prisma/prisma.service.js',
  'apps/api/dist/common/prisma/bump-v2-scope-versions.js',
  'apps/api/dist/audit-logs/audit-log-sanitizer.js',
  'apps/api/dist/v2-auth/v2-identity.service.js',
  'apps/api/dist/v2-auth/system-super-admin.js',
  'packages/shared/dist/v2/decimal.js',
  'packages/shared/dist/index.js'
]);
export const POST_CLEANUP_COST_ENTITY_IDS = Object.freeze([
  '0e095178-8455-4f1d-8e45-d12b09064702:c6866d24-097b-44c5-b3a7-f3a3dcc11b23',
  '10eb0ed7-3ce4-42a7-93e1-b83a898efe15:02d8080d-68d8-4095-8b60-a30d5cd6c4e0',
  '49ba9779-9ff8-4bb8-8dd2-f587865f2a9e:02d8080d-68d8-4095-8b60-a30d5cd6c4e0',
  '5a9ca0f0-2855-48e6-a50f-690dc64ebb65:c6866d24-097b-44c5-b3a7-f3a3dcc11b23',
  'eb3f0d75-3802-49ab-8f3f-86fae65d8514:02d8080d-68d8-4095-8b60-a30d5cd6c4e0'
]);
const postCleanupJournalIds = POST_CLEANUP_COST_ENTITY_IDS.map((id) => id.split(':')[0]);
const postCleanupAccountIds = [
  ...new Set(POST_CLEANUP_COST_ENTITY_IDS.map((id) => id.split(':')[1]))
].sort();
const postCleanupJournalFields = `j.id, j.journal_no AS journalNo, j.journal_type AS journalType,
  j.source_type AS sourceType, j.source_id AS sourceId, j.status, j.reversal_of_journal_id AS reversalOfJournalId,
  j.occurred_at AS occurredAt, j.created_at AS createdAt, j.business_date AS businessDate,
  JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.cashHistoricalCost.version')) AS cashCostEvidenceVersion`;
const postCleanupLineFields = `l.id, l.journal_id AS journalId, l.line_no AS lineNo, l.account_code AS accountCode,
  l.direction, l.currency, CAST(l.amount_original AS CHAR) AS amountOriginal, CAST(l.amount_cny AS CHAR) AS amountCny,
  CAST(l.fx_rate_to_cny AS CHAR) AS fxRateToCny, l.fx_rate_snapshot_id AS fxSnapshotId,
  l.finance_account_id AS financeAccountId, l.supplier_account_id AS supplierAccountId, l.created_at AS createdAt`;
export const postCleanupSourceQueries = Object.freeze({
  accounts: { ids: postCleanupAccountIds, sql: historySourceQueries.accounts },
  journals: {
    ids: postCleanupJournalIds,
    sql: `SELECT ${postCleanupJournalFields} FROM id_business_v2_finance_journals j WHERE j.id IN (IDS)`
  },
  lines: {
    ids: postCleanupJournalIds,
    sql: `SELECT ${postCleanupLineFields} FROM id_business_v2_finance_journal_lines l WHERE l.journal_id IN (IDS)`
  },
  expenses: {
    ids: postCleanupJournalIds,
    sql: historySourceQueries.expenses.replace('WHERE id IN (IDS)', 'WHERE journal_id IN (IDS)')
  },
  cashLines: {
    ids: postCleanupAccountIds,
    sql: `SELECT ${postCleanupLineFields} FROM id_business_v2_finance_journal_lines l WHERE l.account_code = 'cash' AND l.finance_account_id IN (IDS)`
  },
  cashJournals: {
    ids: postCleanupAccountIds,
    sql: `SELECT DISTINCT ${postCleanupJournalFields},
    CAST(SHA2(IF(j.metadata IS NULL, 'NULL', CAST(j.metadata AS CHAR)), 256) AS CHAR) AS metadataSha256
    FROM id_business_v2_finance_journals j JOIN id_business_v2_finance_journal_lines l ON l.journal_id = j.id
    WHERE l.account_code = 'cash' AND l.finance_account_id IN (IDS)`
  }
});
const equal = (a, b) => fingerprint(a) === fingerprint(b);
const sha256Value = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function postCleanupSourceAnchor(policy) {
  return fingerprint({
    expectedCurrent: policy.expectedCurrent,
    activeDatabase: policy.activeDatabase,
    rulesSha256: policy.rulesSha256,
    exceptions: policy.exceptions,
    sources: policy.sources,
    metadataSha256: policy.metadataSha256,
    cleanupReceiptSha256: policy.cleanupReceiptSha256,
    captureEvidence: policy.captureEvidence
  });
}

export function validatePostCleanupPolicyDraft(policy, definitions, expectedCurrent) {
  if (
    policy?.version !== 1 ||
    policy.id !== HISTORY_POST_CLEANUP_POLICY_ID ||
    policy.userApproved !== false ||
    policy.activation !== 'EXTERNAL_REVIEWED_SEAL_REQUIRED' ||
    policy.expectedCurrent !== HISTORY_POST_CLEANUP_BASELINE ||
    expectedCurrent !== HISTORY_POST_CLEANUP_BASELINE ||
    policy.activeDatabase !== HISTORY_POST_CLEANUP_DATABASE ||
    policy.checkCount !== 49 ||
    definitions.length !== 49 ||
    policy.rulesSha256 !== fingerprint(definitions) ||
    !equal(policy.exceptions, [
      { code: 'cash_historical_cost_evidence_mismatch', entityIds: POST_CLEANUP_COST_ENTITY_IDS }
    ]) ||
    policy.cleanupReceiptSha256 !== HISTORY_POST_CLEANUP_RECEIPT_SHA256 ||
    !sha256Value(policy.metadataSha256) ||
    !equal(policy.captureEvidence, POST_CLEANUP_CAPTURE_EVIDENCE) ||
    !equal(Object.keys(policy.sources ?? {}).sort(), Object.keys(postCleanupSourceQueries).sort())
  )
    throw new Error('Post-cleanup draft identity, scope or all 49 rules changed');
  for (const [name, query] of Object.entries(postCleanupSourceQueries)) {
    const source = policy.sources[name];
    if (
      !equal(source?.ids, query.ids) ||
      !sha256Value(source?.sha256) ||
      !Number.isSafeInteger(source.rowCount) ||
      source.rowCount <= 0 ||
      (['accounts', 'journals', 'expenses'].includes(name) && source.rowCount !== query.ids.length)
    )
      throw new Error('Post-cleanup original source coverage changed');
  }
  if (policy.sourceAnchorSha256 !== postCleanupSourceAnchor(policy))
    throw new Error('Post-cleanup original source anchor changed');
  const bindings = policy.candidateBindings;
  for (const [name, map] of Object.entries(bindings ?? {})) {
    if (
      !['sourceSha256', 'compiledServiceHashes'].includes(name) ||
      !map ||
      Array.isArray(map) ||
      Object.keys(map).length === 0 ||
      Object.values(map).some((value) => !sha256Value(value))
    )
      throw new Error('Post-cleanup candidate content was not frozen');
    for (const file of Object.keys(map)) {
      const valid =
        name === 'sourceSha256'
          ? /^(apps\/api\/src\/id-business-v2\/|scripts\/|packages\/shared\/src\/)[A-Za-z0-9_./-]+$/.test(
              file
            )
          : /^(apps\/api\/dist\/|packages\/shared\/dist\/)[A-Za-z0-9_./-]+\.js$/.test(file);
      if (!valid || file.includes('..') || file === 'scripts/lib/v2-release-history-policy.mjs')
        throw new Error('Post-cleanup candidate file boundary changed');
    }
  }
  if (!equal(Object.keys(bindings ?? {}).sort(), ['compiledServiceHashes', 'sourceSha256']))
    throw new Error('Post-cleanup candidate content coverage changed');
  if (
    POST_CLEANUP_REQUIRED_SOURCE_FILES.some(
      (file) => !Object.hasOwn(bindings.sourceSha256, file)
    ) ||
    !equal(
      Object.keys(bindings.compiledServiceHashes).sort(),
      [...POST_CLEANUP_COMPILED_FILES].sort()
    )
  )
    throw new Error('Post-cleanup critical candidate dependency coverage changed');
}

export function assessPostCleanupAuditDraft({
  policy,
  definitions,
  expectedCurrent,
  stage,
  checks,
  sources,
  metadata,
  before,
  identity,
  scope,
  cleanupReceiptSha256
}) {
  validatePostCleanupPolicyDraft(policy, definitions, expectedCurrent);
  if (
    !['before', 'after'].includes(stage) ||
    !/^id_business_audit@/.test(identity?.currentUser) ||
    identity.transactionIsolation !== 'REPEATABLE-READ' ||
    String(identity.foreignKeyChecks) !== '1' ||
    String(identity.sessionReadOnly) !== '1' ||
    identity.databaseName !== HISTORY_POST_CLEANUP_DATABASE ||
    String(identity.readOnly) !== '0' ||
    String(identity.superReadOnly) !== '0' ||
    String(scope?.targetOrdersCount) !== '0' ||
    String(scope?.protectedThirdOrderCount) !== '1' ||
    cleanupReceiptSha256 !== HISTORY_POST_CLEANUP_RECEIPT_SHA256
  )
    throw new Error('Post-cleanup database, original cleanup or read-only identity changed');
  if (!equal(checks.map((item) => item.code).sort(), definitions.map((item) => item.code).sort()))
    throw new Error('Post-cleanup audit rule coverage changed');
  for (const check of checks) {
    const expected =
      check.code === 'cash_historical_cost_evidence_mismatch' ? POST_CLEANUP_COST_ENTITY_IDS : [];
    if (
      check.status !== 'EXECUTED' ||
      check.count !== expected.length ||
      !Array.isArray(check.samples) ||
      !equal(check.samples.map((sample) => sample.entityId).sort(), [...expected].sort())
    )
      throw new Error('New, missing, changed or unexecuted post-cleanup finding');
  }
  if (!equal(Object.keys(sources).sort(), Object.keys(policy.sources).sort()))
    throw new Error('Post-cleanup source coverage changed');
  for (const [name, frozen] of Object.entries(policy.sources))
    if (sources[name]?.sha256 !== frozen.sha256 || sources[name]?.rowCount !== frozen.rowCount)
      throw new Error('Post-cleanup frozen money, state, version or cash chain changed');
  if (
    !equal(metadata.map((row) => row.id).sort(), [...postCleanupJournalIds].sort()) ||
    metadata.some((row) => !sha256Value(row.metadataSha256)) ||
    fingerprintRows(metadata) !== policy.metadataSha256
  )
    throw new Error('Post-cleanup original metadata changed');
  if (
    stage === 'after' &&
    (before?.gate?.accepted !== true ||
      before.gate.status !== 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS' ||
      before.gate.policyId !== policy.id ||
      before.gate.expectedCurrent !== expectedCurrent ||
      before.gate.stage !== 'before' ||
      before.gate.checkCount !== 49 ||
      before.gate.executedCheckCount !== 49 ||
      before.gate.unavailableCheckCount !== 0 ||
      before.gate.violationCount !== 5 ||
      before.gate.sourceAnchorSha256 !== policy.sourceAnchorSha256 ||
      !equal(before.gate.sources, sources) ||
      before.gate.metadataSha256 !== policy.metadataSha256 ||
      before.gate.cleanupReceiptSha256 !== cleanupReceiptSha256)
  )
    throw new Error('Post-cleanup before receipt or source changed during release');
  return {
    accepted: false,
    status: 'POST_CLEANUP_DRAFT_VERIFIED_NOT_ACTIVATED',
    policyId: policy.id,
    expectedCurrent,
    stage,
    checkCount: 49,
    executedCheckCount: 49,
    unavailableCheckCount: 0,
    violationCount: 5,
    sourceAnchorSha256: policy.sourceAnchorSha256,
    sources,
    metadataSha256: policy.metadataSha256,
    cleanupReceiptSha256
  };
}

export function acceptSealedPostCleanupAudit(
  input,
  { seal, sealSha256, sealBytes, cleanupReceiptBytes, candidateCommit, candidateTree }
) {
  const draft = assessPostCleanupAuditDraft(input);
  if (
    !sha256Value(HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256) ||
    input.policy.sourceAnchorSha256 !== HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256 ||
    !Buffer.isBuffer(sealBytes) ||
    !Buffer.isBuffer(cleanupReceiptBytes) ||
    createHash('sha256').update(sealBytes).digest('hex') !== sealSha256 ||
    createHash('sha256').update(cleanupReceiptBytes).digest('hex') !==
      HISTORY_POST_CLEANUP_RECEIPT_SHA256 ||
    !equal(JSON.parse(sealBytes.toString()), seal) ||
    seal?.version !== 1 ||
    seal.policyId !== HISTORY_POST_CLEANUP_POLICY_ID ||
    seal.userApproved !== true ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,299}$/.test(seal.approvalReference ?? '') ||
    seal.expectedCurrent !== HISTORY_POST_CLEANUP_BASELINE ||
    seal.activeDatabase !== HISTORY_POST_CLEANUP_DATABASE ||
    seal.sourceAnchorSha256 !== input.policy.sourceAnchorSha256 ||
    seal.policySha256 !== fingerprint(input.policy) ||
    seal.candidateBindingsSha256 !== fingerprint(input.policy.candidateBindings) ||
    !/^[a-f0-9]{40}$/.test(candidateCommit ?? '') ||
    candidateCommit === HISTORY_POST_CLEANUP_BASELINE ||
    seal.candidateCommit !== candidateCommit ||
    !/^[a-f0-9]{40}$/.test(candidateTree ?? '') ||
    seal.candidateTree !== candidateTree ||
    !/^sha256:[a-f0-9]{64}$/.test(seal.apiImage ?? '')
  )
    throw new Error('Post-cleanup independent source or reviewed runtime seal required');
  const receipt = JSON.parse(cleanupReceiptBytes.toString());
  if (
    receipt?.ok !== true ||
    receipt.status !== 'POST_OPEN_READONLY_RUNTIME_AND_TWO_ORDER_SCOPE_VERIFIED' ||
    receipt.databaseName !== HISTORY_POST_CLEANUP_DATABASE ||
    receipt.release?.commit !== HISTORY_POST_CLEANUP_BASELINE ||
    receipt.normalWritesOpened !== true ||
    receipt.databaseMutationCommands !== 0 ||
    receipt.credentialsExported !== false
  )
    throw new Error('Post-cleanup immutable completion receipt changed');
  if (
    input.stage === 'after' &&
    (input.before?.gate?.releaseSealSha256 !== sealSha256 ||
      input.before.gate.candidateCommit !== candidateCommit ||
      input.before.gate.candidateTree !== candidateTree ||
      input.before.gate.apiImage !== seal.apiImage)
  )
    throw new Error('Post-cleanup approved candidate changed during release');
  return {
    ...draft,
    accepted: true,
    status: 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS',
    releaseSealSha256: sealSha256,
    candidateCommit,
    candidateTree,
    apiImage: seal.apiImage
  };
}
