import { createHash } from 'node:crypto';
import {
  assessPostCleanupAuditDraft,
  fingerprint,
  HISTORY_POST_CLEANUP_POLICY_ID,
  HISTORY_POST_CLEANUP_BASELINE,
  HISTORY_POST_CLEANUP_DATABASE,
  HISTORY_POST_CLEANUP_RECEIPT_SHA256,
  HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256,
  POST_CLEANUP_REQUIRED_SOURCE_FILES,
  POST_CLEANUP_COMPILED_FILES,
  validatePostCleanupPolicyDraft,
  serializeHistoricalAuditReport,
  postCleanupSourceAnchor
} from './v2-release-history-policy.mjs';

export const ORDER_ARCHIVE_POLICY_ID = 'historical-finance-20261005-order-archive';
export const ORDER_ARCHIVE_BASELINE = '7f70688b9bf53a071a0a324ca558aeabc4ced2e3';
export const ORDER_ARCHIVE_SCOPE = 'API_ADMIN_ORDER_ARCHIVE';
export const ORDER_ARCHIVE_POLICY_FILE = 'deploy/aws/' + ORDER_ARCHIVE_POLICY_ID + '.json';
export const ORDER_ARCHIVE_MIGRATION_NAME = '20261005193000_order_independent_archive';
export const ORDER_ARCHIVE_MIGRATION_FILE =
  'apps/api/prisma-mysql/migrations/' + ORDER_ARCHIVE_MIGRATION_NAME + '/migration.sql';
export const ORDER_ARCHIVE_MIGRATION_SQL_SHA256 =
  '5738091ee212f78514c322a38d271bdc22ae6ec3743daf5e17835e52d93e0e04';
export const ORDER_ARCHIVE_REQUIRED_SOURCE_FILES = Object.freeze([
  ...POST_CLEANUP_REQUIRED_SOURCE_FILES,
  'apps/api/prisma-mysql/schema.prisma',
  ORDER_ARCHIVE_MIGRATION_FILE,
  'apps/api/src/id-business-v2/orders/id-business-v2-order-archive.service.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-orders.controller.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-orders.service.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-orders.module.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-lock-support.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-lock.service.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-completion.service.ts',
  'apps/api/src/id-business-v2/orders/id-business-v2-order-balance-return.service.ts',
  'apps/api/src/id-business-v2/finance/persistence/id-business-v2-finance-report.repository.ts',
  'apps/admin/src/v2/types/orders.ts',
  'apps/admin/src/v2/api/orders.ts',
  'scripts/lib/v2-order-archive-release-policy.mjs',
  'scripts/v2-order-archive-release-audit.mjs'
]);
export const ORDER_ARCHIVE_REQUIRED_COMPILED_FILES = Object.freeze([
  ...POST_CLEANUP_COMPILED_FILES,
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-archive.service.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-orders.controller.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-orders.service.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-orders.module.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-lock-support.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-lock.service.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-completion.service.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-balance-return.service.js',
  'apps/api/dist/id-business-v2/orders/id-business-v2-order-lifecycle-support.js',
  'apps/api/dist/id-business-v2/orders/persistence/id-business-v2-orders.repository.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-report.repository.js'
]);
const equal = (a, b) => fingerprint(a) === fingerprint(b);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const gitSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes('\0') &&
  value.split('/').every((part) => part && !['.', '..', '.git'].includes(part));
const requireValue = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const keysEqual = (object, keys) =>
  object && !Array.isArray(object) && equal(Object.keys(object).sort(), [...keys].sort());
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function financialProjection(policy) {
  const { scope, historicalSourceBaseline, candidateBindings, ...financial } = policy;
  void scope;
  void historicalSourceBaseline;
  return {
    ...financial,
    id: HISTORY_POST_CLEANUP_POLICY_ID,
    expectedCurrent: HISTORY_POST_CLEANUP_BASELINE,
    candidateBindings: {
      sourceSha256: Object.fromEntries(
        POST_CLEANUP_REQUIRED_SOURCE_FILES.map((path) => [
          path,
          candidateBindings?.sourceSha256?.[path]
        ])
      ),
      compiledServiceHashes: Object.fromEntries(
        POST_CLEANUP_COMPILED_FILES.map((path) => [
          path,
          candidateBindings?.compiledServiceHashes?.[path]
        ])
      )
    }
  };
}

