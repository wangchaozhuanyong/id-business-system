// Native checkout fixes cannot select ONLINE, database or dependency changes.
export const checkoutControlPaths = Object.freeze([
  '.github/workflows/recharge-checkout-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py', 'dispatch.py'].map(
    (name) => `scripts/production-release/recharge-checkout-${name}`
  ),
  'scripts/ci-recharge-checkout-scope.mjs',
  'scripts/ci-recharge-checkout-scope.test.mjs'
]);
const support = new Set([
  ...checkoutControlPaths,
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/acceptance-v2-auto-recharge.mjs',
  'packages/shared/src/v2/auto-recharge.ts',
  'docs/V2_TASKS.md',
  'docs/AUTO_RECHARGE_NATIVE_CHECKOUT_20261016.md'
]);
export const checkoutSourceRecoveryControls = Object.freeze([
  '.github/workflows/recharge-source-recovery-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py', 'dispatch.py'].map(
    (name) => `scripts/production-release/recharge-source-recovery-${name}`
  )
]);
const sourceRecoveryPaths = new Set([
  ...checkoutSourceRecoveryControls,
  'apps/api/src/id-business-v2/auto-recharge/worker/payment_form.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_payment_form_focus.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py',
  'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.spec.ts',
  'scripts/ci-recharge-checkout-scope.mjs',
  'scripts/ci-recharge-checkout-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/V2_TASKS.md',
  'docs/CHECKOUT_SOURCE_RECOVERY_20261016.md'
]);
export function isRechargeSourceRecoveryOnly(paths) {
  return (
    paths.length > 0 &&
    (paths.some((path) => checkoutSourceRecoveryControls.includes(path)) ||
      ['payment_form.py', 'test_payment_form_focus.py'].every((name) =>
        paths.includes(`apps/api/src/id-business-v2/auto-recharge/worker/${name}`)
      )) &&
    paths.every((path) => sourceRecoveryPaths.has(path))
  );
}
export function isRechargeCheckoutOnly(paths) {
  if (isRechargeSourceRecoveryOnly(paths)) return true;
  return (
    paths.length > 0 &&
    paths.some((p) => checkoutControlPaths.includes(p) || p.endsWith('/native_checkout.py')) &&
    paths.every(
      (p) =>
        support.has(p) ||
        /^apps\/(?:admin\/src\/v2\/features|api\/src\/id-business-v2)\/auto-recharge\//.test(p)
    )
  );
}
