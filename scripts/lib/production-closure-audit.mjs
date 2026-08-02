export const PRODUCTION_SMOKE_ROLE_CODE = 'production_smoke_readonly';

const REMOVED_DATABASE_OPTIONS = [
  'schema',
  'pgbouncer',
  'connection_limit',
  'pool_timeout',
  'sslmode'
];

export function normalizeDatabaseConnection(rawValue) {
  if (!rawValue?.trim()) {
    throw new Error('缺少 DIRECT_URL 或 DATABASE_URL');
  }

  const url = new URL(rawValue);
  for (const option of REMOVED_DATABASE_OPTIONS) {
    url.searchParams.delete(option);
  }

  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  return {
    connectionString: url.toString(),
    ssl: localHosts.has(url.hostname) ? undefined : { rejectUnauthorized: false }
  };
}

export function assessProductionClosure(snapshot) {
  const automatedGaps = [];

  if (snapshot.migrations.pendingOrFailed > 0 || snapshot.migrations.unappliedLocal.length > 0) {
    automatedGaps.push('database_migrations_pending_or_failed');
  }
  if (snapshot.finance.historyStatus !== 'completed') {
    automatedGaps.push('finance_history_incomplete');
  }
  if (snapshot.auth.activeBusinessUsersWithoutIdentity > 0) {
    automatedGaps.push('active_business_users_without_auth_identity');
  }
  if (
    snapshot.governance.jobs === 0 ||
    snapshot.governance.approvals === 0 ||
    snapshot.governance.checkpoints === 0
  ) {
    automatedGaps.push('governance_live_rehearsal_missing');
  }

  return {
    ready: automatedGaps.length === 0,
    readyForCompleteFinancialReporting: snapshot.finance.historyStatus === 'completed',
    automatedGaps,
    manualGates: [
      'production_role_permission_matrix_review',
      'real_business_end_to_end_rehearsal',
      'supabase_auth_session_and_mfa_review',
      'supabase_compatible_restore_rehearsal'
    ]
  };
}
