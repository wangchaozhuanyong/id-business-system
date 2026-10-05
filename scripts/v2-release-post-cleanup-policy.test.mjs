import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { V2_DATA_INTEGRITY_CHECKS, assessV2DataIntegrity } from './lib/v2-data-integrity-audit.mjs';
import { historicalCashRuntimeFiles } from './historical-cash-package.mjs';
import {
  HISTORY_POST_CLEANUP_POLICY_ID,
  HISTORY_POST_CLEANUP_BASELINE,
  HISTORY_POST_CLEANUP_DATABASE,
  HISTORY_POST_CLEANUP_RECEIPT_SHA256,
  HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256,
  POST_CLEANUP_COST_ENTITY_IDS,
  POST_CLEANUP_REQUIRED_SOURCE_FILES,
  POST_CLEANUP_COMPILED_FILES,
  POST_CLEANUP_CAPTURE_EVIDENCE,
  postCleanupSourceQueries,
  fingerprint,
  fingerprintRows,
  postCleanupSourceAnchor,
  validateHistoryPolicy,
  assessPostCleanupAuditDraft,
  acceptSealedPostCleanupAudit
} from './lib/v2-release-history-policy.mjs';

const fixture = () => {
  const metadata = POST_CLEANUP_COST_ENTITY_IDS.map((entity) => ({
    id: entity.split(':')[0],
    metadataSha256: 'a'.repeat(64)
  }));
  const policy = {
    version: 1,
    id: HISTORY_POST_CLEANUP_POLICY_ID,
    activation: 'EXTERNAL_REVIEWED_SEAL_REQUIRED',
    userApproved: false,
    expectedCurrent: HISTORY_POST_CLEANUP_BASELINE,
    activeDatabase: HISTORY_POST_CLEANUP_DATABASE,
    checkCount: 49,
    rulesSha256: fingerprint(V2_DATA_INTEGRITY_CHECKS),
    exceptions: [
      {
        code: 'cash_historical_cost_evidence_mismatch',
        entityIds: [...POST_CLEANUP_COST_ENTITY_IDS]
      }
    ],
    cleanupReceiptSha256: HISTORY_POST_CLEANUP_RECEIPT_SHA256,
    captureEvidence: POST_CLEANUP_CAPTURE_EVIDENCE,
    metadataSha256: fingerprintRows(metadata),
    sources: Object.fromEntries(
      Object.entries(postCleanupSourceQueries).map(([name, query]) => [
        name,
        {
          ids: [...query.ids],
          rowCount: name === 'accounts' ? 2 : name === 'lines' || name === 'cashLines' ? 10 : 5,
          sha256: 'a'.repeat(64)
        }
      ])
    ),
    candidateBindings: {
      sourceSha256: Object.fromEntries(
        POST_CLEANUP_REQUIRED_SOURCE_FILES.map((file) => [file, 'a'.repeat(64)])
      ),
      compiledServiceHashes: Object.fromEntries(
        POST_CLEANUP_COMPILED_FILES.map((file) => [file, 'a'.repeat(64)])
      )
    }
  };
  policy.sourceAnchorSha256 = postCleanupSourceAnchor(policy);
  return {
    policy,
    definitions: V2_DATA_INTEGRITY_CHECKS,
    expectedCurrent: HISTORY_POST_CLEANUP_BASELINE,
    stage: 'before',
    metadata,
    scope: { targetOrdersCount: 0n, protectedThirdOrderCount: 1n },
    cleanupReceiptSha256: HISTORY_POST_CLEANUP_RECEIPT_SHA256,
    identity: {
      currentUser: 'id_business_audit@%',
      transactionIsolation: 'REPEATABLE-READ',
      foreignKeyChecks: 1n,
      databaseName: HISTORY_POST_CLEANUP_DATABASE,
      readOnly: 0n,
      superReadOnly: 0n,
      sessionReadOnly: 1n
    },
    sources: Object.fromEntries(
      Object.entries(policy.sources).map(([name, group]) => [
        name,
        { rowCount: group.rowCount, sha256: group.sha256 }
      ])
    ),
    checks: V2_DATA_INTEGRITY_CHECKS.map((definition) => ({
      code: definition.code,
      status: 'EXECUTED',
      count: definition.code === 'cash_historical_cost_evidence_mismatch' ? 5 : 0,
      samples:
        definition.code === 'cash_historical_cost_evidence_mismatch'
          ? POST_CLEANUP_COST_ENTITY_IDS.map((entityId) => ({ entityId }))
          : []
    }))
  };
};

