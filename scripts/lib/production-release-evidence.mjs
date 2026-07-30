import {
  createHash,
  createPublicKey,
  sign as signPayload,
  verify as verifySignature
} from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const MAX_RECEIPT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_FRESH_CHECK_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TRUST_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const BUSINESS_OWNER_APPROVAL_PROVIDER = 'github_pull_request_review';

export const RELEASE_EVIDENCE_ARTIFACT_FILES = Object.freeze({
  authAudit: 'auth-audit.json',
  backupProvider: 'backup-provider.json',
  businessOwnerApproval: 'business-owner-approval.json',
  dataIntegrity: 'data-integrity.json',
  migrations: 'migration-status.json',
  restoreDrill: 'restore-drill.json'
});

export function validateProductionReleaseTrust(trust) {
  const errors = [];
  if (!isRecord(trust)) return ['生产发布信任配置必须是 JSON 对象'];
  expectEqual(trust.schemaVersion, 1, '生产发布信任配置 schemaVersion 必须为 1', errors);
  if (!Array.isArray(trust.keys) || trust.keys.length === 0) {
    errors.push('生产发布信任配置必须至少包含一个受信任公钥');
    return errors;
  }

  const keyIds = new Set();
  for (const [index, key] of trust.keys.entries()) {
    const label = `生产发布信任配置 keys[${index}]`;
    if (!isRecord(key)) {
      errors.push(`${label} 必须是 JSON 对象`);
      continue;
    }
    expectPattern(key.keyId, TRUST_KEY_ID_PATTERN, `${label}.keyId 格式无效`, errors);
    expectEqual(key.algorithm, 'ed25519', `${label}.algorithm 必须为 ed25519`, errors);
    expectEqual(key.status, 'active', `${label}.status 必须为 active`, errors);
    if (typeof key.keyId === 'string') {
      if (keyIds.has(key.keyId)) errors.push(`${label}.keyId 不得重复`);
      keyIds.add(key.keyId);
    }
    try {
      if (createPublicKey(key.publicKey).asymmetricKeyType !== 'ed25519') {
        errors.push(`${label}.publicKey 必须是 Ed25519 公钥`);
      }
    } catch {
      errors.push(`${label}.publicKey 格式无效`);
    }
  }
  return errors;
}

export function validateProductionReleaseEvidenceArtifacts(evidence, artifacts) {
  const errors = [];
  const specifications = [
    [RELEASE_EVIDENCE_ARTIFACT_FILES.backupProvider, evidence?.backup?.providerEvidenceSha256],
    [RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill, evidence?.restoreDrill?.checksArtifactSha256],
    [RELEASE_EVIDENCE_ARTIFACT_FILES.authAudit, evidence?.authAudit?.reportSha256],
    [RELEASE_EVIDENCE_ARTIFACT_FILES.migrations, evidence?.migrations?.reportSha256],
    [RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity, evidence?.dataIntegrity?.reportSha256],
    [
      RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval,
      evidence?.dataIntegrity?.businessOwnerApprovalSha256
    ]
  ];

  for (const [filename, expectedHash] of specifications) {
    const content = artifacts?.[filename];
    if (!Buffer.isBuffer(content) || content.length === 0) {
      errors.push(`缺少非空生产发布证据附件：${filename}`);
      continue;
    }
    const actualHash = createHash('sha256').update(content).digest('hex');
    expectEqual(expectedHash, actualHash, `${filename} 的 SHA-256 与发布凭证不一致`, errors);
    try {
      const artifact = JSON.parse(content.toString('utf8'));
      validateArtifactScope(filename, artifact, evidence, errors);
    } catch {
      errors.push(`${filename} 必须是有效 JSON`);
    }
  }
  return errors;
}

export function createDatabaseIdentitySha256(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return '';
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const schema = url.searchParams.get('schema') ?? 'public';
    const projectRef = getSupabaseDatabaseProjectRef(url);
    if (!projectRef || database !== 'postgres' || schema !== 'public') return '';
    const identity = {
      provider: 'supabase',
      projectRef,
      database,
      schema
    };
    return createHash('sha256').update(stableStringify(identity)).digest('hex');
  } catch {
    return '';
  }
}

export function createReleaseEvidenceIntegrity(evidence, privateKey, keyId) {
  const payload = getEvidencePayload(evidence);
  const canonicalPayload = stableStringify(payload);
  return {
    canonicalSha256: createHash('sha256').update(canonicalPayload).digest('hex'),
    keyId,
    signature: signPayload(null, Buffer.from(canonicalPayload), privateKey).toString('base64'),
    signatureAlgorithm: 'ed25519'
  };
}

