#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';

const tables = [
  'users',
  'roles',
  'permissions',
  'id_business_v2_sensitive_display_policies',
  'id_business_v2_options',
  'id_business_v2_user_table_preferences',
  'id_business_v2_workspace_shortcuts',
  'id_business_v2_managed_mailboxes',
  'id_business_v2_mail_query_attempts',
  'id_business_v2_customers',
  'id_business_v2_accounts',
  'id_business_v2_gift_cards',
  'id_business_v2_orders',
  'id_business_v2_order_display_snapshots',
  'id_business_v2_activations',
  'id_business_v2_topup_supplier_accounts',
  'id_business_v2_topup_supplier_payments',
  'id_business_v2_finance_journals'
];

const secretsPath = await realpath(path.resolve('.deploy/cloudflare-free.secrets.json'));
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const profiles = {
  migration: secrets.MIGRATION_DATABASE_URL,
  runtime: secrets.V2_RUNTIME_DATABASE_URL,
  audit: secrets.AUDIT_DATABASE_URL
};

for (const [name, value] of Object.entries(profiles)) {
  if (!value) throw new Error(`部署凭据缺少 ${name} 数据库地址`);
}

const expectedRuntimeDeleteTables = new Set([
  'ip_whitelists',
  'user_roles',
  'role_permissions',
  'id_business_v2_user_table_preferences',
  'id_business_v2_customer_tags',
  'id_business_v2_sensitive_display_policies',
  'id_business_v2_workspace_shortcuts'
]);
const expectedRestrictedRuntimePrivileges = new Map([
  [
    'id_business_v2_order_display_snapshots',
    { select: true, insert: false, update: false, delete: false }
  ],
  [
    'id_business_v2_mail_query_attempts',
    { select: true, insert: true, update: false, delete: false }
  ]
]);

const report = {
  ok: true,
  profiles: {},
  rowSecurity: [],
  runtimeDeletePrivileges: [],
  restrictedRuntimePrivileges: [],
  governanceFunctionPrivileges: []
};
for (const [name, databaseUrl] of Object.entries(profiles)) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: `id-v2-${name}-role-audit`
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query(
      "SELECT current_user, current_setting('transaction_read_only') AS transaction_read_only"
    );
    const counts = {};
    for (const table of tables) {
      counts[table] = Number(
        (
          await client.query(
            `SELECT count(*)::bigint AS count FROM public.${quoteIdentifier(table)}`
          )
        ).rows[0].count
      );
    }
    report.profiles[name] = { ...identity.rows[0], counts };
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const admin = new Client({
  ...normalizeDatabaseConnection(profiles.migration),
  application_name: 'id-v2-row-security-audit'
});
try {
  await admin.connect();
  report.runtimeDeletePrivileges = (
    await admin.query(
      `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND has_table_privilege('id_business_v2_runtime', c.oid, 'DELETE')
       ORDER BY c.relname`
    )
  ).rows.map((row) => row.table_name);
  const unexpectedDeletePrivileges = report.runtimeDeletePrivileges.filter(
    (table) => !expectedRuntimeDeleteTables.has(table)
  );
  const missingDeletePrivileges = [...expectedRuntimeDeleteTables].filter(
    (table) => !report.runtimeDeletePrivileges.includes(table)
  );
  if (unexpectedDeletePrivileges.length || missingDeletePrivileges.length) {
    throw new Error(
      `运行时 DELETE 权限不符合最小范围：unexpected=${unexpectedDeletePrivileges.join(',') || '-'} missing=${missingDeletePrivileges.join(',') || '-'}`
    );
  }
  report.restrictedRuntimePrivileges = (
    await admin.query(
      `SELECT table_name,
              has_table_privilege('id_business_v2_runtime', format('public.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege('id_business_v2_runtime', format('public.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege('id_business_v2_runtime', format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege('id_business_v2_runtime', format('public.%I', table_name), 'DELETE') AS can_delete
       FROM unnest($1::text[]) AS table_name
       ORDER BY table_name`,
      [[...expectedRestrictedRuntimePrivileges.keys()]]
    )
  ).rows;
  if (
    report.restrictedRuntimePrivileges.length !== expectedRestrictedRuntimePrivileges.size ||
    report.restrictedRuntimePrivileges.some((row) => {
      const expected = expectedRestrictedRuntimePrivileges.get(row.table_name);
      return (
        !expected ||
        row.can_select !== expected.select ||
        row.can_insert !== expected.insert ||
        row.can_update !== expected.update ||
        row.can_delete !== expected.delete
      );
    })
  ) {
    throw new Error('运行时受限制表权限不符合最小 DML 要求');
  }
  report.governanceFunctionPrivileges = (
    await admin.query(
      `SELECT function_record.proname AS function_name,
              has_function_privilege(
                'id_business_v2_runtime',
                function_record.oid,
                'EXECUTE'
              ) AS runtime_execute,
              has_function_privilege(
                'id_business_v2_audit',
                function_record.oid,
                'EXECUTE'
              ) AS audit_execute,
              EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                  function_record.proacl,
                  acldefault('f', function_record.proowner)
                )) privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute
       FROM pg_proc function_record
       JOIN pg_namespace namespace ON namespace.oid = function_record.pronamespace
       WHERE namespace.nspname = 'public'
         AND function_record.proname = ANY($1::text[])
       ORDER BY function_record.proname`,
      [
        [
          'cleanup_id_business_v2_exchange_rate_history',
          'execute_id_business_v2_governance_exchange_rate_cleanup',
          'invoke_id_business_v2_exchange_rate_cron'
        ]
      ]
    )
  ).rows;
  if (
    report.governanceFunctionPrivileges.length !== 3 ||
    report.governanceFunctionPrivileges.some((row) => {
      const governed =
        row.function_name === 'execute_id_business_v2_governance_exchange_rate_cleanup';
      return row.public_execute || row.audit_execute || row.runtime_execute !== governed;
    })
  ) {
    throw new Error('数据治理特权函数权限不符合最小范围');
  }
  report.rowSecurity = (
    await admin.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS row_security,
              c.relforcerowsecurity AS force_row_security, owner.rolname AS owner,
              COALESCE(jsonb_agg(
                jsonb_build_object('policy', policy.policyname, 'roles', policy.roles, 'command', policy.cmd)
              ) FILTER (WHERE policy.policyname IS NOT NULL), '[]'::jsonb) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles owner ON owner.oid = c.relowner
       LEFT JOIN pg_policies policy ON policy.schemaname = n.nspname AND policy.tablename = c.relname
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity, owner.rolname
       ORDER BY c.relname`,
      [tables]
    )
  ).rows;
} finally {
  await admin.end().catch(() => undefined);
}

console.log(JSON.stringify(report, null, 2));

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
