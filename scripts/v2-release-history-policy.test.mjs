import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';
import {
  acceptHistoricalAudit,
  fingerprintRows,
  validateHistoryPolicy
} from './lib/v2-release-history-policy.mjs';

const policy = JSON.parse(
  readFileSync(new URL('../deploy/aws/historical-finance-20261005.json', import.meta.url))
);
const fixture = () => ({
  policy: structuredClone(policy),
  definitions: V2_DATA_INTEGRITY_CHECKS,
  expectedCurrent: policy.expectedCurrent,
  stage: 'before',
  checks: V2_DATA_INTEGRITY_CHECKS.map((item) => {
    const ids =
      policy.exceptions.find((exception) => exception.code === item.code)?.entityIds ?? [];
    return {
      code: item.code,
      status: 'EXECUTED',
      count: ids.length,
      samples: ids.map((entityId) => ({ entityId }))
    };
  }),
  sources: Object.fromEntries(
    Object.entries(policy.sources).map(([key, group]) => [key, group.sha256])
  ),
  metadata: policy.sources.journals.ids.map((id) => ({ id, metadataSha256: 'a'.repeat(64) })),
  identity: {
    currentUser: 'id_business_audit@%',
    transactionIsolation: 'REPEATABLE-READ',
    foreignKeyChecks: 1
  }
});
test('approved baseline retains 10 actual violations and accepts only the release gate', () => {
  const input = fixture();
  const before = { ok: false, violationCount: 10, gate: acceptHistoricalAudit(input) };
  assert.equal(before.ok, false);
  assert.equal(before.gate.executedCheckCount, 48);
  const after = acceptHistoricalAudit({ ...input, stage: 'after', before });
  assert.equal(after.violationCount, 10);
  assert.equal(after.accepted, true);
});
for (const [name, mutate] of [
  ['changed running SHA', (x) => (x.expectedCurrent = 'b'.repeat(40))],
  ['write identity', (x) => (x.identity.currentUser = 'root@%')],
  ['weaker isolation', (x) => (x.identity.transactionIsolation = 'READ-COMMITTED')],
  ['disabled foreign keys', (x) => (x.identity.foreignKeyChecks = 0)],
  ['unapproved policy', (x) => (x.policy.userApproved = false)],
  ['changed policy baseline', (x) => (x.policy.expectedCurrent = 'b'.repeat(40))],
  [
    'changed rule SQL',
    (x) => (x.definitions = x.definitions.map((d, i) => (i ? d : { ...d, sql: 'SELECT 1' })))
  ],
  ['missing rule', (x) => x.checks.pop()],
  ['duplicated rule', (x) => (x.checks[0] = x.checks[1])],
  ['new unrelated anomaly', (x) => (x.checks[0].count = 1)],
  ['extra approved-rule anomaly', (x) => (x.checks.find((c) => c.count === 4).count = 5)],
  [
    'different anomaly with same count',
    (x) => (x.checks.find((c) => c.count === 4).samples[0].entityId = 'new-id')
  ],
  ['truncated samples', (x) => x.checks.find((c) => c.count === 6).samples.pop()],
  ['rule execution error', (x) => (x.checks[0].count = undefined)],
  ['wrong number of exception rows', (x) => x.policy.exceptions[0].entityIds.pop()],
  ['changed original money or balance', (x) => (x.sources.accounts = 'b'.repeat(64))],
  ['changed original source journal', (x) => (x.sources.journals = 'b'.repeat(64))],
  ['changed original order', (x) => (x.sources.orders = 'b'.repeat(64))],
  ['missing original lines', (x) => delete x.sources.lines],
  ['missing metadata row', (x) => x.metadata.pop()],
  ['unexpected metadata row', (x) => (x.metadata[0].id = 'new-id')],
  ['invalid metadata hash', (x) => (x.metadata[0].metadataSha256 = 'unknown')]
])
  test(`historical release rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => acceptHistoricalAudit(input));
  });
test('only the two exact pre-migration missing-field rules may be unavailable before switch', () => {
  const input = fixture();
  for (const code of [
    'bank_subscription_projection_mismatch',
    'bank_soft_delete_safety_mismatch'
  ]) {
    const item = input.checks.find((c) => c.code === code);
    Object.assign(item, {
      count: undefined,
      status: 'SCHEMA_NOT_DEPLOYED',
      databaseCode: '1054',
      field: 'o.deleted_at'
    });
  }
  assert.equal(acceptHistoricalAudit(input).executedCheckCount, 46);
  assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after' }));
  input.checks.find((c) => c.status === 'SCHEMA_NOT_DEPLOYED').field = 'unexpected_column';
  assert.throws(() => acceptHistoricalAudit(input));
});
test('source metadata changes across switch reject publication', () => {
  const input = fixture();
  const before = { gate: acceptHistoricalAudit(input) };
  input.metadata[0].metadataSha256 = 'b'.repeat(64);
  assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after', before }));
});
test('after switch requires an accepted before receipt', () => {
  const input = fixture();
  assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after' }));
});
test('canonical financial fingerprints ignore order and preserve every amount, state and version', () => {
  const original = [
    { id: 'b', amount: '10.0000', version: new Date('2026-10-04T00:00:00Z') },
    { id: 'a', currency: 'CNY', status: 'active' }
  ];
  assert.equal(
    fingerprintRows(original),
    fingerprintRows(JSON.parse(JSON.stringify(original)).reverse())
  );
  const changed = structuredClone(original);
  changed[0].amount = '10.0001';
  assert.notEqual(fingerprintRows(original), fingerprintRows(changed));
});
test('policy schema hashes all 48 real checks', () => {
  validateHistoryPolicy(policy, V2_DATA_INTEGRITY_CHECKS, policy.expectedCurrent);
});

test('production Python deployment and cache controls retain their safety checks', () => {
  for (const path of [
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.test.py'
  ])
    execFileSync('python3', ['-B', path], { stdio: 'pipe' });
});
