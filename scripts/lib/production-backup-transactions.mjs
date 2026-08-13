import { Client } from 'pg';
import { normalizeDatabaseConnection } from './production-closure-audit.mjs';
import { EXPECTED_BACKUP_ROLE } from './production-backup.mjs';

export const BACKUP_TRANSACTION_STALE_MS = 2 * 60 * 1000;

export async function inspectProductionBackupTransactions(
  databaseUrl,
  { applicationName, includeCurrentSessionTimeout = false, includeRoleTimeouts = false } = {}
) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: applicationName ?? 'id-v2-backup-transaction-inspector',
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000
  });
  await client.connect();
  try {
    const transactions = (
      await client.query(
        `SELECT
           pid,
           state,
           GREATEST(
             0,
             EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000
           )::bigint AS transaction_age_ms,
           GREATEST(
             0,
             EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) * 1000
           )::bigint AS state_age_ms,
           wait_event_type,
           wait_event
         FROM pg_catalog.pg_stat_activity
         WHERE usename = $1
           AND pid <> pg_backend_pid()
           AND xact_start IS NOT NULL
           AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')
         ORDER BY xact_start ASC`,
        [EXPECTED_BACKUP_ROLE]
      )
    ).rows.map(normalizeTransaction);
    let currentSessionIdleTimeoutMs = null;
    let backupRoleTimeouts = null;
    if (includeCurrentSessionTimeout) {
      const timeout = await client.query(
        `SELECT (
           EXTRACT(
             EPOCH FROM current_setting('idle_in_transaction_session_timeout')::interval
           ) * 1000
         )::bigint AS timeout_ms`
      );
      currentSessionIdleTimeoutMs = Number(timeout.rows[0].timeout_ms);
    }
    if (includeRoleTimeouts) {
      const roleTimeouts = await client.query(
        `SELECT
           COALESCE(
             (
               SELECT option_value
               FROM pg_catalog.pg_db_role_setting setting
               CROSS JOIN LATERAL pg_catalog.pg_options_to_table(setting.setconfig)
               WHERE setting.setdatabase = 0
                 AND setting.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
                 AND option_name = 'idle_in_transaction_session_timeout'
             ),
             '0'
           )::interval AS idle_in_transaction_timeout,
           COALESCE(
             (
               SELECT option_value
               FROM pg_catalog.pg_db_role_setting setting
               CROSS JOIN LATERAL pg_catalog.pg_options_to_table(setting.setconfig)
               WHERE setting.setdatabase = 0
                 AND setting.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
                 AND option_name = 'idle_session_timeout'
             ),
             '0'
           )::interval AS idle_session_timeout`,
        [EXPECTED_BACKUP_ROLE]
      );
      backupRoleTimeouts = {
        idleInTransactionMs: intervalToMilliseconds(
          roleTimeouts.rows[0].idle_in_transaction_timeout
        ),
        idleSessionMs: intervalToMilliseconds(roleTimeouts.rows[0].idle_session_timeout)
      };
    }
    return { transactions, currentSessionIdleTimeoutMs, backupRoleTimeouts };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function findStaleBackupTransactions(
  transactions,
  staleAfterMs = BACKUP_TRANSACTION_STALE_MS
) {
  return transactions.filter(
    (transaction) =>
      transaction.state.startsWith('idle in transaction') && transaction.stateAgeMs >= staleAfterMs
  );
}

export function describeBackupTransactions(transactions) {
  const longestAgeMs = transactions.reduce(
    (maximum, transaction) =>
      Math.max(
        maximum,
        transaction.state.startsWith('idle in transaction')
          ? transaction.stateAgeMs
          : transaction.transactionAgeMs
      ),
    0
  );
  return `${transactions.length} 个，最长 ${formatDuration(longestAgeMs)}`;
}

function normalizeTransaction(row) {
  return {
    pid: Number(row.pid),
    state: String(row.state),
    transactionAgeMs: Number(row.transaction_age_ms),
    stateAgeMs: Number(row.state_age_ms),
    waitEventType: row.wait_event_type ?? null,
    waitEvent: row.wait_event ?? null
  };
}

function intervalToMilliseconds(interval) {
  return (
    Number(interval.days ?? 0) * 24 * 60 * 60 * 1000 +
    Number(interval.hours ?? 0) * 60 * 60 * 1000 +
    Number(interval.minutes ?? 0) * 60 * 1000 +
    Number(interval.seconds ?? 0) * 1000 +
    Number(interval.milliseconds ?? 0)
  );
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`;
}
