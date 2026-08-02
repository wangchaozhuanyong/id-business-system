#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { Client } from 'pg';
import process from 'node:process';
import { resolve } from 'node:path';
import {
  PRODUCTION_SMOKE_ROLE_CODE,
  assessProductionClosure,
  normalizeDatabaseConnection
} from './lib/production-closure-audit.mjs';

const connection = normalizeDatabaseConnection(process.env.DIRECT_URL ?? process.env.DATABASE_URL);
const client = new Client(connection);

try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const snapshot = {
    migrations: await readMigrations(client),
    finance: await readFinance(client),
    auth: await readAuth(client),
    roles: await readRoles(client),
    permissionCatalog: await readPermissionCatalog(client),
    governance: await readGovernance(client),
    businessEvidence: await readBusinessEvidence(client)
  };

  await client.query('COMMIT');

  console.log(
    JSON.stringify(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        snapshot,
        assessment: assessProductionClosure(snapshot)
      },
      null,
      2
    )
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}

async function readMigrations(database) {
  const result = await database.query(`
    SELECT migration_name AS "migrationName", finished_at AS "finishedAt",
      rolled_back_at AS "rolledBackAt"
    FROM _prisma_migrations
  `);
  const localMigrations = readdirSync(resolve('apps/api/prisma/migrations'), {
    withFileTypes: true
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const appliedMigrations = new Set(
    result.rows.filter((row) => row.finishedAt && !row.rolledBackAt).map((row) => row.migrationName)
  );
  const appliedLocal = localMigrations.filter((migration) => appliedMigrations.has(migration));

  return {
    databaseAppliedTotal: appliedMigrations.size,
    appliedLocal: appliedLocal.length,
    local: localMigrations.length,
    pendingOrFailed: result.rows.filter((row) => !row.finishedAt && !row.rolledBackAt).length,
    unappliedLocal: localMigrations.filter((migration) => !appliedMigrations.has(migration))
  };
}

async function readFinance(database) {
  const result = await database.query(`
    SELECT
      COALESCE(settings.history_status::text, 'missing') AS "historyStatus",
      COALESCE(settings.enabled_at IS NOT NULL, false) AS enabled,
      COALESCE(settings.history_completed_at IS NOT NULL, false) AS "historyCompleted",
      (SELECT count(*) FROM id_business_v2_finance_accounts)::int AS accounts,
      (SELECT count(*) FROM id_business_v2_topup_supplier_accounts)::int AS "supplierWallets",
      (SELECT count(*) FROM id_business_v2_finance_expenses)::int AS expenses,
      (SELECT count(*) FROM id_business_v2_finance_journals)::int AS journals,
      (SELECT count(*) FROM audit_logs
        WHERE action = 'id_business_v2.finance.history_backfill')::int AS "historyBackfillAudits"
    FROM (SELECT 1 AS id) singleton
    LEFT JOIN id_business_v2_finance_settings settings ON settings.id = singleton.id
  `);
  return result.rows[0];
}

async function readAuth(database) {
  const result = await database.query(
    `
      WITH smoke_users AS (
        SELECT DISTINCT assignment.user_id
        FROM user_roles assignment
        JOIN roles role ON role.id = assignment.role_id
        WHERE role.code = $1
      ),
      active_business_users AS (
        SELECT user_record.id
        FROM users user_record
        WHERE user_record.status = 'active'
          AND user_record.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM smoke_users smoke WHERE smoke.user_id = user_record.id
          )
      )
      SELECT
        (SELECT count(*) FROM users)::int AS "totalUsers",
        (SELECT count(*) FROM smoke_users)::int AS "smokeUsers",
        (SELECT count(*) FROM active_business_users)::int AS "activeBusinessUsers",
        (SELECT count(*) FROM active_business_users business_user
          JOIN v2_auth_identities identity ON identity.user_id = business_user.id)::int
          AS "businessAuthIdentities",
        (SELECT count(*) FROM active_business_users business_user
          LEFT JOIN v2_auth_identities identity ON identity.user_id = business_user.id
          WHERE identity.id IS NULL)::int AS "activeBusinessUsersWithoutIdentity",
        (SELECT count(*) FROM v2_auth_identities identity
          JOIN active_business_users business_user ON business_user.id = identity.user_id
          WHERE identity.enabled)::int AS "enabledBusinessIdentities",
        (SELECT count(*) FROM v2_auth_identities identity
          JOIN active_business_users business_user ON business_user.id = identity.user_id
          WHERE identity.must_reset_password)::int AS "businessIdentitiesRequiringPasswordReset",
        (SELECT count(*) FROM active_sessions session
          JOIN active_business_users business_user ON business_user.id = session.user_id
          WHERE session.revoked_at IS NULL AND session.expires_at > now())::int
          AS "activeBusinessSessions"
    `,
    [PRODUCTION_SMOKE_ROLE_CODE]
  );
  return result.rows[0];
}

async function readRoles(database) {
  const result = await database.query(`
    SELECT
      role.code,
      count(DISTINCT assignment.user_id)::int AS "userCount",
      count(DISTINCT role_permission.permission_id)::int AS "permissionCount"
    FROM roles role
    LEFT JOIN user_roles assignment ON assignment.role_id = role.id
    LEFT JOIN role_permissions role_permission ON role_permission.role_id = role.id
    GROUP BY role.code
    ORDER BY role.code
  `);
  return result.rows;
}

async function readPermissionCatalog(database) {
  const result = await database.query('SELECT code FROM permissions ORDER BY code');
  return result.rows.map((row) => row.code);
}

async function readGovernance(database) {
  const result = await database.query(`
    SELECT
      (SELECT count(*) FROM id_business_v2_governance_jobs)::int AS jobs,
      (SELECT count(*) FROM id_business_v2_governance_approvals)::int AS approvals,
      (SELECT count(*) FROM id_business_v2_governance_checkpoints)::int AS checkpoints
  `);
  return result.rows[0];
}

async function readBusinessEvidence(database) {
  const result = await database.query(`
    SELECT
      (SELECT count(*) FROM id_business_v2_gift_cards)::int AS "giftCards",
      (SELECT count(*) FROM id_business_v2_topup_supplier_payments)::int AS "supplierPayments",
      (SELECT count(*) FROM id_business_v2_orders WHERE status = 'completed')::int
        AS "completedOrders",
      (SELECT count(*) FROM id_business_v2_orders WHERE status = 'refunded')::int
        AS "refundedOrders",
      (SELECT count(*) FROM id_business_v2_activations)::int AS activations
  `);
  return result.rows[0];
}
