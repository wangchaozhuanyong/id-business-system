import { PrismaClient } from '@prisma/client';
import { assertV2AuditConnectionReadOnly } from './lib/v2-data-integrity-audit.mjs';
import {
  assertV2ProductionDatabaseGrants,
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
  const [auditGrants, backupGrants, migrationGrants, runtimeGrants, tableRows] = await Promise.all([
    clients.audit.$queryRawUnsafe('SHOW GRANTS'),
    clients.backup.$queryRawUnsafe('SHOW GRANTS'),
    clients.migration.$queryRawUnsafe('SHOW GRANTS'),
    clients.runtime.$queryRawUnsafe('SHOW GRANTS'),
    clients.runtime.$queryRawUnsafe(
      `SELECT TABLE_NAME AS tableName
           FROM information_schema.tables
          WHERE TABLE_SCHEMA = '${provisioning.databaseName}'
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`
    )
  ]);
  const tableNames = tableRows.map((row) => String(row.tableName));
  assertV2AuditConnectionReadOnly(auditGrants);
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
      runtimeTableCount: tableNames.length
    })
  );
} finally {
  await Promise.all(
    Object.values(clients).map((client) => client.$disconnect().catch(() => undefined))
  );
}