test('five unchanged old findings stay visible while all 49 rules execute; draft cannot approve release', () => {
  const input = fixture();
  const report = assessV2DataIntegrity(input.checks);
  assert.equal(report.ok, false);
  assert.equal(report.violationCount, 5);
  const draft = assessPostCleanupAuditDraft(input);
  assert.equal(draft.accepted, false);
  assert.equal(draft.status, 'POST_CLEANUP_DRAFT_VERIFIED_NOT_ACTIVATED');
  assert.equal(draft.executedCheckCount, 49);
  assert.equal(draft.unavailableCheckCount, 0);
  assert.throws(() =>
    validateHistoryPolicy(input.policy, input.definitions, input.expectedCurrent)
  );
  assert.throws(() =>
    acceptSealedPostCleanupAudit(input, {
      seal: {},
      sealSha256: 'a'.repeat(64),
      sealBytes: Buffer.from('{}'),
      cleanupReceiptBytes: Buffer.from('{}'),
      candidateCommit: 'b'.repeat(40),
      candidateTree: 'c'.repeat(40)
    })
  );
});
test('compiled dependencies include all 25 actual runner files and both complete account cash chains', () => {
  assert.deepEqual(POST_CLEANUP_COMPILED_FILES, historicalCashRuntimeFiles);
  assert.equal(POST_CLEANUP_REQUIRED_SOURCE_FILES.length, 26);
  assert.match(postCleanupSourceQueries.cashLines.sql, /l\.finance_account_id IN \(IDS\)/);
  assert.match(postCleanupSourceQueries.cashJournals.sql, /metadataSha256/);
});

for (const [name, mutate] of [
  [
    'later baseline',
    (x) => {
      x.expectedCurrent = 'b'.repeat(40);
    }
  ],
  [
    'another schema',
    (x) => {
      x.identity.databaseName = 'other';
    }
  ],
  [
    'global read-only enabled',
    (x) => {
      x.identity.readOnly = 1n;
    }
  ],
  [
    'global super read-only enabled',
    (x) => {
      x.identity.superReadOnly = 1n;
    }
  ],
  [
    'session may write',
    (x) => {
      x.identity.sessionReadOnly = 0n;
    }
  ],
  [
    'write identity',
    (x) => {
      x.identity.currentUser = 'root@%';
    }
  ],
  [
    'weaker isolation',
    (x) => {
      x.identity.transactionIsolation = 'READ-COMMITTED';
    }
  ],
  [
    'disabled foreign keys',
    (x) => {
      x.identity.foreignKeyChecks = 0;
    }
  ],
  [
    'target returned',
    (x) => {
      x.scope.targetOrdersCount = 1;
    }
  ],
  [
    'protected third removed',
    (x) => {
      x.scope.protectedThirdOrderCount = 0;
    }
  ],
  [
    'missing rule',
    (x) => {
      x.checks.pop();
    }
  ],
  [
    'extra rule',
    (x) => {
      x.checks.push({ code: 'other', count: 0, samples: [], status: 'EXECUTED' });
    }
  ],
  [
    'duplicate rule',
    (x) => {
      x.checks[0] = x.checks[1];
    }
  ],
  [
    'changed SQL',
    (x) => {
      x.definitions = x.definitions.map((row, i) => (i ? row : { ...row, sql: 'SELECT 1' }));
    }
  ],
  [
    'new rule anomaly',
    (x) => {
      x.checks[0].count = 1;
      x.checks[0].samples = [{ entityId: 'other' }];
    }
  ],
  [
    'truncated findings',
    (x) => {
      x.checks.find((row) => row.count === 5).samples.pop();
    }
  ],
  [
    'same-size different finding',
    (x) => {
      x.checks.find((row) => row.count === 5).samples[0].entityId = 'other';
    }
  ],
  [
    'repeated finding',
    (x) => {
      const rows = x.checks.find((row) => row.count === 5).samples;
      rows[0] = rows[1];
    }
  ],
  [
    'false all-zero report',
    (x) => {
      x.checks.forEach((row) => {
        row.count = 0;
        row.samples = [];
      });
    }
  ],
  [
    'schema-unavailable rule',
    (x) => {
      x.checks[0].status = 'SCHEMA_NOT_DEPLOYED';
    }
  ],
  [
    'nonexecuted rule',
    (x) => {
      x.checks[0].status = 'NOT_EXECUTED';
    }
  ],
  [
    'unknown status',
    (x) => {
      delete x.checks[0].status;
    }
  ],
  [
    'unknown count',
    (x) => {
      x.checks[0].count = undefined;
    }
  ],
  [
    'old cleanup receipt',
    (x) => {
      x.cleanupReceiptSha256 = 'b'.repeat(64);
    }
  ],
  [
    'new money with unchanged count',
    (x) => {
      x.sources.cashLines.sha256 = 'b'.repeat(64);
    }
  ],
  [
    'new journal status',
    (x) => {
      x.sources.cashJournals.sha256 = 'b'.repeat(64);
    }
  ],
  [
    'new offsetting cash rows',
    (x) => {
      x.sources.cashLines.rowCount += 2;
    }
  ],
  [
    'changed account version',
    (x) => {
      x.sources.accounts.sha256 = 'b'.repeat(64);
    }
  ],
  [
    'missing source group',
    (x) => {
      delete x.sources.lines;
    }
  ],
  [
    'extra source group',
    (x) => {
      x.sources.extra = { rowCount: 1, sha256: 'b'.repeat(64) };
    }
  ],
  [
    'missing metadata',
    (x) => {
      x.metadata.pop();
    }
  ],
  [
    'duplicate metadata',
    (x) => {
      x.metadata[0] = x.metadata[1];
    }
  ],
  [
    'different metadata',
    (x) => {
      x.metadata[0].metadataSha256 = 'b'.repeat(64);
    }
  ],
  [
    'self-approved source proposal',
    (x) => {
      x.policy.userApproved = true;
    }
  ],
  [
    'extra permitted rule',
    (x) => {
      x.policy.exceptions.push({ code: 'other', entityIds: [] });
    }
  ],
  [
    'wrong frozen scope',
    (x) => {
      x.policy.sources.accounts.ids.pop();
    }
  ],
  [
    'missing required source file',
    (x) => {
      delete x.policy.candidateBindings.sourceSha256[POST_CLEANUP_REQUIRED_SOURCE_FILES[0]];
    }
  ],
  [
    'missing compiled file',
    (x) => {
      delete x.policy.candidateBindings.compiledServiceHashes[POST_CLEANUP_COMPILED_FILES[0]];
    }
  ],
  [
    'unexpected compiled file',
    (x) => {
      x.policy.candidateBindings.compiledServiceHashes['apps/api/dist/other.js'] = 'a'.repeat(64);
    }
  ],
  [
    'cyclic policy source binding',
    (x) => {
      x.policy.candidateBindings.sourceSha256['scripts/lib/v2-release-history-policy.mjs'] =
        'a'.repeat(64);
    }
  ],
  [
    'private configuration binding',
    (x) => {
      x.policy.candidateBindings.sourceSha256['.env.aws.production'] = 'a'.repeat(64);
    }
  ],
  [
    'path traversal',
    (x) => {
      x.policy.candidateBindings.sourceSha256['scripts/../.env'] = 'a'.repeat(64);
    }
  ]
])
  test('post-cleanup draft rejects ' + name, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => assessPostCleanupAuditDraft(input));
  });

