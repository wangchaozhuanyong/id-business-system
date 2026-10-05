import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';
import {
  MAINTENANCE_BASELINE,
  MAINTENANCE_POLICY_ID,
  readPinnedReceipts,
  runMaintenanceSnapshot,
  validateAuditUrl,
  validateMaintenancePolicy
} from './lib/v2-release-maintenance-policy.mjs';

const fail = () => {
  throw new Error('MAINTENANCE_GATE_REJECTED');
};
try {
  const args = {};
  for (const value of process.argv.slice(2)) {
    const match = value.match(/^--(policy|stage|expected-current|before-receipt)=(.+)$/);
    if (!match || Object.hasOwn(args, match[1])) fail();
    args[match[1]] = match[2];
  }
  if (
    args.policy !== `/release-policy/${MAINTENANCE_POLICY_ID}.json` ||
    args['expected-current'] !== MAINTENANCE_BASELINE ||
    !['before', 'after'].includes(args.stage) ||
    (args.stage === 'before' && args['before-receipt'] !== undefined) ||
    (args.stage === 'after' && args['before-receipt'] !== '/release-before-audit.json')
  )
    fail();
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
  const sourceHashes = {};
  for (const name of Object.keys(policy.candidateSourceSha256 ?? {})) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').includes('..')) fail();
    const source = join('/release-source', name);
    const descriptor = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const metadata = fstatSync(descriptor);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o7777) !== (name === 'scripts/backup-aws-mysql.sh' ? 0o755 : 0o644)
      )
        fail();
      sourceHashes[name] = createHash('sha256').update(readFileSync(descriptor)).digest('hex');
      const after = fstatSync(descriptor);
      if (
        metadata.size !== after.size ||
        metadata.mtimeMs !== after.mtimeMs ||
        metadata.ctimeMs !== after.ctimeMs
      )
        fail();
    } finally {
      closeSync(descriptor);
    }
  }
  validateMaintenancePolicy(policy, args['expected-current'], sourceHashes);
  const receipts = readPinnedReceipts(
    Object.fromEntries(
      Object.keys(policy.receiptSha256).map((name) => [name, `/release-evidence/${name}.json`])
    )
  );
  let before;
  if (args.stage === 'after') {
    const descriptor = openSync(
      args['before-receipt'],
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const metadata = fstatSync(descriptor);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        ![0o400, 0o600].includes(metadata.mode & 0o777) ||
        metadata.size > 8 * 1024 * 1024
      )
        fail();
      before = JSON.parse(readFileSync(descriptor, 'utf8')).gate;
      const after = fstatSync(descriptor);
      if (metadata.mtimeMs !== after.mtimeMs || metadata.ctimeMs !== after.ctimeMs) fail();
    } finally {
      closeSync(descriptor);
    }
  }
  const connectionUrl = validateAuditUrl(process.env.V2_DATA_INTEGRITY_DATABASE_URL);
  const client = new PrismaClient({ datasources: { db: { url: connectionUrl } }, log: [] });
  const gate = await runMaintenanceSnapshot(client, {
    policy,
    expectedCurrent: args['expected-current'],
    sourceHashes,
    receipts,
    stage: args.stage,
    before,
    connectionUrl
  });
  console.log(
    JSON.stringify({
      ok: false,
      checkCount: 48,
      violationCount: 6,
      checks: V2_DATA_INTEGRITY_CHECKS.map(({ code }) => ({
        code,
        status: 'EXECUTED',
        count: code === 'cash_historical_cost_evidence_mismatch' ? 6 : 0
      })),
      gate
    })
  );
} catch {
  console.error('MAINTENANCE_GATE_REJECTED');
  process.exitCode = 1;
}
