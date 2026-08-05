import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const BUSINESS_DATA_TABLES = Object.freeze([
  'id_business_v2_account_locks',
  'id_business_v2_account_losses',
  'id_business_v2_accounts',
  'id_business_v2_activations',
  'id_business_v2_balance_ledger',
  'id_business_v2_customer_services',
  'id_business_v2_customer_tags',
  'id_business_v2_customers',
  'id_business_v2_finance_accounts',
  'id_business_v2_finance_expenses',
  'id_business_v2_finance_fx_rate_snapshots',
  'id_business_v2_finance_journal_lines',
  'id_business_v2_finance_journals',
  'id_business_v2_finance_periods',
  'id_business_v2_gift_cards',
  'id_business_v2_governance_approvals',
  'id_business_v2_governance_checkpoints',
  'id_business_v2_governance_job_items',
  'id_business_v2_governance_jobs',
  'id_business_v2_orders',
  'id_business_v2_renewal_evidence',
  'id_business_v2_renewal_operations',
  'id_business_v2_topup_supplier_accounts',
  'id_business_v2_topup_supplier_ledger',
  'id_business_v2_topup_supplier_payments'
]);

export const PRESERVED_SYSTEM_TABLES = Object.freeze([
  '_prisma_migrations',
  'attachments',
  'audit_logs',
  'id_business_v2_exchange_rate_entries',
  'id_business_v2_exchange_rate_provider_snapshots',
  'id_business_v2_exchange_rate_quote_samples',
  'id_business_v2_exchange_rate_runs',
  'id_business_v2_exchange_rate_settings',
  'id_business_v2_exchange_rate_snapshots',
  'id_business_v2_finance_settings',
  'id_business_v2_options',
  'id_business_v2_renewal_warning_settings',
  'id_business_v2_scope_versions',
  'permissions',
  'role_permissions',
  'roles',
  'user_roles',
  'users',
  'v2_auth_identities'
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function classifyMaintenanceTarget(databaseUrlValue) {
  const url = parseDatabaseUrl(databaseUrlValue);
  return {
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    hostType: LOCAL_HOSTS.has(normalizeHostname(url.hostname)) ? 'local' : 'remote'
  };
}

export function assertTargetMatchesDatabase(target, databaseUrlValue) {
  if (!['isolated', 'production'].includes(target)) {
    throw new Error('target 必须是 isolated 或 production');
  }
  const classification = classifyMaintenanceTarget(databaseUrlValue);
  if (target === 'isolated' && classification.hostType !== 'local') {
    throw new Error('isolated 维护只允许连接 localhost、127.0.0.1 或 ::1');
  }
  if (target === 'production' && classification.hostType !== 'remote') {
    throw new Error('production 预览必须明确连接远程数据库');
  }
  return classification;
}

export function assertApplyTargetSupported(target) {
  if (target === 'production') {
    throw new Error(
      '生产执行被硬性禁止：当前工具没有已验证的新数据导入包，不能执行只清空生产库的操作。'
    );
  }
  if (target !== 'isolated') {
    throw new Error('只允许在 isolated 目标执行重建清理');
  }
}

export function createSnapshotFingerprint(snapshot) {
  const stable = {
    database: snapshot.database,
    appliedMigrations: snapshot.appliedMigrations,
    migrationRows: snapshot.migrationRows,
    latestAuditAt: snapshot.latestAuditAt,
    businessTables: snapshot.businessTables,
    preservedTables: snapshot.preservedTables
  };
  return sha256(JSON.stringify(stable));
}

export function createOperationId(fingerprint, generatedAt) {
  return `recovery-${sha256(`${fingerprint}:${generatedAt}`).slice(0, 20)}`;
}

export function assertPreviewAuthorization({
  preview,
  target,
  confirmOperationId,
  backupSha256,
  currentFingerprint,
  now = new Date()
}) {
  if (preview.target !== target) throw new Error('预览目标与本次执行目标不一致');
  if (preview.operationId !== confirmOperationId) throw new Error('确认操作编号不匹配');
  if (preview.snapshotFingerprint !== currentFingerprint) {
    throw new Error('数据库指纹已变化，必须重新生成预览和备份');
  }
  if (!preview.expiresAt || new Date(preview.expiresAt).getTime() <= now.getTime()) {
    throw new Error('预览已经过期，必须重新生成');
  }
  if (!/^[a-f0-9]{64}$/i.test(backupSha256 ?? '')) {
    throw new Error('备份 SHA256 格式不正确');
  }
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export async function captureMaintenanceSnapshot(client, database) {
  const requiredTables = [...BUSINESS_DATA_TABLES, ...PRESERVED_SYSTEM_TABLES];
  const columnsResult = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [requiredTables]
  );
  const columnsByTable = new Map();
  for (const row of columnsResult.rows) {
    const columns = columnsByTable.get(row.table_name) ?? new Set();
    columns.add(row.column_name);
    columnsByTable.set(row.table_name, columns);
  }
  const missingTables = requiredTables.filter((table) => !columnsByTable.has(table));
  if (missingTables.length > 0) {
    throw new Error(`数据库缺少维护所需表：${missingTables.join(', ')}`);
  }

  const businessTables = {};
  for (const table of BUSINESS_DATA_TABLES) {
    const columns = columnsByTable.get(table);
    const timestampColumn = columns.has('updated_at')
      ? 'updated_at'
      : columns.has('created_at')
        ? 'created_at'
        : null;
    const timestampExpression = timestampColumn
      ? `max(${quoteIdentifier(timestampColumn)})::text`
      : 'null::text';
    const result = await client.query(
      `select count(*)::bigint::text as count,
              coalesce(
                md5(string_agg(md5(to_jsonb(row_data)::text), '' order by md5(to_jsonb(row_data)::text))),
                md5('')
              ) as row_hash,
              ${timestampExpression} as latest_timestamp
         from public.${quoteIdentifier(table)} as row_data`
    );
    businessTables[table] = {
      count: Number(result.rows[0].count),
      rowHash: result.rows[0].row_hash,
      latestTimestamp: result.rows[0].latest_timestamp
    };
  }

  const preservedTables = {};
  for (const table of PRESERVED_SYSTEM_TABLES) {
    const result = await client.query(
      `select count(*)::bigint::text as count from public.${quoteIdentifier(table)}`
    );
    preservedTables[table] = Number(result.rows[0].count);
  }
  const migrationResult = await client.query(`
    select count(*)::int as rows,
           count(*) filter (where finished_at is not null and rolled_back_at is null)::int as applied
      from public._prisma_migrations
  `);
  const latestAuditResult = await client.query(
    'select max(created_at)::text as latest from public.audit_logs'
  );
  return {
    database,
    appliedMigrations: migrationResult.rows[0].applied,
    migrationRows: migrationResult.rows[0].rows,
    latestAuditAt: latestAuditResult.rows[0].latest,
    businessTables,
    preservedTables
  };
}

export async function clearIsolatedBusinessData(client, auditContext) {
  const tableList = BUSINESS_DATA_TABLES.map((table) => `public.${quoteIdentifier(table)}`).join(
    ', '
  );
  await client.query(`truncate table ${tableList}`);
  await client.query(`
    update public.id_business_v2_scope_versions
       set version = version + 1,
           updated_at = now()
  `);
  await client.query(
    `insert into public.audit_logs
       (id, module, action, object_type, before_data, after_data, remark)
     values ($1::uuid, 'id_business_v2', 'isolated_reconstruction.cleanup',
             'isolated_reconstruction', $2::jsonb, $3::jsonb, $4)`,
    [
      auditContext.auditId,
      JSON.stringify({
        operationId: auditContext.operationId,
        snapshotFingerprint: auditContext.beforeFingerprint,
        tableCounts: auditContext.beforeCounts
      }),
      JSON.stringify({
        backupSha256: auditContext.backupSha256,
        preservedTables: PRESERVED_SYSTEM_TABLES
      }),
      '仅清理本机隔离重建数据库；生产数据库未执行删除。'
    ]
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function parseDatabaseUrl(value) {
  if (!value?.trim()) throw new Error('维护数据库地址不能为空');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('维护数据库地址格式不正确');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('维护数据库必须使用 PostgreSQL');
  }
  return url;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
