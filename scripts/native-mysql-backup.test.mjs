import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  PROJECT_ROOT,
  NativeMysqlError,
  sha256,
  configuredConnection,
  privateBytes,
  normalizeDump,
  requireCoreSnapshot,
  safeEnvironment,
  mysqlTools
} from './lib/native-mysql-tools.mjs';
import {
  parseArgs,
  dumpArguments,
  preflight,
  sealArchive,
  openArchive,
  s3Preparation
} from './native-mysql-backup.mjs';

const AREA = join(PROJECT_ROOT, '.runtime/docker-independence-20261008/native-backup');
async function ownedArea() {
  await mkdir(AREA, { recursive: true, mode: 0o700 });
  return mkdtemp(join(AREA, 'test-'));
}
const code = (expected) => (error) => error instanceof NativeMysqlError && error.code === expected;

test('unconfigured preflight requests explicit bin directory without connecting a database', async () => {
  const result = await preflight({});
  assert.equal(result.binaryConfiguration, 'EXPLICIT_BIN_DIRECTORY_REQUIRED');
  assert.equal(result.mysqlVersion, 'NOT_MEASURED');
  assert.equal(result.databaseConnected, false);
  assert.equal(result.restoreStarted, false);
  assert.equal(result.productionAcceptance, 'NOT_MEASURED');
});

test('MySQL children receive only the minimal environment and version probes ignore login paths', async () => {
  assert.deepEqual(
    safeEnvironment({
      PATH: '/test/bin',
      HOME: '/test/home',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: '/test/tmp',
      SYSTEMROOT: '/test/system',
      MYSQL_PWD: 'excluded',
      AWS_SESSION_TOKEN: 'excluded',
      V2_ENCRYPTION_KEY: 'excluded',
      DYLD_LIBRARY_PATH: 'excluded'
    }),
    {
      PATH: '/test/bin',
      HOME: '/test/home',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: '/test/tmp',
      SYSTEMROOT: '/test/system'
    }
  );
  const area = await ownedArea();
  try {
    for (const name of ['mysql', 'mysqldump', 'mysqld', 'mysqladmin']) {
      const expected = [
        '--no-defaults',
        ...(name === 'mysqld' ? [] : ['--no-login-paths']),
        '--version'
      ];
      const source =
        '#!' +
        process.execPath +
        '\n' +
        'if (JSON.stringify(process.argv.slice(2)) !== ' +
        JSON.stringify(JSON.stringify(expected)) +
        ') process.exit(2);\nprocess.stdout.write("MySQL 8.4.11\\n");\n';
      await writeFile(join(area, name), source, { mode: 0o700 });
    }
    assert.equal((await mysqlTools(area)).version, '8.4.11');
    await assert.rejects(mysqlTools('relative/bin'), code('ABSOLUTE_PATH_REQUIRED'));
  } finally {
    await rm(area, { recursive: true });
  }
});

