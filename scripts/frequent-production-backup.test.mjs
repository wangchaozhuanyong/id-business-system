import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FREQUENT_BACKUP_STALE_AFTER_MS,
  MAX_LOCAL_BACKUP_BYTES,
  MAX_LOCAL_BACKUP_COUNT,
  assertFrequentBackupHealthy,
  pruneFrequentBackups,
  safeBackupError,
  selectFrequentBackupsToDelete
} from './lib/frequent-production-backup.mjs';

test('retention keeps the newest backups under both count and byte caps', () => {
  const backups = Array.from({ length: 120 }, (_, index) => ({
    stem: `backup-${index}`,
    createdAtMs: index,
    sizeBytes: 1024
  }));
  const byCount = selectFrequentBackupsToDelete(backups);
  assert.equal(byCount.length, 120 - MAX_LOCAL_BACKUP_COUNT);
  assert.deepEqual(
    byCount.map((backup) => backup.createdAtMs),
    Array.from({ length: 120 - MAX_LOCAL_BACKUP_COUNT }, (_, index) => index)
  );

  const largeBackups = Array.from({ length: 10 }, (_, index) => ({
    stem: `large-${index}`,
    createdAtMs: index,
    sizeBytes: 40 * 1024 * 1024
  }));
  const byBytes = selectFrequentBackupsToDelete(largeBackups, {
    maxCount: 10,
    maxBytes: 100 * 1024 * 1024,
    minimumCount: 2
  });
  assert.deepEqual(
    byBytes.map((backup) => backup.createdAtMs),
    Array.from({ length: 8 }, (_, index) => index)
  );
  assert.throws(
    () => selectFrequentBackupsToDelete([], { maxCount: 1, maxBytes: 1, minimumCount: 2 }),
    /最低保留数量/
  );
  assert.equal(MAX_LOCAL_BACKUP_BYTES, 16 * 1024 * 1024);
});

test('freshness check fails after twenty minutes and rejects incomplete files', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const latest = {
    createdAt: '2026-08-10T11:45:00.000Z',
    createdAtMs: Date.parse('2026-08-10T11:45:00.000Z'),
    archive: { name: 'local-15m-20260810T114500Z.backup.enc' }
  };
  assert.equal(
    assertFrequentBackupHealthy(
      { backups: [latest], orphans: [], partials: [], totalBytes: 1 },
      now
    ).ageMs,
    15 * 60 * 1000
  );
  assert.throws(
    () =>
      assertFrequentBackupHealthy(
        {
          backups: [{ ...latest, createdAtMs: now - FREQUENT_BACKUP_STALE_AFTER_MS - 1 }],
          orphans: [],
          partials: [],
          totalBytes: 1
        },
        now
      ),
    /已过期/
  );
  assert.throws(
    () =>
      assertFrequentBackupHealthy(
        { backups: [latest], orphans: [{ name: 'orphan' }], partials: [], totalBytes: 1 },
        now
      ),
    /未完成或无效/
  );
});