const afterFixture = () => {
  const input = fixture();
  input.before = {
    gate: {
      ...assessPostCleanupAuditDraft(input),
      accepted: true,
      status: 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS'
    }
  };
  input.stage = 'after';
  return input;
};
test('after stage requires the same independently accepted before evidence', () => {
  assert.equal(assessPostCleanupAuditDraft(afterFixture()).violationCount, 5);
});
for (const [name, mutate] of [
  [
    'no receipt',
    (x) => {
      delete x.before;
    }
  ],
  [
    'draft only',
    (x) => {
      x.before.gate.accepted = false;
    }
  ],
  [
    'other policy',
    (x) => {
      x.before.gate.policyId = 'other';
    }
  ],
  [
    'after receipt',
    (x) => {
      x.before.gate.stage = 'after';
    }
  ],
  [
    'wrong status',
    (x) => {
      x.before.gate.status = 'unknown';
    }
  ],
  [
    'incomplete count',
    (x) => {
      x.before.gate.executedCheckCount = 48;
    }
  ],
  [
    'unavailable rule',
    (x) => {
      x.before.gate.unavailableCheckCount = 1;
    }
  ],
  [
    'hidden findings',
    (x) => {
      x.before.gate.violationCount = 0;
    }
  ],
  [
    'changed anchor',
    (x) => {
      x.before.gate.sourceAnchorSha256 = 'b'.repeat(64);
    }
  ],
  [
    'changed sources',
    (x) => {
      x.before.gate.sources.cashLines.sha256 = 'b'.repeat(64);
    }
  ],
  [
    'changed metadata',
    (x) => {
      x.before.gate.metadataSha256 = 'b'.repeat(64);
    }
  ],
  [
    'changed cleanup receipt',
    (x) => {
      x.before.gate.cleanupReceiptSha256 = 'b'.repeat(64);
    }
  ]
])
  test('post-cleanup after stage rejects ' + name, () => {
    const input = afterFixture();
    mutate(input);
    assert.throws(() => assessPostCleanupAuditDraft(input));
  });

