import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CLEARANCE_SHA256 = '46f1b091459ba540af2c26a2fad3136d1ca4b7f269d2a77bd6c97c48976ee520';
export const FINANCE_MODE = 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (value) => {
  if (!value) throw new Error('Fixed registration approved reversal audit rejected');
};
const jsonBytes = (path) => {
  const raw = readFileSync(path);
  requireValue(raw.length > 0 && raw.length <= 4 * 1024 * 1024);
  return raw;
};

export function parseRegistrationFinanceArgs(values) {
  const allowed = ['profile', 'policy', 'stage', 'seal', 'cleanup-receipt', 'before-receipt'];
  const args = {};
  for (const value of values) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    requireValue(match && allowed.includes(match[1]) && !Object.hasOwn(args, match[1]));
    args[match[1]] = match[2];
  }
  requireValue(
    allowed.slice(0, 5).every((key) => args[key]) && ['before', 'after'].includes(args.stage)
  );
  requireValue(args.stage === 'after' ? Boolean(args['before-receipt']) : !args['before-receipt']);
  return args;
}

export function approvedReversalEvidence(mirrors, audits, originalIds, fingerprintRows) {
  const expected = [...originalIds].sort();
  requireValue(mirrors.length === 5 && audits.length === 5 && new Set(expected).size === 5);
  requireValue(JSON.stringify(mirrors.map((row) => row.id).sort()) === JSON.stringify(expected));
  requireValue(
    JSON.stringify(audits.map((row) => row.originalJournalId).sort()) === JSON.stringify(expected)
  );
  requireValue(
    new Set(audits.map((row) => row.id)).size === 5 &&
      new Set(mirrors.map((row) => row.reversalId)).size === 5
  );
  requireValue(
    audits.every(
      (row) =>
        row.actorId &&
        mirrors.some(
          (mirror) =>
            mirror.id === row.originalJournalId && mirror.reversalId === row.reversalJournalId
        )
    )
  );
  return {
    reversalChainSha256: fingerprintRows(mirrors),
    reversalAuditSha256: fingerprintRows(audits)
  };
}

export function registrationZeroGate(profile, stage, frozen, fingerprint) {
  const seal = profile.financeClearance;
  requireValue(fingerprint(seal) === CLEARANCE_SHA256 && seal.mode === FINANCE_MODE);
  return {
    ...frozen,
    accepted: true,
    status: FINANCE_MODE,
    stage,
    checkCount: 49,
    executedCheckCount: 49,
    unavailableCheckCount: 0,
    violationCount: 0,
    sourceCommit: seal.sourceCommit,
    sourcePolicyId: profile.financeValidator.policyId,
    clearanceSealSha256: CLEARANCE_SHA256,
    rulesSha256: seal.rulesSha256,
    checksSha256: seal.checksSha256,
    sources: seal.sources,
    metadataSha256: seal.metadataSha256,
    reversalCount: 5,
    reversalAuditSha256: seal.reversalAuditSha256,
    reversalChainSha256: seal.reversalChainSha256,
    scope: { targetOrdersCount: 0, protectedThirdOrderCount: 1 }
  };
}

