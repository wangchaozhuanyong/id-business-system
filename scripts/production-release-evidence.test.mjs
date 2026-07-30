import assert from 'node:assert/strict';
// The receipt fixture intentionally contains no credentials or production identifiers.
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  createDatabaseIdentitySha256,
  createGitHubApprovalReceiptSha256,
  createGitHubApproverIdentitySha256,
  createReleaseEvidenceIntegrity,
  RELEASE_EVIDENCE_ARTIFACT_FILES,
  validateGitHubBusinessOwnerApproval,
  validateProductionReleaseEvidence,
  validateProductionReleaseEvidenceArtifacts,
  validateProductionReleaseTrust
} from './lib/production-release-evidence.mjs';

const now = new Date('2026-07-30T10:00:00.000Z');
const repository = 'wangchaozhuanyong/id-business-system';
const branch = 'main';
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const migrationWatermark = '20260729110000_finance_closed_loop';
const supabaseProjectRef = 'abcdefghijklmnopqrst';
const isolatedProjectRef = 'zyxwvutsrqponmlkjihg';
const databaseUrl = `postgresql://postgres.${supabaseProjectRef}:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres`;
const databaseIdentitySha256 = createDatabaseIdentitySha256(databaseUrl);
const reportHash = 'c'.repeat(64);
const migrationSetSha256 = 'd'.repeat(64);
const prismaSchemaSha256 = 'e'.repeat(64);
const schemaSha256 = 'f'.repeat(64);
const coreDataWatermarkSha256 = '1'.repeat(64);
const fieldEncryptionKey = 'field-encryption-key-material-0001';
const hashSecret = 'hash-secret-key-material-0000000001';
const fieldEncryptionKeySha256 = sha256(fieldEncryptionKey);
const hashSecretSha256 = sha256(hashSecret);
const businessOwnerApprovalProvider = 'github_pull_request_review';
const businessOwnerApprovalReference =
  'https://api.github.com/repos/wangchaozhuanyong/id-business-system/pulls/42/reviews/1001';
const businessOwnerApprovalReceiptSha256 = '2'.repeat(64);
const businessOwnerApprovedAt = '2026-07-30T09:58:00.000Z';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({
  format: 'pem',
  type: 'spki'
});
const keyId = 'production-release-v1';
const trust = {
  schemaVersion: 1,
  keys: [
    {
      keyId,
      algorithm: 'ed25519',
      status: 'active',
      publicKey: publicKeyPem
    }
  ]
};

function createEvidence() {
  const evidence = {
    schemaVersion: 1,
    receiptId: '10000000-0000-4000-8000-000000000000',
    environment: 'production',
    issuedAt: '2026-07-30T09:59:00.000Z',
    expiresAt: '2026-07-30T11:59:00.000Z',
    release: {
      repository,
      branch,
      commit,
      tree
    },
    target: {
      supabaseProjectRef,
      databaseIdentitySha256,
      migrationWatermark,
      migrationSetSha256,
      prismaSchemaSha256,
      fieldEncryptionKeySha256,
      hashSecretSha256
    },
    backup: {
      provider: 'supabase',
      reference: 'backup-20260730-094000',
      kind: 'snapshot',
      sourceProjectRef: supabaseProjectRef,
      status: 'available',
      createdAt: '2026-07-30T09:40:00.000Z',
      restorePoint: '2026-07-30T09:39:30.000Z',
      migrationWatermark,
      schemaSha256,
      coreDataWatermarkSha256,
      providerEvidenceSha256: reportHash
    },
    restoreDrill: {
      reference: 'restore-drill-20260730-094500',
      sourceBackupReference: 'backup-20260730-094000',
      targetProjectRef: isolatedProjectRef,
      status: 'passed',
      completedAt: '2026-07-30T09:50:00.000Z',
      sourceMigrationWatermark: migrationWatermark,
      restoredMigrationWatermark: migrationWatermark,
      sourceSchemaSha256: schemaSha256,
      restoredSchemaSha256: schemaSha256,
      sourceCoreDataWatermarkSha256: coreDataWatermarkSha256,
      restoredCoreDataWatermarkSha256: coreDataWatermarkSha256,
      checks: {
        sourceTargetSeparated: true,
        schemaMatched: true,
        migrationsMatched: true,
        constraintsPassed: true,
        financeBalancesPassed: true,
        sensitiveDecryptSamplePassed: true,
        postBackupChangesCompared: true
      },
      checksArtifactSha256: reportHash
    },
    authAudit: {
      projectRef: supabaseProjectRef,
      databaseIdentitySha256,
      generatedAt: '2026-07-30T09:55:00.000Z',
      readOnly: true,
      readyForAutomaticRelease: true,
      detailsTruncated: false,
      blockingIssueCount: 0,
      reportSha256: reportHash
    },
    migrations: {
      checkedAt: '2026-07-30T09:56:00.000Z',
      appliedWatermark: migrationWatermark,
      pending: [],
      failed: [],
      schemaDrift: false,
      forwardOnly: true,
      migrationSetSha256,
      prismaSchemaSha256,
      reportSha256: reportHash
    },
    dataIntegrity: {
      checkedAt: '2026-07-30T09:57:00.000Z',
      reference: 'finance-integrity-20260730',
      businessOwnerApprovalProvider,
      businessOwnerApprovalReference,
      businessOwnerApprovalReceiptSha256,
      businessOwnerApprovedAt,
      businessOwnerApprovalSha256: reportHash,
      reportSha256: reportHash,
      immutableLedgersBalanced: true,
      financeHistoryComplete: true,
      initialBalancesConfirmed: true,
      postBackupChangesCompared: true
    },
    restorePolicy: {
      inPlaceRestoreAllowed: false,
      databaseRollbackOnAppFailure: false
    }
  };
  return {
    ...evidence,
    integrity: createReleaseEvidenceIntegrity(evidence, privateKey, keyId)
  };
}

