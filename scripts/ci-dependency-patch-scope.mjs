import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// This exact package-only patch keeps full API/Admin/DB/UI checks. The frozen
// historical ONLINE image producer cannot consume unrelated root manifests.
export const dependencyPatchSources = Object.freeze({
  '.github/workflows/quality.yml':
    '99bf8c66b750980fc612c798fe7610ac20190b147b5668516a22f2d5f199faeb',
  'package.json': 'f2da8ada6b06e2050a98060375b30ced0bfd95a4aff728e653628afb443d9e69',
  'package-lock.json': '1e0ec3f854b87981e22ff6f9cfd4e735a3844aaaa3c026264d269069900cacf6',
  'apps/api/package.json': '86e1139bad4bf05dda6369f0817d6a66ba4ebdd51298be6c0fb6e1ed198cc786',
  'scripts/dependency-security-regressions.test.mjs':
    '1d0c9efcda18ce2d2edc6afa617d4e4615e0797ef1a72bdcc864f79a07a6f23b'
});
export const dependencyPatchPaths = Object.freeze([
  ...Object.keys(dependencyPatchSources),
  'docs/V2_TASKS.md',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-dependency-patch-scope.mjs',
  'scripts/ci-dependency-patch-scope.test.mjs'
]);
const digest = (name) =>
  createHash('sha256')
    .update(readFileSync(new URL('../' + name, import.meta.url)))
    .digest('hex');

export function isDependencyPatchCandidate(paths, readDigest = digest) {
  if (
    paths.length !== dependencyPatchPaths.length ||
    new Set(paths).size !== paths.length ||
    !dependencyPatchPaths.every((name) => paths.includes(name))
  )
    return false;
  try {
    return Object.entries(dependencyPatchSources).every(
      ([name, expected]) => readDigest(name) === expected
    );
  } catch {
    return false;
  }
}
