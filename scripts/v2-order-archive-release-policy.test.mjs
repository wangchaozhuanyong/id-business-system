import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { V2_DATA_INTEGRITY_CHECKS, assessV2DataIntegrity } from './lib/v2-data-integrity-audit.mjs';
import {
  fingerprint,
  fingerprintRows,
  postCleanupSourceAnchor,
  postCleanupSourceQueries,
  HISTORY_POST_CLEANUP_POLICY_ID,
  HISTORY_POST_CLEANUP_BASELINE,
  HISTORY_POST_CLEANUP_DATABASE,
  HISTORY_POST_CLEANUP_RECEIPT_SHA256,
  HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256,
  POST_CLEANUP_COST_ENTITY_IDS,
  POST_CLEANUP_CAPTURE_EVIDENCE
} from './lib/v2-release-history-policy.mjs';
import {
  createOrderArchivePolicyDraft,
  computeOrderArchiveSourceTree,
  verifyOrderArchiveSourceBindings,
  verifyOrderArchiveSchemaChange,
  validateOrderArchivePolicyDraft,
  ORDER_ARCHIVE_POLICY_ID,
  ORDER_ARCHIVE_POLICY_FILE,
  ORDER_ARCHIVE_SCOPE,
  ORDER_ARCHIVE_BASELINE,
  ORDER_ARCHIVE_MIGRATION_NAME,
  ORDER_ARCHIVE_MIGRATION_FILE,
  ORDER_ARCHIVE_MIGRATION_SQL_SHA256,
  ORDER_ARCHIVE_REQUIRED_SOURCE_FILES,
  ORDER_ARCHIVE_REQUIRED_COMPILED_FILES
} from './lib/v2-order-archive-release-policy.mjs';
import { parseOrderArchiveAuditArgs } from './v2-order-archive-release-audit.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineSchema = Buffer.from('model IdBusinessV2Order {\n  id String @id\n}\n');
const candidateSchema = Buffer.from(
  'model IdBusinessV2Order {\n  id String @id\n' +
    '  archivedAt DateTime? @map("archived_at") @db.DateTime(6)\n' +
    '  @@index([deletedAt, archivedAt, createdAt, id], map: "id_business_v2_orders_archive_list_idx")\n}\n'
);

