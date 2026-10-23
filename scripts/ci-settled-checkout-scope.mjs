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
  return [
    ['scripts/production-release/settled-checkout-contract.json', settledCheckoutControlPaths],
    ['scripts/production-release/bitbrowser-quote-contract.json', quoteTierControlPaths]
  ].some(
    ([contract, allowed]) =>
      paths.includes(contract) &&
      new Set(paths).size === paths.length &&
      paths.every((name) => allowed.includes(name))
  );
}

export const quoteTierControlPaths = Object.freeze([
  '.github/workflows/bitbrowser-quote-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (name) => 'scripts/production-release/bitbrowser-quote-' + name
  ),
  'scripts/ci-settled-checkout-scope.mjs',
  'scripts/ci-settled-checkout-scope.test.mjs',
  'scripts/ci-recharge-check.mjs'
]);