export function assessRegistrationFinanceSnapshot(
  profile,
  stage,
  snapshot,
  frozen,
  libraries,
  before
) {
  const { fingerprint, HISTORY_POST_CLEANUP_DATABASE } = libraries.history;
  const definitions = libraries.integrity.V2_DATA_INTEGRITY_CHECKS;
  const gate = registrationZeroGate(profile, stage, frozen, fingerprint);
  const identity = snapshot.identity;
  requireValue(
    ['before', 'after'].includes(stage) &&
      definitions.length === 49 &&
      fingerprint(definitions) === gate.rulesSha256
  );
  requireValue(
    /^id_business_audit@/.test(identity?.currentUser) &&
      identity.databaseName === HISTORY_POST_CLEANUP_DATABASE &&
      identity.transactionIsolation === 'REPEATABLE-READ' &&
      String(identity.sessionReadOnly) === '1' &&
      String(identity.foreignKeyChecks) === '1' &&
      String(identity.readOnly) === '0' &&
      String(identity.superReadOnly) === '0'
  );
  requireValue(
    snapshot.checks.length === 49 &&
      new Set(snapshot.checks.map((item) => item.code)).size === 49 &&
      snapshot.checks.every(
        (item) =>
          item.status === 'EXECUTED' &&
          Number.isSafeInteger(item.count) &&
          item.count === 0 &&
          Array.isArray(item.samples) &&
          item.samples.length === 0
      ) &&
      fingerprint(snapshot.checks) === gate.checksSha256
  );
  requireValue(
    fingerprint(snapshot.sources) === fingerprint(gate.sources) &&
      snapshot.metadataSha256 === gate.metadataSha256 &&
      snapshot.reversalChainSha256 === gate.reversalChainSha256 &&
      snapshot.reversalAuditSha256 === gate.reversalAuditSha256 &&
      String(snapshot.scope.targetOrdersCount) === '0' &&
      String(snapshot.scope.protectedThirdOrderCount) === '1'
  );
  if (stage === 'after')
    requireValue(
      before?.ok === true &&
        before.checkCount === 49 &&
        before.violationCount === 0 &&
        fingerprint(before.gate) ===
          fingerprint(registrationZeroGate(profile, 'before', frozen, fingerprint)) &&
        fingerprint(before.checks) === fingerprint(snapshot.checks) &&
        fingerprint(before.identity) === fingerprint(identity)
    );
  else requireValue(!before);
  return {
    ok: true,
    checkCount: 49,
    violationCount: 0,
    failedChecks: [],
    identity,
    checks: snapshot.checks,
    gate
  };
}

export async function readRegistrationFinanceSnapshot(tx, profile, policy, libraries) {
  const { integrity, history, cash } = libraries;
  const [identity] = await tx.$queryRawUnsafe(
    'SELECT CURRENT_USER() AS currentUser, DATABASE() AS databaseName, ' +
      '@@transaction_isolation AS transactionIsolation, @@session.foreign_key_checks AS foreignKeyChecks, ' +
      '@@global.read_only AS readOnly, @@global.super_read_only AS superReadOnly, @@session.transaction_read_only AS sessionReadOnly'
  );
  const checks = [];
  for (const definition of integrity.V2_DATA_INTEGRITY_CHECKS) {
    const [result] = await tx.$queryRawUnsafe(
      integrity.buildV2DataIntegrityCheckQueries(definition.sql).count
    );
    checks.push({
      code: definition.code,
      count: Number(result.count),
      samples: [],
      status: 'EXECUTED'
    });
  }
  const sources = {};
  for (const [name, query] of Object.entries(history.postCleanupSourceQueries)) {
    const ids = policy.sources[name].ids;
    requireValue(
      history.fingerprint(ids) === history.fingerprint(profile.financeClearance.sources[name].ids)
    );
    const rows = await tx.$queryRawUnsafe(
      query.sql.replace('IDS', ids.map(() => '?').join(',')),
      ...ids
    );
    sources[name] = { ids: [...ids], rowCount: rows.length, sha256: history.fingerprintRows(rows) };
  }
  const ids = policy.sources.journals.ids;
  const marks = ids.map(() => '?').join(',');
  const metadata = await tx.$queryRawUnsafe(
    "SELECT id, CAST(SHA2(IF(metadata IS NULL, 'NULL', CAST(metadata AS CHAR)), 256) AS CHAR) AS metadataSha256 " +
      'FROM id_business_v2_finance_journals WHERE id IN (' +
      marks +
      ')',
    ...ids
  );
  const mirrors = await tx.$queryRawUnsafe(
    'WITH ' +
      cash.HISTORICAL_CASH_ADJUSTMENT_CTES +
      ' SELECT original_journal_id AS id, reversal_journal_id AS reversalId FROM historical_exact_reversals ' +
      'WHERE original_journal_id IN (' +
      marks +
      ')',
    ...ids
  );
  const audits = await tx.$queryRawUnsafe(
    'SELECT id,user_id AS actorId,object_id AS originalJournalId,' +
      "JSON_UNQUOTE(JSON_EXTRACT(after_data,'$.reversalJournalId')) AS reversalJournalId," +
      "CAST(SHA2(JSON_UNQUOTE(JSON_EXTRACT(after_data,'$.reason')),256) AS CHAR) AS reasonSha256," +
      "DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt FROM audit_logs " +
      "WHERE module='id_business_v2_finance' AND action='id_business_v2.finance_journal.reverse' " +
      "AND object_type='id_business_v2_finance_journal' AND object_id IN (" +
      marks +
      ')',
    ...ids
  );
  const [scope] = await tx.$queryRawUnsafe(
    'SELECT ' +
      'COALESCE(SUM(SHA2(CAST(id AS CHAR),256) IN (?,?)),0) AS targetOrdersCount,' +
      'COALESCE(SUM(SHA2(CAST(id AS CHAR),256)=?),0) AS protectedThirdOrderCount FROM id_business_v2_orders',
    ...profile.financeClearance.scope.deletedOrderSha256,
    profile.financeClearance.scope.protectedOrderSha256
  );
  return {
    identity,
    checks,
    sources,
    metadataSha256: history.fingerprintRows(metadata),
    scope,
    ...approvedReversalEvidence(mirrors, audits, ids, history.fingerprintRows)
  };
}