// Every candidate commit/image/preparation here is explicitly synthetic unit data.
// Only two immutable financial pins are substituted in an in-memory module.
// The real module rejects these fixtures, and no policy/receipt is activated.
async function syntheticFixture() {
  const receipt = {
    ok: true,
    status: 'POST_OPEN_READONLY_RUNTIME_AND_TWO_ORDER_SCOPE_VERIFIED',
    databaseName: HISTORY_POST_CLEANUP_DATABASE,
    release: { commit: HISTORY_POST_CLEANUP_BASELINE },
    normalWritesOpened: true,
    databaseMutationCommands: 0,
    credentialsExported: false,
    usage: 'PURE_SYNTHETIC_TEST_NOT_HUMAN_APPROVAL'
  };
  const cleanupReceiptBytes = Buffer.from(JSON.stringify(receipt));
  const metadata = POST_CLEANUP_COST_ENTITY_IDS.map((entity) => ({
    id: entity.split(':')[0],
    metadataSha256: 'a'.repeat(64)
  }));
  const financial = {
    version: 1,
    id: HISTORY_POST_CLEANUP_POLICY_ID,
    userApproved: false,
    activation: 'EXTERNAL_REVIEWED_SEAL_REQUIRED',
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
    sources: Object.fromEntries(
      Object.entries(postCleanupSourceQueries).map(([name, query]) => [
        name,
        {
          ids: [...query.ids],
          rowCount: ['lines', 'cashLines', 'cashJournals'].includes(name)
            ? 10
            : name === 'accounts'
              ? 2
              : 5,
          sha256: 'a'.repeat(64)
        }
      ])
    ),
    metadataSha256: fingerprintRows(metadata),
    captureEvidence: POST_CLEANUP_CAPTURE_EVIDENCE,
    cleanupReceiptSha256: sha(cleanupReceiptBytes)
  };
  financial.sourceAnchorSha256 = postCleanupSourceAnchor(financial);
  const entries = [...new Set(ORDER_ARCHIVE_REQUIRED_SOURCE_FILES)].map((path) => ({
    path,
    mode: '100644',
    bytes:
      path === ORDER_ARCHIVE_MIGRATION_FILE
        ? readFileSync(new URL('../' + path, import.meta.url))
        : path === 'apps/api/prisma-mysql/schema.prisma'
          ? candidateSchema
          : Buffer.from('synthetic source ' + path)
  }));
  const bindings = {
    sourceTree: computeOrderArchiveSourceTree(entries),
    sourceSha256: Object.fromEntries(entries.map((entry) => [entry.path, sha(entry.bytes)])),
    sourceGitModes: Object.fromEntries(entries.map((entry) => [entry.path, entry.mode])),
    compiledServiceHashes: Object.fromEntries(
      ORDER_ARCHIVE_REQUIRED_COMPILED_FILES.map((path) => [path, 'a'.repeat(64)])
    ),
    adminBuildHashes: {
      'apps/admin/dist/index.html': 'a'.repeat(64),
      'apps/admin/dist/assets/archive.js': 'b'.repeat(64),
      'apps/admin/dist/assets/archive.css': 'c'.repeat(64)
    },
    migration: {
      name: ORDER_ARCHIVE_MIGRATION_NAME,
      sqlSha256: ORDER_ARCHIVE_MIGRATION_SQL_SHA256,
      mysqlSchemaSha256: sha(candidateSchema),
      baselineMysqlSchemaSha256: sha(baselineSchema)
    }
  };
  const policy = createOrderArchivePolicyDraft(financial, bindings);
  const input = {
    policy,
    definitions: V2_DATA_INTEGRITY_CHECKS,
    expectedCurrent: ORDER_ARCHIVE_BASELINE,
    stage: 'before',
    metadata,
    sources: Object.fromEntries(
      Object.entries(policy.sources).map(([name, source]) => [
        name,
        { rowCount: source.rowCount, sha256: source.sha256 }
      ])
    ),
    identity: {
      currentUser: 'id_business_audit@%',
      transactionIsolation: 'REPEATABLE-READ',
      foreignKeyChecks: 1n,
      databaseName: HISTORY_POST_CLEANUP_DATABASE,
      readOnly: 0n,
      superReadOnly: 0n,
      sessionReadOnly: 1n
    },
    scope: { targetOrdersCount: 0n, protectedThirdOrderCount: 1n },
    cleanupReceiptSha256: sha(cleanupReceiptBytes),
    checks: V2_DATA_INTEGRITY_CHECKS.map((def) => ({
      code: def.code,
      status: 'EXECUTED',
      count: def.code === 'cash_historical_cost_evidence_mismatch' ? 5 : 0,
      samples:
        def.code === 'cash_historical_cost_evidence_mismatch'
          ? POST_CLEANUP_COST_ENTITY_IDS.map((entityId) => ({ entityId }))
          : []
    }))
  };
  const legacySource = readFileSync(
    new URL('./lib/v2-release-history-policy.mjs', import.meta.url),
    'utf8'
  )
    .replace(HISTORY_POST_CLEANUP_RECEIPT_SHA256, sha(cleanupReceiptBytes))
    .replace(HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256, financial.sourceAnchorSha256);
  const legacyUrl = 'data:text/javascript;base64,' + Buffer.from(legacySource).toString('base64');
  const source = readFileSync(
    new URL('./lib/v2-order-archive-release-policy.mjs', import.meta.url),
    'utf8'
  ).replace('./v2-release-history-policy.mjs', legacyUrl);
  const isolated = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const seal = {
    version: 1,
    policyId: ORDER_ARCHIVE_POLICY_ID,
    scope: ORDER_ARCHIVE_SCOPE,
    userApproved: true,
    approvalReference: 'synthetic-unit-fixture:never-production-approval',
    expectedCurrent: ORDER_ARCHIVE_BASELINE,
    historicalSourceBaseline: HISTORY_POST_CLEANUP_BASELINE,
    activeDatabase: HISTORY_POST_CLEANUP_DATABASE,
    sourceAnchorSha256: policy.sourceAnchorSha256,
    cleanupReceiptSha256: sha(cleanupReceiptBytes),
    policySha256: fingerprint(policy),
    candidateBindingsSha256: fingerprint(bindings),
    sourceTree: bindings.sourceTree,
    candidateCommit: 'c'.repeat(40),
    candidateTree: 'd'.repeat(40),
    images: {
      api: 'sha256:' + 'a'.repeat(64),
      admin: 'sha256:' + 'b'.repeat(64),
      migrate: 'sha256:' + 'c'.repeat(64)
    },
    migration: structuredClone(bindings.migration),
    preparedImagesSha256: 'e'.repeat(64),
    preparationRunId: 123,
    preparationRunAttempt: 1
  };
  const proof = {
    seal,
    cleanupReceiptBytes,
    candidateCommit: seal.candidateCommit,
    candidateTree: seal.candidateTree
  };
  const reseal = () => {
    proof.sealBytes = Buffer.from(JSON.stringify(seal));
    proof.sealSha256 = sha(proof.sealBytes);
  };
  reseal();
  const accept = () => isolated.acceptSealedOrderArchiveAudit(input, proof);
  return { input, proof, isolated, entries, accept, reseal };
}

