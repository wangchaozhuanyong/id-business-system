export const settledCheckoutControlPaths = Object.freeze([
  '.github/workflows/settled-checkout-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/settled-checkout-' + name
  ),
  'scripts/ci-settled-checkout-scope.mjs',
  'scripts/ci-settled-checkout-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs'
]);

export function isSettledCheckoutControlsOnly(paths) {
  return (
    paths.includes('scripts/production-release/settled-checkout-contract.json') &&
    new Set(paths).size === paths.length &&
    paths.every((name) => settledCheckoutControlPaths.includes(name))
  );
}
