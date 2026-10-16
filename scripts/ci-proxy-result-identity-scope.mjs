import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const proxyResultIdentityBase = '7c3c102c98539d33cb379ef018427371ba750cb7';
export const proxyResultIdentityTree = 'f6ab4537e28437af244c2263dd591516ae8e2a22';
export const proxyResultIdentityEngineRoot = 'apps/api/src/id-business-v2/online-recharge/engine';
export const proxyResultIdentitySources = Object.freeze([
  proxyResultIdentityEngineRoot + '/security.cjs',
  proxyResultIdentityEngineRoot + '/SOURCE_MANIFEST.json',
  proxyResultIdentityEngineRoot + '/test/proxy-result-identity.test.cjs',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js'
]);
export const proxyResultIdentityAcceptance = 'scripts/acceptance-v2-registration-console-draft.mjs';
export const proxyResultIdentityControls = Object.freeze([
  '.github/workflows/proxy-result-identity-validation.yml',
  ...['build.py', 'dispatch.py', 'release.py', 'contract.json', 'release.test.py'].map(
    (name) => 'scripts/production-release/proxy-result-identity-' + name
  )
]);
export const proxyResultIdentityCiPaths = Object.freeze([
  'scripts/ci-proxy-result-identity-scope.mjs',
  'scripts/ci-proxy-result-identity-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);
// This is an application repair. Every source and publisher is byte-bound;
// unidentified files use the existing checks instead of this finite channel.
export const proxyResultIdentityPins = Object.freeze({
  '.github/workflows/proxy-result-identity-validation.yml':
    'dc6cf5a3b25cbfc2a40d7eeec4e2ef15333d432c855c17d29bf435160ffaccf5',
  'scripts/production-release/proxy-result-identity-build.py':
    'cd7f0fc7ee2b2dc4b68e99dcb14ae4e21aa495957786fe666c7c6d626c421b0d',
  'scripts/production-release/proxy-result-identity-dispatch.py':
    'e2ee8cd0ff217a75cd62c44f519f07212aba2a7d71f3d2dfe309242b0dbf1ca8',
  'scripts/production-release/proxy-result-identity-release.py':
    '97207252c12924dcbbfe3e86ebf397e928cd9545bbf9260337fd94ffd5109d45',
  'scripts/production-release/proxy-result-identity-contract.json':
    'c3e65f8e73bfa570978a2f1239b1c363b3fd007fff8280d3e43e12f7d775ebfc',
  'scripts/production-release/proxy-result-identity-release.test.py':
    '8c9dc73eb3d914a16c39cd7213684e821c48db995db935de668bdf4f1e7aac77',
  'scripts/acceptance-v2-registration-console-draft.mjs':
    '9eeb65f2d7621a6b9d71a5c37867d3581ebad66134e784ce67b68b6b3ed9d541',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js':
    '16da7ccdb5b131ba52c4d7ff6ad74584ff928e33bda1e3189b86dabb52e32ea3',
  'apps/api/src/id-business-v2/online-recharge/engine/security.cjs':
    '8c72522b9eeab4274c3289761f986c82efdebc63e86e77eb88b23dde5c879b3d',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json':
    '38da5d8679ecc217d4e8ccdf336f91e1d6db180d103dfa874c5d25a52d3d8afd',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-result-identity.test.cjs':
    '0e954be288783466bee0e69fb6863429b72e9d6e5d50c9a3ba6957b34479030e'
});
export const proxyResultIdentityPaths = Object.freeze([
  ...proxyResultIdentitySources,
  ...proxyResultIdentityControls,
  proxyResultIdentityAcceptance,
  ...proxyResultIdentityCiPaths
]);
export const proxyResultIdentityEngineTests = Object.freeze(
  [
    'regressions',
    'dispatch',
    'proxy-test',
    'proxy-worker',
    'proxy-pool',
    'proxy-result-identity'
  ].map((name) => proxyResultIdentityEngineRoot + '/test/' + name + '.test.cjs')
);
export function isProxyResultIdentityOnly(
  paths,
  {
    base = proxyResultIdentityBase,
    baseTree = proxyResultIdentityTree,
    sourceDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  } = {}
) {
  if (
    base !== proxyResultIdentityBase ||
    baseTree !== proxyResultIdentityTree ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !proxyResultIdentityPaths.includes(path)) ||
    [
      ...proxyResultIdentitySources,
      ...proxyResultIdentityControls,
      proxyResultIdentityAcceptance
    ].some((path) => !paths.includes(path)) ||
    Object.keys(proxyResultIdentityPins).length !== 11
  )
    return false;
  try {
    return Object.entries(proxyResultIdentityPins).every(
      ([path, digest]) => /^[a-f0-9]{64}$/.test(digest) && sourceDigest(path) === digest
    );
  } catch {
    return false;
  }
}