test('independent before/after keeps all49 and original5 visible, and real module rejects synthetic approval', async () => {
  const f = await syntheticFixture();
  const draft = f.isolated.assessOrderArchiveAuditDraft(f.input);
  assert.equal(draft.accepted, false);
  assert.equal(draft.expectedCurrent, ORDER_ARCHIVE_BASELINE);
  assert.equal(draft.historicalSourceBaseline, HISTORY_POST_CLEANUP_BASELINE);
  assert.equal(assessV2DataIntegrity(f.input.checks).ok, false);
  const before = f.accept();
  assert.equal(before.accepted, true);
  assert.equal(before.executedCheckCount, 49);
  assert.equal(before.violationCount, 5);
  assert.equal(before.scope, ORDER_ARCHIVE_SCOPE);
  f.input.stage = 'after';
  f.input.before = { gate: before };
  assert.equal(f.accept().accepted, true);
  assert.throws(() =>
    validateOrderArchivePolicyDraft(f.input.policy, f.input.definitions, f.input.expectedCurrent)
  );
});

test('order archive refuses the previous b8 runtime after the verified mailbox release', async () => {
  const f = await syntheticFixture();
  const previousCurrent = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0';
  assert.equal(f.accept().accepted, true);
  assert.throws(
    () => f.isolated.assessOrderArchiveAuditDraft({ ...f.input, expectedCurrent: previousCurrent }),
    /Independent unapproved order archive policy required/
  );
  f.input.policy.expectedCurrent = previousCurrent;
  assert.throws(
    () => f.isolated.assessOrderArchiveAuditDraft(f.input),
    /Independent unapproved order archive policy required/
  );
});

for (const [name, mutate] of [
  [
    'old approval',
    (f) => {
      f.proof.seal.policyId = HISTORY_POST_CLEANUP_POLICY_ID;
    }
  ],
  [
    'not approved',
    (f) => {
      f.proof.seal.userApproved = false;
    }
  ],
  [
    'approval reference missing',
    (f) => {
      delete f.proof.seal.approvalReference;
    }
  ],
  [
    'old current baseline',
    (f) => {
      f.proof.seal.expectedCurrent = HISTORY_POST_CLEANUP_BASELINE;
    }
  ],
  [
    'history rewritten to new baseline',
    (f) => {
      f.proof.seal.historicalSourceBaseline = ORDER_ARCHIVE_BASELINE;
    }
  ],
  [
    'candidate mismatch',
    (f) => {
      f.proof.seal.candidateCommit = 'f'.repeat(40);
    }
  ],
  [
    'source tree mismatch',
    (f) => {
      f.proof.seal.sourceTree = 'f'.repeat(40);
    }
  ],
  [
    'full tree used as projection',
    (f) => {
      f.proof.seal.candidateTree = f.proof.seal.sourceTree;
      f.proof.candidateTree = f.proof.seal.sourceTree;
    }
  ],
  [
    'images missing',
    (f) => {
      delete f.proof.seal.images.admin;
    }
  ],
  [
    'extra worker image',
    (f) => {
      f.proof.seal.images.worker = 'sha256:' + 'a'.repeat(64);
    }
  ],
  [
    'invalid image',
    (f) => {
      f.proof.seal.images.api = 'latest';
    }
  ],
  [
    'preparation missing',
    (f) => {
      delete f.proof.seal.preparedImagesSha256;
    }
  ],
  [
    'invalid preparation run',
    (f) => {
      f.proof.seal.preparationRunId = 0;
    }
  ],
  [
    'migration changed',
    (f) => {
      f.proof.seal.migration.sqlSha256 = 'f'.repeat(64);
    }
  ],
  [
    'cleanup changed',
    (f) => {
      f.proof.cleanupReceiptBytes = Buffer.from('{}');
    }
  ],
  [
    'new finding',
    (f) => {
      f.input.checks[0].count = 1;
      f.input.checks[0].samples = [{ entityId: 'extra' }];
    }
  ],
  [
    'cost findings hidden',
    (f) => {
      const row = f.input.checks.find((x) => x.count);
      row.count = 0;
      row.samples = [];
    }
  ],
  [
    'rule unavailable',
    (f) => {
      f.input.checks[0].status = 'SCHEMA_NOT_DEPLOYED';
    }
  ],
  [
    'cash chain changed',
    (f) => {
      f.input.sources.cashLines.sha256 = 'f'.repeat(64);
    }
  ],
  [
    'metadata changed',
    (f) => {
      f.input.metadata[0].metadataSha256 = 'f'.repeat(64);
    }
  ],
  [
    'wrong database',
    (f) => {
      f.input.identity.databaseName = 'other';
    }
  ],
  [
    'not read only',
    (f) => {
      f.input.identity.sessionReadOnly = 0n;
    }
  ],
  [
    'cleaned order reappeared',
    (f) => {
      f.input.scope.targetOrdersCount = 1n;
    }
  ],
  [
    'protected source lost',
    (f) => {
      f.input.scope.protectedThirdOrderCount = 0n;
    }
  ],
  [
    'sealed bytes changed',
    (f) => {
      f.proof.sealSha256 = 'f'.repeat(64);
    }
  ]
])
  test('sealed archive rejects ' + name, async () => {
    const f = await syntheticFixture();
    mutate(f);
    if (name !== 'sealed bytes changed') f.reseal();
    assert.throws(f.accept);
  });

