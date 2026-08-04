#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';

const tables = [
  'users',
  'roles',
  'permissions',
  'id_business_v2_options',
  'id_business_v2_customers',
  'id_business_v2_accounts',
  'id_business_v2_gift_cards',
  'id_business_v2_orders',
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

const report = { ok: true, profiles: {}, rowSecurity: [] };
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
