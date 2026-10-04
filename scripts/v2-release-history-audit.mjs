import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries,
  normalizeV2DataIntegritySamples
} from './lib/v2-data-integrity-audit.mjs';
import {
  acceptHistoricalAudit,
  fingerprintRows,
  historySourceQueries,
  serializeHistoricalAuditReport,
  validateHistoryPolicy
} from './lib/v2-release-history-policy.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--(policy|stage|expected-current|before-receipt)=(.+)$/);
    if (!match) throw new Error('Unknown historical audit option');
    return [match[1], match[2]];
  })
);
const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
validateHistoryPolicy(policy, V2_DATA_INTEGRITY_CHECKS, args['expected-current']);
const before = args['before-receipt']
  ? JSON.parse(readFileSync(args['before-receipt'], 'utf8'))
  : null;
const databaseUrl = process.env.V2_DATA_INTEGRITY_DATABASE_URL;
if (!databaseUrl?.startsWith('mysql://')) throw new Error('Read-only MySQL audit URL required');
const client = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
try {
  await client.$connect();
  assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
  await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
  const report = await client.$transaction(
    async (tx) => {
      const [identity] = await tx.$queryRawUnsafe(`SELECT CURRENT_USER() AS currentUser,
      @@transaction_isolation AS transactionIsolation, @@session.foreign_key_checks AS foreignKeyChecks`);
      const checks = [];
      for (const definition of V2_DATA_INTEGRITY_CHECKS) {
        try {
          const query = buildV2DataIntegrityCheckQueries(definition.sql);
          const [result] = await tx.$queryRawUnsafe(query.count);
          const count = Number(result.count);
          const samples =
            count > 0
              ? normalizeV2DataIntegritySamples(await tx.$queryRawUnsafe(query.samples))
              : [];
          checks.push({ code: definition.code, count, samples, status: 'EXECUTED' });
        } catch (error) {
          const databaseCode = String(error.meta?.code ?? '');
          const field = String(error.meta?.message ?? '').match(
            /Unknown column '([a-zA-Z0-9_.]+)'/i
          )?.[1];
          if (
            args.stage !== 'before' ||
            databaseCode !== '1054' ||
            field !== 'o.deleted_at' ||
            !['bank_subscription_projection_mismatch', 'bank_soft_delete_safety_mismatch'].includes(
              definition.code
            )
          )
            throw new Error('Financial integrity rule execution failed', { cause: error });
          checks.push({
            code: definition.code,
            status: 'SCHEMA_NOT_DEPLOYED',
            databaseCode,
            field
          });
        }
      }
      const sources = {};
      for (const [name, query] of Object.entries(historySourceQueries)) {
        const ids = policy.sources[name].ids;
        const rows = await tx.$queryRawUnsafe(
          query.replace('IDS', ids.map(() => '?').join(',')),
          ...ids
        );
        sources[name] = fingerprintRows(rows);
      }
      const ids = policy.sources.journals.ids;
      const metadata = await tx.$queryRawUnsafe(
        `SELECT id,
      CAST(SHA2(IF(metadata IS NULL, 'NULL', CAST(metadata AS CHAR)), 256) AS CHAR) AS metadataSha256
      FROM id_business_v2_finance_journals WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids
      );
      const gate = acceptHistoricalAudit({
        policy,
        definitions: V2_DATA_INTEGRITY_CHECKS,
        expectedCurrent: args['expected-current'],
        stage: args.stage,
        checks,
        sources,
        metadata,
        before,
        identity
      });
      return { ...assessV2DataIntegrity(checks), identity, checks, gate };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120000 }
  );
  console.log(serializeHistoricalAuditReport({ ...report, generatedAt: new Date().toISOString() }));
} catch {
  console.log(
    JSON.stringify({
      ok: false,
      gate: { accepted: false },
      reason: 'Historical release audit rejected; raw data suppressed'
    })
  );
  process.exitCode = 1;
} finally {
  await client.$disconnect().catch(() => undefined);
}
