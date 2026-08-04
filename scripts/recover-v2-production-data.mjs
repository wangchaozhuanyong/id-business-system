#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client, types } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';

const EXPECTED_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
const EXPECTED_SOURCE_BACKUP_SHA256 =
  '0f7d59dcdfc4c2501cbf4aed6e7152b1e267f554350abb78283020c915b3cfd2';
const RECOVERY_ACTION = 'id_business_v2.production_data.recovery';

// Preserve exact PostgreSQL textual values for bigint, Decimal and microsecond timestamps.
for (const oid of [20, 1082, 1083, 1114, 1184, 1266, 1700]) {
  types.setTypeParser(oid, (value) => value);
}

const TABLES = [
  'attachments',
  'id_business_v2_finance_fx_rate_snapshots',
  'id_business_v2_finance_accounts',
  'id_business_v2_topup_supplier_accounts',
  'id_business_v2_customers',
  'id_business_v2_accounts',
  'id_business_v2_gift_cards',
  'id_business_v2_orders',
  'id_business_v2_account_locks',
  'id_business_v2_activations',
  'id_business_v2_customer_tags',
  'id_business_v2_customer_services',
  'id_business_v2_topup_supplier_payments',
  'id_business_v2_finance_journals',
  'id_business_v2_finance_journal_lines',
  'id_business_v2_topup_supplier_ledger',
  'id_business_v2_balance_ledger',
  'id_business_v2_account_losses',
  'id_business_v2_finance_periods',
  'id_business_v2_finance_expenses',
  'id_business_v2_renewal_operations',
  'id_business_v2_renewal_evidence',
  'audit_logs'
];

const BUSINESS_TABLES = TABLES.filter(
  (table) =>
    table.startsWith('id_business_v2_') && table !== 'id_business_v2_finance_fx_rate_snapshots'
);

const SOURCE_WHOLE_TABLES = TABLES.filter(
  (table) => table !== 'attachments' && table !== 'audit_logs'
);

const SELF_REFERENCE_COLUMNS = new Map([
  ['id_business_v2_finance_journals', 'reversal_of_journal_id'],
  ['id_business_v2_topup_supplier_ledger', 'reversal_of_entry_id'],
  ['id_business_v2_balance_ledger', 'reversal_of_entry_id']
]);

const STAGED_COLUMN_GROUPS = new Map([
  ['id_business_v2_accounts', [['sold_by_order_id', 'sold_at']]],
  ['id_business_v2_activations', [['renewed_from_activation_id']]]
]);

const args = parseArgs(process.argv.slice(2));
const mode = args.apply ? 'apply' : 'plan';
const sourceRaw = process.env.RECOVERY_SOURCE_DATABASE_URL;
const targetRaw = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!sourceRaw) throw new Error('缺少 RECOVERY_SOURCE_DATABASE_URL');
if (!targetRaw) throw new Error('缺少 DIRECT_URL 或 DATABASE_URL');
assertLocalSource(sourceRaw);
assertExpectedTarget(targetRaw, args.allowLocalTargetForRehearsal);
if (args.sourceBackupSha256 !== EXPECTED_SOURCE_BACKUP_SHA256) {
  throw new Error('源备份 SHA-256 与已核验事故备份不一致');
}
if (!args.preRecoverySha256?.match(/^[a-f0-9]{64}$/)) {
  throw new Error('必须提供已核验的 --pre-recovery-sha256');
}

const expectedConfirmation = args.allowLocalTargetForRehearsal
  ? `REHEARSE_LOCAL_${EXPECTED_SOURCE_BACKUP_SHA256.slice(0, 8)}_${args.preRecoverySha256.slice(0, 8)}`
  : `RECOVER_${EXPECTED_PROJECT_REF}_${EXPECTED_SOURCE_BACKUP_SHA256.slice(0, 8)}_${args.preRecoverySha256.slice(0, 8)}`;
if (mode === 'apply' && args.confirmation !== expectedConfirmation) {
  throw new Error(`生产恢复确认口令不匹配；本次必须显式提供 ${expectedConfirmation}`);
}