export function createOrderArchivePolicyDraft(financialPolicy, candidateBindings) {
  return {
    ...structuredClone(financialPolicy),
    id: ORDER_ARCHIVE_POLICY_ID,
    expectedCurrent: ORDER_ARCHIVE_BASELINE,
    historicalSourceBaseline: HISTORY_POST_CLEANUP_BASELINE,
    userApproved: false,
    activation: 'EXTERNAL_REVIEWED_SEAL_REQUIRED',
    scope: ORDER_ARCHIVE_SCOPE,
    candidateBindings: structuredClone(candidateBindings)
  };
}

export function validateOrderArchivePolicyDraft(policy, definitions, expectedCurrent) {
  requireValue(
    policy?.id === ORDER_ARCHIVE_POLICY_ID &&
      policy.scope === ORDER_ARCHIVE_SCOPE &&
      policy.expectedCurrent === ORDER_ARCHIVE_BASELINE &&
      expectedCurrent === ORDER_ARCHIVE_BASELINE &&
      policy.historicalSourceBaseline === HISTORY_POST_CLEANUP_BASELINE &&
      policy.userApproved === false &&
      policy.activation === 'EXTERNAL_REVIEWED_SEAL_REQUIRED',
    'Independent unapproved order archive policy required'
  );
  validatePostCleanupPolicyDraft(
    financialProjection(policy),
    definitions,
    HISTORY_POST_CLEANUP_BASELINE
  );
  requireValue(
    policy.sourceAnchorSha256 === HISTORY_POST_CLEANUP_SOURCE_ANCHOR_SHA256,
    'Order archive original financial source anchor changed'
  );
  const bindings = policy.candidateBindings;
  requireValue(
    keysEqual(bindings, [
      'sourceTree',
      'sourceSha256',
      'sourceGitModes',
      'compiledServiceHashes',
      'adminBuildHashes',
      'migration'
    ]) && gitSha(bindings.sourceTree),
    'Order archive complete candidate bindings required'
  );
  for (const [name, map] of Object.entries(bindings)) {
    if (!['sourceSha256', 'compiledServiceHashes', 'adminBuildHashes'].includes(name)) continue;
    requireValue(
      map &&
        !Array.isArray(map) &&
        Object.keys(map).length > 0 &&
        Object.entries(map).every(([path, value]) => validPath(path) && sha(value)),
      'Order archive candidate content hash map invalid'
    );
  }
  requireValue(
    !Object.hasOwn(bindings.sourceSha256, ORDER_ARCHIVE_POLICY_FILE) &&
      keysEqual(bindings.sourceGitModes, Object.keys(bindings.sourceSha256)) &&
      Object.values(bindings.sourceGitModes).every((mode) => ['100644', '100755'].includes(mode)) &&
      ORDER_ARCHIVE_REQUIRED_SOURCE_FILES.every((path) =>
        Object.hasOwn(bindings.sourceSha256, path)
      ),
    'Order archive projection must exclude its policy and cover exact regular source modes'
  );
  requireValue(
    ORDER_ARCHIVE_REQUIRED_COMPILED_FILES.every((path) =>
      Object.hasOwn(bindings.compiledServiceHashes, path)
    ) &&
      Object.keys(bindings.compiledServiceHashes).every((path) =>
        /^(apps\/api\/dist\/|packages\/shared\/dist\/).+\.js$/.test(path)
      ),
    'Order archive compiled financial and order dependencies missing'
  );
  const adminPaths = Object.keys(bindings.adminBuildHashes);
  requireValue(
    adminPaths.includes('apps/admin/dist/index.html') &&
      adminPaths.some((path) => path.endsWith('.js')) &&
      adminPaths.some((path) => path.endsWith('.css')) &&
      adminPaths.every((path) => path.startsWith('apps/admin/dist/')),
    'Order archive complete admin build bindings required'
  );
  const migration = bindings.migration;
  requireValue(
    keysEqual(migration, ['name', 'sqlSha256', 'mysqlSchemaSha256', 'baselineMysqlSchemaSha256']) &&
      migration.name === ORDER_ARCHIVE_MIGRATION_NAME &&
      migration.sqlSha256 === ORDER_ARCHIVE_MIGRATION_SQL_SHA256 &&
      sha(migration.mysqlSchemaSha256) &&
      sha(migration.baselineMysqlSchemaSha256) &&
      bindings.sourceSha256[ORDER_ARCHIVE_MIGRATION_FILE] === migration.sqlSha256 &&
      bindings.sourceSha256['apps/api/prisma-mysql/schema.prisma'] === migration.mysqlSchemaSha256,
    'Only the reviewed nullable order archive migration and schema may be selected'
  );
}

