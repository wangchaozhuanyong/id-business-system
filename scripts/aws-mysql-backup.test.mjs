import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

function backupFixture(run) {
  const evidenceRoot = resolve(projectRoot, '.runtime/registration-worker-only-release-20261005');
  mkdirSync(evidenceRoot, { recursive: true });
  const root = mkdtempSync(join(evidenceRoot, 'backup-fixture-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  writeFileSync(log, '');
  const environmentFile = join(root, 'production.env');
  const archive = join(root, 'backup.sql.gz');
  const writeEnvironment = (
    database = 'active_fixture_database',
    urlDatabase = database,
    extra = ''
  ) =>
    writeFileSync(
      environmentFile,
      `MYSQL_DATABASE=${database}\nDATABASE_URL=mysql://id_business_app:fixture-only@mysql:3306/${urlDatabase}?connection_limit=3\n${extra}`
    );
  writeEnvironment();
  const writeExecutable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  writeExecutable(
    'docker',
    `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + '\\n');
if (args[0] === 'run') {
  const target = args.find(value => value.startsWith('MYSQL_DATABASE='))?.split('=')[1];
  record({ kind: 'restore-run', target, isolated: args.includes('none') });
  process.stdout.write('fixture-container\\n');
} else if (args[0] === 'rm') {
  record({ kind: 'restore-remove' });
} else {
  const env = { ...process.env, MYSQL_DATABASE: 'old_fixture_database',
    MYSQL_BACKUP_USER: 'id_business_backup', MYSQL_BACKUP_PASSWORD: 'fixture-only',
    MYSQL_ROOT_PASSWORD: 'fixture-only' };
  if (args[0] === 'compose') {
    const override = args[args.indexOf('-e') + 1];
    if (!override || !override.startsWith('MYSQL_DATABASE=')) process.exit(19);
    env.MYSQL_DATABASE = override.slice('MYSQL_DATABASE='.length);
    record({ kind: 'backup-exec', target: env.MYSQL_DATABASE });
  } else if (args[0] === 'exec') {
    env.MYSQL_DATABASE = 'id_business_v2_restore';
  } else process.exit(18);
  const result = spawnSync('sh', ['-c', args.at(-1)], { env, stdio: 'inherit' });
  process.exit(result.status ?? 17);
}
`
  );
  writeExecutable(
    'mysqldump',
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const kind = args.includes('--user=root') ? 'routine' : 'data';
const flags = args.filter(value => value.startsWith('--') && !value.startsWith('--password='));
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ kind, target: args.at(-1), flags }) + '\\n');
if (kind === 'data') process.stdout.write('CREATE TABLE fixture (id int);\\nINSERT INTO fixture VALUES (1);\\n');
else process.stdout.write('CREATE FUNCTION idv2_integrity_trigger_exists() RETURNS INTEGER RETURN 1;\\n');
if (process.env.FIXTURE_FAILURE === kind) process.exit(7);
`
  );
  writeExecutable('mysqladmin', '#!/bin/sh\nexit 0\n');
  writeExecutable(
    'mysql',
    `#!/usr/bin/env node
import fs from 'node:fs';
const sql = fs.readFileSync(0, 'utf8');
if (sql.includes('SELECT\\n')) process.stdout.write('6 6 1\\n');
else if (sql.includes('SELECT CONCAT')) process.stdout.write('CHECK TABLE fixture;\\n');
else if (sql.startsWith('CHECK TABLE')) {
  for (let index = 0; index < 6; index++) process.stdout.write('restore.fixture' + index + '\\tcheck\\tstatus\\tOK\\n');
} else fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ kind: 'restore-import',
  target: process.env.MYSQL_DATABASE, data: sql.includes('INSERT INTO fixture'),
  routine: sql.includes('CREATE FUNCTION idv2_integrity_trigger_exists') }) + '\\n');