const source = new Client({
  ...normalizeDatabaseConnection(sourceRaw),
  application_name: 'id-v2-recovery-source'
});
const target = new Client({
  ...normalizeDatabaseConnection(targetRaw),
  application_name: 'id-v2-production-recovery'
});
let sourceTransactionOpen = false;
let targetTransactionOpen = false;

try {
  await source.connect();
  await target.connect();
  await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  sourceTransactionOpen = true;

  const sourceMigrations = await readMigrationStatus(source);
  const targetMigrations = await readMigrationStatus(target);
  assertMigrationsCurrent(sourceMigrations, '隔离库');
  assertMigrationsCurrent(targetMigrations, '生产库');
  if (stableStringify(sourceMigrations.applied) !== stableStringify(targetMigrations.applied)) {
    throw new Error('隔离库与生产库 migration 历史不一致');
  }

  const sourceMetadata = await readMetadata(source, TABLES);
  const targetMetadata = await readMetadata(target, TABLES);
  assertCompatibleMetadata(sourceMetadata, targetMetadata);

  const sourceRows = await readRecoveryRows(source, sourceMetadata);
  const sourceIntegrity = await verifyIntegrity(source);
  assertIntegrity(sourceIntegrity, '隔离库');

  if (mode === 'apply') {
    await target.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    targetTransactionOpen = true;
    await target.query("SET LOCAL lock_timeout = '10s'");
    await target.query("SET LOCAL statement_timeout = '120s'");
    await target.query(
      `LOCK TABLE ${TABLES.map(quoteQualified).join(', ')} IN SHARE ROW EXCLUSIVE MODE`
    );
  } else {
    await target.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    targetTransactionOpen = true;
  }

  const preservedBefore = await readPreservedSnapshot(target);
  const comparison = await compareTarget(target, sourceRows, targetMetadata);
  assertNoContentConflicts(comparison);
  assertNoUnexpectedBusinessRows(comparison);

  let inserted = Object.fromEntries(TABLES.map((table) => [table, 0]));
  let recoveryAuditId = null;

  if (mode === 'apply') {
    inserted = await insertMissingRows(target, sourceRows, comparison, targetMetadata);

    const afterComparison = await compareTarget(target, sourceRows, targetMetadata);
    assertNoContentConflicts(afterComparison);
    for (const item of Object.values(afterComparison)) {
      if (item.missingPrimaryKeys.length > 0) {
        throw new Error(`${item.table} 恢复后仍缺少 ${item.missingPrimaryKeys.length} 个主键`);
      }
    }

    const targetIntegrity = await verifyIntegrity(target);
    assertIntegrity(targetIntegrity, '生产事务');
    const preservedDuring = await readPreservedSnapshot(target);
    assertPreservedSnapshot(preservedBefore, preservedDuring);

    const audit = await target.query(
      `INSERT INTO public.audit_logs
        (id, user_id, module, action, object_type, object_id, before_data, after_data, ip, user_agent, remark, created_at)
       VALUES
        (gen_random_uuid(), NULL, $1, $2, $3, NULL, NULL, $4::jsonb, NULL, $5, $6, now())
       RETURNING id`,
      [
        'id_business_v2',
        RECOVERY_ACTION,
        'production_data_recovery',
        JSON.stringify({
          sourceBackupSha256: EXPECTED_SOURCE_BACKUP_SHA256,
          preRecoveryBackupSha256: args.preRecoverySha256,
          inserted,
          validation: {
            migrations: 'passed',
            foreignKeys: 'passed',
            financeJournalBalance: 'passed',
            balanceLedgerContinuity: 'passed',
            supplierLedgerContinuity: 'passed',
            preservedData: 'passed'
          }
        }),
        'codex-production-recovery',
        '从隔离 PostgreSQL 17.6 定向恢复；不含敏感资料'
      ]
    );
    recoveryAuditId = audit.rows[0].id;
    inserted.audit_logs += 1;

    await target.query('COMMIT');
    targetTransactionOpen = false;
  } else {
    await target.query('COMMIT');
    targetTransactionOpen = false;
  }

  await source.query('COMMIT');
  sourceTransactionOpen = false;

  const report = {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    projectRef: EXPECTED_PROJECT_REF,
    sourceBackup: {
      sha256: EXPECTED_SOURCE_BACKUP_SHA256
    },
    preRecoveryBackup: {
      sha256: args.preRecoverySha256
    },
    migrations: {
      source: sourceMigrations,
      target: targetMigrations
    },
    integrity: sourceIntegrity,
    preservedBefore,
    tables: Object.fromEntries(
      TABLES.map((table) => [
        table,
        {
          primaryKey: sourceMetadata[table].primaryKey,
          foreignKeys: sourceMetadata[table].foreignKeys,
          sourceCount: sourceRows[table].length,
          sourceContentSha256: hashRows(sourceRows[table], sourceMetadata[table].primaryKey),
          sourcePrimaryKeys: sourceRows[table].map((row) =>
            pick(row, sourceMetadata[table].primaryKey)
          ),
          targetMatchingCount: comparison[table].matchingPrimaryKeys.length,
          targetMissingCount: comparison[table].missingPrimaryKeys.length,
          targetExtraCount: comparison[table].extraPrimaryKeys.length,
          insertedCount: inserted[table]
        }
      ])
    ),
    recoveryAuditId
  };

  if (args.report) {
    const reportPath = path.resolve(args.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o400
    });
    report.reportPath = reportPath;
  }

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (targetTransactionOpen) await target.query('ROLLBACK').catch(() => undefined);
  if (sourceTransactionOpen) await source.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await target.end().catch(() => undefined);
  await source.end().catch(() => undefined);
}

