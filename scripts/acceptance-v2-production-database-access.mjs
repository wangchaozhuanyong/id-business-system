import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const containerName = `id-business-v2-db-access-${process.pid}`;
const databaseName = 'id_business_v2';
const rootPassword = 'acceptance-root-password-123456';
const migrationPassword = 'acceptance-migration-password-123';
const runtimePassword = 'acceptance-runtime-password-123456';
const auditPassword = 'acceptance-audit-password-12345678';
const backupPassword = 'acceptance-backup-password-1234567';

try {
  runDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::3306',
    '--env',
    `MYSQL_ROOT_PASSWORD=${rootPassword}`,
    '--env',
    `MYSQL_DATABASE=${databaseName}`,
    'mysql:8.4',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_0900_ai_ci',
    '--default-time-zone=+00:00',
    '--log-bin-trust-function-creators=1'
  ]);
  await waitForMysql();
  const port = dockerOutput(['port', containerName, '3306/tcp']).trim().split(':').at(-1);
  assert.match(port, /^\d+$/);
  createAcceptanceSchema();

  const environment = {
    ...process.env,
    DATABASE_URL: `mysql://id_business_app:${runtimePassword}@mysql:3306/${databaseName}`,
    MIGRATION_DATABASE_URL: `mysql://id_business_migrator:${migrationPassword}@mysql:3306/${databaseName}`,
    MYSQL_BACKUP_PASSWORD: backupPassword,
    MYSQL_BACKUP_USER: 'id_business_backup',
    MYSQL_DATABASE: databaseName,
    MYSQL_HOST_PORT: port,
    MYSQL_PASSWORD: migrationPassword,
    MYSQL_ROOT_PASSWORD: rootPassword,
    MYSQL_USER: 'id_business_migrator',
    V2_DATA_INTEGRITY_DATABASE_URL: `mysql://id_business_audit:${auditPassword}@127.0.0.1:${port}/${databaseName}`,
    V2_RUNTIME_DATABASE_URL: `mysql://id_business_app:${runtimePassword}@127.0.0.1:${port}/${databaseName}`
  };
  runNodeScript('scripts/provision-v2-production-database-access.mjs', environment);
  createAcceptanceIntegrityFunction();
  runNodeScript('scripts/provision-v2-data-integrity-auditor.mjs', environment);
  runNodeScript('scripts/gate-v2-production-database-access.mjs', environment);
  await verifyRuntimeEnforcement(environment.V2_RUNTIME_DATABASE_URL);
  console.log('V2 production database access acceptance passed.');
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

function createAcceptanceSchema() {
  const sql = `
    CREATE TABLE \`_prisma_migrations\` (id INT PRIMARY KEY);
    CREATE TABLE \`users\` (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL);
    CREATE TABLE \`audit_logs\` (id INT PRIMARY KEY, payload VARCHAR(80) NOT NULL);
    CREATE TABLE \`sensitive_access_logs\` (id INT PRIMARY KEY, payload VARCHAR(80) NOT NULL);
    CREATE TABLE \`ip_whitelists\` (id INT PRIMARY KEY, cidr VARCHAR(40) NOT NULL);
    CREATE TABLE \`id_business_v2_orders\` (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL);
  `;
  const result = spawnSync(
    'docker',
    [
      'exec',
      '--interactive',
      containerName,
      'mysql',
      '--host=127.0.0.1',
      '--user=root',
      `--password=${rootPassword}`,
      databaseName
    ],
    { encoding: 'utf8', input: sql }
  );
  assert.equal(result.status, 0, result.stderr);
}

function createAcceptanceIntegrityFunction() {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '--interactive',
      containerName,
      'mysql',
      '--host=127.0.0.1',
      '--user=id_business_migrator',
      `--password=${migrationPassword}`,
      databaseName
    ],
    {
      encoding: 'utf8',
      input:
        'CREATE FUNCTION `idv2_integrity_trigger_exists`() RETURNS INTEGER DETERMINISTIC NO SQL SQL SECURITY DEFINER RETURN 1;'
    }
  );
  assert.equal(result.status, 0, result.stderr);
}

async function verifyRuntimeEnforcement(databaseUrl) {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$executeRawUnsafe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'user')");
    await client.$executeRawUnsafe("UPDATE `users` SET `name` = 'updated' WHERE `id` = 1");
    await client.$executeRawUnsafe(
      "INSERT INTO `audit_logs` (`id`, `payload`) VALUES (1, 'created')"
    );
    await client.$executeRawUnsafe(
      "INSERT INTO `ip_whitelists` (`id`, `cidr`) VALUES (1, '203.0.113.0/24')"
    );
    await client.$executeRawUnsafe('DELETE FROM `ip_whitelists` WHERE `id` = 1');
    await assert.rejects(
      client.$executeRawUnsafe('CREATE TABLE `runtime_must_not_create` (`id` INT)'),
      /denied|command denied|privilege/i
    );
    await assert.rejects(
      client.$executeRawUnsafe('DELETE FROM `users` WHERE `id` = 1'),
      /denied|command denied/i
    );
    await assert.rejects(
      client.$executeRawUnsafe("UPDATE `audit_logs` SET `payload` = 'tampered' WHERE `id` = 1"),
      /denied|command denied/i
    );
    await assert.rejects(
      client.$executeRawUnsafe('INSERT INTO `_prisma_migrations` (`id`) VALUES (1)'),
      /denied|command denied/i
    );
  } finally {
    await client.$disconnect();
  }
}

function runNodeScript(path, environment) {
  const result = spawnSync(process.execPath, [path], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment
  });
  assert.equal(result.status, 0, `${path}\n${result.stdout}\n${result.stderr}`);
}

function runDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function dockerOutput(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
