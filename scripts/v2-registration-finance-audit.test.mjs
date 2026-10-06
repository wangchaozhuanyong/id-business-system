import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as integrity from './lib/v2-data-integrity-audit.mjs';
import * as history from './lib/v2-release-history-policy.mjs';
import {
  CLEARANCE_SHA256,
  FINANCE_MODE,
  approvedReversalEvidence,
  assessRegistrationFinanceSnapshot,
  parseRegistrationFinanceArgs,
  readRegistrationFinanceSnapshot
} from './v2-registration-finance-audit.mjs';

const profile = JSON.parse(
  readFileSync(new URL('../deploy/aws/registration-worker-b8-80-20261006.json', import.meta.url))
);
const libraries = { integrity, history };
const frozen = {
  releaseSealSha256: profile.financeValidator.releaseSealSha256,
  candidateCommit: profile.expectedCurrent
};
const snapshot = () => ({
  identity: {
    currentUser: 'id_business_audit@synthetic',
    databaseName: history.HISTORY_POST_CLEANUP_DATABASE,
    transactionIsolation: 'REPEATABLE-READ',
    sessionReadOnly: '1',
    foreignKeyChecks: '1',
    readOnly: '0',
    superReadOnly: '0'
  },
  checks: integrity.V2_DATA_INTEGRITY_CHECKS.map(({ code }) => ({
    code,
    count: 0,
    samples: [],
    status: 'EXECUTED'
  })),
  sources: structuredClone(profile.financeClearance.sources),
  metadataSha256: profile.financeClearance.metadataSha256,
  reversalChainSha256: profile.financeClearance.reversalChainSha256,
  reversalAuditSha256: profile.financeClearance.reversalAuditSha256,
  scope: { targetOrdersCount: '0', protectedThirdOrderCount: '1' }
});
const assess = (value, stage = 'before', before) =>
  assessRegistrationFinanceSnapshot(profile, stage, value, frozen, libraries, before);

test('only the reviewed five-reversal seal and unchanged 49 rules are selected', () => {
  assert.equal(history.fingerprint(profile.financeClearance), CLEARANCE_SHA256);
  assert.equal(
    history.fingerprint(integrity.V2_DATA_INTEGRITY_CHECKS),
    profile.financeClearance.rulesSha256
  );
  const result = assess(snapshot());
  assert.equal(result.ok, true);
  assert.equal(result.violationCount, 0);
  assert.equal(result.gate.status, FINANCE_MODE);
  assert.equal(result.gate.reversalCount, 5);
  assert.equal(result.gate.sourcePolicyId, profile.financeValidator.policyId);
  assert.equal(result.gate.clearanceSealSha256, CLEARANCE_SHA256);
  assert.deepEqual(assess(snapshot(), 'after', result).checks, result.checks);
});

test('each rule rejects new findings, old five findings, skipped status and nonempty samples', () => {
  for (let i = 0; i < 49; i++) {
    for (const patch of [
      { count: 1 },
      { count: 5 },
      { count: -1 },
      { count: '0' },
      { status: 'SKIPPED' },
      { samples: [{ entityId: 'synthetic-hidden' }] }
    ]) {
      const value = snapshot();
      Object.assign(value.checks[i], patch);
      assert.throws(() => assess(value));
    }
  }
  for (const value of [snapshot().checks.slice(1), [...snapshot().checks, snapshot().checks[0]]])
    assert.throws(() => assess({ ...snapshot(), checks: value }));
  const duplicate = snapshot();
  duplicate.checks[1].code = duplicate.checks[0].code;
  assert.throws(() => assess(duplicate));
});

test('all six sources, metadata, approved audit and mirror fingerprints remain frozen', () => {
  for (const name of Object.keys(profile.financeClearance.sources)) {
    for (const field of ['rowCount', 'sha256']) {
      const value = snapshot();
      value.sources[name][field] = field === 'rowCount' ? 999 : '0'.repeat(64);
      assert.throws(() => assess(value));
    }
  }
  for (const name of ['metadataSha256', 'reversalAuditSha256', 'reversalChainSha256'])
    assert.throws(() => assess({ ...snapshot(), [name]: '0'.repeat(64) }));
  const expanded = structuredClone(profile);
  expanded.financeClearance.sources.accounts.sha256 = '0'.repeat(64);
  assert.throws(() =>
    assessRegistrationFinanceSnapshot(expanded, 'before', snapshot(), frozen, libraries)
  );
});

