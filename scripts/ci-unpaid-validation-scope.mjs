import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sessionDiagnosticPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  ...[
    'SOURCE_MANIFEST.json',
    'subscription-diagnostics.cjs',
    'unpaid-validation.cjs',
    'upstream/index.js',
    'upstream/session-auth.js',
    'upstream/subscription-check.js',
    'test/browser-profile.test.cjs',
    'test/execution-budget.test.cjs',
    'test/human-verification.test.cjs',
    'test/unpaid-validation.test.cjs',
    'test/upstream-session-transition.test.cjs'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);

export const subscriptionBodyFallbackPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  ...[
    'SOURCE_MANIFEST.json',
    'confirmation.cjs',
    'subscription-diagnostics.cjs',
    'subscription-network-diagnostics.cjs',
    'unpaid-validation.cjs',
    'upstream/subscription-check.js',
    'test/subscription-body-fallback.test.cjs',
    'test/subscription-network-diagnostics.test.cjs',
    'test/unpaid-validation.test.cjs'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);

// Exact unpaid validation batch. Adding another business path restores full checks.
export const unpaidValidationPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineCheckoutDebugView.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
  'apps/admin/src/v2/features/online-recharge/api.spec.ts',
  'apps/admin/src/v2/features/online-recharge/auditPresentation.spec.ts',
  'apps/admin/src/v2/features/online-recharge/contracts.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-creation-diagnostics.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/human-verification.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-await-diagnostics.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/evidence-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/auth-page-detect.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.card-capacity.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const checkoutResumePaths = Object.freeze([
  'apps/api/src/id-business-v2/online-recharge/checkout-preparation.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-page-state.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-preparation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-page-loading.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-preparation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/mysql-store.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'docs/V2_TASKS.md'
]);
export const persistentProfilePaths = Object.freeze([
  '.env.example',
  'apps/api/src/id-business-v2/online-recharge/engine/.env.example',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/safe-media.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-navigation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/evidence-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/execution-budget.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/session-routing-browser.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/browser-pool-client.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/browser-pool.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/browser-runtime.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/browser-standalone.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md',
  'apps/api/src/id-business-v2/online-recharge/engine/browser-profile.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs'
]);
export const profileEgressLifecyclePaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/browser-profile.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-connectivity-retry.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const freshSessionPaths = Object.freeze([
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/browser-profile.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const cardReadDiagnosticsPaths = Object.freeze([
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const proxyFailureEvidencePaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const countryEvidencePaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/evidence-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/rpc-response.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const unpaidValidationControls = Object.freeze([
  '.github/workflows/online-fresh-session-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-fresh-session-' + name
  ),
  '.github/workflows/online-session-diagnostic-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-session-diagnostic-' + name
  ),
  '.github/workflows/online-profile-lock-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-profile-lock-' + name
  ),
  '.github/workflows/online-country-evidence-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-country-evidence-' + name
  ),
  '.github/workflows/online-profile-egress-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-profile-egress-' + name
  ),
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-unpaid-validation-scope.mjs',
  'scripts/ci-unpaid-validation-scope.test.mjs',
  '.github/workflows/online-proxy-failure-evidence-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-proxy-failure-evidence-' + name
  ),
  '.github/workflows/online-card-read-diagnostics-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-card-read-diagnostics-' + name
  ),
  '.github/workflows/online-persistent-profile-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-persistent-profile-' + name
  ),
  '.github/workflows/online-unpaid-validation-publication.yml',
  'scripts/production-release/online-unpaid-validation-release.py',
  'scripts/production-release/online-unpaid-validation-build.py',
  'scripts/production-release/online-unpaid-validation-publication.py',
  'scripts/production-release/online-unpaid-validation-release.test.py',
  'scripts/production-release/online-unpaid-validation-contract.json',
  '.github/workflows/online-checkout-resume-publication.yml',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/online-checkout-resume-' + name
  )
]);
export const profileLockRecoveryPaths = Object.freeze([
  'scripts/production-release/online-checkout-release.py',
  'scripts/production-release/online-profile-lock-recovery.py',
  'scripts/production-release/online-profile-lock-recovery.test.py',
  'scripts/production-release/online-profile-lock-continuity.test.mjs'
]);
export function isProfileLockRecoveryOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    profileLockRecoveryPaths.every((p) => paths.includes(p)) &&
    paths.every(
      (p) =>
        profileLockRecoveryPaths.includes(p) ||
        [
          'scripts/ci-unpaid-validation-scope.mjs',
          'scripts/ci-unpaid-validation-scope.test.mjs',
          'scripts/ci-recharge-scope.mjs',
          'docs/ONLINE_RECHARGE.md',
          'docs/V2_TASKS.md'
        ].includes(p)
    )
  );
}
export function isUnpaidValidationOnly(paths) {
  if (isProfileLockRecoveryOnly(paths)) return true;
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    [
      sessionDiagnosticPaths,
      subscriptionBodyFallbackPaths,
      unpaidValidationPaths,
      checkoutResumePaths,
      persistentProfilePaths,
      profileEgressLifecyclePaths,
      freshSessionPaths,
      cardReadDiagnosticsPaths,
      proxyFailureEvidencePaths,
      countryEvidencePaths
    ].some(
      (batch) =>
        batch.filter((p) => p.startsWith('apps/')).every((p) => paths.includes(p)) &&
        paths.every((p) => batch.includes(p) || unpaidValidationControls.includes(p))
    )
  );
}
export function isFreshSessionOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    freshSessionPaths.filter((p) => p.startsWith('apps/')).every((p) => paths.includes(p)) &&
    paths.every((p) => freshSessionPaths.includes(p) || unpaidValidationControls.includes(p))
  );
}
export function isPersistentProfileOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    persistentProfilePaths
      .filter((p) => p.startsWith('apps/') || p === '.env.example')
      .every((p) => paths.includes(p)) &&
    paths.every((p) => persistentProfilePaths.includes(p) || unpaidValidationControls.includes(p))
  );
}
export function isProfileEgressLifecycleOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    profileEgressLifecyclePaths
      .filter((p) => p.startsWith('apps/'))
      .every((p) => paths.includes(p)) &&
    paths.every(
      (p) => profileEgressLifecyclePaths.includes(p) || unpaidValidationControls.includes(p)
    )
  );
}
const profileInventoryRepairPaths = new Set([
  'scripts/production-release/online-profile-lock-recovery.py',
  'scripts/production-release/online-profile-lock-recovery.test.py',
  'scripts/production-release/online-profile-lock-release.test.py',
  'scripts/ci-unpaid-validation-scope.mjs',
  'scripts/ci-unpaid-validation-scope.test.mjs'
]);
export function isProfileInventoryControlRepair(paths, options = {}) {
  if (
    paths.length !== profileInventoryRepairPaths.size ||
    new Set(paths).size !== paths.length ||
    !paths.every((path) => profileInventoryRepairPaths.has(path))
  )
    return false;
  const digest =
    options.helperSha256 ??
    createHash('sha256')
      .update(
        readFileSync(
          new URL('./production-release/online-profile-lock-recovery.py', import.meta.url)
        )
      )
      .digest('hex');
  return digest === 'bda837bfe6b6b8ca91f356fe780c13d75de15928d017a1fe6780d7b481065b58';
}
export function isUnpaidValidationControlsOnly(paths) {
  if (isProfileInventoryControlRepair(paths)) return true;
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.some(
      (p) =>
        p.startsWith('scripts/production-release/online-fresh-session-') ||
        p === '.github/workflows/online-fresh-session-publication.yml' ||
        p.startsWith('scripts/production-release/online-session-diagnostic-') ||
        p === '.github/workflows/online-session-diagnostic-publication.yml' ||
        p.startsWith('scripts/production-release/online-profile-lock-') ||
        p === '.github/workflows/online-profile-lock-publication.yml' ||
        p.startsWith('scripts/production-release/online-country-evidence-') ||
        p === '.github/workflows/online-country-evidence-publication.yml' ||
        p.startsWith('scripts/production-release/online-profile-egress-') ||
        p === '.github/workflows/online-profile-egress-publication.yml' ||
        p.startsWith('scripts/production-release/online-proxy-failure-evidence-') ||
        p === '.github/workflows/online-proxy-failure-evidence-publication.yml' ||
        p.startsWith('scripts/production-release/online-card-read-diagnostics-') ||
        p === '.github/workflows/online-card-read-diagnostics-publication.yml' ||
        p.startsWith('scripts/production-release/online-persistent-profile-') ||
        p === '.github/workflows/online-persistent-profile-publication.yml' ||
        p.startsWith('scripts/production-release/online-checkout-resume-') ||
        p === '.github/workflows/online-checkout-resume-publication.yml' ||
        p.startsWith('scripts/production-release/online-unpaid-validation-') ||
        p.startsWith('scripts/ci-unpaid-validation-') ||
        p === '.github/workflows/online-unpaid-validation-publication.yml'
    ) &&
    paths.every((p) => unpaidValidationControls.includes(p))
  );
}
export function unpaidValidationCommands(part, paths) {
  const controlsOnly = isUnpaidValidationControlsOnly(paths);
  if (!isUnpaidValidationOnly(paths) && !controlsOnly)
    throw new Error('Unsupported unpaid validation scope');
  const npm = (...args) => ['npm', ...args];
  const engine = 'apps/api/src/id-business-v2/online-recharge/engine';
  if (isProfileLockRecoveryOnly(paths)) {
    if (part === 'guards')
      return [
        npm(
          'exec',
          '--',
          'prettier',
          '--check',
          ...paths.filter((p) => /\.(?:mjs|cjs|md)$/.test(p))
        ),
        npm('exec', '--', 'eslint', ...paths.filter((p) => /\.(?:mjs|cjs)$/.test(p))),
        ['node', '--test', 'scripts/ci-unpaid-validation-scope.test.mjs'],
        ['python3', '-B', 'scripts/production-release/online-profile-lock-recovery.test.py'],
        ['python3', '-B', 'scripts/production-release/online-checkout-release.test.py'],
        ['python3', '-B', 'scripts/production-release/online-country-evidence-release.test.py'],
        npm('run', 'check:v2-module-architecture'),
        npm('run', 'check:v2-isolation')
      ];
    if (part === 'online-engine')
      return [
        npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
        [
          'node',
          engine + '/upstream/node_modules/playwright/cli.js',
          'install',
          '--with-deps',
          'chromium'
        ],
        [
          'node',
          '--test',
          'scripts/production-release/online-profile-lock-continuity.test.mjs',
          engine + '/test/browser-profile.test.cjs'
        ]
      ];
    throw new Error('Profile lock recovery cannot select unrelated application checks');
  }
  if (part === 'guards') {
    const formatted = paths.filter(
      (p) => /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(p) && !p.includes('/engine/upstream/')
    );
    const linted = paths.filter(
      (p) => /\.(?:mjs|cjs|ts|vue)$/.test(p) && !p.includes('/engine/upstream/')
    );
    return [
      ...(formatted.length ? [npm('exec', '--', 'prettier', '--check', ...formatted)] : []),
      ...(linted.length ? [npm('exec', '--', 'eslint', ...linted)] : []),
      ['node', '--test', 'scripts/ci-unpaid-validation-scope.test.mjs'],
      ['python3', '-B', 'scripts/production-release/online-unpaid-validation-release.test.py'],
      ...(paths.some((p) => p.includes('online-fresh-session-'))
        ? [['python3', '-B', 'scripts/production-release/online-fresh-session-release.test.py']]
        : []),
      ...(paths.some((p) => p.includes('online-profile-lock-'))
        ? [['python3', '-B', 'scripts/production-release/online-profile-lock-release.test.py']]
        : []),
      ...(paths.some((p) => /online-profile-lock-recovery(?:\.test)?\.py$/.test(p))
        ? [['python3', '-B', 'scripts/production-release/online-profile-lock-recovery.test.py']]
        : []),
      ...(paths.some((p) => p.includes('online-country-evidence-'))
        ? [['python3', '-B', 'scripts/production-release/online-country-evidence-release.test.py']]
        : []),
      ...(paths.some((p) => p.includes('online-profile-egress-'))
        ? [['python3', '-B', 'scripts/production-release/online-profile-egress-release.test.py']]
        : []),
      ...(paths.some((p) => p.includes('online-proxy-failure-evidence-'))
        ? [
            [
              'python3',
              '-B',
              'scripts/production-release/online-proxy-failure-evidence-release.test.py'
            ]
          ]
        : []),
      ...(paths.some((p) => p.includes('online-card-read-diagnostics-'))
        ? [
            [
              'python3',
              '-B',
              'scripts/production-release/online-card-read-diagnostics-release.test.py'
            ]
          ]
        : []),
      ...(paths.some((p) => p.includes('online-session-diagnostic-'))
        ? [
            [
              'python3',
              '-B',
              'scripts/production-release/online-session-diagnostic-release.test.py'
            ]
          ]
        : []),
      ...(paths.some((p) => p.includes('online-persistent-profile-'))
        ? [
            [
              'python3',
              '-B',
              'scripts/production-release/online-persistent-profile-release.test.py'
            ]
          ]
        : []),
      ...(paths.some((p) => p.includes('online-checkout-resume-'))
        ? [['python3', '-B', 'scripts/production-release/online-checkout-resume-release.test.py']]
        : []),
      ...(controlsOnly ||
      isPersistentProfileOnly(paths) ||
      (cardReadDiagnosticsPaths
        .filter((p) => p.startsWith('apps/'))
        .every((p) => paths.includes(p)) &&
        paths.every(
          (p) => cardReadDiagnosticsPaths.includes(p) || unpaidValidationControls.includes(p)
        ))
        ? [
            'check:v2-module-architecture',
            'check:v2-isolation',
            ...(!controlsOnly ? ['test:online-recharge:controls'] : [])
          ]
        : [
            'check:admin-ui',
            'check:v2-ui-language',
            'check:v2-color-contrast',
            'check:v2-table-standard',
            'check:v2-loading-standard',
            'check:v2-module-architecture',
            'check:v2-isolation',
            'test:online-recharge:controls'
          ]
      ).map((n) => npm('run', n))
    ];
  }
  if (controlsOnly) throw new Error('Control-only update cannot select application checks');
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
      [
        'node',
        engine + '/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/online-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/features/online-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin')
    ];
  if (part === 'online-engine')
    return [
      npm('ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
      npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
      [
        'node',
        engine + '/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg'],
      npm('run', 'test:online-recharge:engine')
    ];
  throw new Error('Unsupported unpaid validation part');
}
