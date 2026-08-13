import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CORE_BACKUP_TABLES,
  EXPECTED_BACKUP_PROJECT_REF,
  EXPECTED_BACKUP_ROLE,
  MAX_ENCRYPTED_ARCHIVE_BYTES,
  assertExpectedBackupDatabase,
  countFingerprint,
  decryptBackupBundle,
  encryptBackupBundle,
  isRetryableBackupConnectionError,
  parseCoreCounts,
  parsePgRestoreList,
  validateManifestAgainstDump
} from './lib/production-backup.mjs';
import {
  BACKUP_SESSION_TIMEOUT_MS,
  describeBackupTransactions,
  findStaleBackupTransactions
} from './lib/production-backup-transactions.mjs';

function createCounts() {
  return Object.fromEntries(CORE_BACKUP_TABLES.map((table, index) => [table, index]));
}

test('accepts only the dedicated production backup role', () => {
  const direct = assertExpectedBackupDatabase(
    `postgresql://${EXPECTED_BACKUP_ROLE}:secret@db.${EXPECTED_BACKUP_PROJECT_REF}.supabase.co/postgres`
  );
  assert.equal(direct.username, EXPECTED_BACKUP_ROLE);
  assert.doesNotThrow(() =>
    assertExpectedBackupDatabase(
      `postgresql://${EXPECTED_BACKUP_ROLE}.${EXPECTED_BACKUP_PROJECT_REF}:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`
    )
  );
  assert.throws(
    () =>
      assertExpectedBackupDatabase(
        `postgresql://postgres.${EXPECTED_BACKUP_PROJECT_REF}:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`
      ),
    /专用只读角色/
  );
  assert.throws(
    () => assertExpectedBackupDatabase('postgresql://id_v2_backup:secret@localhost/postgres'),
    /专用只读角色/
  );
});

test('retries only explicit PostgreSQL connection interruptions', () => {
  assert.equal(
    isRetryableBackupConnectionError(new Error('SSL connection has been closed unexpectedly')),
    true
  );
  assert.equal(
    isRetryableBackupConnectionError(new Error('could not receive data from server: reset')),
    true
  );
  assert.equal(
    isRetryableBackupConnectionError(new Error('permission denied for table users')),
    false
  );
  assert.equal(isRetryableBackupConnectionError(new Error('pg_restore catalog invalid')), false);
});

test('classifies only expired idle backup transactions as stale', () => {
  const transactions = [
    {
      state: 'active',
      transactionAgeMs: BACKUP_SESSION_TIMEOUT_MS + 1,
      stateAgeMs: BACKUP_SESSION_TIMEOUT_MS + 1
    },
    {
      state: 'idle in transaction',
      transactionAgeMs: 10 * 60 * 1000,
      stateAgeMs: BACKUP_SESSION_TIMEOUT_MS - 1
    },
    {
      state: 'idle in transaction',
      transactionAgeMs: 10 * 60 * 1000,
      stateAgeMs: BACKUP_SESSION_TIMEOUT_MS
    },
    {
      state: 'idle in transaction (aborted)',
      transactionAgeMs: 11 * 60 * 1000,
      stateAgeMs: BACKUP_SESSION_TIMEOUT_MS + 61_000
    }
  ];

  const stale = findStaleBackupTransactions(transactions);
  assert.deepEqual(stale, transactions.slice(2));
  assert.equal(describeBackupTransactions(stale), '2 个，最长 17 分 1 秒');
});