export function createGitHubApprovalReceiptSha256(review) {
  if (
    !isRecord(review) ||
    !isRecord(review.user) ||
    !Number.isInteger(review.id) ||
    !Number.isInteger(review.user.id)
  ) {
    return '';
  }
  const payload = {
    authorAssociation: review.author_association,
    commitId: review.commit_id,
    id: review.id,
    pullRequestUrl: review.pull_request_url,
    state: review.state,
    submittedAt: review.submitted_at,
    user: {
      id: review.user.id,
      login: review.user.login,
      type: review.user.type
    }
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function createGitHubApproverIdentitySha256(user) {
  if (
    !isRecord(user) ||
    !Number.isInteger(user.id) ||
    typeof user.login !== 'string' ||
    !user.login.trim() ||
    typeof user.type !== 'string'
  ) {
    return '';
  }
  return createHash('sha256')
    .update(
      stableStringify({
        id: user.id,
        login: user.login.trim().toLowerCase(),
        type: user.type
      })
    )
    .digest('hex');
}

export function validateGitHubBusinessOwnerApproval(input) {
  const errors = [];
  const {
    artifact,
    branch,
    commit,
    evidence,
    pullNumber,
    pullRequest,
    releaseActor,
    repository,
    review,
    reviewId
  } = input;
  const reviewerLogin = review?.user?.login?.toLowerCase();
  const submittedAt = Date.parse(review?.submitted_at);
  const approvedAt = Date.parse(artifact?.approvedAt);

  if (
    review?.id !== reviewId ||
    review?.state !== 'APPROVED' ||
    !Number.isFinite(submittedAt) ||
    submittedAt !== approvedAt ||
    !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review?.author_association) ||
    review?.pull_request_url !== `https://api.github.com/repos/${repository}/pulls/${pullNumber}` ||
    review?.commit_id !== pullRequest?.head?.sha ||
    pullRequest?.number !== pullNumber ||
    pullRequest?.merged !== true ||
    pullRequest?.base?.ref !== branch ||
    pullRequest?.merge_commit_sha !== commit ||
    !reviewerLogin ||
    pullRequest?.user?.login?.toLowerCase() === reviewerLogin ||
    releaseActor?.login?.toLowerCase() === reviewerLogin
  ) {
    errors.push(
      'GitHub 业务负责人 Review 必须来自独立协作者、批准最终 PR head，并已合并为当前生产 commit'
    );
  }
  if (
    createGitHubApprovalReceiptSha256(review) !== artifact?.approvalReceiptSha256 ||
    createGitHubApproverIdentitySha256(review?.user) !== artifact?.approverIdentitySha256 ||
    artifact?.approvalReceiptSha256 !==
      evidence?.dataIntegrity?.businessOwnerApprovalReceiptSha256 ||
    artifact?.approvedAt !== evidence?.dataIntegrity?.businessOwnerApprovedAt
  ) {
    errors.push('GitHub 业务负责人 Review 的在线回执摘要、审批人或时间与签名证据不一致');
  }
  return errors;
}

export function validateProductionReleaseEvidence(evidence, context) {
  const errors = [];
  if (!isRecord(evidence)) return ['生产发布凭证必须是 JSON 对象'];
  errors.push(...validateProductionReleaseTrust(context.trust));

  const payload = getEvidencePayload(evidence);
  const integrity = evidence.integrity;
  const issuedAt = parseDate(evidence.issuedAt, 'issuedAt', errors);
  const expiresAt = parseDate(evidence.expiresAt, 'expiresAt', errors);
  const now = context.now instanceof Date ? context.now : new Date(context.now);
  let backupCreatedAt = null;
  let restoreCompletedAt = null;
  let dataIntegrityCheckedAt = null;
  let businessOwnerApprovedAt = null;

  expectEqual(evidence.schemaVersion, 1, 'schemaVersion 必须为 1', errors);
  expectEqual(evidence.environment, 'production', 'environment 必须为 production', errors);
  expectPattern(evidence.receiptId, UUID_PATTERN, 'receiptId 必须是 UUID', errors);
  if (issuedAt && issuedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    errors.push('生产发布凭证签发时间不能晚于当前时间');
  }
  if (
    issuedAt &&
    expiresAt &&
    (expiresAt <= issuedAt || expiresAt.getTime() - issuedAt.getTime() > MAX_RECEIPT_LIFETIME_MS)
  ) {
    errors.push('生产发布凭证有效期必须大于 0 且不超过 2 小时');
  }
  if (expiresAt && expiresAt <= now) {
    errors.push('生产发布凭证已过期');
  }

  const release = evidence.release;
  expectRecord(release, 'release', errors);
  if (isRecord(release)) {
    expectEqual(release.repository, context.repository, '发布凭证仓库与当前仓库不一致', errors);
    expectEqual(release.branch, context.branch, '发布凭证分支与当前分支不一致', errors);
    expectEqual(release.commit, context.commit, '发布凭证 commit 与当前 HEAD 不一致', errors);
    expectPattern(release.commit, GIT_SHA_PATTERN, 'release.commit 必须是完整 Git SHA', errors);
    expectEqual(release.tree, context.tree, '发布凭证 tree 与当前 Git tree 不一致', errors);
    expectPattern(release.tree, GIT_SHA_PATTERN, 'release.tree 必须是完整 Git tree SHA', errors);
  }

  const expectedProjectRef = getSupabaseProjectRef(context.env.SUPABASE_URL);
  const expectedDatabaseIdentity = createDatabaseIdentitySha256(context.env.DATABASE_URL);
  const expectedFieldEncryptionKeySha256 = createSecretSha256(context.env.FIELD_ENCRYPTION_KEY);
  const expectedHashSecretSha256 = createSecretSha256(context.env.HASH_SECRET);
  const target = evidence.target;
  expectRecord(target, 'target', errors);
  if (isRecord(target)) {
    expectEqual(
      target.supabaseProjectRef,
      expectedProjectRef,
      '发布凭证 Supabase 项目与当前目标不一致',
      errors
    );
    expectPattern(
      target.supabaseProjectRef,
      SUPABASE_PROJECT_REF_PATTERN,
      'target.supabaseProjectRef 无效',
      errors
    );
    expectEqual(
      target.databaseIdentitySha256,
      expectedDatabaseIdentity,
      '发布凭证数据库指纹与当前目标不一致',
      errors
    );
    expectPattern(
      target.databaseIdentitySha256,
      SHA256_PATTERN,
      'target.databaseIdentitySha256 无效',
      errors
    );
    expectEqual(
      target.migrationWatermark,
      context.migrationWatermark,
      '发布凭证 migration 水位与仓库不一致',
      errors
    );
    expectEqual(
      target.migrationSetSha256,
      context.migrationSetSha256,
      '发布凭证 migration 集合摘要与仓库不一致',
      errors
    );
    expectHash(target.migrationSetSha256, 'target.migrationSetSha256', errors);
    expectEqual(
      target.prismaSchemaSha256,
      context.prismaSchemaSha256,
      '发布凭证 Prisma schema 摘要与仓库不一致',
      errors
    );
    expectHash(target.prismaSchemaSha256, 'target.prismaSchemaSha256', errors);
    expectEqual(
      target.fieldEncryptionKeySha256,
      expectedFieldEncryptionKeySha256,
      '发布凭证字段加密密钥摘要与当前部署密钥不一致',
      errors
    );
    expectHash(target.fieldEncryptionKeySha256, 'target.fieldEncryptionKeySha256', errors);
    expectEqual(
      target.hashSecretSha256,
      expectedHashSecretSha256,
      '发布凭证哈希密钥摘要与当前部署密钥不一致',
      errors
    );
    expectHash(target.hashSecretSha256, 'target.hashSecretSha256', errors);
  }

  const backup = evidence.backup;
  expectRecord(backup, 'backup', errors);
  if (isRecord(backup)) {
    expectEqual(backup.provider, 'supabase', '生产备份 provider 必须为 supabase', errors);
    if (!['snapshot', 'pitr'].includes(backup.kind)) {
      errors.push('生产备份 kind 必须为 snapshot 或 pitr');
    }
    expectEqual(backup.status, 'available', '生产备份必须处于 available 状态', errors);
    expectReference(backup.reference, 'backup.reference', errors);
    expectEqual(
      backup.sourceProjectRef,
      expectedProjectRef,
      '生产备份来源项目与发布目标不一致',
      errors
    );
    backupCreatedAt = parseDate(backup.createdAt, 'backup.createdAt', errors);
    const restorePoint = parseDate(backup.restorePoint, 'backup.restorePoint', errors);
    validateNotFuture(backupCreatedAt, 'backup.createdAt', now, errors);
    validateNotFuture(restorePoint, 'backup.restorePoint', now, errors);
    validateMaximumAge(backupCreatedAt, 'backup.createdAt', now, MAX_RECEIPT_LIFETIME_MS, errors);
    validateMaximumAge(restorePoint, 'backup.restorePoint', now, MAX_RECEIPT_LIFETIME_MS, errors);
    validateNotAfter(
      restorePoint,
      backupCreatedAt,
      'backup.restorePoint 不得晚于 backup.createdAt',
      errors
    );
    validateNotAfter(
      backupCreatedAt,
      issuedAt,
      'backup.createdAt 不得晚于发布凭证签发时间',
      errors
    );
    expectEqual(
      backup.migrationWatermark,
      context.migrationWatermark,
      '生产备份 migration 水位与当前发布不一致',
      errors
    );
    expectHash(backup.schemaSha256, 'backup.schemaSha256', errors);
    expectHash(backup.coreDataWatermarkSha256, 'backup.coreDataWatermarkSha256', errors);
    expectHash(backup.providerEvidenceSha256, 'backup.providerEvidenceSha256', errors);
  }

  const restoreDrill = evidence.restoreDrill;
  expectRecord(restoreDrill, 'restoreDrill', errors);
  if (isRecord(restoreDrill)) {
    expectReference(restoreDrill.reference, 'restoreDrill.reference', errors);
    expectEqual(
      restoreDrill.sourceBackupReference,
      isRecord(backup) ? backup.reference : undefined,
      '隔离恢复未引用本次生产备份',
      errors
    );
    expectEqual(restoreDrill.status, 'passed', '隔离恢复状态必须为 passed', errors);
    expectPattern(
      restoreDrill.targetProjectRef,
      SUPABASE_PROJECT_REF_PATTERN,
      'restoreDrill.targetProjectRef 无效',
      errors
    );
    if (restoreDrill.targetProjectRef === expectedProjectRef) {
      errors.push('隔离恢复目标不得是生产 Supabase 项目');
    }
    restoreCompletedAt = parseDate(restoreDrill.completedAt, 'restoreDrill.completedAt', errors);
    if (restoreCompletedAt && backupCreatedAt && restoreCompletedAt < backupCreatedAt) {
      errors.push('隔离恢复完成时间不得早于备份创建时间');
    }
    validateNotFuture(restoreCompletedAt, 'restoreDrill.completedAt', now, errors);
    validateMaximumAge(
      restoreCompletedAt,
      'restoreDrill.completedAt',
      now,
      MAX_RECEIPT_LIFETIME_MS,
      errors
    );
    validateNotAfter(
      restoreCompletedAt,
      issuedAt,
      'restoreDrill.completedAt 不得晚于发布凭证签发时间',
      errors
    );
    expectEqual(
      restoreDrill.sourceMigrationWatermark,
      isRecord(backup) ? backup.migrationWatermark : undefined,
      '隔离恢复来源 migration 水位与备份不一致',
      errors
    );
    expectEqual(
      restoreDrill.restoredMigrationWatermark,
      isRecord(backup) ? backup.migrationWatermark : undefined,
      '隔离恢复后的 migration 水位与备份不一致',
      errors
    );
    expectEqual(
      restoreDrill.sourceSchemaSha256,
      isRecord(backup) ? backup.schemaSha256 : undefined,
      '隔离恢复来源 schema 摘要与备份不一致',
      errors
    );
    expectEqual(
      restoreDrill.restoredSchemaSha256,
      isRecord(backup) ? backup.schemaSha256 : undefined,
      '隔离恢复后的 schema 摘要与备份不一致',
      errors
    );
    expectEqual(
      restoreDrill.sourceCoreDataWatermarkSha256,
      isRecord(backup) ? backup.coreDataWatermarkSha256 : undefined,
      '隔离恢复来源核心数据水位与备份不一致',
      errors
    );
    expectEqual(
      restoreDrill.restoredCoreDataWatermarkSha256,
      isRecord(backup) ? backup.coreDataWatermarkSha256 : undefined,
      '隔离恢复后的核心数据水位与备份不一致',
      errors
    );
    expectHash(restoreDrill.checksArtifactSha256, 'restoreDrill.checksArtifactSha256', errors);
    expectAllTrue(
      restoreDrill.checks,
      [
        'sourceTargetSeparated',
        'schemaMatched',
        'migrationsMatched',
        'constraintsPassed',
        'financeBalancesPassed',
        'sensitiveDecryptSamplePassed',
        'postBackupChangesCompared'
      ],
      'restoreDrill.checks',
      errors
    );
  }

  const authAudit = evidence.authAudit;
  expectRecord(authAudit, 'authAudit', errors);
  if (isRecord(authAudit)) {
    expectEqual(authAudit.projectRef, expectedProjectRef, '认证审计项目与发布目标不一致', errors);
    expectEqual(
      authAudit.databaseIdentitySha256,
      expectedDatabaseIdentity,
      '认证审计数据库与发布目标不一致',
      errors
    );
    expectEqual(authAudit.readOnly, true, '认证审计必须是只读执行', errors);
    expectEqual(authAudit.readyForAutomaticRelease, true, '认证审计尚未满足自动发布条件', errors);
    expectEqual(authAudit.detailsTruncated, false, '认证审计明细不得截断', errors);
    expectEqual(authAudit.blockingIssueCount, 0, '认证审计仍有阻断项', errors);
    validateFreshDate(authAudit.generatedAt, 'authAudit.generatedAt', now, errors);
    validateNotAfter(
      parseDate(authAudit.generatedAt, 'authAudit.generatedAt', []),
      issuedAt,
      'authAudit.generatedAt 不得晚于发布凭证签发时间',
      errors
    );
    expectHash(authAudit.reportSha256, 'authAudit.reportSha256', errors);
  }

  const migrations = evidence.migrations;
  expectRecord(migrations, 'migrations', errors);
  if (isRecord(migrations)) {
    validateFreshDate(migrations.checkedAt, 'migrations.checkedAt', now, errors);
    validateNotAfter(
      parseDate(migrations.checkedAt, 'migrations.checkedAt', []),
      issuedAt,
      'migrations.checkedAt 不得晚于发布凭证签发时间',
      errors
    );
    expectEqual(
      migrations.appliedWatermark,
      context.migrationWatermark,
      '生产 migration 尚未达到仓库水位',
      errors
    );
    expectEmptyArray(migrations.pending, 'migrations.pending', errors);
    expectEmptyArray(migrations.failed, 'migrations.failed', errors);
    expectEqual(migrations.schemaDrift, false, '生产数据库存在 schema drift', errors);
    expectEqual(migrations.forwardOnly, true, '生产 migration 必须只向前执行', errors);
    expectEqual(
      migrations.migrationSetSha256,
      context.migrationSetSha256,
      '生产 migration 集合摘要与仓库不一致',
      errors
    );
    expectEqual(
      migrations.prismaSchemaSha256,
      context.prismaSchemaSha256,
      '生产 Prisma schema 摘要与仓库不一致',
      errors
    );
    expectHash(migrations.migrationSetSha256, 'migrations.migrationSetSha256', errors);
    expectHash(migrations.prismaSchemaSha256, 'migrations.prismaSchemaSha256', errors);
    expectHash(migrations.reportSha256, 'migrations.reportSha256', errors);
  }

  const dataIntegrity = evidence.dataIntegrity;
  expectRecord(dataIntegrity, 'dataIntegrity', errors);
  if (isRecord(dataIntegrity)) {
    dataIntegrityCheckedAt = validateFreshDate(
      dataIntegrity.checkedAt,
      'dataIntegrity.checkedAt',
      now,
      errors
    );
    validateNotAfter(
      dataIntegrityCheckedAt,
      issuedAt,
      'dataIntegrity.checkedAt 不得晚于发布凭证签发时间',
      errors
    );
    expectEqual(
      dataIntegrity.businessOwnerApprovalProvider,
      BUSINESS_OWNER_APPROVAL_PROVIDER,
      `dataIntegrity.businessOwnerApprovalProvider 必须为 ${BUSINESS_OWNER_APPROVAL_PROVIDER}`,
      errors
    );
    expectReference(dataIntegrity.reference, 'dataIntegrity.reference', errors);
    expectGitHubApprovalReceiptReference(
      dataIntegrity.businessOwnerApprovalReference,
      evidence.release?.repository,
      'dataIntegrity.businessOwnerApprovalReference',
      errors
    );
    businessOwnerApprovedAt = parseDate(
      dataIntegrity.businessOwnerApprovedAt,
      'dataIntegrity.businessOwnerApprovedAt',
      errors
    );
    expectHash(
      dataIntegrity.businessOwnerApprovalReceiptSha256,
      'dataIntegrity.businessOwnerApprovalReceiptSha256',
      errors
    );
    expectHash(dataIntegrity.reportSha256, 'dataIntegrity.reportSha256', errors);
    expectHash(
      dataIntegrity.businessOwnerApprovalSha256,
      'dataIntegrity.businessOwnerApprovalSha256',
      errors
    );
    expectAllTrue(
      dataIntegrity,
      [
        'immutableLedgersBalanced',
        'financeHistoryComplete',
        'initialBalancesConfirmed',
        'postBackupChangesCompared'
      ],
      'dataIntegrity',
      errors
    );
  }

  validateNotAfter(
    restoreCompletedAt,
    dataIntegrityCheckedAt,
    'dataIntegrity.checkedAt 不得早于隔离恢复完成时间',
    errors
  );
  validateNotAfter(
    dataIntegrityCheckedAt,
    businessOwnerApprovedAt,
    '业务负责人批准时间不得早于数据完整性检查时间',
    errors
  );
  validateNotAfter(
    businessOwnerApprovedAt,
    issuedAt,
    '业务负责人批准时间不得晚于发布凭证签发时间',
    errors
  );

  const restorePolicy = evidence.restorePolicy;
  expectRecord(restorePolicy, 'restorePolicy', errors);
  if (isRecord(restorePolicy)) {
    expectEqual(restorePolicy.inPlaceRestoreAllowed, false, '禁止允许旧备份原地覆盖生产库', errors);
    expectEqual(
      restorePolicy.databaseRollbackOnAppFailure,
      false,
      '应用发布失败不得自动回滚数据库',
      errors
    );
  }

  expectRecord(integrity, 'integrity', errors);
  if (isRecord(integrity)) {
    expectEqual(integrity.signatureAlgorithm, 'ed25519', '发布凭证签名算法必须为 ed25519', errors);
    expectPattern(integrity.keyId, TRUST_KEY_ID_PATTERN, '发布凭证签名 keyId 格式无效', errors);
    expectHash(integrity.canonicalSha256, 'integrity.canonicalSha256', errors);
    const canonicalPayload = stableStringify(payload);
    const actualHash = createHash('sha256').update(canonicalPayload).digest('hex');
    expectEqual(integrity.canonicalSha256, actualHash, '发布凭证 canonical SHA-256 不匹配', errors);
    const trustedKey = context.trust?.keys?.find(
      (key) => key?.keyId === integrity.keyId && key?.status === 'active'
    );
    if (!trustedKey) {
      errors.push('发布凭证签名 keyId 不在受保护代码的信任配置中');
      return errors;
    }
    try {
      const signatureValid = verifySignature(
        null,
        Buffer.from(canonicalPayload),
        trustedKey.publicKey,
        Buffer.from(integrity.signature ?? '', 'base64')
      );
      if (!signatureValid) errors.push('生产发布凭证 Ed25519 签名无效');
    } catch {
      errors.push('生产发布凭证 Ed25519 公钥或签名格式无效');
    }
  }

  return errors;
}

function getEvidencePayload(evidence) {
  if (!isRecord(evidence)) return evidence;
  const payload = { ...evidence };
  delete payload.integrity;
  return payload;
}

function validateArtifactScope(filename, artifact, evidence, errors) {
  if (!isRecord(artifact)) {
    errors.push(`${filename} 必须是 JSON 对象`);
    return;
  }
  const artifactTypes = {
    [RELEASE_EVIDENCE_ARTIFACT_FILES.authAudit]: 'auth_audit',
    [RELEASE_EVIDENCE_ARTIFACT_FILES.backupProvider]: 'backup_provider',
    [RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval]: 'business_owner_approval',
    [RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity]: 'data_integrity',
    [RELEASE_EVIDENCE_ARTIFACT_FILES.migrations]: 'migration_status',
    [RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill]: 'restore_drill'
  };
  expectEqual(artifact.schemaVersion, 1, `${filename}.schemaVersion 必须为 1`, errors);
  expectEqual(
    artifact.artifactType,
    artifactTypes[filename],
    `${filename}.artifactType 不匹配`,
    errors
  );
  expectEqual(artifact.receiptId, evidence?.receiptId, `${filename}.receiptId 不匹配`, errors);
  expectEqual(
    artifact.releaseCommit,
    evidence?.release?.commit,
    `${filename}.releaseCommit 不匹配`,
    errors
  );
  expectEqual(
    artifact.productionProjectRef,
    evidence?.target?.supabaseProjectRef,
    `${filename}.productionProjectRef 不匹配`,
    errors
  );
  expectEqual(
    artifact.databaseIdentitySha256,
    evidence?.target?.databaseIdentitySha256,
    `${filename}.databaseIdentitySha256 不匹配`,
    errors
  );

  switch (filename) {
    case RELEASE_EVIDENCE_ARTIFACT_FILES.backupProvider:
      compareArtifactFields(
        artifact,
        evidence?.backup,
        [
          'provider',
          'reference',
          'sourceProjectRef',
          'status',
          'createdAt',
          'restorePoint',
          'migrationWatermark',
          'schemaSha256',
          'coreDataWatermarkSha256'
        ],
        filename,
        errors
      );
      break;
    case RELEASE_EVIDENCE_ARTIFACT_FILES.restoreDrill:
      compareArtifactFields(
        artifact,
        evidence?.restoreDrill,
        [
          'reference',
          'sourceBackupReference',
          'targetProjectRef',
          'status',
          'completedAt',
          'sourceMigrationWatermark',
          'restoredMigrationWatermark',
          'sourceSchemaSha256',
          'restoredSchemaSha256',
          'sourceCoreDataWatermarkSha256',
          'restoredCoreDataWatermarkSha256'
        ],
        filename,
        errors
      );
      expectEqual(
        stableStringify(artifact.checks),
        stableStringify(evidence?.restoreDrill?.checks),
        `${filename}.checks 不匹配`,
        errors
      );
      break;
    case RELEASE_EVIDENCE_ARTIFACT_FILES.authAudit:
      compareArtifactFields(
        artifact,
        evidence?.authAudit,
        [
          'generatedAt',
          'readOnly',
          'readyForAutomaticRelease',
          'detailsTruncated',
          'blockingIssueCount'
        ],
        filename,
        errors
      );
      break;
    case RELEASE_EVIDENCE_ARTIFACT_FILES.migrations:
      compareArtifactFields(
        artifact,
        evidence?.migrations,
        [
          'checkedAt',
          'appliedWatermark',
          'schemaDrift',
          'forwardOnly',
          'migrationSetSha256',
          'prismaSchemaSha256'
        ],
        filename,
        errors
      );
      expectEqual(
        stableStringify(artifact.pending),
        stableStringify(evidence?.migrations?.pending),
        `${filename}.pending 不匹配`,
        errors
      );
      expectEqual(
        stableStringify(artifact.failed),
        stableStringify(evidence?.migrations?.failed),
        `${filename}.failed 不匹配`,
        errors
      );
      break;
    case RELEASE_EVIDENCE_ARTIFACT_FILES.dataIntegrity:
      compareArtifactFields(
        artifact,
        evidence?.dataIntegrity,
        [
          'checkedAt',
          'reference',
          'businessOwnerApprovalProvider',
          'businessOwnerApprovalReference',
          'businessOwnerApprovalReceiptSha256',
          'businessOwnerApprovedAt',
          'immutableLedgersBalanced',
          'financeHistoryComplete',
          'initialBalancesConfirmed',
          'postBackupChangesCompared'
        ],
        filename,
        errors
      );
      break;
    case RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval:
      expectEqual(
        artifact.approvalProvider,
        BUSINESS_OWNER_APPROVAL_PROVIDER,
        `${filename}.approvalProvider 必须为 ${BUSINESS_OWNER_APPROVAL_PROVIDER}`,
        errors
      );
      expectEqual(
        artifact.approvalProvider,
        evidence?.dataIntegrity?.businessOwnerApprovalProvider,
        `${filename}.approvalProvider 不匹配`,
        errors
      );
      expectEqual(
        artifact.approvalReference,
        evidence?.dataIntegrity?.businessOwnerApprovalReference,
        `${filename}.approvalReference 不匹配`,
        errors
      );
      expectEqual(
        artifact.approvalReceiptSha256,
        evidence?.dataIntegrity?.businessOwnerApprovalReceiptSha256,
        `${filename}.approvalReceiptSha256 不匹配`,
        errors
      );
      expectHash(artifact.approvalReceiptSha256, `${filename}.approvalReceiptSha256`, errors);
      expectEqual(artifact.decision, 'approved', `${filename}.decision 必须为 approved`, errors);
      expectEqual(
        artifact.approverRole,
        'business-owner',
        `${filename}.approverRole 必须为 business-owner`,
        errors
      );
      expectHash(artifact.approverIdentitySha256, `${filename}.approverIdentitySha256`, errors);
      expectEqual(
        artifact.approvedAt,
        evidence?.dataIntegrity?.businessOwnerApprovedAt,
        `${filename}.approvedAt 不匹配`,
        errors
      );
      validateNotAfter(
        parseDate(artifact.approvedAt, `${filename}.approvedAt`, errors),
        parseDate(evidence?.issuedAt, 'issuedAt', []),
        `${filename}.approvedAt 不得晚于凭证签发时间`,
        errors
      );
      expectEqual(
        artifact.inPlaceRestoreAllowed,
        false,
        `${filename} 不得批准旧备份原地覆盖生产库`,
        errors
      );
      expectEqual(
        artifact.databaseRollbackOnAppFailure,
        false,
        `${filename} 不得批准应用失败时回滚数据库`,
        errors
      );
      break;
    default:
      errors.push(`未知生产发布证据附件：${filename}`);
  }
}

function compareArtifactFields(artifact, evidenceSection, fields, label, errors) {
  for (const field of fields) {
    expectEqual(
      artifact?.[field],
      evidenceSection?.[field],
      `${label}.${field} 与发布凭证不匹配`,
      errors
    );
  }
}

function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('生产发布凭证包含无法规范化的值');
}

