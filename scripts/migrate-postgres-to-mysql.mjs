#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const CONFIRMATION = 'COPY_CURRENT_SYSTEM_POSTGRES_TO_MYSQL';
const EXCLUDED_TARGET_TABLES = new Set(['_prisma_migrations', 'mysql_transaction_locks']);
const INSERT_BATCH_SIZE = 50;

const sourceUrl = requiredUrl('SOURCE_DATABASE_URL', 'postgresql:');
const destinationUrl = requiredUrl('DATABASE_URL', 'mysql:');
const dryRun = process.env.MIGRATION_DRY_RUN === 'true';
if (!dryRun && process.env.MIGRATION_CONFIRM !== CONFIRMATION) {
  throw new Error(`数据迁移必须显式设置 MIGRATION_CONFIRM=${CONFIRMATION}`);
}
if (sourceUrl.href === destinationUrl.href) {
  throw new Error('源数据库和目标数据库不得相同');
}

const source = new pg.Client(normalizePostgresConnection(sourceUrl));
const destination = new PrismaClient({
  transactionOptions: { maxWait: 30_000, timeout: 60 * 60 * 1_000 }
});
let sourceClosed = false;

try {
  await source.connect();
  await destination.$connect();

  const sourceTables = await listPostgresTables(source);
  const destinationTables = await listMysqlTables(destination);
  const migrationTables = [...destinationTables]
    .filter((table) => sourceTables.has(table) && !EXCLUDED_TARGET_TABLES.has(table))
    .sort();
  const missingSourceTables = [...destinationTables]
    .filter((table) => !sourceTables.has(table) && !EXCLUDED_TARGET_TABLES.has(table))
    .sort();
  if (missingSourceTables.length > 0) {
    throw new Error(`源数据库缺少目标表：${missingSourceTables.join(', ')}`);
  }

  const sourceCounts = new Map();
  for (const table of migrationTables) {
    const sourceCount = await postgresCount(source, table);
    const destinationCount = await mysqlCount(destination, table);
    sourceCounts.set(table, sourceCount);
    if (destinationCount !== 0) {
      throw new Error(`目标表 ${table} 不是空表（${destinationCount} 行），迁移已停止`);
    }
  }

  printPlan({
    dryRun,
    migrationTables,
    sourceCounts,
    ignoredSourceTableCount: [...sourceTables].filter((table) => !destinationTables.has(table)).length
  });
  if (dryRun) process.exitCode = 0;
  else {
    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let tableCopies;
    try {
      tableCopies = [];
      for (const table of migrationTables) {
        tableCopies.push(await readSourceTable(source, table, destination));
      }
      await source.query('COMMIT');
    } catch (error) {
      await source.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await source.end();
    sourceClosed = true;

    await destination.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET SESSION FOREIGN_KEY_CHECKS = 0');
        try {
          for (const tableCopy of tableCopies) {
            await writeDestinationTable(tx, tableCopy);
          }
        } finally {
          await tx.$executeRawUnsafe('SET SESSION FOREIGN_KEY_CHECKS = 1');
        }
      },
      { maxWait: 30_000, timeout: 60 * 60 * 1_000 }
    );

    let copiedRows = 0;
    for (const table of migrationTables) {
      const expected = sourceCounts.get(table) ?? 0;
      const actual = await mysqlCount(destination, table);
      if (actual !== expected) {
        throw new Error(`目标表 ${table} 行数校验失败：期望 ${expected}，实际 ${actual}`);
      }
      copiedRows += actual;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: false,
          migratedTableCount: migrationTables.length,
          copiedRows,
          rowCountsVerified: true
        },
        null,
        2
      )
    );
  }
} finally {
  if (!sourceClosed) await source.end().catch(() => undefined);
  await destination.$disconnect().catch(() => undefined);
}

async function readSourceTable(source, table, destination) {
  const sourceColumns = await listPostgresColumns(source, table);
  const destinationColumns = await listMysqlColumns(destination, table);
  const columns = destinationColumns.filter((column) => sourceColumns.has(column.name));
  if (columns.length === 0) throw new Error(`表 ${table} 没有可迁移字段`);

  const sourceRows = await source.query(
    `SELECT ${columns.map((column) => quotePostgres(column.name)).join(', ')} FROM ${quotePostgres(table)}`
  );
  return { table, columns, rows: sourceRows.rows };
}

async function writeDestinationTable(destination, tableCopy) {
  const { table, columns, rows } = tableCopy;
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    if (batch.length === 0) continue;
    const placeholders = batch
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    const values = batch.flatMap((row) =>
      columns.map((column) => normalizeValue(row[column.name], column.dataType))
    );
    await destination.$executeRawUnsafe(
      `INSERT INTO ${quoteMysql(table)} (${columns.map((column) => quoteMysql(column.name)).join(', ')}) VALUES ${placeholders}`,
      ...values
    );
  }
}

async function listPostgresTables(client) {
  const result = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function listMysqlTables(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.tables
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  );
  return new Set(rows.map((row) => row.tableName));
}

async function listPostgresColumns(client, table) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function listMysqlColumns(client, table) {
  return client.$queryRawUnsafe(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    table
  );
}

async function postgresCount(client, table) {
  const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quotePostgres(table)}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function mysqlCount(client, table) {
  const rows = await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM ${quoteMysql(table)}`);
  return Number(rows[0]?.count ?? 0);
}

function normalizeValue(value, dataType) {
  if (value === null || value === undefined) return null;
  if (dataType === 'json') return JSON.stringify(value);
  return value;
}

function normalizePostgresConnection(url) {
  const normalized = new URL(url);
  for (const option of ['schema', 'pgbouncer', 'connection_limit', 'pool_timeout', 'sslmode']) {
    normalized.searchParams.delete(option);
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  return {
    connectionString: normalized.toString(),
    keepAlive: true,
    ssl: localHosts.has(normalized.hostname) ? undefined : { rejectUnauthorized: false }
  };
}

function requiredUrl(name, protocol) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  const url = new URL(value);
  if (url.protocol !== protocol) throw new Error(`${name} 必须使用 ${protocol}//`);
  return url;
}

function quotePostgres(identifier) {
  assertIdentifier(identifier);
  return `"${identifier}"`;
}

function quoteMysql(identifier) {
  assertIdentifier(identifier);
  return `\`${identifier}\``;
}

function assertIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`数据库标识符无效：${value}`);
}

function printPlan({ dryRun, migrationTables, sourceCounts, ignoredSourceTableCount }) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        migrationTableCount: migrationTables.length,
        sourceRows: [...sourceCounts.values()].reduce((sum, count) => sum + count, 0),
        ignoredLegacySourceTableCount: ignoredSourceTableCount,
        targetEmptyVerified: true
      },
      null,
      2
    )
  );
}