`
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_LOG: log,
    environment_file: environmentFile,
    compose_file: join(root, 'compose.yml'),
    partial_file: archive,
    normalizer_script: resolve(projectRoot, 'scripts/mysql-dump-restore-normalizer.sed')
  };
  const source = readProjectFile('scripts/backup-aws-mysql.sh');
  const validationStart = source.indexOf('target_database="$(python3');
  const validationEnd = source.indexOf('\ns3_bucket=', validationStart);
  const pipelineStart = source.indexOf('\n{\n  docker compose');
  const pipelineEnd = source.indexOf('\ngzip -t "${partial_file}"', pipelineStart);
  assert.ok(validationStart > 0 && validationEnd > validationStart);
  assert.ok(pipelineStart > validationEnd && pipelineEnd > pipelineStart);
  const execute = ({ pipeline = true, failure = '' } = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail\n' +
          source.slice(validationStart, validationEnd) +
          (pipeline
            ? source.slice(pipelineStart, pipelineEnd) +
              '\ngzip -t "${partial_file}"\nprintf complete > "$FIXTURE_COMPLETED"\n'
            : '')
      ],
      {
        env: { ...env, FIXTURE_FAILURE: failure, FIXTURE_COMPLETED: join(root, 'completed') },
        encoding: 'utf8'
      }
    );
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    run({ root, archive, env, execute, events, writeEnvironment });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('backup data and metadata dumps explicitly use the active database despite an old container target', () => {
  backupFixture(({ execute, events, archive }) => {
    const result = execute();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      events().map(({ kind, target }) => ({ kind, target })),
      [
        { kind: 'backup-exec', target: 'active_fixture_database' },
        { kind: 'data', target: 'active_fixture_database' },
        { kind: 'backup-exec', target: 'active_fixture_database' },
        { kind: 'routine', target: 'active_fixture_database' }
      ]
    );
    const routine = events().find(({ kind }) => kind === 'routine');
    for (const flag of [
      '--routines',
      '--no-data',
      '--no-create-info',
      '--skip-triggers',
      '--no-tablespaces',
      '--skip-add-locks',
      '--skip-lock-tables',
      '--set-gtid-purged=OFF'
    ])
      assert.ok(routine.flags.includes(flag), flag);
    assert.ok(
      events()
        .find(({ kind }) => kind === 'data')
        .flags.includes('--user=id_business_backup')
    );
    const restored = spawnSync('gzip', ['-dc', archive], { encoding: 'utf8' });
    assert.equal(restored.status, 0);
    assert.match(restored.stdout, /INSERT INTO fixture/);
    assert.match(restored.stdout, /CREATE FUNCTION idv2_integrity_trigger_exists/);
    assert.doesNotMatch(restored.stdout, /USE |CREATE DATABASE|GRANT /);
  });
});

test('invalid, duplicate or inconsistent active target configuration stops before either dump', () => {
  for (const [database, urlDatabase, extra] of [
    ['bad-name', 'bad-name'],
    ['', ''],
    ['x'.repeat(65), 'x'.repeat(65)],
    ['active_fixture_database', 'old_fixture_database'],
    ['active_fixture_database', 'active_fixture_database/another'],
    ['active_fixture_database', 'active_fixture_database#fragment'],
    ['active_fixture_database', 'active_fixture_database', 'MYSQL_DATABASE=old_fixture_database\n'],
    [
      'active_fixture_database',
      'active_fixture_database',
      'DATABASE_URL=mysql://fixture@mysql/old_fixture_database\n'
    ]
  ])
    backupFixture(({ execute, events, writeEnvironment, root }) => {
      writeEnvironment(database, urlDatabase, extra);
      const result = execute();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /MySQL backup target configuration is invalid/);
      assert.doesNotMatch(result.stderr, /fixture-only|mysql:\/\//);
      assert.deepEqual(events(), []);
      assert.equal(existsSync(join(root, 'completed')), false);
    });
});

test('a failed data or metadata dump prevents completion even if a partial archive exists', () => {
  for (const failure of ['data', 'routine'])
    backupFixture(({ execute, events, root }) => {
      assert.notEqual(execute({ failure }).status, 0);
      assert.deepEqual(
        events()
          .filter(({ kind }) => kind === 'data' || kind === 'routine')
          .map(({ kind }) => kind),
        failure === 'data' ? ['data'] : ['data', 'routine']
      );
      assert.equal(existsSync(join(root, 'completed')), false);
    });
});

test('a two-part active database dump restores in the fixed isolated database without reading production configuration', () => {
  backupFixture(({ execute, events, root, archive, env }) => {
    assert.equal(execute().status, 0);
    const deployment = join(root, 'deployment');
    mkdirSync(join(deployment, 'scripts'), { recursive: true });
    writeFileSync(
      join(deployment, 'scripts/mysql-dump-restore-normalizer.sed'),
      readProjectFile('scripts/mysql-dump-restore-normalizer.sed')
    );
    const result = spawnSync(
      'bash',
      [
        resolve(projectRoot, 'scripts/verify-aws-mysql-backup.sh'),
        `--archive=${archive}`,
        `--deployment-directory=${deployment}`,
        `--work-directory=${join(root, 'drills')}`
      ],
      { env, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      events().find(({ kind }) => kind === 'restore-run'),
      { kind: 'restore-run', target: 'id_business_v2_restore', isolated: true }
    );
    assert.deepEqual(
      events().find(({ kind }) => kind === 'restore-import'),
      { kind: 'restore-import', target: 'id_business_v2_restore', data: true, routine: true }
    );
    assert.match(
      result.stdout,
      /MySQL isolated restore verified: tables=6, checked=6, migrations=1/
    );
  });
});

test('AWS MySQL backup shell scripts pass bash syntax validation', () => {
  for (const script of ['scripts/backup-aws-mysql.sh', 'scripts/verify-aws-mysql-backup.sh']) {
    const result = spawnSync('bash', ['-n', resolve(projectRoot, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('production backup requires S3 and verifies the remote SHA-256 checksum', () => {
  const source = readProjectFile('scripts/backup-aws-mysql.sh');

  assert.match(source, /MYSQL_BACKUP_S3_BUCKET 未配置/);
  assert.match(source, /--checksum-algorithm SHA256/);
  assert.match(source, /--checksum-mode ENABLED/);
  assert.match(source, /remote_checksum_base64/);
  assert.match(source, /MYSQL_BACKUP_LOCAL_RETENTION_COUNT/);
  assert.match(source, /MYSQL_BACKUP_LOCAL_MAX_BYTES/);
  assert.match(source, /MYSQL_BACKUP_MIN_FREE_BYTES/);
  assert.match(source, /prune_local_backups/);
  assert.match(source, /mysql-dump-restore-normalizer\.sed/);
  assert.match(source, /sed -E -f "\$\{normalizer_script\}"/);
  assert.match(source, /MYSQL_BACKUP_USER/);
  assert.match(source, /MYSQL_BACKUP_PASSWORD/);
  assert.doesNotMatch(source, /--user="\$MYSQL_USER"/);
});

test('restore verification downloads S3 data into an isolated MySQL 8.4 container', () => {
  const source = readProjectFile('scripts/verify-aws-mysql-backup.sh');

  assert.match(source, /mysql_image="mysql:8\.4@sha256:[a-f0-9]{64}"/);
  assert.match(source, /--network none/);
  assert.match(source, /--checksum-mode ENABLED/);
  assert.match(source, /normalize_mysql_dump_stream/);
  assert.match(source, /CHECK TABLE/);
  assert.doesNotMatch(source, /mysqlcheck --check/);
  assert.match(source, /checked_table_count/);
  assert.match(source, /_prisma_migrations/);
  assert.match(source, /id_business_v2_finance_journals/);
  assert.match(source, /trap cleanup EXIT INT TERM/);
});

test('restore drill paths are explicit and never use a shared temporary directory', () => {
  const source = readProjectFile('scripts/verify-aws-mysql-backup.sh');
  assert.match(source, /--deployment-directory=/);
  assert.match(source, /--work-directory=/);
  assert.match(source, /work_directory.*\/opt\/id-business-v2\/backups\/mysql\/restore-drills/);
  assert.match(source, /mktemp -d "\$\{work_directory\}\/restore\.XXXXXX"/);
  assert.doesNotMatch(source, /mktemp -d \/tmp/);
  const result = spawnSync(
    'bash',
    [resolve(projectRoot, 'scripts/verify-aws-mysql-backup.sh'), '--deployment-directory=relative'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必须是绝对路径/);
});

test('restore normalizer fixes MySQL trigger terminators without rewriting normal SQL', () => {
  const fixture = [
    'CREATE TABLE `untouched` (`id` int); */;;',
    'DELIMITER ;;',
    "/*!50003 CREATE*/ /*!50003 TRIGGER `single` BEFORE UPDATE ON `x` FOR EACH ROW SIGNAL SQLSTATE '45000'; */;;",
    '/*!50003 CREATE*/ /*!50003 TRIGGER `multi` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.`v` = CASE',
    '  WHEN NEW.`v` = 1 THEN 2',
    '  ELSE NULL',
    'END; */;;',
    'DELIMITER ;',
    ''
  ].join('\n');
  const result = spawnSync(
    'sed',
    ['-E', '-f', resolve(projectRoot, 'scripts/mysql-dump-restore-normalizer.sed')],
    { encoding: 'utf8', input: fixture }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    fixture
      .replace("SIGNAL SQLSTATE '45000'; */;;", "SIGNAL SQLSTATE '45000' */;;")
      .replace('END; */;;', 'END */;;')
  );
});

test('systemd uses frequent backups and a weekly restore verification', () => {
  const backupTimer = readProjectFile('deploy/systemd/id-business-v2-mysql-backup.timer');
  const backupService = readProjectFile('deploy/systemd/id-business-v2-mysql-backup.service');
  const verifyTimer = readProjectFile('deploy/systemd/id-business-v2-mysql-backup-verify.timer');
  const verifyService = readProjectFile(
    'deploy/systemd/id-business-v2-mysql-backup-verify.service'
  );

  assert.match(backupTimer, /OnCalendar=\*-\*-\* \*:00,30:00/);
  assert.match(verifyTimer, /OnCalendar=Sun/);
  assert.match(backupService, /User=root/);
  assert.match(backupService, /UMask=0077/);
  assert.match(verifyService, /User=root/);
  assert.match(verifyService, /UMask=0077/);
  assert.match(verifyService, /verify-aws-mysql-backup\.sh/);
});

test('S3 lifecycle expires backup objects instead of retaining them forever', () => {
  const template = readProjectFile('deploy/aws/id-business-v2-backup-ssm.yaml');

  assert.match(template, /ExpirationInDays: 90/);
  assert.match(template, /NoncurrentVersionExpiration:\s+NoncurrentDays: 30/);
});
test('obsolete PostgreSQL production backup workflow is absent', () => {
  assert.equal(existsSync(resolve(projectRoot, '.github/workflows/production-backup.yml')), false);
});
