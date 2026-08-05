#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';
import {
  EXPECTED_BACKUP_PROJECT_REF,
  EXPECTED_BACKUP_ROLE,
  sha256File
} from './lib/production-backup.mjs';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';

const SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS = new Set([
  'net.http_request_queue_id_seq',
  'net.http_request_queue',
  'net._http_response',
  'cron.job_run_details'
]);
const args = parseArgs(process.argv.slice(2));
if (!args.apply) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'preview',
        projectRef: EXPECTED_BACKUP_PROJECT_REF,
        role: EXPECTED_BACKUP_ROLE,
        privileges: ['connect', 'read_all_data', 'bypass_rls'],
        denied: [
          'business_write',
          'truncate',
          'ddl',
          'create_database',
          'create_role',
          'replication'
        ],
        managedExtensionWriteExceptions: [...SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS]
      },
      null,
      2
    )
  );
  process.exit(0);
}

await validateBackup(args.backup, args.backupSha256);
const expectedConfirmation = `PROVISION_BACKUP_ROLE_${EXPECTED_BACKUP_PROJECT_REF}_${args.backupSha256.slice(0, 12)}`;
if (args.confirmation !== expectedConfirmation) {
  throw new Error(`确认口令不匹配；必须显式提供 ${expectedConfirmation}`);
}

const secretsPath = await realpath(path.resolve(args.secretsFile));
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const migrationDatabaseUrl = secrets.MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('部署凭据缺少 MIGRATION_DATABASE_URL');
assertExpectedAdminDatabase(migrationDatabaseUrl);
const previousBackupDatabaseUrl = secrets.BACKUP_DATABASE_URL;
const password = randomBytes(36).toString('base64url');
const backupDatabaseUrl = buildRoleDatabaseUrl(
  migrationDatabaseUrl,
  EXPECTED_BACKUP_ROLE,
  password
);
const admin = new Client({
  ...normalizeDatabaseConnection(migrationDatabaseUrl),
  application_name: 'id-v2-backup-role-provisioner'
});
let transactionOpen = false;

try {
  await admin.connect();
  await admin.query('BEGIN');
  transactionOpen = true;
  await admin.query("SELECT pg_advisory_xact_lock(hashtext('id_v2_backup_role_provisioning'))");
  await ensureLoginRole(admin, password);
  await admin.query(`ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} BYPASSRLS`);
  await admin.query(`GRANT pg_read_all_data TO ${quoteIdentifier(EXPECTED_BACKUP_ROLE)}`);
  await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(EXPECTED_BACKUP_ROLE)}`);
  await admin.query(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(EXPECTED_BACKUP_ROLE)}`
  );
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} SET default_transaction_read_only = on`
  );
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} SET statement_timeout = '15min'`
  );
  await admin.query(`ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} SET lock_timeout = '30s'`);
  await admin.query(
    `ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} SET idle_in_transaction_session_timeout = '2min'`
  );
  await verifyAdminCatalog(admin);
  await admin.query('COMMIT');
  transactionOpen = false;
} catch (error) {
  if (transactionOpen) await admin.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await admin.end().catch(() => undefined);
}

try {
  await verifyRoleLoginWithRetry(backupDatabaseUrl);
} catch (error) {
  await compensateRole(migrationDatabaseUrl, previousBackupDatabaseUrl);
  throw error;
}

const temporaryPath = `${secretsPath}.backup-role-${process.pid}.tmp`;
await writeFile(
  temporaryPath,
  `${JSON.stringify({ ...secrets, BACKUP_DATABASE_URL: backupDatabaseUrl }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 }
);
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, secretsPath);
await chmod(secretsPath, 0o600);

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: 'apply',
      projectRef: EXPECTED_BACKUP_PROJECT_REF,
      role: EXPECTED_BACKUP_ROLE,
      backupCredentialWritten: true,
      protectionsVerified: true,
      managedExtensionWriteExceptions: [...SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS]
    },
    null,
    2
  )
);

function parseArgs(values) {
  const result = {
    apply: false,
    secretsFile: '.deploy/cloudflare-free.secrets.json'
  };
  for (const value of values) {
    if (value === '--apply') result.apply = true;
    else if (value.startsWith('--backup=')) result.backup = value.slice('--backup='.length);
    else if (value.startsWith('--backup-sha256=')) {
      result.backupSha256 = value.slice('--backup-sha256='.length).toLowerCase();
    } else if (value.startsWith('--confirmation=')) {
      result.confirmation = value.slice('--confirmation='.length);
    } else if (value.startsWith('--secrets-file=')) {
      result.secretsFile = value.slice('--secrets-file='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (result.apply) {
    if (!path.isAbsolute(result.backup || '')) throw new Error('--backup 必须是绝对路径');
    if (!result.backupSha256?.match(/^[a-f0-9]{64}$/u)) {
      throw new Error('--backup-sha256 必须是 64 位 SHA-256');
    }
  }
  return result;
}

async function validateBackup(inputPath, expectedSha256) {
  const resolvedPath = await realpath(inputPath);
  if (!resolvedPath.endsWith('.dump')) throw new Error('--backup 必须是 .dump 文件');
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('生产备份无效');
  const actualSha256 = await sha256File(resolvedPath);
  if (actualSha256 !== expectedSha256) throw new Error('生产备份 SHA-256 不匹配');
  const manifest = JSON.parse(
    await readFile(resolvedPath.replace(/\.dump$/u, '.manifest.json'), 'utf8')
  );
  if (manifest.sha256 !== actualSha256 || manifest.sizeBytes !== fileStat.size) {
    throw new Error('生产备份 manifest 与 dump 不一致');
  }
}

function assertExpectedAdminDatabase(raw) {
  const url = new URL(raw);
  const direct =
    url.hostname === `db.${EXPECTED_BACKUP_PROJECT_REF}.supabase.co` && url.username === 'postgres';
  const pooler =
    url.hostname.endsWith('.pooler.supabase.com') &&
    url.username === `postgres.${EXPECTED_BACKUP_PROJECT_REF}`;
  if (!direct && !pooler) throw new Error('管理员凭据不属于已核验的生产 Supabase 项目');
}

function buildRoleDatabaseUrl(raw, role, password) {
  const url = new URL(raw);
  if (url.hostname.endsWith('.pooler.supabase.com')) {
    url.username = `${role}.${EXPECTED_BACKUP_PROJECT_REF}`;
    url.port = '5432';
    url.searchParams.delete('pgbouncer');
    url.searchParams.delete('connection_limit');
  } else {
    url.username = role;
  }
  url.password = password;
  return url.toString();
}

async function ensureLoginRole(client, password) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    EXPECTED_BACKUP_ROLE
  ]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} LOGIN`);
  }
  const passwordSql = (
    await client.query('SELECT format($1::text, $2::text) AS sql', [
      `ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} WITH LOGIN PASSWORD %L`,
      password
    ])
  ).rows[0].sql;
  await client.query(passwordSql);
}