export function orderArchiveFinancialSourceAnchor(policy) {
  return postCleanupSourceAnchor(financialProjection(policy));
}

export function verifyOrderArchiveSchemaChange(baselineBytes, candidateBytes, migration) {
  requireValue(
    Buffer.isBuffer(baselineBytes) &&
      Buffer.isBuffer(candidateBytes) &&
      digest(baselineBytes) === migration.baselineMysqlSchemaSha256 &&
      digest(candidateBytes) === migration.mysqlSchemaSha256,
    'Order archive actual baseline or candidate schema changed'
  );
  const text = candidateBytes.toString('utf8');
  const models = [...text.matchAll(/(model IdBusinessV2Order \{\r?\n)([\s\S]*?)(^\}\r?$)/gm)];
  requireValue(
    models.length === 1 && Buffer.from(text).equals(candidateBytes),
    'Order archive ordinary order model unavailable'
  );
  const [model] = models;
  const field =
    /^[ \t]*archivedAt[ \t]+DateTime\?[ \t]+@map\("archived_at"\)[ \t]+@db\.DateTime\(6\)[ \t]*\r?\n/gm;
  const index =
    /^[ \t]*@@index\(\[deletedAt,[ \t]*archivedAt,[ \t]*createdAt,[ \t]*id\], map: "id_business_v2_orders_archive_list_idx"\)[ \t]*\r?\n/gm;
  requireValue(
    [...model[2].matchAll(field)].length === 1 && [...model[2].matchAll(index)].length === 1,
    'Order archive exact nullable field and list index required'
  );
  const restored =
    text.slice(0, model.index) +
    model[1] +
    model[2].replace(field, '').replace(index, '') +
    model[3] +
    text.slice(model.index + model[0].length);
  requireValue(
    Buffer.from(restored).equals(baselineBytes),
    'Order archive contains additional schema changes'
  );
  return {
    baselineMysqlSchemaSha256: digest(baselineBytes),
    mysqlSchemaSha256: digest(candidateBytes)
  };
}

// Git object hashing is read-only. All files of the final Git tree except this policy
// participate, including exact executable modes; no index or Git object is written.
export function computeOrderArchiveSourceTree(entries) {
  const root = { children: new Map() };
  for (const { path, mode, bytes } of entries) {
    requireValue(
      validPath(path) &&
        path !== ORDER_ARCHIVE_POLICY_FILE &&
        ['100644', '100755'].includes(mode) &&
        Buffer.isBuffer(bytes),
      'Invalid order archive Git projection entry'
    );
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      requireValue(!child || child.children, 'Order archive source file directory collision');
      if (!child) node.children.set(part, (child = { children: new Map() }));
      node = child;
    }
    requireValue(!node.children.has(parts.at(-1)), 'Duplicate order archive source entry');
    const header = Buffer.from('blob ' + bytes.length + '\0');
    node.children.set(parts.at(-1), {
      mode,
      oid: createHash('sha1')
        .update(Buffer.concat([header, bytes]))
        .digest()
    });
  }
  const tree = (node) => {
    const records = [...node.children]
      .sort(([a, av], [b, bv]) =>
        Buffer.compare(
          Buffer.from(a + (av.children ? '/' : '')),
          Buffer.from(b + (bv.children ? '/' : ''))
        )
      )
      .map(([name, child]) =>
        Buffer.concat([
          Buffer.from((child.children ? '40000' : child.mode) + ' ' + name + '\0'),
          child.children ? tree(child) : child.oid
        ])
      );
    const bytes = Buffer.concat(records);
    return createHash('sha1')
      .update(Buffer.concat([Buffer.from('tree ' + bytes.length + '\0'), bytes]))
      .digest();
  };
  return tree(root).toString('hex');
}