// Pure synthetic fixtures exercise the exact sealed algorithm. Only its two immutable
// production SHA pins are replaced in an in-memory module; no source policy is activated.
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureReceipt = () => ({
  ok: true,
  status: 'POST_OPEN_READONLY_RUNTIME_AND_TWO_ORDER_SCOPE_VERIFIED',
  databaseName: HISTORY_POST_CLEANUP_DATABASE,
  release: { commit: HISTORY_POST_CLEANUP_BASELINE },
  normalWritesOpened: true,
  databaseMutationCommands: 0,
  credentialsExported: false,
  usage: 'PURE_SYNTHETIC_TEST_NOT_HUMAN_APPROVAL'
});
const syntheticSealedFixture = async (receipt = fixtureReceipt()) => {
  const input = fixture();
  const cleanupReceiptBytes = Buffer.from(JSON.stringify(receipt));
  const receiptSha = sha256Bytes(cleanupReceiptBytes);
  input.policy.cleanupReceiptSha256 = receiptSha;
  input.cleanupReceiptSha256 = receiptSha;
  input.policy.sourceAnchorSha256 = postCleanupSourceAnchor(input.policy);
  const productionSource = readFileSync(
    new URL('./lib/v2-release-history-policy.mjs', import.meta.url),
    'utf8'
  );
  assert.equal(productionSource.split(HISTORY_POST_CLEANUP_RECEIPT_SHA256).length, 2);
  assert.equal(productionSource.split(HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256).length, 2);
  const isolatedSource = productionSource
    .replace(HISTORY_POST_CLEANUP_RECEIPT_SHA256, receiptSha)
    .replace(HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256, input.policy.sourceAnchorSha256);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(isolatedSource).toString('base64')
  );
  const candidateCommit = 'c'.repeat(40);
  const candidateTree = 'd'.repeat(40);
  const seal = {
    version: 1,
    policyId: input.policy.id,
    userApproved: true,
    approvalReference: 'synthetic-fixture:never-production-approval',
    expectedCurrent: input.expectedCurrent,
    activeDatabase: HISTORY_POST_CLEANUP_DATABASE,
    sourceAnchorSha256: input.policy.sourceAnchorSha256,
    policySha256: fingerprint(input.policy),
    candidateBindingsSha256: fingerprint(input.policy.candidateBindings),
    candidateCommit,
    candidateTree,
    apiImage: 'sha256:' + 'e'.repeat(64)
  };
  const proof = { seal, cleanupReceiptBytes, candidateCommit, candidateTree };
  const reseal = () => {
    proof.sealBytes = Buffer.from(JSON.stringify(proof.seal));
    proof.sealSha256 = sha256Bytes(proof.sealBytes);
  };
  reseal();
  const accept = () => module.acceptSealedPostCleanupAudit(input, proof);
  const after = () => {
    input.before = { gate: accept() };
    input.stage = 'after';
  };
  return { input, proof, accept, reseal, after };
};

