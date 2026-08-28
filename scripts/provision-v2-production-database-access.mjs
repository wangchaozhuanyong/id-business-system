import { PrismaClient } from '@prisma/client';
import {
  assertV2ProductionDatabaseGrants,
  buildV2ProductionDatabaseAccountProvisioning,
  buildV2RuntimeTableGrantStatements
} from './lib/v2-production-database-access.mjs';

const provisioning = buildV2ProductionDatabaseAccountProvisioning(process.env);
const prisma = new PrismaClient({ datasourceUrl: provisioning.rootDatabaseUrl });

try {
  for (const statement of provisioning.statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  const tableNames = await readTableNames(prisma, provisioning.databaseName);
  for (const statement of buildV2RuntimeTableGrantStatements(
    provisioning.databaseName,
    tableNames
  )) {
    await prisma.$executeRawUnsafe(statement);
  }
  const [backupGrants, migrationGrants, runtimeGrants] = await Promise.all([
    prisma.$queryRawUnsafe(provisioning.showGrantsSql.backup),
    prisma.$queryRawUnsafe(provisioning.showGrantsSql.migration),
    prisma.$queryRawUnsafe(provisioning.showGrantsSql.runtime)
  ]);
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
  await prisma.$disconnect();
}

async function readTableNames(client, databaseName) {
  const rows = await client.$queryRawUnsafe(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.tables
      WHERE TABLE_SCHEMA = '${databaseName}'
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`
  );
  return rows.map((row) => String(row.tableName));
}