function createContext() {
  return {
    repository,
    branch,
    commit,
    tree,
    migrationSetSha256,
    migrationWatermark,
    now,
    prismaSchemaSha256,
    trust,
    env: {
      DATABASE_URL: databaseUrl,
      FIELD_ENCRYPTION_KEY: fieldEncryptionKey,
      HASH_SECRET: hashSecret,
      SUPABASE_URL: `https://${supabaseProjectRef}.supabase.co`
    }
  };
}

test('accepts a fresh signed receipt bound to the current release and production target', () => {
  assert.deepEqual(validateProductionReleaseEvidence(createEvidence(), createContext()), []);
});

test('rejects stale, mismatched or incomplete production evidence', () => {
  const evidence = createEvidence();
  evidence.release.commit = 'd'.repeat(40);
  evidence.expiresAt = '2026-07-30T09:59:30.000Z';
  evidence.restoreDrill.sourceBackupReference = 'another-backup';
  evidence.dataIntegrity.financeHistoryComplete = false;

  const errors = validateProductionReleaseEvidence(evidence, createContext());
  assert.ok(errors.some((error) => error.includes('commit')));
  assert.ok(errors.some((error) => error.includes('已过期')));
  assert.ok(errors.some((error) => error.includes('本次生产备份')));
  assert.ok(errors.some((error) => error.includes('financeHistoryComplete')));
  assert.ok(errors.some((error) => error.includes('canonical SHA-256')));
  assert.ok(errors.some((error) => error.includes('签名无效')));
});

test('rejects a receipt signed by an untrusted key', () => {
  const evidence = createEvidence();
  const otherKeyPair = generateKeyPairSync('ed25519');
  evidence.integrity = createReleaseEvidenceIntegrity(evidence, otherKeyPair.privateKey, keyId);

  assert.ok(
    validateProductionReleaseEvidence(evidence, createContext()).some((error) =>
      error.includes('签名无效')
    )
  );
});

test('rejects stale restore points and impossible approval chronology even when re-signed', () => {
  const evidence = createEvidence();
  evidence.backup.restorePoint = '2026-07-30T07:30:00.000Z';
  evidence.dataIntegrity.checkedAt = '2026-07-30T09:49:00.000Z';
  evidence.dataIntegrity.businessOwnerApprovedAt = '2026-07-30T09:48:00.000Z';
  resignEvidence(evidence);

  const errors = validateProductionReleaseEvidence(evidence, createContext());
  assert.ok(errors.some((error) => error.includes('backup.restorePoint')));
  assert.ok(errors.some((error) => error.includes('隔离恢复完成时间')));
  assert.ok(errors.some((error) => error.includes('批准时间不得早于数据完整性检查时间')));
  assert.ok(!errors.some((error) => error.includes('签名无效')));
});

test('rejects unbound business approval receipts and deployment secret drift', () => {
  const evidence = createEvidence();
  evidence.dataIntegrity.businessOwnerApprovalReference = 'local-owner-approval-20260730';
  resignEvidence(evidence);

  const receiptErrors = validateProductionReleaseEvidence(evidence, createContext());
  assert.ok(receiptErrors.some((error) => error.includes('GitHub Pull Request Review')));

  const driftedContext = createContext();
  driftedContext.env.FIELD_ENCRYPTION_KEY = 'different-field-encryption-key-0001';
  driftedContext.env.HASH_SECRET = 'different-hash-secret-key-000001';
  const secretErrors = validateProductionReleaseEvidence(createEvidence(), driftedContext);
  assert.ok(secretErrors.some((error) => error.includes('字段加密密钥摘要')));
  assert.ok(secretErrors.some((error) => error.includes('哈希密钥摘要')));
  assert.ok(
    secretErrors.every(
      (error) =>
        !error.includes(driftedContext.env.FIELD_ENCRYPTION_KEY) &&
        !error.includes(driftedContext.env.HASH_SECRET)
    )
  );
});

