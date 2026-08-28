import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  V2_RUNTIME_DELETE_TABLES,
  assertV2ProductionDatabaseGrants,
  buildV2ProductionDatabaseAccountProvisioning,
  buildV2RuntimeTableGrantStatements
} from './lib/v2-production-database-access.mjs';

const databaseName = 'id_business_v2';
const environment = {
  DATABASE_URL: 'mysql://id_business_app:runtime-password-123456789@mysql:3306/id_business_v2',
  MIGRATION_DATABASE_URL:
    'mysql://id_business_migrator:migration-password-123456@mysql:3306/id_business_v2',
  MYSQL_BACKUP_PASSWORD: 'backup-password-1234567890',
  MYSQL_BACKUP_USER: 'id_business_backup',
  MYSQL_DATABASE: databaseName,
  MYSQL_HOST_PORT: '3306',
  MYSQL_PASSWORD: 'migration-password-123456',
  MYSQL_ROOT_PASSWORD: 'root-password-123456789012',
  MYSQL_USER: 'id_business_migrator',
  V2_DATA_INTEGRITY_DATABASE_URL:
    'mysql://id_business_audit:audit-password-12345678901@127.0.0.1:3306/id_business_v2',
  V2_RUNTIME_DATABASE_URL:
    'mysql://id_business_app:runtime-password-123456789@127.0.0.1:3306/id_business_v2'
};

test('production database provisioning requires four fixed, distinct service identities', () => {
  const provisioning = buildV2ProductionDatabaseAccountProvisioning(environment);
  assert.deepEqual(provisioning.accounts, {
    audit: 'id_business_audit',
    backup: 'id_business_backup',
    migration: 'id_business_migrator',
    runtime: 'id_business_app'
  });
  assert.match(provisioning.rootDatabaseUrl, /^mysql:\/\/root:/);
  assert.match(provisioning.localMigrationDatabaseUrl, /^mysql:\/\/id_business_migrator:/);
  assert.match(provisioning.localRuntimeDatabaseUrl, /^mysql:\/\/id_business_app:/);
  assert.match(provisioning.localBackupDatabaseUrl, /^mysql:\/\/id_business_backup:/);
  assert.ok(
    provisioning.statements.some((statement) =>
      statement.startsWith('GRANT ALL PRIVILEGES ON `id_business_v2`.*')
    )
  );
  assert.ok(
    provisioning.statements.every(
      (statement) =>
        !statement.includes("GRANT ALL PRIVILEGES ON `id_business_v2`.* TO 'id_business_app'")
    )
  );

  assert.throws(
    () =>
      buildV2ProductionDatabaseAccountProvisioning({
        ...environment,
        MYSQL_USER: 'id_business_app'
      }),
    /MYSQL_USER 必须为 id_business_migrator/
  );
  assert.throws(
    () =>
      buildV2ProductionDatabaseAccountProvisioning({
        ...environment,
        MYSQL_BACKUP_PASSWORD: environment.MYSQL_PASSWORD
      }),
    /必须使用不同密码/
  );
});

test('runtime grants protect migration and audit records while limiting physical deletes', () => {
  const tableNames = [
    '_prisma_migrations',
    'audit_logs',
    'sensitive_access_logs',
    'users',
    'ip_whitelists',
    'id_business_v2_orders'
  ];
  const grants = buildV2RuntimeTableGrantStatements(databaseName, tableNames);
  assert.ok(
    grants.includes(
      "GRANT SELECT ON `id_business_v2`.`_prisma_migrations` TO 'id_business_app'@'%'"
    )
  );
  assert.ok(
    grants.includes(
      "GRANT SELECT, INSERT ON `id_business_v2`.`audit_logs` TO 'id_business_app'@'%'"
    )
  );
  assert.ok(
    grants.includes(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `id_business_v2`.`ip_whitelists` TO 'id_business_app'@'%'"
    )
  );
  assert.ok(
    grants.includes(
      "GRANT SELECT, INSERT, UPDATE ON `id_business_v2`.`id_business_v2_orders` TO 'id_business_app'@'%'"
    )
  );
  assert.equal(V2_RUNTIME_DELETE_TABLES.includes('id_business_v2_orders'), false);
});

test('production grant gate rejects DDL, broad runtime access and unexpected deletes', () => {
  const tableNames = ['_prisma_migrations', 'audit_logs', 'users', 'ip_whitelists'];
  const validInput = {
    backupGrants: [
      { grant: 'GRANT USAGE ON *.* TO `id_business_backup`@`%`' },
      {
        grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `id_business_v2`.* TO `id_business_backup`@`%`'
      }
    ],
    databaseName,
    migrationGrants: [
      { grant: 'GRANT USAGE ON *.* TO `id_business_migrator`@`%`' },
      {
        grant: 'GRANT ALL PRIVILEGES ON `id_business_v2`.* TO `id_business_migrator`@`%`'
      }
    ],
    runtimeGrants: [
      { grant: 'GRANT USAGE ON *.* TO `id_business_app`@`%`' },
      { grant: 'GRANT SELECT ON `id_business_v2`.`_prisma_migrations` TO `id_business_app`@`%`' },
      { grant: 'GRANT SELECT, INSERT ON `id_business_v2`.`audit_logs` TO `id_business_app`@`%`' },
      {
        grant: 'GRANT SELECT, INSERT, UPDATE ON `id_business_v2`.`users` TO `id_business_app`@`%`'
      },
      {
        grant:
          'GRANT SELECT, INSERT, UPDATE, DELETE ON `id_business_v2`.`ip_whitelists` TO `id_business_app`@`%`'
      }
    ],
    tableNames
  };
  assert.doesNotThrow(() => assertV2ProductionDatabaseGrants(validInput));
  assert.throws(
    () =>
      assertV2ProductionDatabaseGrants({
        ...validInput,
        runtimeGrants: [
          { grant: 'GRANT ALL PRIVILEGES ON `id_business_v2`.* TO `id_business_app`@`%`' }
        ]
      }),
    /非表级授权/
  );
  assert.throws(
    () =>
      assertV2ProductionDatabaseGrants({
        ...validInput,
        runtimeGrants: validInput.runtimeGrants.map((row) =>
          row.grant.includes('`users`')
            ? {
                grant:
                  'GRANT SELECT, INSERT, UPDATE, DELETE ON `id_business_v2`.`users` TO `id_business_app`@`%`'
              }
            : row
        )
      }),
    /users/
  );
});

test('AWS Compose and backup scripts use their dedicated database identities', () => {
  const compose = readFileSync('docker-compose.aws-mysql.yml', 'utf8');
  const backup = readFileSync('scripts/backup-aws-mysql.sh', 'utf8');
  assert.match(
    compose,
    /DATABASE_URL: \$\{MIGRATION_DATABASE_URL:\?set MySQL MIGRATION_DATABASE_URL\}/
  );
  assert.match(compose, /DATABASE_URL: \$\{DATABASE_URL:\?set MySQL DATABASE_URL\}/);
  assert.match(compose, /MYSQL_BACKUP_USER: \$\{MYSQL_BACKUP_USER:\?set MYSQL_BACKUP_USER\}/);
  assert.match(backup, /--user="\$MYSQL_BACKUP_USER"/);
  assert.match(backup, /--password="\$MYSQL_BACKUP_PASSWORD"/);
});
