// One-use mailbox release approval; shared helpers below only collect read-only facts.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries
} from './lib/v2-data-integrity-audit.mjs';
import {
  collectClosedFacts,
  fingerprint,
  schemaQueries,
  validateAuditUrl
} from './lib/v2-release-maintenance-policy.mjs';

export const MAILBOX_POLICY_ID = 'historical-finance-20261005-mailbox-batch';
export const MAILBOX_BASELINE = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0';
export const MAILBOX_IMAGE_COMMIT = 'f5826f9fb4ad0d846d9875c035c913a61eb68290';
export const MAILBOX_POLICY_SHA256 =
  'f3051a718cdbd55840d50affe6e5e1ddc62f187ff231f309679998608189481c';
const COST = 'cash_historical_cost_evidence_mismatch';
const requireFact = (value) => {
  if (!value) throw new Error('MAILBOX_GATE_REJECTED');
};

export async function collectMailboxSnapshot(client) {
  try {
    await client.$connect();
    assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
    await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
    return await client.$transaction(
      async (tx) => {
        const identities = await tx.$queryRawUnsafe(
          'SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, @@transaction_isolation AS transactionIsolation, @@session.foreign_key_checks AS foreignKeyChecks, @@session.transaction_read_only AS transactionReadOnly'
        );
        const identity = identities[0];
        requireFact(
          identities.length === 1 &&
            identity.databaseName === 'id_business_v2_partial_cleanup_20261005_v1' &&
            /^id_business_audit@/.test(identity.currentUser) &&
            identity.transactionIsolation === 'REPEATABLE-READ' &&
            String(identity.foreignKeyChecks) === '1' &&
            String(identity.transactionReadOnly) === '1'
        );
        const q = schemaQueries();
        const columns = await tx.$queryRawUnsafe(q.columns, ...q.tables);
        const schema = {
          columns,
          tables: await tx.$queryRawUnsafe(q.tablesSql, ...q.tables),
          indexes: await tx.$queryRawUnsafe(q.indexes, ...q.tables),
          relations: await tx.$queryRawUnsafe(q.relations, ...q.tables),
          database: (await tx.$queryRawUnsafe(q.database))[0]
        };
        requireFact(
          schema.tables.length === q.tables.length &&
            schema.tables.every((row) => row.engine === 'InnoDB') &&
            schema.relations.every((row) => Number(row.localReference) === 1)
        );
        const checks = [];
        let ids;
        for (const definition of V2_DATA_INTEGRITY_CHECKS) {
          const counts = await tx.$queryRawUnsafe(
            buildV2DataIntegrityCheckQueries(definition.sql).count
          );
          requireFact(counts.length === 1 && /^[0-9]+$/.test(String(counts[0].count)));
          const count = Number(counts[0].count);
          requireFact(Number.isSafeInteger(count) && count === (definition.code === COST ? 6 : 0));
          if (count) {
            const rows = await tx.$queryRawUnsafe(
              'SELECT entity_id AS id FROM (' + definition.sql + ') violations ORDER BY entity_id'
            );
            ids = rows.map((row) => String(row.id));
            requireFact(ids.length === 6 && new Set(ids).size === 6);
          }
          checks.push({ code: definition.code, status: 'EXECUTED', count });
        }
        requireFact(checks.length === 48);
        // Complete journal, all journal lines, and predicate vectors stay in process memory.
        const facts = await collectClosedFacts(tx, ids, columns);
        return {
          databaseName: identity.databaseName,
          rulesSha256: fingerprint(V2_DATA_INTEGRITY_CHECKS),
          schemaSha256: fingerprint(schema),
          entitySetSha256: fingerprint([...ids].sort()),
          closedFactsSha256: fingerprint([...facts].sort(([a], [b]) => a.localeCompare(b, 'en'))),
          checks
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

export function acceptMailboxSnapshot(policy, snapshot, stage, before) {
  requireFact(
    fingerprint(policy) === MAILBOX_POLICY_SHA256 &&
      policy.id === MAILBOX_POLICY_ID &&
      policy.userApproved === true &&
      policy.expectedCurrent === MAILBOX_BASELINE &&
      policy.imageCommit === MAILBOX_IMAGE_COMMIT &&
      policy.imageRun === '37312405714' &&
      policy.imageAttempt === '1' &&
      policy.externalTestAcknowledged === true &&
      fingerprint(policy.servicesUpdated) === fingerprint(['api']) &&
      fingerprint(snapshot) === fingerprint(policy.snapshot) &&
      ['before', 'after'].includes(stage)
  );
  const gate = {
    accepted: true,
    status: 'APPROVED_MAILBOX_FROZEN_EXCEPTIONS',
    policyId: MAILBOX_POLICY_ID,
    policySha256: MAILBOX_POLICY_SHA256,
    expectedCurrent: MAILBOX_BASELINE,
    fixedCurrent: MAILBOX_BASELINE,
    imageCommit: MAILBOX_IMAGE_COMMIT,
    imageRun: '37312405714',
    imageAttempt: '1',
    servicesUpdated: ['api'],
    stage,
    checkCount: 48,
    executedCheckCount: 48,
    unavailableCheckCount: 0,
    violationCount: 6,
    snapshotSha256: fingerprint(snapshot)
  };
  if (stage === 'after') {
    requireFact(
      before?.stage === 'before' && fingerprint({ ...before, stage }) === fingerprint(gate)
    );
  } else requireFact(before === undefined);
  return gate;
}

async function main() {
  try {
    const args = {};
    for (const arg of process.argv.slice(2)) {
      const match = arg.match(/^--(policy|stage|expected-current|before-receipt)=(.+)$/);
      requireFact(match && !Object.hasOwn(args, match[1]));
      args[match[1]] = match[2];
    }
    requireFact(
      args.policy === `/release-policy/${MAILBOX_POLICY_ID}.json` &&
        args['expected-current'] === MAILBOX_BASELINE &&
        ['before', 'after'].includes(args.stage) &&
        (args.stage === 'after'
          ? args['before-receipt'] === '/release-before-audit.json'
          : args['before-receipt'] === undefined)
    );
    const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
    requireFact(fingerprint(policy) === MAILBOX_POLICY_SHA256);
    const before =
      args.stage === 'after'
        ? JSON.parse(readFileSync(args['before-receipt'], 'utf8')).gate
        : undefined;
    const { PrismaClient } = await import('@prisma/client');
    const url = validateAuditUrl(process.env.V2_DATA_INTEGRITY_DATABASE_URL);
    const snapshot = await collectMailboxSnapshot(
      new PrismaClient({ datasources: { db: { url } }, log: [] })
    );
    const gate = acceptMailboxSnapshot(policy, snapshot, args.stage, before);
    console.log(
      JSON.stringify({
        ok: false,
        checkCount: 48,
        violationCount: 6,
        checks: snapshot.checks,
        gate
      })
    );
  } catch {
    console.error('MAILBOX_GATE_REJECTED');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