test('requires the release signing key to come from the protected trust config', () => {
  assert.ok(
    validateProductionReleaseTrust({ schemaVersion: 1, keys: [] }).some((error) =>
      error.includes('至少包含一个')
    )
  );
  const context = createContext();
  context.trust = { schemaVersion: 1, keys: [] };
  assert.ok(
    validateProductionReleaseEvidence(createEvidence(), context).some((error) =>
      error.includes('信任配置')
    )
  );
});

test('reads every evidence artifact and rejects missing or mismatched content', () => {
  const evidence = createEvidence();
  const base = {
    schemaVersion: 1,
    receiptId: evidence.receiptId,
    releaseCommit: evidence.release.commit,
    productionProjectRef: evidence.target.supabaseProjectRef,
    databaseIdentitySha256: evidence.target.databaseIdentitySha256
  };
  const artifacts = {
    [RELEASE_EVIDENCE_ARTIFACT_FILES.backupProvider]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'backup_provider',
        ...evidence.backup
      })
    ),
    [RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'restore_drill',
        ...evidence.restoreDrill,
        productionProjectRef: evidence.target.supabaseProjectRef
      })
    ),
    [RELEASE_EVIDENCE_ARTIFACT_FILES.authAudit]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'auth_audit',
        ...evidence.authAudit,
        productionProjectRef: evidence.target.supabaseProjectRef
      })
    ),
    [RELEASE_EVIDENCE_ARTIFACT_FILES.migrations]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'migration_status',
        ...evidence.migrations
      })
    ),
    [RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'data_integrity',
        ...evidence.dataIntegrity
      })
    ),
    [RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval]: Buffer.from(
      JSON.stringify({
        ...base,
        artifactType: 'business_owner_approval',
        approvalProvider: evidence.dataIntegrity.businessOwnerApprovalProvider,
        approvalReference: evidence.dataIntegrity.businessOwnerApprovalReference,
        approvalReceiptSha256: evidence.dataIntegrity.businessOwnerApprovalReceiptSha256,
        decision: 'approved',
        approverRole: 'business-owner',
        approverIdentitySha256: '3'.repeat(64),
        approvedAt: evidence.dataIntegrity.businessOwnerApprovedAt,
        inPlaceRestoreAllowed: false,
        databaseRollbackOnAppFailure: false
      })
    )
  };
  evidence.backup.providerEvidenceSha256 = sha256(
    artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.backupProvider]
  );
  evidence.restoreDrill.checksArtifactSha256 = sha256(
    artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill]
  );
  evidence.authAudit.reportSha256 = sha256(artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.authAudit]);
  evidence.migrations.reportSha256 = sha256(artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.migrations]);
  evidence.dataIntegrity.reportSha256 = sha256(
    artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity]
  );
  evidence.dataIntegrity.businessOwnerApprovalSha256 = sha256(
    artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval]
  );

  assert.deepEqual(validateProductionReleaseEvidenceArtifacts(evidence, artifacts), []);
  const missing = { ...artifacts };
  delete missing[RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill];
  assert.ok(
    validateProductionReleaseEvidenceArtifacts(evidence, missing).some((error) =>
      error.includes('restore-drill.json')
    )
  );
  const tampered = {
    ...artifacts,
    [RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity]: Buffer.from('{}')
  };
  assert.ok(
    validateProductionReleaseEvidenceArtifacts(evidence, tampered).some((error) =>
      error.includes('data-integrity.json')
    )
  );

  const approvalFilename = RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval;
  const invalidApproval = JSON.parse(artifacts[approvalFilename].toString('utf8'));
  invalidApproval.approverRole = 'release-engineer';
  invalidApproval.approvalReceiptSha256 = 'not-a-hash';
  const invalidApprovalContent = Buffer.from(JSON.stringify(invalidApproval));
  evidence.dataIntegrity.businessOwnerApprovalSha256 = sha256(invalidApprovalContent);
  assert.ok(
    validateProductionReleaseEvidenceArtifacts(evidence, {
      ...artifacts,
      [approvalFilename]: invalidApprovalContent
    }).some(
      (error) =>
        error.includes('approverRole') || error.includes('approvalReceiptSha256 必须是 SHA-256')
    )
  );
});

