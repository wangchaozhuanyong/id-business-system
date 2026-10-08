import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256, verifyFinanceArtifact, verifyFinanceRunner } from './native-finance-artifact.mjs';

const requireValue = (value, auditFailure = 'INVARIANT') => {
  if (!value) {
    const error = new Error('原生只读财务检查未通过');
    error.auditFailure = auditFailure;
    throw error;
  }
};
const fingerprint = (value) => sha256(JSON.stringify(value));
async function step(code, action) {
  try {
    return await action();
  } catch {
    requireValue(false, code);
  }
}

export async function auditNativeFinance(client, definitions, library, options) {
  requireValue(definitions.length === 49 && fingerprint(definitions) === options.rulesSha256);
  requireValue(['before', 'after'].includes(options.stage));
  if (options.stage === 'after') {
    requireValue(
      options.before?.ok === true &&
        options.before?.stage === 'before' &&
        options.before?.format === 'id-business-native-finance-receipt-v1' &&
        options.before?.scope === 'STRICT_ZERO_READ_ONLY_49' &&
        options.before?.manifestSha256 === options.manifestSha256 &&
        options.before?.rulesSha256 === options.rulesSha256 &&
        options.before?.checkCount === 49 &&
        options.before?.unavailableCheckCount === 0 &&
        options.before?.violationCount === 0
    );
  } else requireValue(!options.before);
  try {
    await step('CONNECT', () => client.$connect());
    await step('READ_ONLY_GRANTS', async () =>
      library.assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'))
    );
    await step('READ_ONLY_SESSION', () =>
      client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY')
    );
    const snapshot = await client.$transaction(
      async (tx) => {
        const [identity] = await step('IDENTITY_QUERY', () =>
          tx.$queryRawUnsafe(
            'SELECT CURRENT_USER() AS currentUser, DATABASE() AS databaseName, ' +
              '@@transaction_isolation AS transactionIsolation, @@session.transaction_read_only AS sessionReadOnly, ' +
              '@@session.foreign_key_checks AS foreignKeyChecks'
          )
        );
        requireValue(
          identity?.databaseName === options.database &&
            identity.transactionIsolation === 'REPEATABLE-READ' &&
            String(identity.sessionReadOnly) === '1' &&
            String(identity.foreignKeyChecks) === '1',
          'SESSION_IDENTITY'
        );
        const checks = [];
        for (const definition of definitions) {
          const rows = await step(`RULE_${definition.code}`, () =>
            tx.$queryRawUnsafe(library.buildV2DataIntegrityCheckQueries(definition.sql).count)
          );
          requireValue(rows.length === 1 && /^[0-9]+$/.test(String(rows[0]?.count)));
          const count = Number(rows[0].count);
          requireValue(Number.isSafeInteger(count));
          checks.push({ code: definition.code, status: 'EXECUTED', count });
        }
        // Prisma returns MySQL integer system variables as bigint on real connections.
        // Use one representation before hashing without exposing account/database names.
        const normalizedIdentity = Object.fromEntries(
          [
            'currentUser',
            'databaseName',
            'transactionIsolation',
            'sessionReadOnly',
            'foreignKeyChecks'
          ].map((key) => [key, String(identity[key])])
        );
        return { identity: normalizedIdentity, checks };
      },
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
    requireValue(new Set(snapshot.checks.map((check) => check.code)).size === 49);
    const assessment = library.assessV2DataIntegrity(snapshot.checks);
    const identitySha256 = fingerprint(snapshot.identity);
    const checksSha256 = fingerprint(snapshot.checks);
    if (options.stage === 'after')
      requireValue(
        options.before.identitySha256 === identitySha256 &&
          options.before.checksSha256 === checksSha256
      );
    return {
      ...assessment,
      format: 'id-business-native-finance-receipt-v1',
      stage: options.stage,
      manifestSha256: options.manifestSha256,
      rulesSha256: options.rulesSha256,
      executedCheckCount: 49,
      unavailableCheckCount: 0,
      identitySha256,
      checksSha256,
      checks: snapshot.checks,
      generatedAt: new Date().toISOString(),
      scope: 'STRICT_ZERO_READ_ONLY_49',
      historicalClearanceEquivalent: false,
      productionCutoverAllowed: false
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

export async function runNativeFinance(options, environment = process.env) {
  const manifest = await step('ARTIFACT', () => verifyFinanceArtifact(options));
  if (options.run)
    await step('RUNNER_IDENTITY', () => verifyFinanceRunner(manifest, import.meta.url));
  const library = await step(
    'LIBRARY_LOAD',
    () => import(pathToFileURL(resolve(options.root, 'scripts/lib/v2-data-integrity-audit.mjs')))
  );
  requireValue(
    fingerprint(library.V2_DATA_INTEGRITY_CHECKS) === manifest.rulesSha256 &&
      process.versions.node.split('.')[0] === '24'
  );
  if (!options.run)
    return {
      ok: true,
      mode: 'CHECK_ONLY',
      checkCount: 49,
      databaseConnected: false,
      manifestSha256: options.manifestSha256
    };
  requireValue(
    /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(options.database ?? '') &&
      !['mysql', 'sys', 'information_schema', 'performance_schema'].includes(
        options.database.toLowerCase()
      )
  );
  requireValue(isAbsolute(options.output) && ['before', 'after'].includes(options.stage));
  let url;
  try {
    url = new URL(environment.V2_DATA_INTEGRITY_DATABASE_URL);
  } catch {
    requireValue(false, 'DATABASE_CONFIG');
  }
  requireValue(
    url.protocol === 'mysql:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      decodeURIComponent(url.pathname.slice(1)) === options.database &&
      url.username &&
      !url.hash,
    'DATABASE_CONFIG'
  );
  // The session setting and transaction must use the same physical connection.
  // Identity is still checked inside the transaction; a reconnect fails closed.
  url.searchParams.set('connection_limit', '1');
  const { PrismaClient } = await step('CLIENT_LOAD', () =>
    createRequire(resolve(options.root, 'package.json'))('@prisma/client')
  );
  let before;
  if (options.beforePath) {
    requireValue(isAbsolute(options.beforePath) && /^[0-9a-f]{64}$/.test(options.beforeSha256));
    const bytes = readFileSync(options.beforePath);
    requireValue(bytes.length <= 4 * 1024 * 1024 && sha256(bytes) === options.beforeSha256);
    before = JSON.parse(bytes);
  }
  const client = await step(
    'CLIENT_CONSTRUCTOR',
    () => new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
  );
  const report = await auditNativeFinance(client, library.V2_DATA_INTEGRITY_CHECKS, library, {
    ...options,
    before,
    rulesSha256: manifest.rulesSha256
  });
  // Re-read the seal after the database run: a changed artifact cannot emit a success receipt.
  verifyFinanceArtifact(options);
  verifyFinanceRunner(manifest, import.meta.url);
  writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600
  });
  return {
    ok: report.ok,
    mode: 'READ_ONLY_49',
    checkCount: 49,
    violationCount: report.violationCount,
    receiptSha256: sha256(readFileSync(options.output))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (const arg of process.argv.slice(2)) {
      if (arg === '--run' && !options.run) {
        options.run = true;
        continue;
      }
      const match =
        /^--(root|manifest|sha256|database|stage|before|before-sha256|output)=(.+)$/.exec(arg);
      requireValue(match && !Object.hasOwn(options, match[1]));
      options[match[1]] = match[2];
    }
    const report = await runNativeFinance({
      ...options,
      manifestPath: options.manifest,
      manifestSha256: options.sha256,
      beforePath: options.before,
      beforeSha256: options['before-sha256']
    });
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const code =
      /^(ARTIFACT|RUNNER_IDENTITY|LIBRARY_LOAD|DATABASE_CONFIG|CLIENT_LOAD|CLIENT_CONSTRUCTOR|CONNECT|READ_ONLY_GRANTS|READ_ONLY_SESSION|IDENTITY_QUERY|SESSION_IDENTITY|INVARIANT|RULE_[a-z0-9_]+)$/.test(
        error?.auditFailure
      )
        ? error.auditFailure
        : 'EXECUTION';
    console.error(`原生只读财务检查失败（${code}），数据库资料与原始错误已隐藏`);
    process.exitCode = 1;
  }
}
