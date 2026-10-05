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
const diagnosticsPolicySha256 = 'a4bdc86d86661aed440921b148e9a95f1516370d3a5394af132e12954e31dd20';
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
    throw new Error('Historical diagnostics changed the approved three source files');
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