test('database identity ignores password rotation but changes with the target identity', () => {
  assert.equal(
    createDatabaseIdentitySha256(databaseUrl),
    createDatabaseIdentitySha256(databaseUrl.replace(':password@', ':rotated-password@'))
  );
  assert.equal(
    createDatabaseIdentitySha256(databaseUrl),
    createDatabaseIdentitySha256(
      `postgresql://postgres:password@db.${supabaseProjectRef}.supabase.co:5432/postgres?schema=public`
    )
  );
  assert.notEqual(
    createDatabaseIdentitySha256(databaseUrl),
    createDatabaseIdentitySha256(
      databaseUrl.replace(`postgres.${supabaseProjectRef}`, `postgres.${isolatedProjectRef}`)
    )
  );
  assert.equal(createDatabaseIdentitySha256(`${databaseUrl}?schema=unrelated`), '');
});

test('canonicalizes the immutable GitHub review receipt and approver identity', () => {
  const review = {
    id: 1001,
    state: 'APPROVED',
    submitted_at: businessOwnerApprovedAt,
    commit_id: commit,
    pull_request_url: 'https://api.github.com/repos/wangchaozhuanyong/id-business-system/pulls/42',
    author_association: 'COLLABORATOR',
    user: {
      id: 77,
      login: 'BusinessOwner',
      type: 'User'
    }
  };
  const withIgnoredFields = {
    ...review,
    body: 'not part of the canonical release receipt',
    user: {
      ...review.user,
      avatar_url: 'https://avatars.githubusercontent.com/u/77'
    }
  };

  assert.equal(
    createGitHubApprovalReceiptSha256(review),
    createGitHubApprovalReceiptSha256(withIgnoredFields)
  );
  assert.notEqual(
    createGitHubApprovalReceiptSha256(review),
    createGitHubApprovalReceiptSha256({ ...review, state: 'DISMISSED' })
  );
  assert.equal(
    createGitHubApproverIdentitySha256(review.user),
    createGitHubApproverIdentitySha256({ ...review.user, login: 'businessowner' })
  );
});

test('validates the live GitHub review against the merged production commit', () => {
  const evidence = createEvidence();
  const review = {
    id: 1001,
    state: 'APPROVED',
    submitted_at: businessOwnerApprovedAt,
    commit_id: '9'.repeat(40),
    pull_request_url: 'https://api.github.com/repos/wangchaozhuanyong/id-business-system/pulls/42',
    author_association: 'COLLABORATOR',
    user: {
      id: 77,
      login: 'business-owner',
      type: 'User'
    }
  };
  const artifact = {
    approvedAt: businessOwnerApprovedAt,
    approvalReceiptSha256: createGitHubApprovalReceiptSha256(review),
    approverIdentitySha256: createGitHubApproverIdentitySha256(review.user)
  };
  evidence.dataIntegrity.businessOwnerApprovalReceiptSha256 = artifact.approvalReceiptSha256;
  const input = {
    artifact,
    branch,
    commit,
    evidence,
    pullNumber: 42,
    reviewId: 1001,
    review,
    repository,
    releaseActor: { login: 'release-engineer' },
    pullRequest: {
      number: 42,
      merged: true,
      merge_commit_sha: commit,
      base: { ref: branch },
      head: { sha: review.commit_id },
      user: { login: 'pull-request-author' }
    }
  };

  assert.deepEqual(validateGitHubBusinessOwnerApproval(input), []);
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      review: { ...review, state: 'DISMISSED' }
    }).some((error) => error.includes('独立协作者'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      releaseActor: { login: review.user.login }
    }).some((error) => error.includes('独立协作者'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      review: {
        ...review,
        commit_id: '8'.repeat(40)
      }
    }).some((error) => error.includes('最终 PR head'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      pullRequest: {
        ...input.pullRequest,
        merged: false
      }
    }).some((error) => error.includes('最终 PR head'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      pullRequest: {
        ...input.pullRequest,
        merge_commit_sha: '7'.repeat(40)
      }
    }).some((error) => error.includes('最终 PR head'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      pullRequest: {
        ...input.pullRequest,
        user: { login: review.user.login }
      }
    }).some((error) => error.includes('独立协作者'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      artifact: {
        ...artifact,
        approvalReceiptSha256: '6'.repeat(64)
      }
    }).some((error) => error.includes('在线回执摘要'))
  );
  assert.ok(
    validateGitHubBusinessOwnerApproval({
      ...input,
      artifact: {
        ...artifact,
        approverIdentitySha256: '5'.repeat(64)
      }
    }).some((error) => error.includes('在线回执摘要'))
  );
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function resignEvidence(evidence) {
  evidence.integrity = createReleaseEvidenceIntegrity(evidence, privateKey, keyId);
}