function parseArgs(values) {
  const result = { apply: false };
  for (const value of values) {
    if (value === '--apply') result.apply = true;
    else if (value === '--allow-local-target-for-rehearsal')
      result.allowLocalTargetForRehearsal = true;
    else if (value.startsWith('--source-backup-sha256='))
      result.sourceBackupSha256 = value.split('=', 2)[1];
    else if (value.startsWith('--pre-recovery-sha256='))
      result.preRecoverySha256 = value.split('=', 2)[1];
    else if (value.startsWith('--confirmation=')) result.confirmation = value.split('=', 2)[1];
    else if (value.startsWith('--report=')) result.report = value.split('=', 2)[1];
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function assertLocalSource(raw) {
  const url = new URL(raw);
  if (!new Set(['127.0.0.1', 'localhost', '::1']).has(url.hostname)) {
    throw new Error('隔离恢复源必须是本机 PostgreSQL');
  }
}

function assertExpectedTarget(raw, allowLocalTargetForRehearsal) {
  const url = new URL(raw);
  const isLocal = new Set(['127.0.0.1', 'localhost', '::1']).has(url.hostname);
  if (allowLocalTargetForRehearsal) {
    if (!isLocal) throw new Error('本地演练开关不能用于远程数据库');
    return;
  }
  if (
    !url.username.endsWith(`.${EXPECTED_PROJECT_REF}`) &&
    !url.hostname.startsWith(`${EXPECTED_PROJECT_REF}.`)
  ) {
    throw new Error('目标数据库不是已核验的 Supabase 生产项目');
  }
  if (isLocal) {
    throw new Error('生产恢复目标不能是本机数据库');
  }
}

async function readMigrationStatus(client) {
  const result = await client.query(`
    SELECT migration_name, finished_at, rolled_back_at
    FROM public._prisma_migrations
    ORDER BY migration_name
  `);
  return {
    total: result.rows.length,
    applied: result.rows
      .filter((row) => row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name),
    pendingOrFailed: result.rows
      .filter((row) => !row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name)
  };
}

function assertMigrationsCurrent(status, label) {
  if (status.pendingOrFailed.length > 0) throw new Error(`${label}存在未完成 migration`);
  const required = [
    '20260802010000_normal_id_status_seed',
    '20260802011000_exchange_rate_validation_function'
  ];
  for (const migration of required) {
    if (!status.applied.includes(migration))
      throw new Error(`${label}缺少当前 migration：${migration}`);
  }
}

async function readMetadata(client, tables) {
  const metadata = {};
  for (const table of tables) {
    const columns = await client.query(
      `SELECT column_name, ordinal_position, data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    if (columns.rows.length === 0) throw new Error(`缺少表 public.${table}`);

    const primaryKey = await client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [table]
    );
    if (primaryKey.rows.length === 0) throw new Error(`表 ${table} 缺少主键`);

    const foreignKeys = await client.query(
      `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS referenced_table,
              ccu.column_name AS referenced_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
      [table]
    );

    metadata[table] = {
      columns: columns.rows,
      primaryKey: primaryKey.rows.map((row) => row.column_name),
      foreignKeys: foreignKeys.rows
    };
  }
  return metadata;
}

function assertCompatibleMetadata(sourceMetadata, targetMetadata) {
  for (const table of TABLES) {
    const simplify = (item) =>
      item.columns.map(({ column_name, data_type, udt_name, is_nullable }) => ({
        column_name,
        data_type,
        udt_name,
        is_nullable
      }));
    if (
      stableStringify(simplify(sourceMetadata[table])) !==
      stableStringify(simplify(targetMetadata[table]))
    ) {
      throw new Error(`${table} 的隔离库与生产库字段结构不一致`);
    }
    if (
      stableStringify(sourceMetadata[table].primaryKey) !==
      stableStringify(targetMetadata[table].primaryKey)
    ) {
      throw new Error(`${table} 的隔离库与生产库主键不一致`);
    }
    if (
      stableStringify(sourceMetadata[table].foreignKeys) !==
      stableStringify(targetMetadata[table].foreignKeys)
    ) {
      throw new Error(`${table} 的隔离库与生产库外键不一致`);
    }
  }
}

async function readRecoveryRows(client, metadata) {
  const rows = {};
  for (const table of SOURCE_WHOLE_TABLES) {
    rows[table] = (await client.query(`SELECT * FROM ${quoteQualified(table)}`)).rows;
  }

  const objectIds = new Set();
  for (const [table, tableRows] of Object.entries(rows)) {
    if (metadata[table].primaryKey.length === 1 && metadata[table].primaryKey[0] === 'id') {
      for (const row of tableRows) objectIds.add(row.id);
    }
  }

  const attachmentIds = new Set();
  for (const row of rows.id_business_v2_gift_cards) {
    if (row.source_attachment_id) attachmentIds.add(row.source_attachment_id);
  }
  for (const row of rows.id_business_v2_finance_expenses) {
    if (row.receipt_attachment_id) attachmentIds.add(row.receipt_attachment_id);
  }
  rows.attachments = attachmentIds.size
    ? (
        await client.query('SELECT * FROM public.attachments WHERE id = ANY($1::uuid[])', [
          [...attachmentIds]
        ])
      ).rows
    : [];
  rows.audit_logs = objectIds.size
    ? (
        await client.query(
          `SELECT * FROM public.audit_logs
           WHERE object_id = ANY($1::uuid[])
             AND (module LIKE 'id_business_v2%' OR action LIKE 'id_business_v2.%')`,
          [[...objectIds]]
        )
      ).rows
    : [];

  for (const table of TABLES) {
    rows[table].sort((left, right) =>
      stableStringify(pick(left, metadata[table].primaryKey)).localeCompare(
        stableStringify(pick(right, metadata[table].primaryKey))
      )
    );
  }
  return rows;
}

async function compareTarget(client, sourceRows, metadata) {
  const result = {};
  for (const table of TABLES) {
    const primaryKey = metadata[table].primaryKey;
    const matchingPrimaryKeys = [];
    const missingPrimaryKeys = [];
    const conflictingPrimaryKeys = [];
    const sourceKeySet = new Set(
      sourceRows[table].map((row) => stableStringify(pick(row, primaryKey)))
    );

    for (const row of sourceRows[table]) {
      const key = pick(row, primaryKey);
      const existing = await selectByPrimaryKey(client, table, primaryKey, key);
      if (!existing) missingPrimaryKeys.push(key);
      else if (stableStringify(existing) === stableStringify(row)) matchingPrimaryKeys.push(key);
      else conflictingPrimaryKeys.push(key);
    }

    const targetKeys = (
      await client.query(
        `SELECT ${primaryKey.map(quoteIdentifier).join(', ')} FROM ${quoteQualified(table)}`
      )
    ).rows;
    const extraPrimaryKeys = targetKeys.filter((key) => !sourceKeySet.has(stableStringify(key)));
    result[table] = {
      table,
      matchingPrimaryKeys,
      missingPrimaryKeys,
      conflictingPrimaryKeys,
      extraPrimaryKeys
    };
  }
  return result;
}

function assertNoContentConflicts(comparison) {
  const conflicts = Object.values(comparison).filter(
    (item) => item.conflictingPrimaryKeys.length > 0
  );
  if (conflicts.length > 0) {
    throw new Error(
      `发现主键内容冲突：${conflicts.map((item) => `${item.table}=${item.conflictingPrimaryKeys.length}`).join(', ')}`
    );
  }
}

function assertNoUnexpectedBusinessRows(comparison) {
  const extras = BUSINESS_TABLES.filter((table) => comparison[table].extraPrimaryKeys.length > 0);
  if (extras.length > 0) {
    throw new Error(`生产库出现备份外业务主键，停止自动恢复：${extras.join(', ')}`);
  }
}

async function insertMissingRows(client, sourceRows, comparison, metadata) {
  const inserted = Object.fromEntries(TABLES.map((table) => [table, 0]));
  const missingSets = Object.fromEntries(
    TABLES.map((table) => [
      table,
      new Set(comparison[table].missingPrimaryKeys.map((key) => stableStringify(key)))
    ])
  );
  const stagedUpdates = [];

  for (const table of TABLES) {
    let rows = sourceRows[table].filter((row) =>
      missingSets[table].has(stableStringify(pick(row, metadata[table].primaryKey)))
    );
    if (table === 'id_business_v2_activations') {
      rows.sort((left, right) =>
        [left.opened_at, left.created_at, left.id]
          .join('|')
          .localeCompare([right.opened_at, right.created_at, right.id].join('|'))
      );
    }
    const selfReference = SELF_REFERENCE_COLUMNS.get(table);
    if (selfReference) rows = sortSelfReferencedRows(rows, selfReference);

    for (const sourceRow of rows) {
      const current = await selectByPrimaryKey(
        client,
        table,
        metadata[table].primaryKey,
        pick(sourceRow, metadata[table].primaryKey)
      );
      if (current) {
        if (stableStringify(current) !== stableStringify(sourceRow)) {
          const differingColumns = Object.keys(sourceRow).filter(
            (column) => stableStringify(current[column]) !== stableStringify(sourceRow[column])
          );
          throw new Error(
            `${table} 在事务内出现内容冲突，已停止恢复；差异字段：${differingColumns.join(',')}`
          );
        }
        continue;
      }
      const row = { ...sourceRow };
      for (const columns of STAGED_COLUMN_GROUPS.get(table) ?? []) {
        if (columns.some((column) => row[column] !== null)) {
          stagedUpdates.push({
            table,
            primaryKey: pick(row, metadata[table].primaryKey),
            values: Object.fromEntries(columns.map((column) => [column, row[column]]))
          });
          for (const column of columns) row[column] = null;
        }
      }
      await insertRow(
        client,
        table,
        metadata[table].columns.map((column) => column.column_name),
        row
      );
      inserted[table] += 1;
    }
  }

  for (const update of stagedUpdates) {
    const keyColumns = Object.keys(update.primaryKey);
    const updateColumns = Object.keys(update.values);
    const params = [
      ...updateColumns.map((column) => update.values[column]),
      ...keyColumns.map((column) => update.primaryKey[column])
    ];
    await client.query(
      `UPDATE ${quoteQualified(update.table)} SET ${updateColumns
        .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
        .join(', ')}
       WHERE ${keyColumns
         .map(
           (column, index) => `${quoteIdentifier(column)} = $${updateColumns.length + index + 1}`
         )
         .join(' AND ')}`,
      params
    );
  }
  return inserted;
}

function sortSelfReferencedRows(rows, dependencyColumn) {
  const pending = [...rows];
  const sourceIds = new Set(rows.map((row) => row.id));
  const emitted = new Set();
  const sorted = [];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (row) =>
        !row[dependencyColumn] ||
        !sourceIds.has(row[dependencyColumn]) ||
        emitted.has(row[dependencyColumn])
    );
    if (index < 0) throw new Error(`${dependencyColumn} 存在无法安全恢复的循环引用`);
    const [row] = pending.splice(index, 1);
    sorted.push(row);
    emitted.add(row.id);
  }
  return sorted;
}