function createSecretSha256(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return createHash('sha256').update(value).digest('hex');
}

function expectGitHubApprovalReceiptReference(value, repository, label, errors) {
  try {
    const url = new URL(value);
    const repositoryPath =
      typeof repository === 'string'
        ? repository
            .split('/')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('/')
        : '';
    const pathPattern = new RegExp(
      `^/repos/${repositoryPath}/pulls/[1-9][0-9]*/reviews/[1-9][0-9]*$`,
      'i'
    );
    if (
      url.origin !== 'https://api.github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !repositoryPath ||
      !pathPattern.test(url.pathname)
    ) {
      throw new Error();
    }
  } catch {
    errors.push(`${label} 必须是当前仓库不可变 GitHub Pull Request Review API 引用`);
  }
}

function getSupabaseProjectRef(value) {
  try {
    return new URL(value).hostname.toLowerCase().match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function getSupabaseDatabaseProjectRef(url) {
  const hostname = url.hostname.toLowerCase();
  const directProjectRef = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/)?.[1];
  if (directProjectRef && decodeURIComponent(url.username).toLowerCase() === 'postgres') {
    return directProjectRef;
  }
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)) return '';
  return (
    decodeURIComponent(url.username)
      .toLowerCase()
      .match(/^postgres\.([a-z0-9]{20})$/)?.[1] ?? ''
  );
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function expectRecord(value, label, errors) {
  if (!isRecord(value)) errors.push(`${label} 必须是 JSON 对象`);
}