for (const [name, mutate] of [
  [
    'approved warehouse policy',
    (p) => {
      p.userApproved = true;
    }
  ],
  [
    'source self reference',
    (p) => {
      p.candidateBindings.sourceSha256[ORDER_ARCHIVE_POLICY_FILE] = 'a'.repeat(64);
    }
  ],
  [
    'unbound executable mode',
    (p) => {
      delete p.candidateBindings.sourceGitModes[ORDER_ARCHIVE_MIGRATION_FILE];
    }
  ],
  [
    'symlink mode',
    (p) => {
      p.candidateBindings.sourceGitModes[ORDER_ARCHIVE_MIGRATION_FILE] = '120000';
    }
  ],
  [
    'migration widened',
    (p) => {
      p.candidateBindings.migration.name = 'another';
    }
  ],
  [
    'schema unbound',
    (p) => {
      p.candidateBindings.migration.mysqlSchemaSha256 = 'a'.repeat(64);
    }
  ],
  [
    'compiled archive guard omitted',
    (p) => {
      delete p.candidateBindings.compiledServiceHashes[
        ORDER_ARCHIVE_REQUIRED_COMPILED_FILES.at(-1)
      ];
    }
  ],
  [
    'admin entry omitted',
    (p) => {
      delete p.candidateBindings.adminBuildHashes['apps/admin/dist/index.html'];
    }
  ]
])
  test('draft rejects ' + name, async () => {
    const f = await syntheticFixture();
    mutate(f.input.policy);
    assert.throws(() =>
      f.isolated.validateOrderArchivePolicyDraft(
        f.input.policy,
        f.input.definitions,
        f.input.expectedCurrent
      )
    );
  });

for (const key of [
  'images',
  'migration',
  'preparedImagesSha256',
  'preparationRunId',
  'candidateTree',
  'sourceTree'
]) {
  test('after rejects changed independent before ' + key, async () => {
    const f = await syntheticFixture();
    f.input.before = { gate: f.accept() };
    f.input.stage = 'after';
    f.input.before.gate[key] = 'invalid-before';
    assert.throws(f.accept);
  });
}

test('actual source projection preserves exact bytes and modes without a self binding cycle', async () => {
  const f = await syntheticFixture();
  assert.equal(
    verifyOrderArchiveSourceBindings(f.input.policy, f.entries).sourceTree,
    f.input.policy.candidateBindings.sourceTree
  );
  assert.throws(() => verifyOrderArchiveSourceBindings(f.input.policy, f.entries.slice(1)));
  const changed = f.entries.map((entry) => ({ ...entry }));
  changed[0].mode = '100755';
  assert.throws(() => verifyOrderArchiveSourceBindings(f.input.policy, changed));
  changed[0].mode = '100644';
  changed[0].bytes = Buffer.from('altered');
  assert.throws(() => verifyOrderArchiveSourceBindings(f.input.policy, changed));
});

