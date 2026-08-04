#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';

const EXPECTED_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
const EXPECTED_BACKUP_SHA256 = '56f0cbc93b49c70323c08386d90a687f7b97f4b19dacb1da520d3910918b2d74';
const RUNTIME_ROLE = 'id_business_v2_runtime';
const AUDIT_ROLE = 'id_business_v2_audit';
const ACCESS_CHECK_TABLES = [
  'users',
  'roles',
  'permissions',
  'id_business_v2_options',
  'id_business_v2_accounts',
  'id_business_v2_orders',
  'id_business_v2_finance_journals'
];

const RUNTIME_TABLES = [
  'users',
  'login_logs',
  'active_sessions',
  'security_settings',
  'ip_whitelists',
  'sensitive_access_logs',
  'sensitive_access_approvals',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'audit_logs',
  'attachments',
  'v2_auth_identities',
  'id_business_v2_options',
  'id_business_v2_customers',
  'id_business_v2_customer_tags',
  'id_business_v2_customer_services',
  'id_business_v2_accounts',
  'id_business_v2_gift_cards',
  'id_business_v2_topup_supplier_accounts',
  'id_business_v2_topup_supplier_payments',
  'id_business_v2_topup_supplier_ledger',
  'id_business_v2_finance_settings',
  'id_business_v2_finance_accounts',
  'id_business_v2_finance_fx_rate_snapshots',
  'id_business_v2_finance_journals',
  'id_business_v2_finance_journal_lines',
  'id_business_v2_finance_expenses',
  'id_business_v2_finance_periods',
  'id_business_v2_balance_ledger',
  'id_business_v2_account_losses',
  'id_business_v2_orders',
  'id_business_v2_account_locks',
  'id_business_v2_activations',
  'id_business_v2_renewal_warning_settings',
  'id_business_v2_exchange_rate_runs',
  'id_business_v2_exchange_rate_entries',
  'id_business_v2_exchange_rate_snapshots',
  'id_business_v2_exchange_rate_settings',
  'id_business_v2_exchange_rate_provider_snapshots',
  'id_business_v2_exchange_rate_quote_samples',
  'id_business_v2_governance_jobs',
  'id_business_v2_governance_job_items',
  'id_business_v2_governance_approvals',
  'id_business_v2_governance_checkpoints',
  'id_business_v2_scope_versions'
];

const values = parseArgs(process.argv.slice(2));
if (!values.apply) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'preview',
        projectRef: EXPECTED_PROJECT_REF,
        roles: [RUNTIME_ROLE, AUDIT_ROLE],
        runtimeTableCount: RUNTIME_TABLES.length,
        protections: [
          'runtime_not_owner',
          'runtime_no_truncate',
          'runtime_no_migration_history_write',
          'audit_select_only',
          'public_schema_create_revoked'
        ]
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (values.backupSha256 !== EXPECTED_BACKUP_SHA256) {
  throw new Error('生产备份指纹不匹配');
}
await validateBackup(values.backup, values.backupSha256);
const expectedConfirmation = `PROVISION_DB_ROLES_${EXPECTED_PROJECT_REF}_${EXPECTED_BACKUP_SHA256.slice(0, 8)}`;
if (values.confirmation !== expectedConfirmation) {
  throw new Error(`确认口令不匹配；必须显式提供 ${expectedConfirmation}`);
}

const linkPath = path.resolve('.deploy/cloudflare-free.secrets.json');
const secretsPath = await realpath(linkPath);
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const migrationDatabaseUrl = secrets.MIGRATION_DATABASE_URL ?? secrets.DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('部署凭据缺少 MIGRATION_DATABASE_URL 或旧 DATABASE_URL');
assertExpectedProductionDatabase(migrationDatabaseUrl);
const previousRuntimeDatabaseUrl = secrets.V2_RUNTIME_DATABASE_URL;
const previousAuditDatabaseUrl = secrets.AUDIT_DATABASE_URL;