test('backup role provisioner configures transaction and session cleanup timeouts', async () => {
  const source = await readFile(
    new URL('./provision-production-backup-role.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /idle_in_transaction_session_timeout = '2min'/u);
  assert.match(source, /idle_session_timeout = '16min'/u);
});

test('requires a real pg_restore catalog with tables and table data', () => {
  const parsed = parsePgRestoreList(
    [
      '; Archive created at 2026-08-04',
      '1; 2615 2200 SCHEMA - public postgres',
      '2; 1259 100 TABLE public users postgres',
      '3; 0 100 TABLE DATA public users postgres'
    ].join('\n')
  );
  assert.deepEqual(parsed, { tocEntries: 3, tableEntries: 2, tableDataEntries: 1 });
  assert.throws(() => parsePgRestoreList('; empty'), /缺少表或表数据/);
});

test('rejects incomplete and malformed core count output', () => {
  const valid = CORE_BACKUP_TABLES.map((table, index) => `${table}=${index}`).join('\n');
  assert.deepEqual(parseCoreCounts(valid), createCounts());
  assert.throws(() => parseCoreCounts('users=1'), /不完整/);
  assert.throws(() => parseCoreCounts(`${valid}\nunknown=1`), /格式无效/);
});

test('encrypts, authenticates and decrypts a backup bundle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'id-v2-backup-test-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const dump = Buffer.from('valid-custom-dump-fixture');
    const counts = createCounts();
    const { createHash } = await import('node:crypto');
    const manifest = {
      createdAt: '2026-08-04T00:00:00.000Z',
      databaseProjectRef: EXPECTED_BACKUP_PROJECT_REF,
      databaseVersion: '17.6',
      pgDumpVersion: '17.6',
      format: 'custom',
      file: 'fixture.dump',
      sizeBytes: dump.length,
      sha256: createHash('sha256').update(dump).digest('hex'),
      purpose: 'test',
      tocEntries: 3,
      tableEntries: 2,
      tableDataEntries: 1,
      coreCounts: counts,
      countFingerprint: countFingerprint(counts)
    };
    const dumpPath = path.join(directory, 'fixture.dump');
    const manifestPath = path.join(directory, 'fixture.manifest.json');
    const archivePath = path.join(directory, 'fixture.backup.enc');
    await writeFile(dumpPath, dump);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const encrypted = await encryptBackupBundle({
      dumpPath,
      manifestPath,
      outputPath: archivePath,
      publicKeyPem: publicKey
    });
    assert.ok(encrypted.sizeBytes < MAX_ENCRYPTED_ARCHIVE_BYTES);
    const decrypted = await decryptBackupBundle({ archivePath, privateKeyPem: privateKey });
    assert.deepEqual(decrypted.dump, dump);
    assert.deepEqual(decrypted.manifest, manifest);

    const tampered = Buffer.from(await readFile(archivePath));
    tampered[tampered.length - 17] ^= 1;
    const tamperedPath = path.join(directory, 'tampered.backup.enc');
    await writeFile(tamperedPath, tampered);
    await assert.rejects(
      decryptBackupBundle({ archivePath: tamperedPath, privateKeyPem: privateKey }),
      /认证失败/
    );

    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    await assert.rejects(
      decryptBackupBundle({ archivePath, privateKeyPem: wrongPrivateKey }),
      /decrypt|decoding|oaep|error/iu
    );

    const damagedPath = path.join(directory, 'damaged.backup.enc');
    await writeFile(damagedPath, Buffer.from('not-a-backup'));
    await assert.rejects(
      decryptBackupBundle({ archivePath: damagedPath, privateKeyPem: privateKey }),
      /魔数无效/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects zero-byte plaintext and an encrypted archive above the free cap', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'id-v2-backup-limit-test-'));
  try {
    const emptyDumpPath = path.join(directory, 'empty.dump');
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(emptyDumpPath, Buffer.alloc(0));
    await writeFile(manifestPath, '{}');
    const { validatePlaintextBackup } = await import('./lib/production-backup.mjs');
    await assert.rejects(
      validatePlaintextBackup({ dumpPath: emptyDumpPath, manifestPath }),
      /为空或不是文件/
    );

    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const oversizedDumpPath = path.join(directory, 'oversized.dump');
    const oversizedArchivePath = path.join(directory, 'oversized.backup.enc');
    await writeFile(oversizedDumpPath, Buffer.alloc(MAX_ENCRYPTED_ARCHIVE_BYTES));
    await assert.rejects(
      encryptBackupBundle({
        dumpPath: oversizedDumpPath,
        manifestPath,
        outputPath: oversizedArchivePath,
        publicKeyPem: publicKey
      }),
      /超过免费方案单份上限/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup command rejects path traversal, concurrent locks, and cleans partial files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'id-v2-backup-command-test-'));
  const backupDirectory = path.join(directory, 'backups/postgres');
  const fakeBin = path.join(directory, 'bin');
  const scriptPath = path.resolve('scripts/backup-production-database.mjs');
  const environment = {
    ...process.env,
    BACKUP_DATABASE_URL: `postgresql://${EXPECTED_BACKUP_ROLE}:secret@db.${EXPECTED_BACKUP_PROJECT_REF}.supabase.co/postgres`,
    PATH: `${fakeBin}:${process.env.PATH}`
  };
  const commonArgs = [
    scriptPath,
    '--label=test-command',
    `--confirmation=BACKUP_${EXPECTED_BACKUP_PROJECT_REF}_test-command`
  ];
  try {
    await mkdir(backupDirectory, { recursive: true });
    await mkdir(fakeBin);
    const fakeDockerPath = path.join(fakeBin, 'docker');
    await writeFile(
      fakeDockerPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const imageIndex = args.indexOf('postgres:17.6');
const command = args[imageIndex + 1];
if (command === 'pg_dump') {
  const mount = args[args.indexOf('-v') + 1].split(':')[0];
  const output = args[args.indexOf('--file') + 1].replace('/backup/', '');
  writeFileSync(mount + '/' + output, 'partial-dump');
  process.exit(0);
}
if (command === 'pg_restore') {
  writeFileSync(1, '1; 1259 100 TABLE public users postgres\\n2; 0 100 TABLE DATA public users postgres\\n;' + 'x'.repeat(100000));
  process.exit(0);
}
if (command === 'psql') {
  process.stderr.write('forced count failure');
  process.exit(9);
}
process.exit(2);
`
    );
    await chmod(fakeDockerPath, 0o755);

    await assert.rejects(
      runNode(commonArgs.concat('--output-dir=../outside'), { cwd: directory, environment }),
      /备份目录必须固定/
    );

    const lockPath = path.join(backupDirectory, '.production-backup.lock');
    await writeFile(lockPath, 'existing-lock');
    await assert.rejects(runNode(commonArgs, { cwd: directory, environment }), /EEXIST/u);
    assert.equal(await readFile(lockPath, 'utf8'), 'existing-lock');
    await rm(lockPath);

    await assert.rejects(
      runNode(commonArgs, { cwd: directory, environment }),
      /forced count failure/u
    );
    assert.deepEqual(await readdir(backupDirectory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native backup executor uses the pinned PostgreSQL 17 client without Docker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'id-v2-native-backup-test-'));
  const fakeBin = path.join(directory, 'native-bin');
  const scriptPath = path.resolve('scripts/backup-production-database.mjs');
  const environment = {
    ...process.env,
    BACKUP_DATABASE_URL: `postgresql://${EXPECTED_BACKUP_ROLE}:secret@db.${EXPECTED_BACKUP_PROJECT_REF}.supabase.co/postgres`
  };
  try {
    await mkdir(fakeBin, { recursive: true });
    const fakeCommandSource = `#!/usr/bin/env node
const { basename } = require('node:path');
const { writeFileSync } = require('node:fs');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(command + ' (PostgreSQL) 17.10');
  process.exit(0);
}
if (command === 'pg_dump') {
  writeFileSync(args[args.indexOf('--file') + 1], 'valid-native-dump');
  process.exit(0);
}
if (command === 'pg_restore') {
  console.log('1; 1259 100 TABLE public users postgres\\n2; 0 100 TABLE DATA public users postgres');
  process.exit(0);
}
if (command === 'psql') {
  console.log(${JSON.stringify(CORE_BACKUP_TABLES)}.map((table, index) => table + '=' + index).join('\\n'));
  process.exit(0);
}
process.exit(2);
`;
    for (const command of ['pg_dump', 'pg_restore', 'psql']) {
      const commandPath = path.join(fakeBin, command);
      await writeFile(commandPath, fakeCommandSource);
      await chmod(commandPath, 0o755);
    }
    const stdout = await runNode(
      [
        scriptPath,
        '--label=native-test',
        `--confirmation=BACKUP_${EXPECTED_BACKUP_PROJECT_REF}_native-test`,
        '--executor=native',
        `--postgres-bin-dir=${await realpath(fakeBin)}`
      ],
      { cwd: directory, environment }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.executor, 'native');
    assert.equal(result.pgDumpVersion, '17.10');
    assert.ok(result.dump.endsWith('.dump'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest rejects project, checksum and count drift', async () => {
  const { createHash } = await import('node:crypto');
  const dump = Buffer.from('dump');
  const counts = createCounts();
  const manifest = {
    createdAt: '2026-08-04T00:00:00.000Z',
    databaseProjectRef: EXPECTED_BACKUP_PROJECT_REF,
    databaseVersion: '17.6',
    pgDumpVersion: '17.6',
    format: 'custom',
    sizeBytes: dump.length,
    sha256: createHash('sha256').update(dump).digest('hex'),
    tocEntries: 3,
    tableEntries: 2,
    tableDataEntries: 1,
    coreCounts: counts,
    countFingerprint: countFingerprint(counts)
  };
  assert.doesNotThrow(() => validateManifestAgainstDump(manifest, dump));
  assert.doesNotThrow(() =>
    validateManifestAgainstDump({ ...manifest, pgDumpVersion: '17.10' }, dump)
  );
  assert.throws(
    () => validateManifestAgainstDump({ ...manifest, databaseProjectRef: 'wrong' }, dump),
    /项目、版本或格式/
  );
  assert.throws(
    () => validateManifestAgainstDump({ ...manifest, sha256: '0'.repeat(64) }, dump),
    /SHA-256/
  );
  assert.throws(
    () => validateManifestAgainstDump({ ...manifest, coreCounts: { ...counts, users: 999 } }, dump),
    /计数指纹/
  );
  assert.throws(
    () => validateManifestAgainstDump({ ...manifest, pgDumpVersion: '18.1' }, dump),
    /项目、版本或格式/
  );
});

test('workflow is hourly, encrypted, capacity-capped and never persists plaintext', async () => {
  const source = await readFile(
    new URL('../.github/workflows/production-backup.yml', import.meta.url),
    'utf8'
  );
  assert.match(source, /cron: '17 \* \* \* \*'/u);
  assert.match(source, /--ephemeral-plaintext/u);
  assert.match(source, /backup-recovery-public\.pem/u);
  assert.match(source, /419430400/u);
  assert.doesNotMatch(source, /\.size_in_bytes' \|\| true/u);
  assert.match(source, /retention-days: 30/u);
  assert.match(source, /Keep only two hourly backups/u);
  assert.match(source, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.doesNotMatch(source, /MIGRATION_DATABASE_URL/u);
});

test('backup subprocesses have a 15-minute timeout and launchd preserves command PATH', async () => {
  const backupSource = await readFile(
    new URL('./backup-production-database.mjs', import.meta.url),
    'utf8'
  );
  assert.match(backupSource, /15 \* 60 \* 1000/u);
  assert.match(backupSource, /setTimeout\(\(\) => child\.kill\('SIGTERM'\), timeoutMs\)/u);
  const launchdSource = await readFile(
    new URL('./install-production-restore-drill-launchd.mjs', import.meta.url),
    'utf8'
  );
  assert.match(launchdSource, /<key>EnvironmentVariables<\/key>/u);
  assert.match(launchdSource, /<key>PATH<\/key>/u);
});

test('restore drill creates only no-login compatibility roles before applying policies', async () => {
  const source = await readFile(
    new URL('./restore-production-backup-drill.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /CREATE ROLE id_business_v2_runtime NOLOGIN/u);
  assert.match(source, /CREATE ROLE id_business_v2_audit NOLOGIN/u);
  assert.match(source, /CREATE ROLE id_v2_backup NOLOGIN/u);
  assert.doesNotMatch(source, /MIGRATION_DATABASE_URL/u);
});

test('role provisioner grants read-all and bypass RLS without write-all', async () => {
  const source = await readFile(
    new URL('./provision-production-backup-role.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /GRANT pg_read_all_data/u);
  assert.match(source, /BYPASSRLS/u);
  assert.match(source, /pg_has_role\(\$1, 'pg_write_all_data'/u);
  assert.match(source, /SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS/u);
  assert.match(source, /default_transaction_read_only = on/u);
  const backupSource = await readFile(
    new URL('./backup-production-database.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(backupSource, /MIGRATION_DATABASE_URL/u);
});

function runNode(arguments_, { cwd, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve(stdout);
      else reject(new Error(`${stdout}\n${stderr}`));
    });
  });
}
