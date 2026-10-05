import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
if (kind === 'data') process.stdout.write(${JSON.stringify(restoreFixtureSql('active_fixture_database', 'missing-function'))});
else process.stdout.write(${JSON.stringify(
      '-- Host: 127.0.0.1    Database: active_fixture_database\nDELIMITER ;;\n' +
        restoreFixtureSql('active_fixture_database').match(/^CREATE DEFINER=.* FUNCTION .*$/m)[0] +
        '\nDELIMITER ;\n'
    )});
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
    assert.match(restored.stdout, /INSERT INTO `users`/);
    assert.match(restored.stdout, /FUNCTION `idv2_integrity_trigger_exists`/);
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

test('a two-part active database dump restores in an isolated container with the configured schema', () => {
  backupFixture(({ execute, archive }) => {
    assert.equal(execute().status, 0);
    const restored = spawnSync('gzip', ['-dc', archive], { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    const harness = restoreHarness({ database: 'active_fixture_database', sql: restored.stdout });
    try {
      const result = harness.run();
      assert.equal(result.status, 0, result.stderr);
      const run = harness.calls().find((call) => call.tool === 'docker' && call.args[0] === 'run');
      assert.ok(run.args.includes('--network') && run.args.includes('none'));
      assert.ok(run.args.includes('MYSQL_DATABASE=active_fixture_database'));
      assert.match(
        result.stdout,
        /MySQL isolated restore verified: tables=8, checked=8, migrations=1/
      );
      assert.match(result.stdout, /rollbackProbes=7/);
    } finally {
      harness.cleanup();
    }
  });
});

// This fixture is deliberately synthetic. It exercises restore protections,
// not the business schema or production customer/order records.
function restoreFixtureSql(database, variant = 'valid') {
  const definer = variant === 'invalid-definer' ? 'id_business_app' : 'id_business_migrator';
  const header = variant === 'invalid-schema' ? 'another_database' : database;
  const tables = [
    '_prisma_migrations',
    'users',
    'audit_logs',
    'id_business_v2_orders',
    'id_business_v2_finance_journals',
    'id_business_v2_balance_ledger',
    'id_business_v2_finance_journal_lines',
    'restore_fixture_non_core'
  ];
  const guards = [
    ['idv2_audit_log_no_update', 'audit_logs', 'UPDATE', 'Audit logs are immutable'],
    ['idv2_audit_log_no_delete', 'audit_logs', 'DELETE', 'Audit logs are immutable'],
    [
      'idv2_balance_ledger_no_update',
      'id_business_v2_balance_ledger',
      'UPDATE',
      'V2 balance ledger is immutable'
    ],
    [
      'idv2_balance_ledger_no_delete',
      'id_business_v2_balance_ledger',
      'DELETE',
      'V2 balance ledger is immutable'
    ],
    [
      'idv2_finance_journal_no_delete',
      'id_business_v2_finance_journals',
      'DELETE',
      'Posted finance journals cannot be deleted'
    ],
    [
      'idv2_finance_line_no_update',
      'id_business_v2_finance_journal_lines',
      'UPDATE',
      'Posted finance journal lines are immutable'
    ],
    [
      'idv2_finance_line_no_delete',
      'id_business_v2_finance_journal_lines',
      'DELETE',
      'Posted finance journal lines are immutable'
    ]
  ];
  let sql = `-- Host: 127.0.0.1    Database: ${header}\n`;
  for (const table of tables) {
    if (variant === 'missing-non-core-table' && table === 'restore_fixture_non_core') continue;
    sql +=
      table === '_prisma_migrations'
        ? 'CREATE TABLE `_prisma_migrations` (`id` INT PRIMARY KEY, `finished_at` DATETIME, `rolled_back_at` DATETIME);\nINSERT INTO `_prisma_migrations` VALUES (1,UTC_TIMESTAMP(),NULL);\n'
        : `CREATE TABLE \`${table}\` (\`id\` ${variant === 'schema-drift' && table === 'restore_fixture_non_core' ? 'BIGINT' : 'INT'} PRIMARY KEY);\nINSERT INTO \`${table}\` VALUES (1);\n`;
  }
  sql += 'DELIMITER ;;\n';
  if (variant !== 'missing-function') {
    sql += `CREATE DEFINER=\`${definer}\`@\`%\` FUNCTION \`idv2_integrity_trigger_exists\`(expected_trigger VARCHAR(64),expected_table VARCHAR(64)) RETURNS TINYINT NOT DETERMINISTIC READS SQL DATA SQL SECURITY DEFINER RETURN EXISTS (SELECT 1 FROM information_schema.triggers trigger_record WHERE trigger_record.trigger_schema=DATABASE() AND trigger_record.event_object_table=expected_table AND trigger_record.trigger_name=expected_trigger);;\n`;
  }
  for (const [name, table, operation, message] of guards) {
    const body =
      variant === 'missing-protection' && name === 'idv2_audit_log_no_update'
        ? 'SET NEW.id=NEW.id'
        : `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='${message}'`;
    sql += `CREATE DEFINER=\`${definer}\`@\`%\` TRIGGER \`${name}\` BEFORE ${operation} ON \`${table}\` FOR EACH ROW ${body};;\n`;
  }
  for (let index = 1; index <= 42; index++) {
    sql += `CREATE DEFINER=\`${definer}\`@\`%\` TRIGGER \`restore_fixture_extra_${index}\` BEFORE INSERT ON \`users\` FOR EACH ROW SET NEW.id=NEW.id;;\n`;
  }
  return sql + 'DELIMITER ;\n';
}

const fixtureArgument = process.argv.find((argument) =>
  argument.startsWith('--write-restore-fixture=')
);
if (fixtureArgument) {
  const destination = fixtureArgument.slice('--write-restore-fixture='.length);
  const databaseArgument = process.argv.find((argument) => argument.startsWith('--database='));
  const variantArgument = process.argv.find((argument) => argument.startsWith('--variant='));
  const database =
    databaseArgument?.slice('--database='.length) ?? 'id_business_v2_restore_fixture';
  const variant = variantArgument?.slice('--variant='.length) ?? 'valid';
  assert.match(database, /^[A-Za-z0-9_]{1,64}$/);
  assert.ok(
    [
      'valid',
      'invalid-definer',
      'invalid-schema',
      'missing-function',
      'missing-protection',
      'missing-non-core-table',
      'schema-drift'
    ].includes(variant)
  );
  assert.ok(destination.startsWith(projectRoot + '/') && destination.endsWith('.sql.gz'));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, gzipSync(restoreFixtureSql(database, variant)), {
    flag: 'wx',
    mode: 0o600
  });
  console.log(JSON.stringify({ synthetic: true, database, variant, archive: destination }));
  process.exit(0);
}

function restoreHarness(options = {}) {
  const harnessRoot = resolve(projectRoot, 'backups/restore-tests');
  mkdirSync(harnessRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(resolve(harnessRoot, 'case-'));
  const binaryDirectory = resolve(directory, 'bin');
  const deploymentDirectory = resolve(directory, 'deployment');
  const workDirectory = resolve(directory, 'work');
  mkdirSync(binaryDirectory);
  mkdirSync(resolve(deploymentDirectory, 'scripts'), { recursive: true });
  writeFileSync(
    resolve(deploymentDirectory, 'scripts/mysql-dump-restore-normalizer.sed'),
    readProjectFile('scripts/mysql-dump-restore-normalizer.sed')
  );
  const database = options.database ?? 'id_business_v2_restore_fixture';
  if (!options.noEnvironment) {
    writeFileSync(
      resolve(deploymentDirectory, '.env.aws.production'),
      [
        `MYSQL_DATABASE=${database}`,
        'COMPOSE_PROJECT_NAME=restore_fixture',
        'MYSQL_BACKUP_S3_BUCKET=fixture-backups',
        'MYSQL_BACKUP_S3_PREFIX=mysql/daily',
        'MYSQL_BACKUP_S3_REGION=ap-northeast-1',
        ''
      ].join('\n'),
      { mode: 0o600 }
    );
  }
  const archive = resolve(directory, 'fixture.sql.gz');
  const sql = options.sql ?? restoreFixtureSql('id_business_v2_restore_fixture');
  const archiveBytes = gzipSync(sql);
  writeFileSync(archive, archiveBytes, { mode: 0o600 });
  const calls = resolve(directory, 'calls.jsonl');
  const state = resolve(directory, 'label');
  const behavior = options.behavior ?? 'valid';
  const mockDocker = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const logArgs = args.map(arg => arg.startsWith('MYSQL_ROOT_PASSWORD=') ? 'MYSQL_ROOT_PASSWORD=[REDACTED]' : arg);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: 'docker', args: logArgs, input })+'\\n');
