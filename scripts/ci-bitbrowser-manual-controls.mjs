import { readFileSync } from 'node:fs';

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
  const controlRepair =
    paths.length > 0 &&
    paths.includes('scripts/production-release/bitbrowser-manual-contract.json') &&
    paths.includes('scripts/production-release/bitbrowser-manual-release.test.py') &&
    paths.every((name) => [...manualReleasePaths, ...manualCiPaths].includes(name));
  if (!controlRepair && !manualReleasePaths.every((name) => paths.includes(name))) return false;
  try {
    const c =
      manifest ??
      JSON.parse(
        readFileSync('scripts/production-release/bitbrowser-manual-contract.json', 'utf8')
      );
    if (
      c.status !== 'FROZEN' ||
      c.sourceReviewCommit !== '66c57c383db67f6bcebbe4cda32a9b9a35d6dc00' ||
      Object.keys(c.sources ?? {}).length !== 43 ||
      Object.keys(c.productionSources ?? {}).length !== 32
    )
      return false;
    const allowed = new Set([...Object.keys(c.sources), ...manualReleasePaths, ...manualCiPaths]);
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