function readHeadSourceEntries() {
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'])
    .toString()
    .split('\0')
    .filter(Boolean);
  const records = listing.map((line) => {
    const [info, path] = line.split('\t');
    const [mode, type, oid] = info.split(' ');
    assert.equal(type, 'blob');
    assert.ok(['100644', '100755'].includes(mode));
    return { path, mode, oid };
  });
  const contents = execFileSync('git', ['cat-file', '--batch'], {
    input: records.map((record) => record.oid).join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024
  });
  let offset = 0;
  const entries = records.map((record) => {
    const end = contents.indexOf(10, offset);
    assert.ok(end >= offset);
    const [oid, type, length] = contents.subarray(offset, end).toString().split(' ');
    assert.equal(oid, record.oid);
    assert.equal(type, 'blob');
    assert.match(length, /^(0|[1-9][0-9]*)$/);
    const bytes = contents.subarray(end + 1, end + 1 + Number(length));
    assert.equal(bytes.length, Number(length));
    assert.equal(contents[end + 1 + Number(length)], 10);
    offset = end + 2 + Number(length);
    return { ...record, bytes };
  });
  assert.equal(offset, contents.length);
  return entries;
}

test('Git projection equals complete actual HEAD subtrees without the policy using read-only Git objects', () => {
  const entries = readHeadSourceEntries();
  // Git's real subtree OIDs independently check serialization, ordering and modes.
  // No tree implementation is duplicated and no Git index or object is written.
  for (const subtree of ['apps', 'scripts', 'deploy/caddy', 'deploy/nginx', 'deploy/systemd']) {
    const prefix = subtree + '/';
    const subtreeEntries = entries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    assert.ok(subtreeEntries.length > 0, subtree);
    assert.ok(
      !entries.some(
        (entry) => entry.path === ORDER_ARCHIVE_POLICY_FILE && entry.path.startsWith(prefix)
      )
    );
    assert.equal(
      computeOrderArchiveSourceTree(subtreeEntries),
      execFileSync('git', ['rev-parse', 'HEAD:' + subtree])
        .toString()
        .trim(),
      subtree
    );
  }
  assert.ok(entries.some((entry) => entry.path.startsWith('scripts/') && entry.mode === '100755'));
});

test('actual HEAD root projection equals raw Git trees with only its policy leaf removed', () => {
  const entries = readHeadSourceEntries();
  const policyEntries = entries.filter((entry) => entry.path === ORDER_ARCHIVE_POLICY_FILE);
  assert.equal(policyEntries.length, 1);
  const projected = entries.filter((entry) => entry.path !== ORDER_ARCHIVE_POLICY_FILE);
  assert.equal(projected.length, entries.length - 1);
  assert.throws(
    () => computeOrderArchiveSourceTree(entries),
    /Invalid order archive Git projection entry/
  );

  // Independently alter only the existing Git records along deploy/aws/policy.
  // All other raw tree bytes and their original ordering stay untouched; there
  // is no generic tree serializer or frozen historical source-binding assertion.
  const treeOid = (bytes) =>
    createHash('sha1')
      .update(Buffer.from('tree ' + bytes.length + '\0'))
      .update(bytes)
      .digest();
  const readTree = (ref) => {
    const bytes = execFileSync('git', ['cat-file', 'tree', ref]);
    assert.equal(
      treeOid(bytes).toString('hex'),
      execFileSync('git', ['rev-parse', ref]).toString().trim()
    );
    return bytes;
  };
  const entryRange = (bytes, target) => {
    let offset = 0;
    const matches = [];
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset);
      const nul = bytes.indexOf(0, space + 1);
      assert.ok(space > offset && nul > space);
      const end = nul + 21;
      assert.ok(end <= bytes.length);
      if (bytes.subarray(space + 1, nul).toString() === target) {
        matches.push({
          start: offset,
          oidStart: nul + 1,
          end,
          mode: bytes.subarray(offset, space).toString()
        });
      }
      offset = end;
    }
    assert.equal(offset, bytes.length);
    assert.equal(matches.length, 1, target);
    return matches[0];
  };
  const [deployName, awsName, policyName] = ORDER_ARCHIVE_POLICY_FILE.split('/');
  assert.deepEqual([deployName, awsName], ['deploy', 'aws']);
  const root = readTree('HEAD^{tree}');
  const deploy = readTree('HEAD:deploy');
  const aws = readTree('HEAD:deploy/aws');
  const rootDeploy = entryRange(root, deployName);
  const deployAws = entryRange(deploy, awsName);
  const policy = entryRange(aws, policyName);
  assert.equal(rootDeploy.mode, '40000');
  assert.equal(deployAws.mode, '40000');
  assert.equal(policy.mode, policyEntries[0].mode);
  assert.equal(
    root.subarray(rootDeploy.oidStart, rootDeploy.end).toString('hex'),
    treeOid(deploy).toString('hex')
  );
  assert.equal(
    deploy.subarray(deployAws.oidStart, deployAws.end).toString('hex'),
    treeOid(aws).toString('hex')
  );
  assert.equal(aws.subarray(policy.oidStart, policy.end).toString('hex'), policyEntries[0].oid);
  const projectedAws = Buffer.concat([aws.subarray(0, policy.start), aws.subarray(policy.end)]);
  const projectedDeploy = Buffer.concat([
    deploy.subarray(0, deployAws.oidStart),
    treeOid(projectedAws),
    deploy.subarray(deployAws.end)
  ]);
  const projectedRoot = Buffer.concat([
    root.subarray(0, rootDeploy.oidStart),
    treeOid(projectedDeploy),
    root.subarray(rootDeploy.end)
  ]);
  assert.equal(computeOrderArchiveSourceTree(projected), treeOid(projectedRoot).toString('hex'));
});

