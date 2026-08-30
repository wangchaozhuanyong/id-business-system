import { PrismaClient } from '@prisma/client';
import { assertV2AuditConnectionReadOnly } from './lib/v2-data-integrity-audit.mjs';
import {
  assertV2IntegrityFunctionDefiner,
  assertV2ProductionDatabaseGrants,
  assertV2TriggerDefiners,
  buildV2ProductionDatabaseAccountProvisioning
} from './lib/v2-production-database-access.mjs';

const provisioning = buildV2ProductionDatabaseAccountProvisioning(process.env);
const clients = {
  audit: new PrismaClient({ datasourceUrl: provisioning.localAuditDatabaseUrl }),
  backup: new PrismaClient({ datasourceUrl: provisioning.localBackupDatabaseUrl }),
  migration: new PrismaClient({ datasourceUrl: provisioning.localMigrationDatabaseUrl }),
  runtime: new PrismaClient({ datasourceUrl: provisioning.localRuntimeDatabaseUrl })
};

try {
  await Promise.all(Object.values(clients).map((client) => client.$connect()));
  const [
    auditGrants,
    backupGrants,
    migrationGrants,
    routineRows,
    runtimeGrants,
    tableRows,
    triggerRows
  ] = await Promise.all([
    clients.audit.$queryRawUnsafe('SHOW GRANTS'),
    clients.backup.$queryRawUnsafe('SHOW GRANTS'),
    clients.migration.$queryRawUnsafe('SHOW GRANTS'),
    clients.migration.$queryRawUnsafe(
      `SELECT DEFINER AS definer, SECURITY_TYPE AS securityType
           FROM information_schema.routines
          WHERE ROUTINE_SCHEMA = '${provisioning.databaseName}'
            AND ROUTINE_NAME = 'idv2_integrity_trigger_exists'
            AND ROUTINE_TYPE = 'FUNCTION'`
    ),
    clients.runtime.$queryRawUnsafe('SHOW GRANTS'),
    clients.runtime.$queryRawUnsafe(
      `SELECT TABLE_NAME AS tableName
           FROM information_schema.tables
          WHERE TABLE_SCHEMA = '${provisioning.databaseName}'
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`
    ),
    clients.migration.$queryRawUnsafe(
      `SELECT TRIGGER_NAME AS triggerName, DEFINER AS definer
           FROM information_schema.triggers
          WHERE TRIGGER_SCHEMA = '${provisioning.databaseName}'
          ORDER BY TRIGGER_NAME`
    )
  ]);
  const tableNames = tableRows.map((row) => String(row.tableName));
  assertV2AuditConnectionReadOnly(auditGrants);
  assertV2IntegrityFunctionDefiner(routineRows);
  assertV2TriggerDefiners(triggerRows);
  assertV2ProductionDatabaseGrants({
    backupGrants,
    databaseName: provisioning.databaseName,
    migrationGrants,
    runtimeGrants,
    tableNames
  });
  console.log(
    JSON.stringify({
      ok: true,
      accounts: provisioning.accounts,
      runtimeTableCount: tableNames.length,
      triggerCount: triggerRows.length
    })
  );
} finally {
  await Promise.all(
    Object.values(clients).map((client) => client.$disconnect().catch(() => undefined))
  );
}