test('pruning manages only local-15m files and removes stale partial data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'id-v2-frequent-backup-test-'));
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  try {
    await writeFile(path.join(directory, 'manual-protection.dump'), 'must-stay');
    for (let index = 0; index < 98; index += 1) {
      await createBackupPair(
        directory,
        new Date(Date.parse('2026-08-09T00:00:00.000Z') + index * 60_000)
      );
    }
    const partialPath = path.join(directory, '.local-15m-20260808T000000Z.dump.partial');
    await writeFile(partialPath, 'plaintext-partial');
    await utimes(
      partialPath,
      new Date(now - 2 * 60 * 60 * 1000),
      new Date(now - 2 * 60 * 60 * 1000)
    );

    const result = await pruneFrequentBackups(directory, now);
    assert.equal(result.backups.length, MAX_LOCAL_BACKUP_COUNT);
    assert.equal(result.deletedBackupCount, 98 - MAX_LOCAL_BACKUP_COUNT);
    assert.equal(result.deletedStaleFileCount, 1);
    assert.equal(
      await readFile(path.join(directory, 'manual-protection.dump'), 'utf8'),
      'must-stay'
    );
    assert.doesNotMatch((await readdir(directory)).join('\n'), /\.partial$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('error output removes database addresses and credentials', () => {
  const redacted = safeBackupError(
    new Error('postgresql://user:password@example.com/db token=sensitive password=secret')
  );
  assert.doesNotMatch(redacted, /example\.com|sensitive|password=secret/u);
  assert.match(redacted, /已隐藏/u);
});

test('frequent executor is read-only, bounded and installed without growing log files', async () => {
  const [runner, monitor, installer, backup, restore, nativeClient] = await Promise.all([
    readFile(new URL('./run-frequent-production-backup.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./check-frequent-production-backup.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./install-frequent-production-backup-launchd.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./backup-production-database.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./restore-production-backup-drill.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./lib/native-postgres-client.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(runner, /--ephemeral-plaintext/u);
  assert.match(runner, /--executor=native/u);
  assert.match(runner, /32_000/u);
  assert.doesNotMatch(runner, /MIGRATION_DATABASE_URL/u);
  assert.doesNotMatch(runner, /spawn\(['"]docker/u);
  assert.doesNotMatch(runner, /\b(?:INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b/iu);
  assert.match(monitor, /ALERT_REPEAT_MS = 60 \* 60 \* 1000/u);
  assert.match(installer, /BACKUP_MINUTES = \[5, 20, 35, 50\]/u);
  assert.match(installer, /<key>StartInterval<\/key><integer>300<\/integer>/u);
  assert.match(installer, /<key>LowPriorityIO<\/key><true\/>/u);
  assert.match(installer, /<key>Nice<\/key><integer>10<\/integer>/u);
  assert.match(installer, /<key>POSTGRES_BACKUP_BIN_DIR<\/key>/u);
  assert.match(installer, /path\.join\(homedir\(\), '\.local', 'bin', 'node'\)/u);
  assert.equal(installer.match(/<string>\/dev\/null<\/string>/gu)?.length, 2);
  assert.match(backup, /'--memory',\s*'256m'/u);
  assert.match(backup, /'--cpus',\s*'1'/u);
  assert.match(backup, /'--pids-limit',\s*'64'/u);
  assert.match(backup, /'--ulimit',\s*'fsize=16777216:16777216'/u);
  assert.match(backup, /PGAPPNAME: 'id-business-v2-backup'/u);
  assert.doesNotMatch(backup, /idle_in_transaction_session_timeout=900000/u);
  assert.match(backup, /idle_session_timeout=120000/u);
  assert.match(monitor, /inspectProductionBackupTransactions/u);
  assert.match(monitor, /includeRoleTimeouts: true/u);
  assert.match(monitor, /roleIdleSessionMs <= 0/u);
  assert.match(monitor, /staleBackupTransactionCount/u);
  assert.doesNotMatch(monitor, /pg_terminate_backend/u);
  assert.match(restore, /'--memory',\s*'512m'/u);
  assert.match(restore, /setTimeout\(resolve, 2_000\)/u);
  assert.match(nativeClient, /NATIVE_POSTGRES_CLIENT_VERSION = '17\.10'/u);
});

async function createBackupPair(directory, createdAt) {
  const stamp = createdAt
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.000Z$/u, 'Z');
  const stem = `local-15m-${stamp}`;
  const archiveName = `${stem}.backup.enc`;
  await writeFile(path.join(directory, archiveName), 'x');
  await writeFile(
    path.join(directory, `${stem}.receipt.json`),
    `${JSON.stringify({
      createdAt: createdAt.toISOString(),
      archive: archiveName,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      publicKeySha256: 'b'.repeat(64),
      encrypted: true
    })}\n`
  );
}
