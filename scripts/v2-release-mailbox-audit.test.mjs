import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  V2_DATA_INTEGRITY_CHECKS,
  buildV2DataIntegrityCheckQueries
} from './lib/v2-data-integrity-audit.mjs';
import { fingerprint, schemaQueries } from './lib/v2-release-maintenance-policy.mjs';
import {
  acceptMailboxSnapshot,
  collectMailboxSnapshot,
  MAILBOX_POLICY_SHA256
} from './v2-release-mailbox-audit.mjs';

const policy = JSON.parse(
  readFileSync(
    new URL('../deploy/aws/historical-finance-20261005-mailbox-batch.json', import.meta.url),
    'utf8'
  )
);
const clone = (value) => structuredClone(value);
const accepted = (value = policy, snapshot = policy.snapshot, stage = 'before', before) =>
  acceptMailboxSnapshot(value, snapshot, stage, before);

test('independent approval pins all 48 executed checks and six frozen complete cost facts', () => {
  assert.equal(fingerprint(policy), MAILBOX_POLICY_SHA256);
  const before = accepted();
  assert.equal(before.violationCount, 6);
  assert.equal(before.executedCheckCount, 48);
  assert.equal(accepted(policy, policy.snapshot, 'after', before).accepted, true);
  assert.equal(JSON.stringify(before).includes('entityId'), false);
});

test('approval cannot expand rules, baseline, image source, build, attempt, or historical facts', () => {
  for (const mutate of [
    (p) => {
      p.userApproved = false;
    },
    (p) => {
      p.id = 'historical-finance-20261005-maintenance-continuation';
    },
    (p) => {
      p.expectedCurrent = 'a'.repeat(40);
    },
    (p) => {
      p.imageCommit = 'b'.repeat(40);
    },
    (p) => {
      p.imageRun = '37312405715';
    },
    (p) => {
      p.imageAttempt = '2';
    },
    (p) => {
      p.snapshot.checks[0].count = 1;
    },
    (p) => {
      p.allowAdditionalExceptions = true;
    }
  ]) {
    const value = clone(policy);
    mutate(value);
    assert.throws(() => accepted(value, value.snapshot), /MAILBOX_GATE_REJECTED/);
  }
});

test('missing, unavailable, duplicate, changed counts, schema, predicates or journal facts are rejected', () => {
  for (const mutate of [
    (s) => {
      s.checks.pop();
    },
    (s) => {
      s.checks[0].status = 'UNAVAILABLE';
    },
    (s) => {
      s.checks[0] = clone(s.checks[1]);
    },
    (s) => {
      s.checks.find((c) => c.count === 6).count = 5;
    },
    (s) => {
      s.checks[0].count = 1;
    },
    ...['databaseName', 'rulesSha256', 'schemaSha256', 'entitySetSha256', 'closedFactsSha256'].map(
      (key) => (s) => {
        s[key] = 'changed';
      }
    )
  ]) {
    const snapshot = clone(policy.snapshot);
    mutate(snapshot);
    assert.throws(() => accepted(policy, snapshot), /MAILBOX_GATE_REJECTED/);
  }
});

test('after audit requires the identical approved before receipt and unchanged stage', () => {
  assert.throws(() => accepted(policy, policy.snapshot, 'after'), /MAILBOX_GATE_REJECTED/);
  for (const mutate of [
    (g) => {
      g.snapshotSha256 = 'changed';
    },
    (g) => {
      g.violationCount = 5;
    },
    (g) => {
      g.stage = 'after';
    },
    (g) => {
      g.accepted = false;
    },
    (g) => {
      g.extra = true;
    }
  ]) {
    const before = accepted();
    mutate(before);
    assert.throws(
      () => accepted(policy, policy.snapshot, 'after', before),
      /MAILBOX_GATE_REJECTED/
    );
  }
  assert.throws(
    () => accepted(policy, policy.snapshot, 'before', accepted()),
    /MAILBOX_GATE_REJECTED/
  );
  assert.throws(() => accepted(policy, policy.snapshot, 'unknown'), /MAILBOX_GATE_REJECTED/);
});

test('read-only snapshot fails closed at every one of the 48 checks and disconnects', async () => {
  const q = schemaQueries();
  const countSql = V2_DATA_INTEGRITY_CHECKS.map(
    (c) => buildV2DataIntegrityCheckQueries(c.sql).count
  );
  for (let index = 0; index < 48; index++) {
    let disconnected = false;
    let countCalls = 0;
    const tx = {
      $queryRawUnsafe: async (sql) => {
        if (sql.startsWith('SELECT DATABASE()'))
          return [
            {
              databaseName: policy.snapshot.databaseName,
              currentUser: 'id_business_audit@%',
              transactionIsolation: 'REPEATABLE-READ',
              foreignKeyChecks: 1,
              transactionReadOnly: 1
            }
          ];
        if (sql === q.tablesSql) return q.tables.map(() => ({ engine: 'InnoDB' }));
        if (sql === q.database) return [{}];
        if (countSql.includes(sql)) {
          countCalls++;
          // A SQL exception must not be treated as zero or an approved exception.
          if (sql === countSql[index]) throw new Error('fixture query unavailable');
          return [{ count: sql === countSql[45] ? 6 : 0 }];
        }
        if (sql.startsWith('SELECT entity_id AS id'))
          return Array.from({ length: 6 }, (_, i) => ({ id: String(i) }));
        return [];
      }
    };
    const client = {
      $connect: async () => undefined,
      $disconnect: async () => {
        disconnected = true;
      },
      $executeRawUnsafe: async (sql) => assert.equal(sql, 'SET SESSION TRANSACTION READ ONLY'),
      $queryRawUnsafe: async () => [
        {
          Grants:
            'GRANT SELECT ON `id_business_v2_partial_cleanup_20261005_v1`.* TO `id_business_audit`@`%`'
        }
      ],
      $transaction: async (run, options) => {
        assert.equal(options.isolationLevel, 'RepeatableRead');
        return run(tx);
      }
    };
    await assert.rejects(() => collectMailboxSnapshot(client));
    assert.equal(disconnected, true);
    assert.equal(countCalls, index + 1);
  }
});
