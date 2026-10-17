const applicationPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/auditPresentation.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/checkout-recovery.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/checkout-recovery.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-recovery.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recheck.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/payment-observation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/solver-process.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unattended-task-control.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/verification-state.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/captcha-platform.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/hcaptcha-solver.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/hcaptcha/solver.py',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/verification-runtime.js',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.manual-closure.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/proxy-country.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/reconciliation.service.ts',
  'apps/api/src/id-business-v2/online-recharge/reconciliation.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/reconciliation.ts',
  'apps/admin/src/v2/features/online-recharge/api.ts',
  'apps/admin/src/v2/features/online-recharge/api.spec.ts',
  'apps/admin/src/v2/features/online-recharge/useOnlineTask.ts',
  'apps/admin/src/v2/features/online-recharge/useOnlineTask.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js',
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
  'apps/admin/src/v2/features/online-recharge/sections.ts',
  'apps/admin/src/v2/features/online-recharge/tableSchemas.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/README.md',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/payment-limit.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/security.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/media-browser.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/tax-free-address.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'apps/admin/src/components/ui/FeatureHelp.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineConfigView.vue',
  'apps/admin/src/v2/features/online-recharge/configFields.ts',
  'apps/admin/src/v2/features/online-recharge/contracts.ts',
  'apps/admin/src/v2/features/online-recharge/labels.ts',
  'apps/admin/src/v2/features/online-recharge/planRegionFields.ts',
  'apps/api/src/id-business-v2/online-recharge/contracts.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/paths.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/plans.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-connection.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-resolver.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/safe-media.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-outcomes.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/payment-core.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/plan-regions.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-resolver.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-result-identity.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/regressions.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-recheck.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/rpc-response.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/runtime-main.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/safe-media-finish.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-currency.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-plans.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/third-party.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chile-money.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/mysql-store.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/pricing-checkout.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/region-config.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/test/pricing-checkout.test.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/upgrade-checkout.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/settings.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/plan-region.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/plan-region.ts'
]);
const controlPaths = Object.freeze([
  '.github/workflows/online-legacy-close-validation.yml',
  'scripts/production-release/online-legacy-close-build.py',
  'scripts/production-release/online-legacy-close-contract.json',
  'scripts/production-release/online-legacy-close-release.py',
  'scripts/production-release/online-legacy-close-release.test.py',
  '.github/workflows/online-unattended-validation.yml',
  'scripts/production-release/online-unattended-build.py',
  'scripts/production-release/online-unattended-contract.json',
  'scripts/production-release/online-unattended-release.py',
  'scripts/production-release/online-unattended-release.test.py',
  '.github/workflows/online-checkout-retest-validation.yml',
  'scripts/production-release/online-checkout-retest-build.py',
  'scripts/production-release/online-checkout-retest-contract.json',
  'scripts/production-release/online-checkout-retest-release.py',
  'scripts/production-release/online-checkout-retest-release.test.py',
  'scripts/production-release/online-browser-display-auth-release.py',
  'scripts/production-release/online-browser-display-auth-release.test.py',
  '.github/workflows/online-checkout-validation.yml',
  'scripts/production-release/online-checkout-build.py',
  'scripts/production-release/online-checkout-contract.json',
  'scripts/production-release/online-checkout-release.py',
  'scripts/production-release/online-checkout-release.test.py',
  '.github/workflows/online-settings-validation.yml',
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/production-release/online-settings-build.py',
  'scripts/production-release/online-settings-contract.json',
  'scripts/production-release/online-settings-release.py',
  'scripts/production-release/online-settings-release.test.py',
  'scripts/acceptance-v2-online-settings-help.mjs',
  'scripts/acceptance-v2-online-settings-ui.mjs'
]);
const documentationPaths = Object.freeze([
  'docs/ONLINE_RECHARGE.md',
  'docs/ONLINE_PLAN_REGIONS_20261016.md',
  'docs/ONLINE_SETTINGS_RELEASE_20261016.md',
  'docs/V2_TASKS.md'
]);
export const onlineCheckoutCsRecoveryScope = 'ONLINE_CHECKOUT_CS_RECOVERY';
const checkoutCsRecoveryRequired = [
  'checkout-recovery.spec.ts',
  'checkout-recovery.ts',
  'contracts.ts',
  'engine/SOURCE_MANIFEST.json',
  'engine/checkout-recovery.cjs',
  'engine/test/checkout-cs-browser.test.cjs',
  'engine/test/checkout-recovery-evidence.test.cjs',
  'engine/test/checkout-recovery.test.cjs',
  'engine/test/payment-core.test.cjs',
  'engine/upstream/chatgpt.js',
  'engine/upstream/index.js',
  'engine/upstream/payment-retry.js',
  'engine/upstream/stripe-payment.js',
  'persistence/worker.repository.spec.ts'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const checkoutCsRecoveryReleaseControls = [
  '.github/workflows/online-checkout-cs-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-cs-' + name
  )
];
const checkoutCsRecoveryOptional = [
  ...checkoutCsRecoveryReleaseControls,
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineCheckoutCsRecoveryOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    checkoutCsRecoveryRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        checkoutCsRecoveryRequired.includes(path) || checkoutCsRecoveryOptional.includes(path)
    )
  );
}
export function isOnlineCheckoutCsRecoveryControlsOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    paths.some((path) => checkoutCsRecoveryReleaseControls.includes(path)) &&
    paths.every((path) => checkoutCsRecoveryOptional.includes(path))
  );
}
export const onlineCheckoutLoadRecoveryScope = 'ONLINE_CHECKOUT_LOAD_RECOVERY';
const checkoutLoadRecoveryEngineRequired = [
  'SOURCE_MANIFEST.json',
  'checkout-form.cjs',
  'checkout-recovery.cjs',
  'rpc.cjs',
  'test/checkout-form.test.cjs',
  'test/checkout-load-recovery.test.cjs',
  'test/checkout-page-loading.test.cjs',
  'test/checkout-recovery.test.cjs',
  'test/recharge-flow-acceptance.test.cjs',
  'test/rpc-response.test.cjs',
  'test/verification-state.test.cjs',
  'upstream/chatgpt.js',
  'upstream/human-verification.js',
  'upstream/stripe-payment.js'
];
const checkoutLoadRecoveryRequired = [
  ...checkoutLoadRecoveryEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts'
];
const checkoutLoadRecoveryReleaseControls = [
  '.github/workflows/online-checkout-load-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-load-' + name
  )
];
const checkoutLoadRecoveryOptional = [
  ...checkoutLoadRecoveryReleaseControls,
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export const onlineCheckoutNavigationReadyScope = 'ONLINE_CHECKOUT_NAVIGATION_READY';
const checkoutNavigationReadyEngineRequired = [
  'SOURCE_MANIFEST.json',
  'checkout-form.cjs',
  'checkout-recovery.cjs',
  'safe-media.cjs',
  'test/checkout-form.test.cjs',
  'test/checkout-load-recovery.test.cjs',
  'test/checkout-navigation.test.cjs',
  'test/checkout-recovery.test.cjs',
  'test/recharge-flow-acceptance.test.cjs',
  'test/regressions.test.cjs',
  'test/safe-media-finish.test.cjs',
  'test/verification-state.test.cjs',
  'upstream/chatgpt.js',
  'upstream/human-verification.js',
  'upstream/index.js'
];
const checkoutNavigationReadyRequired = [
  ...checkoutNavigationReadyEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md'
];
const checkoutNavigationReadyControls = [
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-load-' + name
  ),
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs'
];
export function isOnlineCheckoutNavigationReadyOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    checkoutNavigationReadyRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        checkoutNavigationReadyRequired.includes(path) ||
        checkoutNavigationReadyControls.includes(path)
    )
  );
}
export const onlineCoreParityScope = 'ONLINE_CORE_PARITY';
const coreParityEngineRequired = [
  'SOURCE_MANIFEST.json',
  'checkout-form.cjs',
  'task-runner.cjs',
  'test/checkout-form.test.cjs',
  'test/checkout-navigation.test.cjs',
  'test/checkout-recovery.test.cjs',
  'test/debug-checkout.test.cjs',
  'test/recharge-flow-acceptance.test.cjs',
  'test/renewal-state.test.cjs',
  'test/upgrade-checkout.test.cjs',
  'test/worker-heartbeat.test.cjs',
  'upstream/chatgpt.js',
  'upstream/index.js',
  'upstream/pricing-checkout.js',
  'upstream/subscription-check.js',
  'upstream/test/pricing-checkout.test.js',
  'upstream/upgrade-checkout.js',
  'worker.cjs'
];
const coreParityRequired = [
  ...coreParityEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineCoreParityOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    coreParityRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) => coreParityRequired.includes(path) || checkoutNavigationReadyControls.includes(path)
    )
  );
}
export const onlineCheckoutPreparedFieldsScope = 'ONLINE_CHECKOUT_PREPARED_FIELDS';
const checkoutPreparedFieldsEngineRequired = [
  'SOURCE_MANIFEST.json',
  'checkout-form.cjs',
  'safe-media.cjs',
  'test/checkout-form.test.cjs',
  'test/checkout-navigation.test.cjs',
  'test/checkout-recovery.test.cjs',
  'test/media-browser.test.cjs',
  'test/recharge-flow-acceptance.test.cjs',
  'upstream/chatgpt.js',
  'upstream/human-verification.js',
  'upstream/index.js',
  'upstream/stripe-payment.js'
];
const checkoutPreparedFieldsRequired = [
  ...checkoutPreparedFieldsEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineCheckoutPreparedFieldsOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    checkoutPreparedFieldsRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        checkoutPreparedFieldsRequired.includes(path) ||
        checkoutNavigationReadyControls.includes(path)
    )
  );
}
export const onlineSessionRefreshScope = 'ONLINE_SESSION_REFRESH';
const sessionRefreshEngineRequired = [
  'SOURCE_MANIFEST.json',
  'upstream/session-auth.js',
  'upstream/subscription-check.js',
  'test/regressions.test.cjs',
  'test/recharge-flow-acceptance.test.cjs'
];
const sessionRefreshRequired = [
  ...sessionRefreshEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
const sessionRefreshOptional = [
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  ...checkoutNavigationReadyControls
];
export function isOnlineSessionRefreshOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    sessionRefreshRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) => sessionRefreshRequired.includes(path) || sessionRefreshOptional.includes(path)
    )
  );
}
export const onlineLoginVisibilityScope = 'ONLINE_LOGIN_VISIBILITY';
const loginVisibilityEngineRequired = [
  'SOURCE_MANIFEST.json',
  'confirmation.cjs',
  'upstream/auth-page-detect.js',
  'upstream/index.js',
  'upstream/session-auth.js',
  'upstream/subscription-check.js',
  'test/regressions.test.cjs',
  'test/recharge-flow-acceptance.test.cjs'
];
const loginVisibilityRequired = [
  ...loginVisibilityEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineLoginVisibilityOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    loginVisibilityRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        loginVisibilityRequired.includes(path) || checkoutNavigationReadyControls.includes(path)
    )
  );
}
export const onlineAuthStabilityScope = 'ONLINE_AUTH_STABILITY';
const authStabilityEngineRequired = [
  'SOURCE_MANIFEST.json',
  'upstream/auth-page-detect.js',
  'upstream/session-auth.js',
  'upstream/subscription-check.js',
  'test/regressions.test.cjs',
  'test/recharge-flow-acceptance.test.cjs',
  'test/renewal-state.test.cjs'
];
const authStabilityRequired = [
  ...authStabilityEngineRequired.map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  ),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineAuthStabilityOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    authStabilityRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        authStabilityRequired.includes(path) || checkoutNavigationReadyControls.includes(path)
    )
  );
}
const checkoutLoadParentRpcRequired = [
  'SOURCE_MANIFEST.json',
  'rpc.cjs',
  'test/rpc-response.test.cjs'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name);
export function isOnlineCheckoutLoadParentRpcOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    checkoutLoadParentRpcRequired.every((path) => paths.includes(path)) &&
    paths.every(
      (path) =>
        checkoutLoadParentRpcRequired.includes(path) || checkoutLoadRecoveryOptional.includes(path)
    )
  );
}
export function isOnlineCheckoutLoadRecoveryOnly(paths) {
  return (
    isOnlineCheckoutLoadParentRpcOnly(paths) ||
    (new Set(paths).size === paths.length &&
      checkoutLoadRecoveryRequired.every((path) => paths.includes(path)) &&
      paths.every(
        (path) =>
          checkoutLoadRecoveryRequired.includes(path) || checkoutLoadRecoveryOptional.includes(path)
      ))
  );
}
export function isOnlineCheckoutLoadRecoveryControlsOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    paths.some((path) => checkoutLoadRecoveryReleaseControls.includes(path)) &&
    paths.every((path) => checkoutLoadRecoveryOptional.includes(path))
  );
}
export const onlineSettingsPaths = Object.freeze([
  ...applicationPaths,
  ...controlPaths,
  ...documentationPaths
]);
const required = [
  'plan-region.ts',
  'persistence/admin.repository.ts',
  'persistence/tasks.repository.ts'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const checkoutRequired = [
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js'
];
const retestRequired = [
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/admin/src/v2/features/online-recharge/useOnlineTask.ts'
];
const displayRuntimeRequired = [
  'worker.cjs',
  'test/runtime-main.test.cjs',
  'SOURCE_MANIFEST.json'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name);
const unattendedRequired = [
  'checkout-recovery.ts',
  'reconciliation.service.ts',
  'online-recharge.module.ts',
  'persistence/worker-rpc.repository.ts',
  'engine/upstream/human-verification.js'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const testsOnlyRequired = ['test/payment-observation.test.cjs', 'SOURCE_MANIFEST.json'].map(
  (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
);
const testsOnlyControls = [
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs'
];
export function isOnlineSettingsTestsOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    testsOnlyRequired.every((path) => paths.includes(path)) &&
    paths.every((path) => testsOnlyRequired.includes(path) || testsOnlyControls.includes(path))
  );
}
const legacyCloseRequired = [
  'persistence/tasks.repository.ts',
  'persistence/tasks.manual-closure.spec.ts',
  'mysql.integration.spec.ts'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const legacyCloseControls = [
  '.github/workflows/online-legacy-close-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-legacy-close-' + name
  ),
  ...testsOnlyControls,
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
export function isOnlineLegacyCloseOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    legacyCloseRequired.every((path) => paths.includes(path)) &&
    paths.every((path) => legacyCloseRequired.includes(path) || legacyCloseControls.includes(path))
  );
}
export function isOnlineSettingsOnly(paths) {
  if (
    isOnlineSettingsTestsOnly(paths) ||
    isOnlineLegacyCloseOnly(paths) ||
    isOnlineCheckoutCsRecoveryOnly(paths) ||
    isOnlineCheckoutLoadRecoveryOnly(paths) ||
    isOnlineCheckoutNavigationReadyOnly(paths) ||
    isOnlineCoreParityOnly(paths) ||
    isOnlineCheckoutPreparedFieldsOnly(paths) ||
    isOnlineSessionRefreshOnly(paths) ||
    isOnlineLoginVisibilityOnly(paths) ||
    isOnlineAuthStabilityOnly(paths)
  )
    return true;
  const databaseTest = 'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts';
  const fixtureRepair =
    paths.includes(databaseTest) &&
    paths.every(
      (path) =>
        path === databaseTest || controlPaths.includes(path) || documentationPaths.includes(path)
    );
  return (
    new Set(paths).size === paths.length &&
    (required.every((path) => paths.includes(path)) ||
      checkoutRequired.every((path) => paths.includes(path)) ||
      retestRequired.every((path) => paths.includes(path)) ||
      unattendedRequired.every((path) => paths.includes(path)) ||
      fixtureRepair ||
      (displayRuntimeRequired.every((path) => paths.includes(path)) &&
        paths.every(
          (path) => displayRuntimeRequired.includes(path) || controlPaths.includes(path)
        ))) &&
    paths.every((path) => onlineSettingsPaths.includes(path))
  );
}
export function isOnlineSettingsControlsOnly(paths) {
  if (isOnlineCheckoutLoadRecoveryControlsOnly(paths)) return true;
  if (isOnlineCheckoutCsRecoveryControlsOnly(paths)) return true;
  return (
    paths.some(
      (path) =>
        controlPaths.includes(path) &&
        ![
          'scripts/ci-recharge-scope.mjs',
          'scripts/ci-recharge-check.mjs',
          'scripts/ci-recharge-scope.test.mjs'
        ].includes(path)
    ) &&
    new Set(paths).size === paths.length &&
    paths.every((path) => controlPaths.includes(path) || documentationPaths.includes(path))
  );
}
export const onlineSettingsParts = Object.freeze(['guards', 'api', 'admin', 'online-engine']);
export function onlineSettingsCommands(part, paths) {
  const controlsOnly = isOnlineSettingsControlsOnly(paths);
  const testsOnly = isOnlineSettingsTestsOnly(paths);
  const legacyClose = isOnlineLegacyCloseOnly(paths);
  const checkoutCsRecovery = isOnlineCheckoutCsRecoveryOnly(paths);
  const checkoutCsControls = isOnlineCheckoutCsRecoveryControlsOnly(paths);
  const checkoutLoadRecovery = isOnlineCheckoutLoadRecoveryOnly(paths);
  const checkoutLoadParentRpc = isOnlineCheckoutLoadParentRpcOnly(paths);
  const checkoutLoadControls = isOnlineCheckoutLoadRecoveryControlsOnly(paths);
  const checkoutNavigationReady = isOnlineCheckoutNavigationReadyOnly(paths);
  const coreParity = isOnlineCoreParityOnly(paths);
  const checkoutPreparedFields = isOnlineCheckoutPreparedFieldsOnly(paths);
  const sessionRefresh = isOnlineSessionRefreshOnly(paths);
  const loginVisibility = isOnlineLoginVisibilityOnly(paths);
  const authStability = isOnlineAuthStabilityOnly(paths);
  const checkoutLoadBusiness =
    checkoutLoadRecovery ||
    checkoutNavigationReady ||
    coreParity ||
    checkoutPreparedFields ||
    sessionRefresh ||
    loginVisibility ||
    authStability;
  const checkoutEngineRequired = authStability
    ? authStabilityEngineRequired
    : loginVisibility
      ? loginVisibilityEngineRequired
      : sessionRefresh
        ? sessionRefreshEngineRequired
        : checkoutPreparedFields
          ? checkoutPreparedFieldsEngineRequired
          : coreParity
            ? coreParityEngineRequired
            : checkoutNavigationReady
              ? checkoutNavigationReadyEngineRequired
              : checkoutLoadRecoveryEngineRequired;
  if (!isOnlineSettingsOnly(paths) && !controlsOnly)
    throw new Error('Unsupported online settings scope');
  const npm = (...args) => ['npm', ...args];
  if (part === 'guards') {
    const formatted = paths.filter(
      (path) =>
        /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(path) && !path.includes('/engine/upstream/')
    );
    const linted = paths.filter(
      (path) => /\.(?:mjs|cjs|ts|vue)$/.test(path) && !path.includes('/engine/upstream/')
    );
    const controls = [
      ...(formatted.length ? [npm('exec', '--', 'prettier', '--check', ...formatted)] : []),
      ...(linted.length ? [npm('exec', '--', 'eslint', ...linted)] : []),
      [
        'node',
        '--test',
        'scripts/ci-online-settings-scope.test.mjs',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/ci-change-scope.test.mjs'
      ]
    ];
    if (checkoutLoadBusiness || checkoutLoadControls)
      return [
        ...controls,
        ['python3', '-B', 'scripts/production-release/online-checkout-load-release.test.py'],
        ...(checkoutLoadBusiness
          ? [
              ...[
                'check:v2-module-architecture',
                'check:v2-isolation',
                'check:v2-prisma-runtime-boundary',
                'check:v2-concurrency-standard',
                'check:v2-decimal-standard'
              ].map((name) => npm('run', name)),
              [
                'node',
                '--input-type=module',
                '-e',
                [
                  "import assert from 'node:assert/strict';",
                  "import { readFileSync } from 'node:fs';",
                  "import { createHash } from 'node:crypto';",
                  "import { resolve, sep, isAbsolute, win32 } from 'node:path';",
                  "const root = resolve('apps/api/src/id-business-v2/online-recharge/engine');",
                  "const manifest = JSON.parse(readFileSync(resolve(root, 'SOURCE_MANIFEST.json'), 'utf8'));",
                  "assert.equal(manifest.repository, 'https://github.com/nowtostudeyday/PAY-GPT-UPGRADE.git');",
                  "assert.equal(manifest.commit, 'ba6cf96312a6953e62edb9d74299d438d12549df');",
                  'const rows = manifest.files;',
                  'assert.ok(Array.isArray(rows) && rows.length > 0);',
                  'assert.equal(new Set(rows.map(row => row.path)).size, rows.length);',
                  `for (const required of ${JSON.stringify(checkoutEngineRequired.filter((name) => name !== 'SOURCE_MANIFEST.json'))}) assert.ok(rows.some(row => row.path === required), required);`,
                  'for (const row of rows) {',
                  "  assert.ok(typeof row.path === 'string' && row.path.length > 0 && !isAbsolute(row.path) && !win32.isAbsolute(row.path));",
                  "  assert.ok(row.path.split(/[\\\\/]/).every(part => part && part !== '.' && part !== '..'));",
                  '  const file = resolve(root, row.path);',
                  '  assert.ok(file.startsWith(root + sep) && /^[a-f0-9]{64}$/.test(row.adaptedSha256));',
                  "  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), row.adaptedSha256, row.path);",
                  '}',
                  "console.log('Online checkout load source fingerprints passed.');"
                ].join('\n')
              ]
            ]
          : [])
      ];
    if (checkoutCsRecovery || checkoutCsControls)
      return [
        ...controls,
        ['python3', '-B', 'scripts/production-release/online-checkout-cs-release.test.py'],
        ...(checkoutCsRecovery
          ? [
              'check:v2-module-architecture',
              'check:v2-isolation',
              'check:v2-prisma-runtime-boundary',
              'check:v2-concurrency-standard',
              'check:v2-decimal-standard'
            ].map((name) => npm('run', name))
          : [])
      ];
    if (legacyClose)
      return [
        ...controls,
        ['python3', '-B', 'scripts/production-release/online-legacy-close-release.test.py'],
        ...[
          'check:v2-module-architecture',
          'check:v2-isolation',
          'check:v2-prisma-runtime-boundary',
          'check:v2-concurrency-standard',
          'check:v2-decimal-standard'
        ].map((name) => npm('run', name))
      ];
    if (testsOnly)
      return [
        ...controls,
        npm('run', 'check:v2-isolation'),
        [
          'node',
          '--input-type=module',
          '-e',
          [
            "import assert from 'node:assert/strict';",
            "import { readFileSync } from 'node:fs';",
            "import { createHash } from 'node:crypto';",
            "import { resolve, sep, isAbsolute, win32 } from 'node:path';",
            "const root = resolve('apps/api/src/id-business-v2/online-recharge/engine');",
            "const manifest = JSON.parse(readFileSync(resolve(root, 'SOURCE_MANIFEST.json'), 'utf8'));",
            "assert.equal(manifest.repository, 'https://github.com/nowtostudeyday/PAY-GPT-UPGRADE.git');",
            "assert.equal(manifest.commit, 'ba6cf96312a6953e62edb9d74299d438d12549df');",
            'const rows = manifest.files;',
            'assert.ok(Array.isArray(rows) && rows.length > 0);',
            "assert.ok(rows.some(row => row.path === 'test/payment-observation.test.cjs'));",
            'assert.equal(new Set(rows.map(row => row.path)).size, rows.length);',
            'for (const row of rows) {',
            "  assert.ok(typeof row.path === 'string' && row.path.length > 0 && !isAbsolute(row.path) && !win32.isAbsolute(row.path));",
            "  assert.ok(row.path.split(/[\\\\/]/).every(part => part && part !== '.' && part !== '..'));",
            '  const file = resolve(root, row.path);',
            '  assert.ok(file.startsWith(root + sep) && /^[a-f0-9]{64}$/.test(row.adaptedSha256));',
            "  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), row.adaptedSha256, row.path);",
            '}',
            "console.log('Online engine source fingerprints passed.');"
          ].join('\n')
        ]
      ];
    return [
      ...controls,
      ['python3', '-B', 'scripts/production-release/online-settings-release.test.py'],
      ['python3', '-B', 'scripts/production-release/online-unattended-release.test.py'],
      ...(paths.some((path) => path.includes('online-legacy-close-'))
        ? [['python3', '-B', 'scripts/production-release/online-legacy-close-release.test.py']]
        : []),
      ...(paths.some((path) => path.includes('online-checkout-'))
        ? [['python3', '-B', 'scripts/production-release/online-checkout-release.test.py']]
        : []),
      ...(paths.some((path) => path.includes('online-checkout-retest-'))
        ? [['python3', '-B', 'scripts/production-release/online-checkout-retest-release.test.py']]
        : []),
      ...(paths.some((path) => path.includes('online-browser-display-auth-'))
        ? [
            [
              'python3',
              '-B',
              'scripts/production-release/online-browser-display-auth-release.test.py'
            ]
          ]
        : []),
      ...(controlsOnly
        ? []
        : [
            npm('run', 'test:online-recharge:controls'),
            ...[
              'check:admin-ui',
              'check:v2-ui-language',
              'check:v2-color-contrast',
              'check:v2-table-standard',
              'check:v2-loading-standard',
              'check:v2-module-architecture',
              'check:v2-isolation',
              'check:v2-prisma-runtime-boundary',
              'check:v2-concurrency-standard',
              'check:v2-decimal-standard'
            ].map((name) => npm('run', name))
          ])
    ];
  }
  if (controlsOnly) throw new Error('Unsupported controls-only check');
  if (testsOnly && ['api', 'admin'].includes(part)) throw new Error('Unsupported tests-only check');
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (checkoutLoadBusiness) {
    const upstream = 'apps/api/src/id-business-v2/online-recharge/engine/upstream';
    const browser = [
      npm('ci', '--prefix', upstream, '--ignore-scripts', '--no-audit', '--no-fund'),
      ['node', upstream + '/node_modules/playwright/cli.js', 'install', '--with-deps', 'chromium']
    ];
    if (part === 'admin') throw new Error('Unsupported checkout load recovery Admin check');
    if (checkoutLoadParentRpc && part === 'api')
      throw new Error('Unsupported checkout load parent RPC API check');
    if (part === 'api')
      return [
        npm('run', 'prisma:mysql:generate'),
        shared,
        npm('run', 'typecheck', '--workspace', '@apple-business/api'),
        ...browser,
        npm(
          'run',
          'test',
          '--workspace',
          '@apple-business/api',
          '--',
          'src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts'
        )
      ];
    if (part === 'online-engine')
      return [
        npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'),
        ...browser,
        ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg', 'xvfb', 'xauth'],
        [
          'node',
          '--input-type=module',
          '-e',
          [
            "import { readdirSync } from 'node:fs';",
            "import { spawnSync } from 'node:child_process';",
            "const root = 'apps/api/src/id-business-v2/online-recharge/engine/test';",
            "const files = readdirSync(root).filter(name => name.endsWith('.test.cjs')).sort().map(name => root + '/' + name);",
            "if (!files.length) throw new Error('Missing online engine regression files');",
            `const result = spawnSync(process.execPath, ['--test', '--test-concurrency=${checkoutPreparedFields || sessionRefresh || loginVisibility || authStability ? 1 : 2}', ...files], { stdio: 'inherit' });`,
            'if (result.error) throw result.error;',
            'process.exit(result.status ?? 1);'
          ].join('\n')
        ],
        npm(
          '--prefix',
          'apps/api/src/id-business-v2/online-recharge/engine',
          'run',
          'test:upstream'
        )
      ];
    throw new Error('Unsupported checkout load recovery check part');
  }
  if (checkoutCsRecovery && part === 'admin')
    throw new Error('Unsupported checkout CS recovery Admin check');
  if (checkoutCsRecovery && part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
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
  if (legacyClose) {
    if (part !== 'api') throw new Error('Unsupported legacy closure check');
    return [
      npm('run', 'prisma:mysql:generate'),
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
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
  }
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/online-recharge',
        'src/id-business-v2/proxy-pool',
        'src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      shared,
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/features/online-recharge',
        'src/v2/features/proxy-pool'
      ),
      npm('run', 'typecheck', '--workspace', '@apple-business/admin'),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', 'scripts/acceptance-v2-online-settings-help.mjs'],
      ['node', 'scripts/acceptance-v2-online-settings-ui.mjs']
    ];
  if (part === 'online-engine')
    return [
      npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'),
      npm(
        'ci',
        '--prefix',
        'apps/api/src/id-business-v2/online-recharge/engine/upstream',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund'
      ),
      [
        'node',
        'apps/api/src/id-business-v2/online-recharge/engine/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg', 'xvfb', 'xauth'],
      npm('run', 'test:online-recharge:engine')
    ];
  throw new Error('Unsupported online settings check part');
}
