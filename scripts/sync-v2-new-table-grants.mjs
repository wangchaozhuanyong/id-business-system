import { PrismaClient } from '@prisma/client';
import {
  assertV2ProductionDatabaseGrants,
  buildV2RuntimeTableGrantStatements
} from './lib/v2-production-database-access.mjs';

const connection = new URL(process.env.DATABASE_URL);
const databaseName = connection.pathname.slice(1);
if (
  connection.protocol !== 'mysql:' ||
  connection.hostname !== 'mysql' ||
  connection.username !== 'root' ||
  !/^[A-Za-z0-9_]+$/.test(databaseName)
) {
  throw new Error('新增表权限同步必须使用生产容器内的管理连接');
}
const newTables = [...new Set(process.argv.slice(2))];
if (newTables.some((name) => !/^[A-Za-z0-9_]+$/.test(name))) {
  throw new Error('新增数据表名格式无效');
}
const prisma = new PrismaClient();

try {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT TABLE_NAME AS tableName FROM information_schema.tables
     WHERE TABLE_SCHEMA = '${databaseName}' AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  const tableNames = rows.map((row) => String(row.tableName));
  if (newTables.some((name) => !tableNames.includes(name))) {
    throw new Error('新增表迁移尚未完成');
  }
  for (const statement of buildV2RuntimeTableGrantStatements(databaseName, newTables)) {
    await prisma.$executeRawUnsafe(statement);
  }
  const [backupGrants, migrationGrants, runtimeGrants] = await Promise.all([
    prisma.$queryRawUnsafe("SHOW GRANTS FOR 'id_business_backup'@'%'"),
    prisma.$queryRawUnsafe("SHOW GRANTS FOR 'id_business_migrator'@'%'"),
    prisma.$queryRawUnsafe("SHOW GRANTS FOR 'id_business_app'@'%'")
  ]);
  assertV2ProductionDatabaseGrants({
    backupGrants,
    databaseName,
    migrationGrants,
    runtimeGrants,
    tableNames
  });
  console.log(
    JSON.stringify({
      ok: true,
      newTableCount: newTables.length,
      runtimeTableCount: tableNames.length
    })
  );
} finally {
  await prisma.$disconnect();
}