async function insertRow(client, table, columns, row) {
  const values = columns.map((column) => row[column]);
  const sql = `INSERT INTO ${quoteQualified(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns
    .map((_, index) => `$${index + 1}`)
    .join(', ')})`;
  await client.query(sql, values);
}

async function selectByPrimaryKey(client, table, primaryKey, key) {
  const values = primaryKey.map((column) => key[column]);
  const result = await client.query(
    `SELECT * FROM ${quoteQualified(table)} WHERE ${primaryKey
      .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
      .join(' AND ')}`,
    values
  );
  return result.rows[0] ?? null;
}

async function verifyIntegrity(client) {
  const foreignKeyOrphans = [];
  const metadata = await readMetadata(client, TABLES);
  for (const table of TABLES) {
    for (const foreignKey of metadata[table].foreignKeys) {
      const count = await client.query(
        `SELECT count(*)::bigint AS count
         FROM ${quoteQualified(table)} child
         LEFT JOIN ${quoteQualified(foreignKey.referenced_table)} parent
           ON child.${quoteIdentifier(foreignKey.column_name)} = parent.${quoteIdentifier(foreignKey.referenced_column)}
         WHERE child.${quoteIdentifier(foreignKey.column_name)} IS NOT NULL
           AND parent.${quoteIdentifier(foreignKey.referenced_column)} IS NULL`
      );
      if (Number(count.rows[0].count) > 0) {
        foreignKeyOrphans.push({
          table,
          column: foreignKey.column_name,
          referencedTable: foreignKey.referenced_table,
          count: Number(count.rows[0].count)
        });
      }
    }
  }

  const journalImbalances = (
    await client.query(`
      SELECT journal_id
      FROM public.id_business_v2_finance_journal_lines
      GROUP BY journal_id
      HAVING COALESCE(sum(CASE WHEN direction::text = 'debit' THEN amount_cny ELSE 0 END), 0)
           <> COALESCE(sum(CASE WHEN direction::text = 'credit' THEN amount_cny ELSE 0 END), 0)
    `)
  ).rows.length;

  const balanceDiscontinuities = Number(
    (
      await client.query(`
        WITH ordered AS (
          SELECT account_id, balance_before, cost_before,
                 lag(balance_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_balance,
                 lag(cost_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_cost
          FROM public.id_business_v2_balance_ledger
        )
        SELECT count(*)::bigint AS count FROM ordered
        WHERE previous_balance IS NOT NULL
          AND (balance_before <> previous_balance OR cost_before <> previous_cost)
      `)
    ).rows[0].count
  );

  const supplierLedgerDiscontinuities = Number(
    (
      await client.query(`
        WITH ordered AS (
          SELECT supplier_account_id, balance_before, balance_before_cny,
                 lag(balance_after) OVER (PARTITION BY supplier_account_id ORDER BY created_at, id) AS previous_balance,
                 lag(balance_after_cny) OVER (PARTITION BY supplier_account_id ORDER BY created_at, id) AS previous_balance_cny
          FROM public.id_business_v2_topup_supplier_ledger
        )
        SELECT count(*)::bigint AS count FROM ordered
        WHERE previous_balance IS NOT NULL
          AND (balance_before <> previous_balance OR balance_before_cny <> previous_balance_cny)
      `)
    ).rows[0].count
  );

  return {
    foreignKeyOrphans,
    journalImbalances,
    balanceDiscontinuities,
    supplierLedgerDiscontinuities
  };
}