test('default preflight and explicit commands reject credentials or existing restore targets', () => {
  assert.equal(parseArgs([]).command, 'check');
  assert.equal(parseArgs(['preflight']).command, 'preflight');
  assert.throws(() => parseArgs(['backup', '--password=do-not-log']), code('OPTION_INVALID'));
  assert.throws(
    () => parseArgs(['verify', '--defaults-file=/private/existing.cnf']),
    code('RESTORE_TARGET_OPTIONS_FORBIDDEN')
  );
  assert.throws(
    () => parseArgs(['verify', '--database=existing']),
    code('RESTORE_TARGET_OPTIONS_FORBIDDEN')
  );
  assert.throws(
    () => parseArgs(['backup', '--database=a', '--database=b']),
    code('OPTION_INVALID')
  );
});
test('dump is consistent, read only and preserves routines, events and triggers', () => {
  const args = dumpArguments(
    { args: ['--defaults-file=/private/client.cnf', '--no-login-paths'] },
    'idv2'
  );
  for (const flag of [
    '--single-transaction',
    '--routines',
    '--events',
    '--triggers',
    '--skip-lock-tables',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--init-command=SET SESSION TRANSACTION READ ONLY'
  ])
    assert.ok(args.includes(flag));
  assert.ok(!args.some((value) => value.startsWith('--password') || value.includes('docker')));
  assert.throws(
    () => dumpArguments({ args: [] }, 'existing; DROP DATABASE mysql'),
    code('DATABASE_NAME_INVALID')
  );
});
test('private defaults reject includes, command injection, public modes and symlinks', async () => {
  const area = await ownedArea();
  const path = join(area, 'client.cnf');
  try {
    await writeFile(path, '[client]\nuser=root\n!include=/private/other.cnf\n', { mode: 0o600 });
    await assert.rejects(configuredConnection(path), code('DEFAULTS_FILE_INVALID'));
    await writeFile(path, '[client]\nuser=root\ninit-command=DELETE FROM users\n', { mode: 0o600 });
    await assert.rejects(configuredConnection(path), code('DEFAULTS_FILE_INVALID'));
    await chmod(path, 0o644);
    await assert.rejects(privateBytes(path), code('PRIVATE_FILE_REQUIRED'));
    await chmod(path, 0o600);
    const alias = join(area, 'alias.cnf');
    await symlink(path, alias);
    await assert.rejects(privateBytes(alias), code('SYMLINK_REJECTED'));
  } finally {
    await rm(area, { recursive: true });
  }
});
test('normalizer changes only the original DELIMITER trigger blocks', () => {
  const before =
    "INSERT INTO fixture VALUES ('; */;;');\nDELIMITER ;;\nSIGNAL SQLSTATE '45000'; */;;\nDELIMITER ;\n";
  const after = normalizeDump(Buffer.from(before)).toString();
  assert.ok(after.startsWith("INSERT INTO fixture VALUES ('; */;;');"));
  assert.ok(after.includes("SIGNAL SQLSTATE '45000' */;;"));
});
test('encrypted archive rejects ciphertext, manifest and wrong-key changes; plaintext is fixture only', () => {
  const key = randomBytes(32);
  const dump = Buffer.from('-- empty test fixture\n');
  const compressed = gzipSync(dump);
  const rows = [];
  const manifest = {
    database: 'idv2_native_fixture_123456abcdef',
    mysqlVersion: '8.4.11',
    mode: 'OWNED_EMPTY_FIXTURE',
    fixtureOwner: 'owned-test',
    createdAt: new Date().toISOString(),
    sqlSha256: sha256(dump),
    gzipSha256: sha256(compressed),
    definitions: {
      rows,
      sha256: sha256(JSON.stringify(rows)),
      counts: { S: 0, T: 0, F: 0, E: 0, V: 0 }
    }
  };
  const encrypted = sealArchive(manifest, compressed, key);
  assert.deepEqual(openArchive(JSON.stringify(encrypted), key, 'owned-test').dump, dump);
  assert.throws(
    () => openArchive(JSON.stringify(encrypted), randomBytes(32), 'owned-test'),
    code('ARCHIVE_AUTHENTICATION_FAILED')
  );
  const corrupted = structuredClone(encrypted);
  const payload = Buffer.from(corrupted.payload, 'base64');
  payload[0] ^= 1;
  corrupted.payload = payload.toString('base64');
  assert.throws(
    () => openArchive(JSON.stringify(corrupted), key, 'owned-test'),
    code('ARCHIVE_AUTHENTICATION_FAILED')
  );
  const altered = structuredClone(encrypted);
  altered.manifest.createdAt = '2026-10-08T00:00:00.000Z';
  assert.throws(
    () => openArchive(JSON.stringify(altered), key, 'owned-test'),
    code('ARCHIVE_AUTHENTICATION_FAILED')
  );
  const plaintext = sealArchive(manifest, compressed);
  assert.throws(
    () => openArchive(JSON.stringify(plaintext)),
    code('USER_DATA_ENCRYPTION_REQUIRED')
  );
  assert.throws(
    () => openArchive(JSON.stringify(plaintext), undefined, 'different-owner'),
    code('FIXTURE_OWNER_MISMATCH')
  );
  assert.throws(
    () => requireCoreSnapshot(manifest.definitions),
    code('CURRENT_ID_PROTECTION_REQUIRED')
  );
  key.fill(0);
});
test('S3 is only a size/checksum/encryption/retention parameter preparation', () => {
  const plan = s3Preparation(
    { s3Bucket: 'test-example-bucket' },
    '/private/own.backup.json',
    Buffer.from('fixture')
  );
  assert.equal(plan.status, 'PREPARED_NOT_EXECUTED');
  assert.equal(plan.putObject.ServerSideEncryption, 'AES256');
  assert.equal(plan.putObject.ContentLength, 7);
  assert.equal(plan.headObject.requireSHA256, sha256(Buffer.from('fixture')));
  assert.equal(plan.retention.status, 'POLICY_PREPARED_NOT_APPLIED');
  assert.throws(
    () =>
      s3Preparation(
        { s3Bucket: 'test-example-bucket', s3Prefix: '../wrong' },
        '/private/own.backup.json',
        Buffer.from('fixture')
      ),
    code('S3_PLAN_INVALID')
  );
});
