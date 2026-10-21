// Publication controls cannot admit an application, database, executor,
// dependency or existing publisher change into this control-only route.
export const financialPublicationControlPaths = Object.freeze([
  '.github/workflows/financial-closure-publication.yml',
  ...['release.py', 'publication.py', 'release.test.py', 'contract.json', 'parent-proof.json'].map(
    (name) => 'scripts/production-release/financial-closure-' + name
  ),
  'scripts/ci-financial-publication-scope.mjs',
  'scripts/ci-financial-publication-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/V2_TASKS.md',
  'docs/ONLINE_RECHARGE.md'
]);

export function isFinancialPublicationControlsOnly(paths) {
  return (
    paths.includes('scripts/production-release/financial-closure-contract.json') &&
    new Set(paths).size === paths.length &&
    paths.every((name) => financialPublicationControlPaths.includes(name))
  );
}