const runtimePassword = randomBytes(36).toString('base64url');
const auditPassword = randomBytes(36).toString('base64url');
const runtimeDatabaseUrl = buildRoleDatabaseUrl(
  migrationDatabaseUrl,
  RUNTIME_ROLE,
  runtimePassword,
  true
);
const auditDatabaseUrl = buildRoleDatabaseUrl(
  migrationDatabaseUrl,
  AUDIT_ROLE,
  auditPassword,
  false
);
const admin = new Client({
  ...normalizeDatabaseConnection(migrationDatabaseUrl),
  application_name: 'id-v2-role-provisioner'
});
let transactionOpen = false;
let expectedCounts;

try {
  await admin.connect();
  await admin.query('BEGIN');
  transactionOpen = true;
  await admin.query(
    "SELECT pg_advisory_xact_lock(hashtext('id_business_v2_database_role_provisioning'))"
  );

  await ensureLoginRole(admin, RUNTIME_ROLE, runtimePassword);
  await ensureLoginRole(admin, AUDIT_ROLE, auditPassword);
  const databaseName = (await admin.query('SELECT current_database() AS name')).rows[0].name;

  for (const role of [RUNTIME_ROLE, AUDIT_ROLE]) {
    await admin.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(role)}`
    );
    await admin.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${quoteIdentifier(role)}`
    );
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(role)}`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(role)}`
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`);
  }

  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${RUNTIME_TABLES.map(quoteQualified).join(', ')} TO ${quoteIdentifier(RUNTIME_ROLE)}`
  );
  await admin.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(RUNTIME_ROLE)}`
  );
  await admin.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(AUDIT_ROLE)}`
  );

  await admin.query(`ALTER ROLE ${quoteIdentifier(RUNTIME_ROLE)} SET statement_timeout = '30s'`);
  await admin.query(`ALTER ROLE ${quoteIdentifier(RUNTIME_ROLE)} SET lock_timeout = '5s'`);
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(RUNTIME_ROLE)} SET idle_in_transaction_session_timeout = '30s'`
  );
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(AUDIT_ROLE)} SET default_transaction_read_only = on`
  );
  await admin.query(`ALTER ROLE ${quoteIdentifier(AUDIT_ROLE)} SET statement_timeout = '60s'`);
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(AUDIT_ROLE)} SET idle_in_transaction_session_timeout = '30s'`
  );

  await verifyRoleCatalog(admin);
  expectedCounts = await readCounts(admin, ACCESS_CHECK_TABLES);
  await admin.query('COMMIT');
  transactionOpen = false;
} catch (error) {
  if (transactionOpen) await admin.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await admin.end().catch(() => undefined);
}

try {
  const runtimeCounts = await verifyRoleLoginWithRetry(runtimeDatabaseUrl, RUNTIME_ROLE, false);
  const auditCounts = await verifyRoleLoginWithRetry(auditDatabaseUrl, AUDIT_ROLE, true);
  if (
    JSON.stringify(runtimeCounts) !== JSON.stringify(expectedCounts) ||
    JSON.stringify(auditCounts) !== JSON.stringify(expectedCounts)
  ) {
    throw new Error('运行时或审计角色受 RLS 过滤，拒绝写入新凭据');
  }
} catch (error) {
  if (previousRuntimeDatabaseUrl && previousAuditDatabaseUrl) {
    await restorePreviousRolePasswords(
      migrationDatabaseUrl,
      previousRuntimeDatabaseUrl,
      previousAuditDatabaseUrl
    );
    await verifyRoleLoginWithRetry(previousRuntimeDatabaseUrl, RUNTIME_ROLE, false);
    await verifyRoleLoginWithRetry(previousAuditDatabaseUrl, AUDIT_ROLE, true);
  }
  throw error;
}

const updatedSecrets = {
  ...secrets,
  MIGRATION_DATABASE_URL: migrationDatabaseUrl,
  V2_RUNTIME_DATABASE_URL: runtimeDatabaseUrl,
  AUDIT_DATABASE_URL: auditDatabaseUrl
};
delete updatedSecrets.DATABASE_URL;
const temporaryPath = `${secretsPath}.roles-${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(updatedSecrets, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600
});
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, secretsPath);
await chmod(secretsPath, 0o600);

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: 'apply',
      projectRef: EXPECTED_PROJECT_REF,
      roles: {
        runtime: RUNTIME_ROLE,
        audit: AUDIT_ROLE,
        migration: 'postgres (offline only)'
      },
      runtimeTableCount: RUNTIME_TABLES.length,
      secretProfilesWritten: [
        'MIGRATION_DATABASE_URL',
        'V2_RUNTIME_DATABASE_URL',
        'AUDIT_DATABASE_URL'
      ],
      protectionsVerified: true
    },
    null,
    2
  )
);

