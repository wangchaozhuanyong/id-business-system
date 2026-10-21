import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const manualReleasePaths = Object.freeze([
  '.github/workflows/bitbrowser-manual-validation.yml',
  ...['build.py', 'release.py', 'dispatch.py', 'release.test.py', 'contract.json'].map(
    (name) => `scripts/production-release/bitbrowser-manual-${name}`
  )
]);
export const manualCiPaths = Object.freeze([
  'scripts/ci-bitbrowser-manual-controls.mjs',
  'scripts/ci-bitbrowser-manual-controls.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs'
]);

export function isManualSettlementCandidate(paths, manifest) {
  if (!paths.includes('scripts/production-release/bitbrowser-manual-contract.json')) return false;
  try {
    const c =
      manifest ??
      JSON.parse(
        readFileSync('scripts/production-release/bitbrowser-manual-contract.json', 'utf8')
      );
    if (
      c.status !== 'FROZEN' ||
      c.sourceReviewCommit !== 'bbd28b70baf257f21ab3845bb3439ddf41357537' ||
      Object.keys(c.sources ?? {}).length !== 61 ||
      Object.keys(c.productionSources ?? {}).length !== 43
    )
      return false;
    const patch = c.buildDependencyPatch;
    if (
      patch?.path !== 'package-lock.json' ||
      patch.sourceCommit !== c.sourceReviewCommit ||
      patch.package !== 'follow-redirects' ||
      patch.fromVersion !== '1.16.0' ||
      patch.toVersion !== '1.16.1' ||
      patch.sha256 !== createHash('sha256').update(readFileSync(patch.path)).digest('hex')
    )
      return false;
    const allowed = new Set([
      ...Object.keys(c.sources),
      patch.path,
      ...manualReleasePaths,
      ...manualCiPaths
    ]);
    return new Set(paths).size === paths.length && paths.every((name) => allowed.has(name));
  } catch {
    return false;
  }
}

export function hasOnlineRuntimeChange(paths) {
  return paths.some(
    (name) =>
      name.startsWith('apps/api/src/id-business-v2/online-recharge/') && !name.endsWith('.spec.ts')
  );
}
