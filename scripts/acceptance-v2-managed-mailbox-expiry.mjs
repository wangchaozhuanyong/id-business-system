import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const containerName = `id-business-v2-mailbox-expiry-${process.pid}`;
const rootPassword = 'acceptance-mailbox-root-password-123';
const databaseName = 'id_business_v2';

try {
  runDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--env',
    `MYSQL_ROOT_PASSWORD=${rootPassword}`,
    '--env',
    `MYSQL_DATABASE=${databaseName}`,
    'mysql:8.4'
  ]);
  await waitForMysql();
  executeSql(`
    CREATE TABLE \`users\` (
      \`id\` CHAR(36) NOT NULL PRIMARY KEY
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE TABLE \`id_business_v2_managed_mailboxes\` (
      \`id\` CHAR(36) NOT NULL PRIMARY KEY,
      \`status\` VARCHAR(20) NOT NULL
    );
    INSERT INTO \`id_business_v2_managed_mailboxes\` (\`id\`, \`status\`)
    VALUES ('11111111-1111-4111-8111-111111111111', 'active');
  `);
  executeSql(
    readFileSync(
      'apps/api/prisma-mysql/migrations/20260828130000_managed_mailbox_query_code_expiry/migration.sql',
      'utf8'
    )
  );
  executeSql(
    readFileSync(
      'apps/api/prisma-mysql/migrations/20260829100000_managed_mailbox_query_code_settings/migration.sql',
      'utf8'
    )
  );
  executeSql(`
    INSERT INTO \`id_business_v2_managed_mailbox_settings\` (\`id\`, \`scope\`)
    VALUES ('33333333-3333-4333-8333-333333333333', 'global');
  `);

  const [isNullable, remainingSeconds, indexCount, defaultValidityDays] = querySql(`
    SELECT
      (SELECT IS_NULLABLE
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'id_business_v2_managed_mailboxes'
          AND column_name = 'query_code_expires_at'),
      TIMESTAMPDIFF(
        SECOND,
        UTC_TIMESTAMP(6),
        (SELECT query_code_expires_at
           FROM id_business_v2_managed_mailboxes
          WHERE id = '11111111-1111-4111-8111-111111111111')
      ),
      (SELECT COUNT(DISTINCT index_name)
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'id_business_v2_managed_mailboxes'
          AND index_name = 'idv2_mailboxes_status_query_code_expires_at_idx'),
      (SELECT query_code_validity_days
         FROM id_business_v2_managed_mailbox_settings
        WHERE scope = 'global');
  `)
    .trim()
    .split('\t');

  assert.equal(isNullable, 'NO');
  assert.ok(Number(remainingSeconds) >= 30 * 24 * 60 * 60 - 10);
  assert.ok(Number(remainingSeconds) <= 30 * 24 * 60 * 60);
  assert.equal(indexCount, '1');
  assert.equal(defaultValidityDays, '30');
  assert.throws(
    () =>
      executeSql(`
        INSERT INTO \`id_business_v2_managed_mailboxes\` (\`id\`, \`status\`)
        VALUES ('22222222-2222-4222-8222-222222222222', 'active');
      `),
    /doesn't have a default value|cannot be null/i
  );
  console.log('V2 managed mailbox query-code expiry acceptance passed.');
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { encoding: 'utf8' });
}

async function waitForMysql() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        containerName,
        'mysqladmin',
        'ping',
        '--host=127.0.0.1',
        '--user=root',
        `--password=${rootPassword}`,
        '--silent'
      ],
      { encoding: 'utf8' }
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('临时 MySQL 在 60 秒内未就绪');
}

function executeSql(sql) {
  const result = mysql(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function querySql(sql) {
  const result = mysql(sql, ['--batch', '--skip-column-names']);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function mysql(sql, extraArgs = []) {
  return spawnSync(
    'docker',
    [
      'exec',
      '--interactive',
      containerName,
      'mysql',
      '--host=127.0.0.1',
      '--user=root',
      `--password=${rootPassword}`,
      ...extraArgs,
      databaseName
    ],
    { encoding: 'utf8', input: sql }
  );
}

function runDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
