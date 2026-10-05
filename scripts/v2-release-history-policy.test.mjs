import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// The new 49-rule draft guards must run in the existing repository-script CI entry point.
import './v2-release-post-cleanup-policy.test.mjs';
import { V2_DATA_INTEGRITY_CHECKS as CURRENT_V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';
import {
  acceptHistoricalAudit,
  fingerprint,
  fingerprintRows,
  serializeHistoricalAuditReport,
  validateHistoryPolicy
} from './lib/v2-release-history-policy.mjs';

const policy = JSON.parse(
  readFileSync(new URL('../deploy/aws/historical-finance-20261005.json', import.meta.url))
);
// The immutable 48-rule policies describe the original release, never the current 49-rule runtime.
const legacyFixture = JSON.parse(
  readFileSync(new URL('./lib/v2-release-history-48.test-fixture.json', import.meta.url))
);
const V2_DATA_INTEGRITY_CHECKS = legacyFixture.definitions;
test('frozen historical fixture retains exact 48 rules and rejects current 49 rules', () => {
  assert.equal(legacyFixture.usage, 'PURE_TEST_FIXTURE_NEVER_EXECUTE');
  assert.equal(fingerprint(V2_DATA_INTEGRITY_CHECKS), policy.rulesSha256);
  assert.equal(legacyFixture.rulesSha256, policy.rulesSha256);
  assert.equal(CURRENT_V2_DATA_INTEGRITY_CHECKS.length, 49);
  assert.throws(() =>
    validateHistoryPolicy(policy, CURRENT_V2_DATA_INTEGRITY_CHECKS, policy.expectedCurrent)
  );
});
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
test('real MySQL BigInt identity serializes without changing audit or gate status', () => {
  const input = fixture();
  input.identity.foreignKeyChecks = 1n;
  const report = JSON.parse(
    serializeHistoricalAuditReport({
      ok: false,
      violationCount: 10,
      identity: input.identity,
      gate: acceptHistoricalAudit(input)
    })
  );
  assert.equal(report.identity.foreignKeyChecks, '1');
  assert.equal(report.ok, false);
  assert.equal(report.violationCount, 10);
  assert.equal(report.gate.accepted, true);
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

const continuationPolicy = JSON.parse(
  readFileSync(
    new URL(
      '../deploy/aws/historical-finance-20261005-registration-continuation.json',
      import.meta.url
    )
  )
);
// Only irreversible metadata hashes; no journal metadata or private financial fields.
const frozenMetadataHashes = [
  'ce06945f2862986c0ff07e155b9207ec340c58d6598c0eb252a2d607e6cc43a5',
  '4df682e8d327f5d1459d5dbbed31a2f5b5ce8b63d153c7f132a9ecc23e3ca79f',
  'fb329000228cc5a24c264c57139de8bf854fc86fc18bf1c04ab61a2b5cb4b921',
  'baeac8872cb32512fc6952d9c2d4b7211da986205c37b538af4edc51fc24d618',
  '55e09a5f5ff5841180a14530ae248feb06990e1ff99022f6b39c229e9714c05a',
  'fb329000228cc5a24c264c57139de8bf854fc86fc18bf1c04ab61a2b5cb4b921',
  '7f4abe23547d7c8e3a79c039dcaabbe053c430ed9ada83b5006f3e75d94e3a5f',
  '3406929769a319c62237f09a5e47f782e36fb744087fb1762f71da3f0fce23bf',
  'baeac8872cb32512fc6952d9c2d4b7211da986205c37b538af4edc51fc24d618'
];
const continuationFixture = () => ({
  ...fixture(),
  policy: structuredClone(continuationPolicy),
  expectedCurrent: continuationPolicy.expectedCurrent,
  metadata: [...continuationPolicy.sources.journals.ids]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((id, index) => ({ id, metadataSha256: frozenMetadataHashes[index] }))
});
test('registration continuation preserves the complete original financial exception scope', () => {
  const restored = {
    ...continuationPolicy,
    id: policy.id,
    expectedCurrent: policy.expectedCurrent
  };
  delete restored.continuation;
  delete restored.candidateSourceSha256;
  assert.equal(fingerprint(restored), fingerprint(policy));
  assert.equal(
    fingerprintRows(continuationFixture().metadata),
    continuationPolicy.continuation.metadataSha256
  );
  const input = continuationFixture();
  const before = { ok: false, violationCount: 10, gate: acceptHistoricalAudit(input) };
  const after = acceptHistoricalAudit({ ...input, stage: 'after', before });
  assert.equal(after.accepted, true);
  assert.equal(after.continuationOf, policy.id);
  assert.equal(after.fixedCurrent, continuationPolicy.expectedCurrent);
  assert.equal(after.executedCheckCount, 48);
  assert.equal(after.unavailableCheckCount, 0);
  assert.equal(after.violationCount, 10);
});
for (const [name, mutate] of [
  ['previous or later production SHA', (x) => (x.expectedCurrent = policy.expectedCurrent)],
  ['later one-time reuse', (x) => (x.expectedCurrent = 'f'.repeat(40))],
  ['different original manifest', (x) => (x.policy.continuation.manifestSha256 = 'f'.repeat(64))],
  [
    'different original before receipt',
    (x) => (x.policy.continuation.beforeReceiptSha256 = 'f'.repeat(64))
  ],
  [
    'different original after receipt',
    (x) => (x.policy.continuation.afterReceiptSha256 = 'f'.repeat(64))
  ],
  [
    'changed candidate worker',
    (x) =>
      (x.policy.candidateSourceSha256[Object.keys(x.policy.candidateSourceSha256)[0]] = 'f'.repeat(
        64
      ))
  ],
  ['different frozen exception entity', (x) => (x.policy.exceptions[0].entityIds[0] = 'other')],
  ['new anomaly', (x) => (x.checks[0].count = 1)],
  [
    'same-size replaced exception',
    (x) => (x.checks.find((c) => c.count === 4).samples[0].entityId = 'other')
  ],
  ['new metadata before switch', (x) => (x.metadata[0].metadataSha256 = 'f'.repeat(64))],
  ['changed source fingerprint', (x) => (x.sources.accounts = 'f'.repeat(64))],
  ['unknown rule status', (x) => (x.checks[0].status = 'NOT_EXECUTED')],
  [
    'legacy schema-unavailable rule',
    (x) =>
      Object.assign(
        x.checks.find((c) => c.code === 'bank_soft_delete_safety_mismatch'),
        { status: 'SCHEMA_NOT_DEPLOYED', databaseCode: '1054', field: 'o.deleted_at' }
      )
  ]
])
  test(`registration continuation rejects ${name}`, () => {
    const input = continuationFixture();
    mutate(input);
    assert.throws(() => acceptHistoricalAudit(input));
  });
for (const [name, mutate] of [
  ['incomplete original rule execution', (x) => (x.executedCheckCount = 46)],
  ['unavailable original rule', (x) => (x.unavailableCheckCount = 2)],
  ['wrong origin', (x) => (x.continuationOf = 'other')],
  ['wrong fixed production SHA', (x) => (x.fixedCurrent = 'f'.repeat(40))],
  ['changed successful provenance', (x) => (x.continuation.manifestSha256 = 'f'.repeat(64))],
  ['unknown acceptance status', (x) => (x.status = 'UNKNOWN')]
])
  test(`registration continuation rejects before receipt with ${name}`, () => {
    const input = continuationFixture();
    const before = { gate: acceptHistoricalAudit(input) };
    mutate(before.gate);
    assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after', before }));
  });

test('production Python deployment and cache controls retain their safety checks', () => {
  for (const path of [
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.test.py'
  ])
    execFileSync('python3', ['-B', path], { stdio: 'pipe' });
});

const diagnosticsPolicy = JSON.parse(
  readFileSync(
    new URL('../deploy/aws/historical-finance-20261005-recharge-diagnostics.json', import.meta.url)
  )
);
const diagnosticsFixture = () => ({
  ...fixture(),
  policy: structuredClone(diagnosticsPolicy),
  expectedCurrent: diagnosticsPolicy.expectedCurrent,
  // Irreversible frozen-row hashes are fixtures; no prior receipt hash is reused as 6a proof.
  metadata: continuationFixture().metadata
});
test('recharge diagnostics preserves the original frozen scope and exactly the seven approved sources', () => {
  const restored = {
    ...diagnosticsPolicy,
    id: policy.id,
    expectedCurrent: policy.expectedCurrent
  };
  delete restored.continuation;
  delete restored.candidateSourceSha256;
  assert.equal(fingerprint(restored), fingerprint(policy));
  assert.equal(diagnosticsPolicy.expectedCurrent, '6a82a774f2a65e00d4f260c629f7152bf7935d1d');
  assert.deepEqual(diagnosticsPolicy.candidateSourceSha256, {
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py':
      '9c3c0d7b7d60ae26729486943fb7d4eec15154fb1331646fa755a6a014ebde6a',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py':
      '2ccb8e3b0e6b3ba9ff2cfc55e1fb96c5352ce6c0767ae7594aab2f5fa30d948f',
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py':
      '1734bacb68549f8dcc28a35426d659069b7aefc8070b110adb5c0bfd70c140a9',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py':
      'ac459b9a00eaeb482efc54cc7eecf23fc003c993e6d5991ecf45034c5e1c0696',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py':
      '1327c9fdd8e88807e8ba69bbd288c9b2e62edf015352250e2d54f8d4e9a69173',
    'docs/V2_TASKS.md': 'f2eb5c6520c246b7585934935672af8f328415453286c08fca5e71c5aa8b7449',
    'scripts/ci-recharge-check.mjs':
      '86c143e33a862fc31610b68f013d32236447548c9ee238cf58a3393f088f53cc'
  });
  const input = diagnosticsFixture();
  assert.equal(fingerprintRows(input.metadata), diagnosticsPolicy.continuation.metadataSha256);
  const before = { ok: false, violationCount: 10, gate: acceptHistoricalAudit(input) };
  const after = acceptHistoricalAudit({ ...input, stage: 'after', before });
  assert.equal(after.policyId, diagnosticsPolicy.id);
  assert.equal(after.fixedCurrent, diagnosticsPolicy.expectedCurrent);
  assert.equal(after.continuationOf, policy.id);
  assert.equal(after.accepted, true);
  assert.equal(after.checkCount, 48);
  assert.equal(after.executedCheckCount, 48);
  assert.equal(after.unavailableCheckCount, 0);
  assert.equal(after.violationCount, 10);
});
const newlyApprovedDiagnosticSources = [
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
  'docs/V2_TASKS.md'
];
for (const path of newlyApprovedDiagnosticSources)
  for (const [name, mutate] of [
    ['wrong hash', (map) => (map[path] = 'f'.repeat(64))],
    ['missing path', (map) => delete map[path]],
    ['extra path', (map) => (map[path + '.extra'] = map[path])]
  ])
    test(`recharge diagnostics rejects ${name} for newly approved ${path}`, () => {
      const input = diagnosticsFixture();
      mutate(input.policy.candidateSourceSha256);
      assert.throws(() =>
        validateHistoryPolicy(input.policy, input.definitions, input.expectedCurrent)
      );
    });
for (const [name, mutate] of [
  ['unknown policy', (x) => (x.policy.id = 'historical-finance-unreviewed')],
  ['lookalike policy', (x) => (x.policy.id += '-other')],
  ['prototype policy', (x) => (x.policy.id = 'constructor')],
  ['original baseline', (x) => (x.expectedCurrent = policy.expectedCurrent)],
  ['registration baseline', (x) => (x.expectedCurrent = continuationPolicy.expectedCurrent)],
  ['future baseline', (x) => (x.expectedCurrent = 'f'.repeat(40))],
  ['changed fixed baseline', (x) => (x.policy.expectedCurrent = 'f'.repeat(40))],
  ['missing rule', (x) => x.checks.pop()],
  ['duplicated rule', (x) => (x.checks[0] = x.checks[1])],
  [
    'changed rule SQL',
    (x) => (x.definitions = x.definitions.map((d, i) => (i ? d : { ...d, sql: 'SELECT 1' })))
  ],
  ['nonexecuted rule', (x) => (x.checks[0].status = 'NOT_EXECUTED')],
  ['missing execution status', (x) => delete x.checks[0].status],
  [
    'legacy unavailable rule',
    (x) =>
      Object.assign(
        x.checks.find((c) => c.code === 'bank_soft_delete_safety_mismatch'),
        {
          status: 'SCHEMA_NOT_DEPLOYED',
          databaseCode: '1054',
          field: 'o.deleted_at'
        }
      )
  ],
  [
    'false zero violations',
    (x) => x.checks.forEach((c) => Object.assign(c, { count: 0, samples: [] }))
  ],
  [
    'same count different exception',
    (x) => (x.checks.find((c) => c.count === 4).samples[0].entityId = 'other')
  ],
  ['changed frozen scope', (x) => (x.policy.exceptions[0].entityIds[0] = 'other')],
  ['missing frozen source', (x) => delete x.sources.lines],
  ['extra frozen source', (x) => (x.sources.extra = 'f'.repeat(64))],
  ['changed frozen source', (x) => (x.sources.accounts = 'f'.repeat(64))],
  ['missing metadata row', (x) => x.metadata.pop()],
  ['duplicated metadata row', (x) => (x.metadata[0] = x.metadata[1])],
  ['changed frozen metadata', (x) => (x.metadata[0].metadataSha256 = 'f'.repeat(64))],
  ['unknown stage', (x) => (x.stage = 'unknown')],
  [
    'old d0 proof',
    (x) => (x.policy.continuation = structuredClone(continuationPolicy.continuation))
  ],
  ['changed raw manifest proof', (x) => (x.policy.continuation.manifestSha256 = 'f'.repeat(64))],
  ['changed raw before proof', (x) => (x.policy.continuation.beforeReceiptSha256 = 'f'.repeat(64))],
  ['changed raw after proof', (x) => (x.policy.continuation.afterReceiptSha256 = 'f'.repeat(64))],
  [
    'missing approved source file',
    (x) => delete x.policy.candidateSourceSha256['scripts/ci-recharge-check.mjs']
  ],
  ['extra approved source file', (x) => (x.policy.candidateSourceSha256.extra = 'f'.repeat(64))],
  [
    'changed approved CI source',
    (x) => (x.policy.candidateSourceSha256['scripts/ci-recharge-check.mjs'] = 'f'.repeat(64))
  ]
])
  test('recharge diagnostics rejects ' + name, () => {
    const input = diagnosticsFixture();
    mutate(input);
    assert.throws(() => acceptHistoricalAudit(input));
  });
for (const [name, mutate] of [
  ['other policy', (x) => (x.policyId = continuationPolicy.id)],
  ['different expected baseline', (x) => (x.expectedCurrent = continuationPolicy.expectedCurrent)],
  ['after-stage receipt', (x) => (x.stage = 'after')],
  ['rejected receipt', (x) => (x.accepted = false)],
  ['missing rule coverage', (x) => (x.checkCount = 47)],
  ['partial execution', (x) => (x.executedCheckCount = 46)],
  ['unavailable rules', (x) => (x.unavailableCheckCount = 2)],
  ['false zero violations', (x) => (x.violationCount = 0)],
  ['unknown acceptance', (x) => (x.status = 'UNKNOWN')],
  ['changed origin', (x) => (x.continuationOf = 'other')],
  ['changed fixed baseline', (x) => (x.fixedCurrent = continuationPolicy.expectedCurrent)],
  ['changed continuation proof', (x) => (x.continuation.manifestSha256 = 'f'.repeat(64))],
  ['changed sources', (x) => (x.sources.accounts = 'f'.repeat(64))],
  ['changed metadata', (x) => (x.metadataSha256 = 'f'.repeat(64))]
])
  test('recharge diagnostics after audit rejects before receipt with ' + name, () => {
    const input = diagnosticsFixture();
    const before = { gate: structuredClone(acceptHistoricalAudit(input)) };
    mutate(before.gate);
    assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after', before }));
  });
test('recharge diagnostics after audit requires its own same-proof before receipt', () => {
  const input = diagnosticsFixture();
  assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after' }));
  const before = { gate: acceptHistoricalAudit(continuationFixture()) };
  assert.throws(() => acceptHistoricalAudit({ ...input, stage: 'after', before }));
});