const behavior = ${JSON.stringify(behavior)};
if (args[0] === 'ps') { process.stdout.write(behavior === 'ambiguous-source' ? 'fixture-source\\nfixture-other\\n' : 'fixture-source\\n'); }
else if (args[0] === 'run') { const label = args[args.indexOf('--label')+1].split('=')[1]; fs.writeFileSync(${JSON.stringify(state)}, label); process.stdout.write('own-container\\n'); }
else if (args[0] === 'inspect') { process.stdout.write(fs.readFileSync(${JSON.stringify(state)}, 'utf8')+'\\n'); }
else if (args[0] === 'exec' && args.some(a => a.includes('mysqladmin ping'))) {}
else if (args[0] === 'exec') {
  if (input.includes('CREATE USER')) {}
  else if (input.includes('-- Host:')) {}
  else if (input.includes("SELECT 'T',TRIGGER_NAME")) {
    const ownRestore = !args.includes('fixture-source');
    let changedSource = false;
    if (!ownRestore && behavior === 'source-changed') {
      const path = ${JSON.stringify(state + '-source-count')};
      const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8'))+1 : 1;
      fs.writeFileSync(path, String(count)); changedSource = count > 1;
    }
    const tables = ['_prisma_migrations','users','audit_logs','id_business_v2_orders','id_business_v2_finance_journals','id_business_v2_balance_ledger','id_business_v2_finance_journal_lines','restore_fixture_non_core'];
    const metadata = tables.filter(table => !(ownRestore && behavior === 'missing-non-core-table' && table === 'restore_fixture_non_core')).map(table => 'S\\t'+table+'\\t'+(ownRestore && behavior === 'schema-drift' ? 'e' : 'd').repeat(64));
    metadata.push(...Array.from({length:49},(_,index)=>'T\\ttrigger_'+index+'\\t'+('a'.repeat(64))));
    metadata.push('F\\tidv2_integrity_trigger_exists\\t'+((behavior === 'definition-drift' && ownRestore) || changedSource ? 'c'.repeat(64) : 'b'.repeat(64)));
    if (behavior === 'source-incomplete') metadata.pop();
    process.stdout.write(metadata.join('\\n')+'\\n');
  }
  else if (input.includes('SELECT\\n  (SELECT COUNT(*) FROM information_schema.tables')) process.stdout.write('8\\t6\\t1\\n');
  else if (input.includes('valid_function_marker_never_used')) {}
  else if (input.includes('FROM mysql.user')) {
    const values = [49, 1, 0, 0, 1, 0, 1, 7];
    if (behavior === 'missing-function') values[1] = 0;
    if (behavior === 'invalid-definer') values[2] = 1;
    if (behavior === 'invalid-schema') values[3] = 1;
    if (behavior === 'unlocked-definer') values[4] = 0;
    if (behavior === 'wrong-grants') values[5] = 1;
    if (behavior === 'function-drift') values[6] = 0;
    if (behavior === 'missing-trigger') values[7] = 6;
    process.stdout.write(values.join('\\t')+'\\n');
  }
  else if (input.includes('restore_probe_missing_trigger')) process.stdout.write(behavior === 'bad-function-result' ? '1\\t1\\t0\\t0\\n' : '1\\t1\\t1\\t0\\n');
  else if (input.includes('SELECT COUNT(*) FROM \\x60')) process.stdout.write('1\\n');
  else if (input.includes('START TRANSACTION;')) {
    if (!input.includes('ROLLBACK;') || !args.includes('--force')) process.exit(2);
    let message = input.includes('audit_logs') ? 'Audit logs are immutable' : input.includes('balance_ledger') ? 'V2 balance ledger is immutable' : input.includes('journal_lines') ? 'Posted finance journal lines are immutable' : 'Posted finance journals cannot be deleted';
    if (behavior === 'definer-runtime-error') process.stderr.write('ERROR 1449 (HY000) at line 3: PRIVATE_TOKEN\\n');
    else if (behavior !== 'missing-protection') process.stderr.write('ERROR 1644 (45000) at line 3: '+message+'\\n');
    process.stdout.write('restore_probe_rolled_back\\n');
  }
  else if (input.includes("SELECT CONCAT('CHECK TABLE")) process.stdout.write('CHECK TABLE fixture;\\n');
  else if (input.startsWith('CHECK TABLE')) process.stdout.write(Array.from({length:8},(_,i)=>'fixture.table'+i+'\\tcheck\\tstatus\\tOK').join('\\n')+'\\n');
  else { process.stderr.write('ERROR 1000 (HY000): PRIVATE_TOKEN\\n'); process.exit(1); }
}
`;
  writeFileSync(resolve(binaryDirectory, 'docker'), mockDocker, { mode: 0o700 });
  const checksum = createHash('sha256').update(archiveBytes).digest('base64');
  const mockAws = `#!${process.execPath}