export function verifyOrderArchiveSourceBindings(policy, materializedEntries) {
  const bindings = policy.candidateBindings;
  const entries = materializedEntries.filter((entry) => entry.path !== ORDER_ARCHIVE_POLICY_FILE);
  requireValue(
    equal(entries.map((entry) => entry.path).sort(), Object.keys(bindings.sourceSha256).sort()),
    'Order archive materialized source coverage changed'
  );
  for (const entry of entries)
    requireValue(
      Buffer.isBuffer(entry.bytes) &&
        digest(entry.bytes) === bindings.sourceSha256[entry.path] &&
        entry.mode === bindings.sourceGitModes[entry.path],
      'Order archive materialized source content or mode changed'
    );
  requireValue(
    computeOrderArchiveSourceTree(entries) === bindings.sourceTree,
    'Order archive actual source projection tree changed'
  );
  return { sourceTree: bindings.sourceTree, sourceFileCount: entries.length };
}

export function assessOrderArchiveAuditDraft(input) {
  validateOrderArchivePolicyDraft(input.policy, input.definitions, input.expectedCurrent);
  if (input.stage === 'after')
    requireValue(
      input.before?.gate?.accepted === true &&
        input.before.gate.status === 'APPROVED_ORDER_ARCHIVE_HISTORICAL_EXCEPTIONS' &&
        input.before.gate.policyId === ORDER_ARCHIVE_POLICY_ID &&
        input.before.gate.expectedCurrent === ORDER_ARCHIVE_BASELINE &&
        input.before.gate.scope === ORDER_ARCHIVE_SCOPE,
      'Independent order archive before receipt required'
    );
  const before = input.before
    ? {
        ...input.before,
        gate: {
          ...input.before.gate,
          policyId: HISTORY_POST_CLEANUP_POLICY_ID,
          expectedCurrent: HISTORY_POST_CLEANUP_BASELINE,
          status: 'APPROVED_POST_CLEANUP_HISTORICAL_EXCEPTIONS'
        }
      }
    : undefined;
  const facts = assessPostCleanupAuditDraft({
    ...input,
    expectedCurrent: HISTORY_POST_CLEANUP_BASELINE,
    policy: financialProjection(input.policy),
    before
  });
  return {
    ...facts,
    accepted: false,
    policyId: ORDER_ARCHIVE_POLICY_ID,
    expectedCurrent: ORDER_ARCHIVE_BASELINE,
    historicalSourceBaseline: HISTORY_POST_CLEANUP_BASELINE,
    scope: ORDER_ARCHIVE_SCOPE,
    status: 'ORDER_ARCHIVE_DRAFT_VERIFIED_NOT_ACTIVATED'
  };
}