test('schema guard accepts exactly nullable archive field/index and rejects an additional structural change', async () => {
  const f = await syntheticFixture();
  const migration = f.input.policy.candidateBindings.migration;
  assert.equal(
    verifyOrderArchiveSchemaChange(baselineSchema, candidateSchema, migration).mysqlSchemaSha256,
    sha(candidateSchema)
  );
  const changed = Buffer.from(candidateSchema.toString().replace('id String', 'id Int'));
  assert.throws(() =>
    verifyOrderArchiveSchemaChange(baselineSchema, changed, {
      ...migration,
      mysqlSchemaSha256: sha(changed)
    })
  );
});

test('CLI confirmation rejects duplicates/unknown fields before any database connection', () => {
  const args = [
    '--policy=fixture.json',
    '--stage=before',
    '--expected-current=' + ORDER_ARCHIVE_BASELINE,
    '--order-archive-seal=unapproved.json',
    '--order-archive-seal-sha256=' + 'a'.repeat(64),
    '--cleanup-receipt=fixture.json',
    '--candidate-commit=' + 'a'.repeat(40),
    '--candidate-tree=' + 'b'.repeat(40)
  ];
  assert.equal(parseOrderArchiveAuditArgs(args).stage, 'before');
  assert.throws(() => parseOrderArchiveAuditArgs([...args, '--policy=second.json']));
  assert.throws(() => parseOrderArchiveAuditArgs([...args, '--allow-extra=true']));
  const result = spawnSync(
    process.execPath,
    ['scripts/v2-order-archive-release-audit.mjs', '--unknown=PRIVATE_TOKEN'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        V2_DATA_INTEGRITY_DATABASE_URL: 'mysql://unused-fixture@127.0.0.1:1/not-contacted'
      }
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /accepted":false/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TOKEN|mysql:\/\//);
});

test('successful stdout contains only sample identity/hash and its receipt still validates after', async () => {
  const f = await syntheticFixture();
  const marker = 'PRIVATE_FINANCIAL_MARKER_13579';
  const cost = f.input.checks.find((row) => row.count);
  cost.samples = cost.samples.map((sample) => ({
    ...sample,
    detail: {
      openingBalance: marker,
      historicalCost: marker,
      paymentProof: marker
    }
  }));
  const gate = f.accept();
  const stdout = f.isolated.serializeOrderArchiveAuditReport({
    ...assessV2DataIntegrity(f.input.checks),
    checks: f.input.checks,
    identity: f.input.identity,
    gate
  });
  assert.doesNotMatch(stdout, new RegExp(marker + '|openingBalance|historicalCost|paymentProof'));
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.violationCount, 5);
  assert.deepEqual(Object.keys(receipt.checks.find((row) => row.count).samples[0]).sort(), [
    'detailSha256',
    'entityId'
  ]);
  f.input.before = receipt;
  f.input.stage = 'after';
  assert.equal(f.accept().accepted, true);
});
