// This release changes only the independent BitBrowser billing preparation.
// In particular it does not change the sealed ONLINE application projection.
export const billingControlPaths = Object.freeze([
  '.github/workflows/recharge-billing-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py', 'dispatch.py'].map(
    (name) => `scripts/production-release/recharge-billing-${name}`
  ),
  'scripts/ci-recharge-billing-scope.mjs',
  'scripts/ci-recharge-billing-scope.test.mjs'
]);
export const billingMigrationPath =
  'apps/api/prisma-mysql/migrations/20261016020000_recharge_generated_address_locations/migration.sql';
export function isRechargeBillingOnly(paths) {
  return (
    paths.length > 0 &&
    paths.some(
      (p) =>
        p.includes('recharge-billing') ||
        p.includes('RechargeAddressGeneration') ||
        p === billingMigrationPath
    ) &&
    paths.every(
      (p) =>
        !p.includes('/worker/') &&
        (billingControlPaths.includes(p) ||
          p === billingMigrationPath ||
          /^apps\/(?:admin\/src\/v2\/features|api\/src\/id-business-v2)\/auto-recharge\//.test(p) ||
          [
            'scripts/ci-recharge-scope.mjs',
            'scripts/ci-recharge-scope.test.mjs',
            'scripts/ci-recharge-check.mjs'
          ].includes(p) ||
          p === 'scripts/acceptance-v2-recharge-billing.mjs' ||
          /^docs\/.*\.md$/.test(p))
    )
  );
}