async function verifyAdminCatalog(client) {
  const role = (
    await client.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = $1`,
      [EXPECTED_BACKUP_ROLE]
    )
  ).rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    !role.rolbypassrls
  ) {
    throw new Error('备份角色权限属性不符合只读备份要求');
  }
  const privileges = await client.query(
    `SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind,
            c.relacl::text AS acl,
            CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege($1, c.oid, 'SELECT')
              ELSE has_table_privilege($1, c.oid, 'SELECT')
            END AS can_select,
            CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege($1, c.oid, 'UPDATE,USAGE')
              ELSE has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
            END AS can_write
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'`,
    [EXPECTED_BACKUP_ROLE]
  );
  const missingSelect = privileges.rows.filter((row) => !row.can_select);
  const writable = privileges.rows.filter((row) => row.can_write);
  const unexpectedWritable = writable.filter(
    (row) =>
      !SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS.has(`${row.schema_name}.${row.object_name}`)
  );
  if (
    privileges.rows.length === 0 ||
    missingSelect.length > 0 ||
    unexpectedWritable.length > 0 ||
    writable.length !== SUPABASE_EXTENSION_PUBLIC_WRITE_EXCEPTIONS.size
  ) {
    const describe = (rows) =>
      rows
        .slice(0, 20)
        .map((row) => `${row.schema_name}.${row.object_name}[${row.acl ?? 'default'}]`)
        .join(', ');
    throw new Error(
      `备份角色权限校验失败；缺少读取：${describe(missingSelect) || '无'}；非预期写权限：${describe(unexpectedWritable) || '无'}；扩展例外：${describe(writable) || '无'}`
    );
  }
  const writeRoleMembership = (
    await client.query(`SELECT pg_has_role($1, 'pg_write_all_data', 'MEMBER') AS member`, [
      EXPECTED_BACKUP_ROLE
    ])
  ).rows[0].member;
  if (writeRoleMembership) throw new Error('备份角色意外继承 pg_write_all_data');
}

async function verifyRoleLogin(databaseUrl) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: 'id-v2-backup-role-verification'
  });
  try {
    await client.connect();
    const identity = (
      await client.query(
        "SELECT current_user, current_setting('transaction_read_only') AS transaction_read_only"
      )
    ).rows[0];
    if (identity.current_user !== EXPECTED_BACKUP_ROLE || identity.transaction_read_only !== 'on') {
      throw new Error('备份角色登录身份或默认只读状态不匹配');
    }
    await client.query('SELECT count(*) FROM public.users');
    await client.query('CREATE TEMP TABLE backup_role_write_probe(id int)').then(
      () => {
        throw new Error('备份角色意外允许写入临时表');
      },
      () => undefined
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyRoleLoginWithRetry(databaseUrl) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await verifyRoleLogin(databaseUrl);
    } catch (error) {
      lastError = error;
      if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw lastError;
}

async function compensateRole(migrationDatabaseUrl, previousBackupDatabaseUrl) {
  const client = new Client({
    ...normalizeDatabaseConnection(migrationDatabaseUrl),
    application_name: 'id-v2-backup-role-compensation'
  });
  try {
    await client.connect();
    if (previousBackupDatabaseUrl) {
      await ensureLoginRole(
        client,
        decodeURIComponent(new URL(previousBackupDatabaseUrl).password)
      );
    } else {
      await client.query(`ALTER ROLE ${quoteIdentifier(EXPECTED_BACKUP_ROLE)} NOLOGIN`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