test('read-only identity, repeatable snapshot and original order scope are required', () => {
  for (const [key, wrong] of Object.entries({
    currentUser: 'synthetic_writer@host',
    databaseName: 'synthetic_other',
    transactionIsolation: 'READ-COMMITTED',
    sessionReadOnly: '0',
    foreignKeyChecks: '0',
    readOnly: '1',
    superReadOnly: '1'
  })) {
    const value = snapshot();
    value.identity[key] = wrong;
    assert.throws(() => assess(value));
  }
  for (const scope of [
    { targetOrdersCount: 1, protectedThirdOrderCount: 1 },
    { targetOrdersCount: 0, protectedThirdOrderCount: 0 }
  ])
    assert.throws(() => assess({ ...snapshot(), scope }));
});

test('before and after cannot change gate mode, facts or provenance', () => {
  const before = assess(snapshot());
  assert.throws(() => assess(snapshot(), 'after'));
  for (const patch of [
    { status: 'APPROVED_ORDER_ARCHIVE_HISTORICAL_EXCEPTIONS' },
    { violationCount: 5 },
    { stage: 'after' },
    { sourceCommit: '0'.repeat(40) },
    { clearanceSealSha256: '0'.repeat(64) }
  ]) {
    const changed = structuredClone(before);
    Object.assign(changed.gate, patch);
    assert.throws(() => assess(snapshot(), 'after', changed));
  }
  const changed = structuredClone(before);
  changed.checks[0].status = 'SKIPPED';
  assert.throws(() => assess(snapshot(), 'after', changed));
  assert.throws(() => assess(snapshot(), 'before', before));
  assert.throws(() => assess(snapshot(), 'unknown'));
});

test('only unique original targets and exact reversal-to-owned-audit joins qualify', () => {
  const ids = Array.from({ length: 5 }, (_, i) => 'synthetic-original-' + i);
  const mirrors = ids.map((id, i) => ({ id, reversalId: 'synthetic-reversal-' + i }));
  const audits = ids.map((originalJournalId, i) => ({
    id: 'synthetic-audit-' + i,
    actorId: 'synthetic-actor',
    originalJournalId,
    reversalJournalId: mirrors[i].reversalId,
    reasonSha256: '1'.repeat(64),
    createdAt: 'synthetic-time'
  }));
  assert.deepEqual(
    Object.keys(approvedReversalEvidence(mirrors, audits, ids, history.fingerprintRows)).sort(),
    ['reversalAuditSha256', 'reversalChainSha256']
  );
  for (const index of [0, 1, 2, 3, 4]) {
    const changed = structuredClone(audits);
    changed[index].reversalJournalId = 'unapproved';
    assert.throws(() => approvedReversalEvidence(mirrors, changed, ids, history.fingerprintRows));
    changed[index] = { ...audits[index], actorId: null };
    assert.throws(() => approvedReversalEvidence(mirrors, changed, ids, history.fingerprintRows));
  }
  assert.throws(() =>
    approvedReversalEvidence(mirrors.slice(1), audits, ids, history.fingerprintRows)
  );
  assert.throws(() =>
    approvedReversalEvidence(mirrors, [...audits.slice(1), audits[1]], ids, history.fingerprintRows)
  );
});

test('closed arguments forbid zero-stage reuse and unknown options', () => {
  const args = [
    '--profile=profile',
    '--policy=policy',
    '--stage=before',
    '--seal=seal',
    '--cleanup-receipt=cleanup'
  ];
  assert.equal(parseRegistrationFinanceArgs(args).stage, 'before');
  for (const extra of [
    '--stage=after',
    '--before-receipt=before',
    '--allow-exceptions=true',
    '--profile=other'
  ])
    assert.throws(() => parseRegistrationFinanceArgs([...args, extra]));
  const after = args.map((arg) => (arg === '--stage=before' ? '--stage=after' : arg));
  assert.throws(() => parseRegistrationFinanceArgs(after));
  assert.equal(parseRegistrationFinanceArgs([...after, '--before-receipt=before']).stage, 'after');
});