export function validateOrderArchiveReviewSeal(policy, proof) {
  const { seal, sealBytes, sealSha256, cleanupReceiptBytes, candidateCommit, candidateTree } =
    proof;
  const bindings = policy.candidateBindings;
  requireValue(
    Buffer.isBuffer(sealBytes) &&
      sha(sealSha256) &&
      digest(sealBytes) === sealSha256 &&
      equal(JSON.parse(sealBytes.toString()), seal) &&
      Buffer.isBuffer(cleanupReceiptBytes) &&
      digest(cleanupReceiptBytes) === HISTORY_POST_CLEANUP_RECEIPT_SHA256 &&
      seal?.version === 1 &&
      seal.policyId === ORDER_ARCHIVE_POLICY_ID &&
      seal.scope === ORDER_ARCHIVE_SCOPE &&
      seal.userApproved === true &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,299}$/.test(seal.approvalReference ?? '') &&
      seal.expectedCurrent === ORDER_ARCHIVE_BASELINE &&
      seal.historicalSourceBaseline === HISTORY_POST_CLEANUP_BASELINE &&
      seal.activeDatabase === HISTORY_POST_CLEANUP_DATABASE &&
      seal.cleanupReceiptSha256 === HISTORY_POST_CLEANUP_RECEIPT_SHA256 &&
      seal.sourceAnchorSha256 === policy.sourceAnchorSha256 &&
      seal.policySha256 === fingerprint(policy) &&
      seal.candidateBindingsSha256 === fingerprint(bindings) &&
      gitSha(candidateCommit) &&
      candidateCommit !== ORDER_ARCHIVE_BASELINE &&
      seal.candidateCommit === candidateCommit &&
      gitSha(candidateTree) &&
      seal.candidateTree === candidateTree &&
      seal.sourceTree === bindings.sourceTree &&
      candidateTree !== bindings.sourceTree &&
      equal(seal.migration, bindings.migration) &&
      keysEqual(seal.images, ['api', 'admin', 'migrate']) &&
      Object.values(seal.images).every((value) => /^sha256:[a-f0-9]{64}$/.test(value)) &&
      sha(seal.preparedImagesSha256) &&
      Number.isSafeInteger(seal.preparationRunId) &&
      seal.preparationRunId > 0 &&
      Number.isSafeInteger(seal.preparationRunAttempt) &&
      seal.preparationRunAttempt > 0,
    'Independent order archive reviewed source, images, preparation and migration seal required'
  );
  const receipt = JSON.parse(cleanupReceiptBytes.toString());
  requireValue(
    receipt?.ok === true &&
      receipt.status === 'POST_OPEN_READONLY_RUNTIME_AND_TWO_ORDER_SCOPE_VERIFIED' &&
      receipt.databaseName === HISTORY_POST_CLEANUP_DATABASE &&
      receipt.release?.commit === HISTORY_POST_CLEANUP_BASELINE &&
      receipt.normalWritesOpened === true &&
      receipt.databaseMutationCommands === 0 &&
      receipt.credentialsExported === false,
    'Order archive immutable original cleanup receipt changed'
  );
  return {
    releaseSealSha256: sealSha256,
    candidateCommit,
    candidateTree,
    sourceTree: bindings.sourceTree,
    images: seal.images,
    migration: seal.migration,
    preparedImagesSha256: seal.preparedImagesSha256,
    preparationRunId: seal.preparationRunId,
    preparationRunAttempt: seal.preparationRunAttempt
  };
}

export function acceptSealedOrderArchiveAudit(input, proof) {
  const frozen = validateOrderArchiveReviewSeal(input.policy, proof);
  const draft = assessOrderArchiveAuditDraft(input);
  if (input.stage === 'after')
    requireValue(
      Object.entries(frozen).every(([key, value]) => equal(input.before.gate[key], value)),
      'Order archive approved candidate or preparation changed during release'
    );
  return {
    ...draft,
    ...frozen,
    accepted: true,
    status: 'APPROVED_ORDER_ARCHIVE_HISTORICAL_EXCEPTIONS'
  };
}
export function serializeOrderArchiveAuditReport(report) {
  const checks = report.checks?.map(({ code, count, status, samples }) => ({
    code,
    count,
    status,
    samples: (samples ?? []).map((sample) => ({
      entityId: String(sample.entityId),
      detailSha256: fingerprint(sample.detail ?? null)
    }))
  }));
  return serializeHistoricalAuditReport({ ...report, checks });
}