function assertIntegrity(integrity, label) {
  if (
    integrity.foreignKeyOrphans.length > 0 ||
    integrity.journalImbalances > 0 ||
    integrity.balanceDiscontinuities > 0 ||
    integrity.supplierLedgerDiscontinuities > 0
  ) {
    throw new Error(`${label}完整性检查失败：${JSON.stringify(integrity)}`);
  }
}

async function readPreservedSnapshot(client) {
  const query = async (sql) => (await client.query(sql)).rows[0];
  return {
    users: await query(
      'SELECT count(*)::bigint AS count, max(updated_at) AS latest FROM public.users'
    ),
    roles: await query('SELECT count(*)::bigint AS count FROM public.roles'),
    permissions: await query('SELECT count(*)::bigint AS count FROM public.permissions'),
    userRoles: await query('SELECT count(*)::bigint AS count FROM public.user_roles'),
    rolePermissions: await query('SELECT count(*)::bigint AS count FROM public.role_permissions'),
    options: await query(
      'SELECT count(*)::bigint AS count, max(updated_at) AS latest FROM public.id_business_v2_options'
    ),
    financeSettings: await query(
      'SELECT count(*)::bigint AS count, max(updated_at) AS latest FROM public.id_business_v2_finance_settings'
    ),
    renewalSettings: await query(
      'SELECT count(*)::bigint AS count, max(updated_at) AS latest FROM public.id_business_v2_renewal_warning_settings'
    ),
    exchangeRuns: await query(
      'SELECT count(*)::bigint AS count, max(created_at) AS latest FROM public.id_business_v2_exchange_rate_runs'
    ),
    exchangeSnapshots: await query(
      'SELECT count(*)::bigint AS count, max(averaged_at) AS latest FROM public.id_business_v2_exchange_rate_snapshots'
    ),
    exchangeProviderSnapshots: await query(
      'SELECT count(*)::bigint AS count, max(created_at) AS latest FROM public.id_business_v2_exchange_rate_provider_snapshots'
    ),
    exchangeQuoteSamples: await query(
      'SELECT count(*)::bigint AS count, max(created_at) AS latest FROM public.id_business_v2_exchange_rate_quote_samples'
    ),
    scopeVersions: await query(
      'SELECT count(*)::bigint AS count, max(updated_at) AS latest FROM public.id_business_v2_scope_versions'
    ),
    migrations: await query(
      'SELECT count(*)::bigint AS count, max(finished_at) AS latest FROM public._prisma_migrations'
    ),
    activeSessions: await query(
      'SELECT count(*)::bigint AS count, max(last_active_at) AS latest FROM public.active_sessions'
    )
  };
}

function assertPreservedSnapshot(before, after) {
  const exact = [
    'users',
    'roles',
    'permissions',
    'userRoles',
    'rolePermissions',
    'options',
    'financeSettings',
    'renewalSettings',
    'migrations'
  ];
  for (const key of exact) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) {
      throw new Error(`恢复事务意外改变受保护数据：${key}`);
    }
  }
  if (
    before.scopeVersions.count !== after.scopeVersions.count ||
    after.scopeVersions.latest < before.scopeVersions.latest
  ) {
    throw new Error('恢复事务导致 scope version 回退或数量变化');
  }
}

function pick(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function hashRows(rows, primaryKey) {
  const sorted = [...rows].sort((a, b) =>
    stableStringify(pick(a, primaryKey)).localeCompare(stableStringify(pick(b, primaryKey)))
  );
  return createHash('sha256').update(stableStringify(sorted)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])])
    );
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteQualified(table) {
  return `public.${quoteIdentifier(table)}`;
}