test('synthetic external reviewed seal accepts real before and after algorithm while findings remain five', async () => {
  const run = await syntheticSealedFixture();
  const before = run.accept();
  assert.equal(before.accepted, true);
  assert.equal(before.status, 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS');
  assert.equal(before.violationCount, 5);
  assert.equal(before.executedCheckCount, 49);
  assert.equal(before.apiImage, run.proof.seal.apiImage);
  run.after();
  const after = run.accept();
  assert.equal(after.accepted, true);
  assert.equal(after.violationCount, 5);
  assert.equal(after.releaseSealSha256, before.releaseSealSha256);
  // The unchanged production module rejects the same synthetic seal and pins.
  assert.throws(() => acceptSealedPostCleanupAudit(run.input, run.proof));
});

for (const [name, mutate] of [
  [
    'no approval',
    (s) => {
      s.userApproved = false;
    }
  ],
  [
    'no approval reference',
    (s) => {
      delete s.approvalReference;
    }
  ],
  [
    'old policy',
    (s) => {
      s.policyId = 'historical-finance-20261005';
    }
  ],
  [
    'old baseline',
    (s) => {
      s.expectedCurrent = 'f'.repeat(40);
    }
  ],
  [
    'old database',
    (s) => {
      s.activeDatabase = 'old';
    }
  ],
  [
    'wrong policy hash',
    (s) => {
      s.policySha256 = 'f'.repeat(64);
    }
  ],
  [
    'wrong candidate source hash',
    (s) => {
      s.candidateBindingsSha256 = 'f'.repeat(64);
    }
  ],
  [
    'wrong independent source anchor',
    (s) => {
      s.sourceAnchorSha256 = 'f'.repeat(64);
    }
  ],
  [
    'wrong candidate commit',
    (s) => {
      s.candidateCommit = 'f'.repeat(40);
    }
  ],
  [
    'wrong candidate tree',
    (s) => {
      s.candidateTree = 'f'.repeat(40);
    }
  ],
  [
    'missing exact image',
    (s) => {
      delete s.apiImage;
    }
  ],
  [
    'mutable image tag',
    (s) => {
      s.apiImage = 'registry:latest';
    }
  ],
  [
    'unknown seal version',
    (s) => {
      s.version = 2;
    }
  ]
])
  test(`synthetic sealed algorithm rejects resealed ${name}`, async () => {
    const run = await syntheticSealedFixture();
    mutate(run.proof.seal);
    run.reseal();
    assert.throws(run.accept);
  });

for (const [name, mutate] of [
  [
    'seal byte SHA mismatch',
    (r) => {
      r.proof.sealSha256 = 'f'.repeat(64);
    }
  ],
  [
    'seal object and bytes differ',
    (r) => {
      r.proof.seal.userApproved = false;
    }
  ],
  [
    'receipt byte drift',
    (r) => {
      r.proof.cleanupReceiptBytes = Buffer.from('{}');
    }
  ],
  [
    'candidate CLI commit drift',
    (r) => {
      r.proof.candidateCommit = 'f'.repeat(40);
    }
  ],
  [
    'candidate CLI tree drift',
    (r) => {
      r.proof.candidateTree = 'f'.repeat(40);
    }
  ],
  [
    'source hash drift',
    (r) => {
      r.input.sources.journals.sha256 = 'f'.repeat(64);
    }
  ],
  [
    'cash chain row drift',
    (r) => {
      r.input.sources.cashLines.rowCount += 2;
    }
  ],
  [
    'cash chain hash drift',
    (r) => {
      r.input.sources.cashJournals.sha256 = 'f'.repeat(64);
    }
  ],
  [
    'new anomaly',
    (r) => {
      r.input.checks[0].count = 1;
    }
  ],
  [
    'false zero',
    (r) => {
      r.input.checks.find((x) => x.code === 'cash_historical_cost_evidence_mismatch').count = 0;
    }
  ]
])
  test(`synthetic sealed algorithm rejects ${name}`, async () => {
    const run = await syntheticSealedFixture();
    mutate(run);
    assert.throws(run.accept);
  });

for (const [name, mutate] of [
  [
    'cleanup failed',
    (r) => {
      r.ok = false;
    }
  ],
  [
    'cleanup status unknown',
    (r) => {
      r.status = 'unknown';
    }
  ],
  [
    'cleanup wrong database',
    (r) => {
      r.databaseName = 'old';
    }
  ],
  [
    'cleanup wrong release',
    (r) => {
      r.release.commit = 'f'.repeat(40);
    }
  ],
  [
    'normal writes closed',
    (r) => {
      r.normalWritesOpened = false;
    }
  ],
  [
    'capture wrote database',
    (r) => {
      r.databaseMutationCommands = 1;
    }
  ],
  [
    'capture exported credentials',
    (r) => {
      r.credentialsExported = true;
    }
  ]
])
  test(`synthetic independently pinned bad receipt rejects ${name}`, async () => {
    const receipt = fixtureReceipt();
    mutate(receipt);
    const run = await syntheticSealedFixture(receipt);
    assert.throws(run.accept);
  });

for (const [name, mutate] of [
  [
    'approved before seal',
    (g) => {
      g.releaseSealSha256 = 'f'.repeat(64);
    }
  ],
  [
    'approved before commit',
    (g) => {
      g.candidateCommit = 'f'.repeat(40);
    }
  ],
  [
    'approved before tree',
    (g) => {
      g.candidateTree = 'f'.repeat(40);
    }
  ],
  [
    'approved before image',
    (g) => {
      g.apiImage = 'sha256:' + 'f'.repeat(64);
    }
  ],
  [
    'approved before cash chain',
    (g) => {
      g.sources.cashLines.rowCount += 2;
    }
  ]
])
  test(`synthetic sealed after rejects changed ${name}`, async () => {
    const run = await syntheticSealedFixture();
    run.after();
    run.input.before = structuredClone(run.input.before);
    mutate(run.input.before.gate);
    assert.throws(run.accept);
  });