function parseArgs(args) {
  const result = { apply: false };
  for (const argument of args) {
    if (argument === '--apply') result.apply = true;
    else if (argument.startsWith('--backup=')) {
      result.backup = argument.slice('--backup='.length);
    } else if (argument.startsWith('--backup-sha256=')) {
      result.backupSha256 = argument.split('=', 2)[1];
    } else if (argument.startsWith('--confirmation=')) {
      result.confirmation = argument.split('=', 2)[1];
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return result;
}

async function validateBackup(inputPath, expectedSha256) {
  if (!path.isAbsolute(inputPath || '')) throw new Error('--backup 必须是绝对路径');
  const resolvedPath = await realpath(inputPath);
  if (!resolvedPath.endsWith('.dump')) throw new Error('--backup 必须是 .dump 文件');
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('生产备份无效');
  const actualSha256 = await hashFile(resolvedPath);
  if (actualSha256 !== expectedSha256) throw new Error('生产备份文件指纹不匹配');
  const manifest = JSON.parse(
    await readFile(resolvedPath.replace(/\.dump$/, '.manifest.json'), 'utf8')
  );
  if (manifest.sha256 !== actualSha256 || manifest.sizeBytes !== fileStat.size) {
    throw new Error('生产备份 manifest 与 dump 不一致');
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function assertExpectedProductionDatabase(raw) {
  const url = new URL(raw);
  const direct =
    url.hostname === `db.${EXPECTED_PROJECT_REF}.supabase.co` && url.username === 'postgres';
  const pooler =
    url.hostname.endsWith('.pooler.supabase.com') &&
    url.username === `postgres.${EXPECTED_PROJECT_REF}`;
  if (!direct && !pooler) {
    throw new Error('管理员凭据不属于已核验的生产 Supabase 项目');
  }
}

function buildRoleDatabaseUrl(raw, role, password, transactionPooler) {
  const url = new URL(raw);
  if (url.hostname.endsWith('.pooler.supabase.com')) {
    url.username = `${role}.${EXPECTED_PROJECT_REF}`;
    if (transactionPooler) {
      url.port = '6543';
      url.searchParams.set('pgbouncer', 'true');
      url.searchParams.set('connection_limit', '1');
    } else {
      url.port = '5432';
      url.searchParams.delete('pgbouncer');
      url.searchParams.delete('connection_limit');
    }
  } else {
    url.username = role;
  }
  url.password = password;
  return url.toString();
}

async function ensureLoginRole(client, role, password) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) await client.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN`);
  const passwordSql = (
    await client.query('SELECT format($1::text, $2::text) AS sql', [
      `ALTER ROLE ${quoteIdentifier(role)} WITH LOGIN PASSWORD %L`,
      password
    ])
  ).rows[0].sql;
  await client.query(passwordSql);
}

async function verifyRoleCatalog(client) {
  const roles = await client.query(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [[AUDIT_ROLE, RUNTIME_ROLE]]
  );
  if (
    roles.rows.length !== 2 ||
    roles.rows.some(
      (role) =>
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls
    )
  ) {
    throw new Error('生产数据库角色仍含高权限');
  }

  const runtimePrivileges = await client.query(
    `SELECT table_name,
            has_table_privilege($1, format('public.%I', table_name), 'SELECT,INSERT,UPDATE,DELETE') AS dml,
            has_table_privilege($1, format('public.%I', table_name), 'TRUNCATE') AS can_truncate
     FROM unnest($2::text[]) AS table_name`,
    [RUNTIME_ROLE, RUNTIME_TABLES]
  );
  if (runtimePrivileges.rows.some((row) => !row.dml || row.can_truncate)) {
    throw new Error('运行时角色的表权限不符合最小 DML 要求');
  }

  const protectedChecks = await client.query(
    `SELECT
       has_table_privilege($1, 'public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_migration_write,
       has_schema_privilege($1, 'public', 'CREATE') AS runtime_schema_create,
       EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'public' AND r.rolname = $1
       ) AS runtime_owns_public_object,
       has_schema_privilege($2, 'public', 'CREATE') AS audit_schema_create`,
    [RUNTIME_ROLE, AUDIT_ROLE]
  );
  const protectedRow = protectedChecks.rows[0];
  if (
    protectedRow.runtime_migration_write ||
    protectedRow.runtime_schema_create ||
    protectedRow.runtime_owns_public_object ||
    protectedRow.audit_schema_create
  ) {
    throw new Error('生产数据库角色仍可修改 schema、migration 或对象所有权');
  }

  const auditPrivileges = await client.query(
    `
    SELECT c.relname AS table_name,
           has_table_privilege($1, c.oid, 'SELECT') AS can_select,
           has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `,
    [AUDIT_ROLE]
  );
  if (auditPrivileges.rows.some((row) => !row.can_select || row.can_write)) {
    throw new Error('只读审计角色权限不符合要求');
  }
}

async function verifyRoleLogin(databaseUrl, expectedRole, readOnly) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: `id-v2-${expectedRole}-verification`
  });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_user AS current_user, current_setting('transaction_read_only') AS read_only"
    );
    if (result.rows[0].current_user !== expectedRole)
      throw new Error(`${expectedRole} 登录身份不匹配`);
    if (readOnly && result.rows[0].read_only !== 'on')
      throw new Error(`${expectedRole} 未默认只读`);
    return await readCounts(client, ACCESS_CHECK_TABLES);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyRoleLoginWithRetry(databaseUrl, expectedRole, readOnly) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await verifyRoleLogin(databaseUrl, expectedRole, readOnly);
    } catch (error) {
      lastError = error;
      if (attempt < 10) await delay(3_000);
    }
  }
  throw lastError;
}

async function restorePreviousRolePasswords(
  migrationDatabaseUrl,
  previousRuntimeDatabaseUrl,
  previousAuditDatabaseUrl
) {
  const adminClient = new Client({
    ...normalizeDatabaseConnection(migrationDatabaseUrl),
    application_name: 'id-v2-role-provisioner-compensation'
  });
  try {
    await adminClient.connect();
    await adminClient.query('BEGIN');
    await adminClient.query(
      "SELECT pg_advisory_xact_lock(hashtext('id_business_v2_database_role_provisioning'))"
    );
    await ensureLoginRole(
      adminClient,
      RUNTIME_ROLE,
      decodeURIComponent(new URL(previousRuntimeDatabaseUrl).password)
    );
    await ensureLoginRole(
      adminClient,
      AUDIT_ROLE,
      decodeURIComponent(new URL(previousAuditDatabaseUrl).password)
    );
    await adminClient.query('COMMIT');
  } catch (error) {
    await adminClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await adminClient.end().catch(() => undefined);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readCounts(client, tables) {
  const counts = {};
  for (const table of tables) {
    counts[table] = Number(
      (await client.query(`SELECT count(*)::bigint AS count FROM ${quoteQualified(table)}`)).rows[0]
        .count
    );
  }
  return counts;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteQualified(table) {
  return `public.${quoteIdentifier(table)}`;
}
