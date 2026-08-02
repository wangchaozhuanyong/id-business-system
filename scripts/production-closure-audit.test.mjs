import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessProductionClosure,
  normalizeDatabaseConnection
} from './lib/production-closure-audit.mjs';

const completeSnapshot = {
  migrations: {
    databaseAppliedTotal: 79,
    appliedLocal: 18,
    local: 18,
    pendingOrFailed: 0,
    unappliedLocal: []
  },
  finance: { historyStatus: 'completed' },
  auth: { activeBusinessUsersWithoutIdentity: 0 },
  governance: { jobs: 1, approvals: 1, checkpoints: 1 }
};

test('removes Prisma-only connection options without exposing credentials', () => {
  const result = normalizeDatabaseConnection(
    'postgresql://user:secret@db.example.com:5432/app?schema=public&sslmode=require'
  );

  assert.equal(result.connectionString, 'postgresql://user:secret@db.example.com:5432/app');
  assert.deepEqual(result.ssl, { rejectUnauthorized: false });
});

test('keeps local audit connections free of forced TLS', () => {
  const result = normalizeDatabaseConnection('postgresql://postgres:postgres@127.0.0.1:5432/app');
  assert.equal(result.ssl, undefined);
});

test('reports a complete automated closure without claiming manual gates are done', () => {
  const result = assessProductionClosure(completeSnapshot);
  assert.equal(result.ready, true);
  assert.equal(result.readyForCompleteFinancialReporting, true);
  assert.deepEqual(result.automatedGaps, []);
  assert.ok(result.manualGates.includes('production_role_permission_matrix_review'));
});

test('separates measurable gaps from manual production acceptance', () => {
  const result = assessProductionClosure({
    ...completeSnapshot,
    finance: { historyStatus: 'incomplete' },
    auth: { activeBusinessUsersWithoutIdentity: 1 },
    governance: { jobs: 0, approvals: 0, checkpoints: 0 }
  });

  assert.equal(result.ready, false);
  assert.equal(result.readyForCompleteFinancialReporting, false);
  assert.deepEqual(result.automatedGaps, [
    'finance_history_incomplete',
    'active_business_users_without_auth_identity',
    'governance_live_rehearsal_missing'
  ]);
});

test('reports local migrations that have not reached production', () => {
  const result = assessProductionClosure({
    ...completeSnapshot,
    migrations: {
      databaseAppliedTotal: 77,
      appliedLocal: 16,
      local: 18,
      pendingOrFailed: 0,
      unappliedLocal: [
        '20260802010000_normal_id_status_seed',
        '20260802011000_exchange_rate_validation_function'
      ]
    }
  });

  assert.deepEqual(result.automatedGaps, ['database_migrations_pending_or_failed']);
});