import fs from 'node:fs'; const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({tool:'aws',args})+'\\n');
if (args.includes('list-objects-v2')) {
 process.stdout.write('mysql/daily/id-business-v2-20261005T090000Z.sql.gz\\t2026-10-05T09:00:00+00:00\\nmysql/daily/id-business-v2-20261005T100000Z.sql.gz\\t2026-10-05T10:00:00+00:00\\nmysql/daily/id-business-v2-20261005T110000Z.sql.gz/routines.json\\t2026-10-05T11:00:00+00:00\\nmysql/daily/id-business-v2-20261005T120000Z.json\\t2026-10-05T12:00:00+00:00\\n');
} else if (args.includes('head-object')) {
 if (${JSON.stringify(Boolean(options.awsHead404))}) { process.stderr.write('An error occurred (404) when calling the HeadObject operation: PRIVATE_TOKEN fixture-backups\\n'); process.exit(254); }
 process.stdout.write(${JSON.stringify(options.badChecksum ? 'A'.repeat(43) + '=' : checksum)}+'\\t'+${JSON.stringify(options.badSize ? archiveBytes.length + 1 : archiveBytes.length)}+'\\t'+${JSON.stringify(options.badEncryption ? 'aws:kms' : 'AES256')}+'\\n');
} else if (args.includes('get-object')) fs.copyFileSync(${JSON.stringify(archive)},args[args.length-1]);
`;
  writeFileSync(resolve(binaryDirectory, 'aws'), mockAws, { mode: 0o700 });
  return {
    run: () =>
      spawnSync(
        'bash',
        [
          resolve(projectRoot, 'scripts/verify-aws-mysql-backup.sh'),
          `--deployment-directory=${deploymentDirectory}`,
          `--work-directory=${workDirectory}`,
          ...(options.s3 ? [] : [`--archive=${archive}`])
        ],
        {
          env: { ...process.env, PATH: binaryDirectory + ':' + process.env.PATH },
          encoding: 'utf8',
          timeout: 20_000
        }
      ),
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

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

test('restore binds the configured schema and preserves a locked scoped definer', () => {
  const harness = restoreHarness();
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rollbackProbes=7/);
    const calls = harness.calls();
    const run = calls.find((call) => call.tool === 'docker' && call.args[0] === 'run');
    assert.ok(run.args.includes('--network') && run.args.includes('none'));
    assert.ok(run.args.includes('MYSQL_DATABASE=id_business_v2_restore_fixture'));
    const provisioning = calls.find((call) => call.input?.includes('CREATE USER'));
    assert.match(provisioning.input, /CREATE USER 'id_business_migrator'@'%' ACCOUNT LOCK/);
    assert.match(
      provisioning.input,
      /GRANT ALL PRIVILEGES ON `id_business_v2_restore_fixture`\.\*/
    );
    assert.doesNotMatch(provisioning.input, /GRANT ALL PRIVILEGES ON \*\.\*/);
    const probes = calls.filter((call) => call.input?.includes('restore_probe_rolled_back'));
    assert.equal(probes.length, 7);
    for (const probe of probes) {
      assert.match(probe.input, /START TRANSACTION;[\s\S]*ROLLBACK;/);
      assert.ok(probe.args.includes('--force'));
    }
    const sourceCaptures = calls.filter(
      (call) =>
        call.args.includes('fixture-source') && call.input?.includes("SELECT 'T',TRIGGER_NAME")
    );
    assert.equal(sourceCaptures.length, 2);
    assert.ok(
      sourceCaptures.every(
        (call) =>
          call.input.includes('SET TRANSACTION READ ONLY;') && call.input.includes('ROLLBACK;')
      )
    );
    assert.ok(
      sourceCaptures.every((call) =>
        call.args.includes('MYSQL_DATABASE=id_business_v2_restore_fixture')
      )
    );
    assert.ok(calls.some((call) => call.args[0] === 'rm' && call.args.includes('-v')));
  } finally {
    harness.cleanup();
  }
});

test('S3 selection excludes newer companions and nested paths before choosing latest archive', () => {
  const harness = restoreHarness({ s3: true });
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    const head = harness
      .calls()
      .find((call) => call.tool === 'aws' && call.args.includes('head-object'));
    assert.equal(
      head.args[head.args.indexOf('--key') + 1],
      'mysql/daily/id-business-v2-20261005T100000Z.sql.gz'
    );
    assert.doesNotMatch(result.stdout + result.stderr, /s3:\/\/|fixture-backups/);
  } finally {
    harness.cleanup();
  }
});

for (const [description, options] of [
  ['missing environment', { noEnvironment: true }],
  ['missing database configuration', { database: '' }],
  ['unsafe database identifier', { database: 'schema;DROP TABLE users' }],
  ['missing archive schema header', { sql: 'SELECT 1;\n' }],
  ['wrong archive schema', { sql: restoreFixtureSql('another_database') }],
  [
    'conflicting appended routines schema',
    {
      sql:
        restoreFixtureSql('id_business_v2_restore_fixture') +
        '-- Host: 127.0.0.1    Database: another_database\n'
    }
  ],
  ['wrong S3 checksum', { s3: true, badChecksum: true }],
  ['wrong S3 archive size', { s3: true, badSize: true }],
  ['missing AES256 evidence', { s3: true, badEncryption: true }]
]) {
  test(`restore rejects ${description} before starting an own container`, () => {
    const harness = restoreHarness(options);
    try {
      const result = harness.run();
      assert.notEqual(result.status, 0);
      assert.equal(
        harness.calls().filter((call) => call.tool === 'docker' && call.args[0] === 'run').length,
        0
      );
    } finally {
      harness.cleanup();
    }
  });
}

for (const behavior of [
  'missing-function',
  'invalid-definer',
  'invalid-schema',
  'unlocked-definer',
  'wrong-grants',
  'function-drift',
  'missing-trigger',
  'bad-function-result',
  'missing-protection',
  'definer-runtime-error',
  'definition-drift',
  'schema-drift',
  'missing-non-core-table',
  'ambiguous-source',
  'source-incomplete',
  'source-changed'
]) {
  test(`restore fails closed for ${behavior} and suppresses private errors`, () => {
    const harness = restoreHarness({ behavior });
    try {
      const result = harness.run();
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /PRIVATE_TOKEN|MySQL isolated restore verified/
      );
      if (!['ambiguous-source', 'source-incomplete'].includes(behavior)) {
        assert.ok(harness.calls().some((call) => call.args[0] === 'rm'));
      }
    } finally {
      harness.cleanup();
    }
  });
}

test('AWS HeadObject 404 is classified without exposing logs or object locations', () => {
  const harness = restoreHarness({ s3: true, awsHead404: true });
  try {
    const result = harness.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operation=HeadObject, code=404/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TOKEN|fixture-backups/);
    assert.equal(harness.calls().filter((call) => call.args[0] === 'run').length, 0);
  } finally {
    harness.cleanup();
  }
});
