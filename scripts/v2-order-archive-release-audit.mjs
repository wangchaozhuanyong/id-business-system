import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries,
  normalizeV2DataIntegritySamples
} from './lib/v2-data-integrity-audit.mjs';
import { fingerprintRows, postCleanupSourceQueries } from './lib/v2-release-history-policy.mjs';
import {
  acceptSealedOrderArchiveAudit,
  serializeOrderArchiveAuditReport,
  validateOrderArchivePolicyDraft,
  validateOrderArchiveReviewSeal
} from './lib/v2-order-archive-release-policy.mjs';

export function parseOrderArchiveAuditArgs(values) {
  const allowed = new Set([
    'policy',
    'stage',
    'expected-current',
    'before-receipt',
    'order-archive-seal',
    'order-archive-seal-sha256',
    'cleanup-receipt',
    'candidate-commit',
    'candidate-tree'
  ]);
  const args = {};
  for (const value of values) {
    const match = value.match(/^--([a-z0-9-]+)=(.+)$/);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(args, match[1]))
      throw new Error('Unknown or duplicate order archive audit option');
    args[match[1]] = match[2];
  }
  const required = [...allowed].filter((key) => key !== 'before-receipt');
  if (
    required.some((key) => !args[key]) ||
    !['before', 'after'].includes(args.stage) ||
    (args.stage === 'after' && !args['before-receipt']) ||
    (args.stage === 'before' && args['before-receipt'])
  )
    throw new Error('Incomplete order archive audit confirmation');
  return args;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJsonBytes = (path) => {
  const bytes = readFileSync(path);
  if (bytes.length > 4 * 1024 * 1024)
    throw new Error('Order archive evidence exceeds bounded size');
  return bytes;
};

async function main() {
  const args = parseOrderArchiveAuditArgs(process.argv.slice(2));
  const policy = JSON.parse(readJsonBytes(args.policy).toString());
  validateOrderArchivePolicyDraft(policy, V2_DATA_INTEGRITY_CHECKS, args['expected-current']);
  const sealBytes = readJsonBytes(args['order-archive-seal']);
  const seal = JSON.parse(sealBytes.toString());
  const cleanupReceiptBytes = readJsonBytes(args['cleanup-receipt']);
  const before = args['before-receipt']
    ? JSON.parse(readJsonBytes(args['before-receipt']).toString())
    : null;
  const proof = {
    seal,
    sealBytes,
    sealSha256: args['order-archive-seal-sha256'],
    cleanupReceiptBytes,
    candidateCommit: args['candidate-commit'],
    candidateTree: args['candidate-tree']
  };
  validateOrderArchiveReviewSeal(policy, proof);
  // Both stages run a node command in the exact newly prepared API image, without
  // starting the API server. The controller separately verifies all three images.
  for (const [file, expected] of Object.entries(policy.candidateBindings.compiledServiceHashes))
    if (digest(readFileSync('/app/' + file)) !== expected)
      throw new Error('Order archive actual compiled candidate changed');
  const databaseUrl = process.env.V2_DATA_INTEGRITY_DATABASE_URL;
  if (!databaseUrl?.startsWith('mysql://')) throw new Error('Read-only MySQL audit URL required');
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
  try {
    await client.$connect();
    assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
    await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
    const report = await client.$transaction(
      async (tx) => {
        const [identity] = await tx.$queryRawUnsafe(
          'SELECT CURRENT_USER() AS currentUser, DATABASE() AS databaseName, ' +
            '@@transaction_isolation AS transactionIsolation, @@session.foreign_key_checks AS foreignKeyChecks, ' +
            '@@global.read_only AS readOnly, @@global.super_read_only AS superReadOnly, ' +
            '@@session.transaction_read_only AS sessionReadOnly'
        );
        const checks = [];
        for (const definition of V2_DATA_INTEGRITY_CHECKS) {
          const query = buildV2DataIntegrityCheckQueries(definition.sql);
          const [result] = await tx.$queryRawUnsafe(query.count);
          const count = Number(result.count);
          const samples =
            count > 0
              ? normalizeV2DataIntegritySamples(await tx.$queryRawUnsafe(query.samples))
              : [];
          checks.push({ code: definition.code, count, samples, status: 'EXECUTED' });
        }
        const sources = {};
        for (const [name, query] of Object.entries(postCleanupSourceQueries)) {
          const ids = policy.sources[name].ids;
          const rows = await tx.$queryRawUnsafe(
            query.sql.replace('IDS', ids.map(() => '?').join(',')),
            ...ids
          );
          sources[name] = { rowCount: rows.length, sha256: fingerprintRows(rows) };
        }
        const ids = policy.sources.journals.ids;
        const metadata = await tx.$queryRawUnsafe(
          "SELECT id, CAST(SHA2(IF(metadata IS NULL, 'NULL', CAST(metadata AS CHAR)), 256) AS CHAR) AS metadataSha256 " +
            'FROM id_business_v2_finance_journals WHERE id IN (' +
            ids.map(() => '?').join(',') +
            ')',
          ...ids
        );
        const [scope] = await tx.$queryRawUnsafe(
          'SELECT (SELECT COUNT(*) FROM id_business_v2_orders WHERE id IN (' +
            "'c19663b2-7050-427c-b850-819b0e410dfc', 'ed9db3ad-8a60-44b3-ae7c-d4e8f4dd10af')) AS targetOrdersCount, " +
            "(SELECT COUNT(*) FROM id_business_v2_orders WHERE id = '1d7c164c-2215-4b0e-a6ae-d1e9999d1a8b') AS protectedThirdOrderCount"
        );
        const gate = acceptSealedOrderArchiveAudit(
          {
            policy,
            definitions: V2_DATA_INTEGRITY_CHECKS,
            expectedCurrent: args['expected-current'],
            stage: args.stage,
            checks,
            sources,
            metadata,
            before,
            identity,
            scope,
            cleanupReceiptSha256: digest(cleanupReceiptBytes)
          },
          proof
        );
        return { ...assessV2DataIntegrity(checks), identity, checks, gate };
      },
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
    console.log(
      serializeOrderArchiveAuditReport({ ...report, generatedAt: new Date().toISOString() })
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
        gate: { accepted: false },
        reason: 'Order archive release audit rejected; raw data suppressed'
      })
    );
    process.exitCode = 1;
  }
}