function expectEqual(actual, expected, message, errors) {
  if (actual !== expected) errors.push(message);
}

function expectPattern(value, pattern, message, errors) {
  if (typeof value !== 'string' || !pattern.test(value)) errors.push(message);
}

function expectReference(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 256) {
    errors.push(`${label} 必须是 8-256 位稳定证据引用`);
  }
}

function expectHash(value, label, errors) {
  expectPattern(value, SHA256_PATTERN, `${label} 必须是 SHA-256`, errors);
}

function expectEmptyArray(value, label, errors) {
  if (!Array.isArray(value) || value.length !== 0) {
    errors.push(`${label} 必须是空数组`);
  }
}

function expectAllTrue(value, keys, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是 JSON 对象`);
    return;
  }
  for (const key of keys) {
    if (value[key] !== true) errors.push(`${label}.${key} 必须为 true`);
  }
}

function parseDate(value, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} 必须是 ISO 时间`);
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    errors.push(`${label} 必须是规范 UTC ISO 时间`);
    return null;
  }
  return parsed;
}

function validateFreshDate(value, label, now, errors) {
  const date = parseDate(value, label, errors);
  if (!date) return null;
  const age = now.getTime() - date.getTime();
  if (age < -CLOCK_SKEW_MS || age > MAX_FRESH_CHECK_AGE_MS) {
    errors.push(`${label} 必须在发布前 30 分钟内生成`);
  }
  return date;
}

function validateNotFuture(date, label, now, errors) {
  if (date && date.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    errors.push(`${label} 不得晚于当前时间`);
  }
}

function validateNotAfter(earlier, later, message, errors) {
  if (earlier && later && earlier.getTime() > later.getTime()) {
    errors.push(message);
  }
}

function validateMaximumAge(date, label, now, maximumAgeMs, errors) {
  if (date && now.getTime() - date.getTime() > maximumAgeMs) {
    errors.push(`${label} 距离当前时间不得超过 ${maximumAgeMs / 60_000} 分钟`);
  }
}