async function main() {
  const args = parseRegistrationFinanceArgs(process.argv.slice(2));
  const libraries = {};
  for (const [name, file] of Object.entries({
    integrity: 'v2-data-integrity-audit.mjs',
    history: 'v2-release-history-policy.mjs',
    cash: 'v2-historical-cash-adjustment-audit.mjs',
    archive: 'v2-order-archive-release-policy.mjs'
  }))
    libraries[name] = await import(pathToFileURL('/app/scripts/lib/' + file));
  const profile = JSON.parse(jsonBytes(args.profile));
  requireValue(libraries.history.fingerprint(profile.financeClearance) === CLEARANCE_SHA256);
  const policyBytes = jsonBytes(args.policy);
  const policy = JSON.parse(policyBytes);
  requireValue(sha(policyBytes) === profile.financeValidator.policyRawSha256);
  libraries.archive.validateOrderArchivePolicyDraft(
    policy,
    libraries.integrity.V2_DATA_INTEGRITY_CHECKS,
    libraries.archive.ORDER_ARCHIVE_BASELINE
  );
  const sealBytes = jsonBytes(args.seal);
  const frozen = libraries.archive.validateOrderArchiveReviewSeal(policy, {
    seal: JSON.parse(sealBytes),
    sealBytes,
    sealSha256: profile.financeValidator.releaseSealSha256,
    cleanupReceiptBytes: jsonBytes(args['cleanup-receipt']),
    candidateCommit: profile.baselineRelease.commit,
    candidateTree: profile.baselineRelease.sourceTree
  });
  for (const [file, expected] of Object.entries(policy.candidateBindings.compiledServiceHashes))
    requireValue(sha(readFileSync('/app/' + file)) === expected);
  const { PrismaClient } = createRequire('/app/package.json')('@prisma/client');
  const databaseUrl = process.env.V2_DATA_INTEGRITY_DATABASE_URL;
  requireValue(databaseUrl?.startsWith('mysql://'));
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
  try {
    await client.$connect();
    libraries.integrity.assertV2AuditConnectionReadOnly(
      await client.$queryRawUnsafe('SHOW GRANTS')
    );
    await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
    const before = args['before-receipt']
      ? JSON.parse(jsonBytes(args['before-receipt']))
      : undefined;
    const report = await client.$transaction(
      async (tx) =>
        assessRegistrationFinanceSnapshot(
          profile,
          args.stage,
          await readRegistrationFinanceSnapshot(tx, profile, policy, libraries),
          frozen,
          libraries,
          before
        ),
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
    console.log(
      JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    );
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        reason: 'Fixed registration approved reversal audit rejected; raw data suppressed'
      })
    );
    process.exitCode = 1;
  }
}