test('snapshot queries are read-only and all 49 execute before source and reversal checks', async () => {
  const ids = profile.financeClearance.sources.journals.ids;
  const queries = [];
  const policy = {
    sources: Object.fromEntries(
      Object.keys(history.postCleanupSourceQueries).map((name) => [
        name,
        { ids: [...profile.financeClearance.sources[name].ids] }
      ])
    )
  };
  const tx = {
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      assert.match(sql, /^(SELECT|WITH) /);
      if (sql.includes(' AS count FROM ')) return [{ count: '0' }];
      if (sql.startsWith('SELECT CURRENT_USER')) return [snapshot().identity];
      if (sql.includes('original_journal_id AS id'))
        return ids.map((id, i) => ({ id, reversalId: 'synthetic-reversal-' + i }));
      if (sql.includes('user_id AS actorId'))
        return ids.map((originalJournalId, i) => ({
          id: 'synthetic-audit-' + i,
          actorId: 'synthetic-actor',
          originalJournalId,
          reversalJournalId: 'synthetic-reversal-' + i
        }));
      if (sql.startsWith('SELECT COALESCE(SUM')) return [snapshot().scope];
      return [];
    }
  };
  const result = await readRegistrationFinanceSnapshot(tx, profile, policy, {
    ...libraries,
    cash: { HISTORICAL_CASH_ADJUSTMENT_CTES: 'synthetic AS (SELECT 1)' }
  });
  assert.equal(result.checks.length, 49);
  assert.equal(queries.filter((query) => query.includes(' AS count FROM ')).length, 49);
  assert.equal(queries.findIndex((query) => query.includes('user_id AS actorId')) > 49, true);
  assert.equal(
    queries.some((query) => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE TABLE)\b/i.test(query)),
    false
  );
});

test('database read snapshot passes assessment with the exact reviewed source ID lists', async () => {
  const policy = { sources: structuredClone(profile.financeClearance.sources) };
  const ids = policy.sources.journals.ids;
  const sourceQueries = new Map(
    Object.entries(history.postCleanupSourceQueries).map(([name, query]) => [
      query.sql.replace('IDS', policy.sources[name].ids.map(() => '?').join(',')),
      name
    ])
  );
  const queries = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      queries.push(sql);
      if (sql.startsWith('SELECT CURRENT_USER')) return [snapshot().identity];
      if (sql.includes(' AS count FROM ')) return [{ count: '0' }];
      const source = sourceQueries.get(sql);
      if (source) {
        assert.equal(
          history.fingerprint(params) === history.fingerprint(policy.sources[source].ids),
          true
        );
        return Array.from(
          { length: profile.financeClearance.sources[source].rowCount },
          (_, index) => ({
            id: 'synthetic-' + source + '-' + index,
            source
          })
        );
      }
      if (sql.includes('original_journal_id AS id'))
        return ids.map((id, index) => ({ id, reversalId: 'synthetic-reversal-' + index }));
      if (sql.includes('user_id AS actorId'))
        return ids.map((originalJournalId, index) => ({
          id: 'synthetic-audit-' + index,
          actorId: 'synthetic-actor',
          originalJournalId,
          reversalJournalId: 'synthetic-reversal-' + index
        }));
      if (sql.startsWith('SELECT COALESCE(SUM')) return [snapshot().scope];
      return [{ id: 'synthetic-metadata', metadataSha256: 'synthetic-metadata-sha' }];
    }
  };
  const connectedLibraries = {
    ...libraries,
    history: {
      ...history,
      fingerprintRows(rows) {
        if (rows[0]?.source) return profile.financeClearance.sources[rows[0].source].sha256;
        if (rows[0]?.reversalId) return profile.financeClearance.reversalChainSha256;
        if (rows[0]?.actorId) return profile.financeClearance.reversalAuditSha256;
        return profile.financeClearance.metadataSha256;
      }
    },
    cash: { HISTORICAL_CASH_ADJUSTMENT_CTES: 'synthetic AS (SELECT 1)' }
  };
  const read = await readRegistrationFinanceSnapshot(tx, profile, policy, connectedLibraries);
  const before = assessRegistrationFinanceSnapshot(
    profile,
    'before',
    read,
    frozen,
    connectedLibraries
  );
  assert.equal(before.ok, true);
  for (const name of Object.keys(policy.sources)) {
    assert.equal(
      history.fingerprint(read.sources[name].ids) === history.fingerprint(policy.sources[name].ids),
      true
    );
    assert.notEqual(read.sources[name].ids, policy.sources[name].ids);
  }
  assert.equal(
    assessRegistrationFinanceSnapshot(profile, 'after', read, frozen, connectedLibraries, before)
      .ok,
    true
  );
  const alteredPolicy = structuredClone(policy);
  alteredPolicy.sources.accounts.ids.push('synthetic-unreviewed');
  await assert.rejects(() =>
    readRegistrationFinanceSnapshot(tx, profile, alteredPolicy, connectedLibraries)
  );
  assert.equal(
    queries.every((sql) => /^(SELECT|WITH) /.test(sql)),
    true
  );
});
