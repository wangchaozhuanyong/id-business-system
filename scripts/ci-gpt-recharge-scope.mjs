import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Finite task scope. Neighboring source, schema and credentials still select the normal checks.
export const gptRechargePaths = Object.freeze([
  '.env.example',
  '.github/workflows/gpt-recharge-validation.yml',
  '.github/workflows/quality.yml',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/task-acceptance.ts',
  'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.controller.ts',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.service.ts',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/worker-body-parser.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md',
  'scripts/ci-gpt-recharge-scope.mjs',
  'scripts/ci-gpt-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/production-release/api-admin-scope.test.py',
  'scripts/production-release/gpt-recharge-build.py',
  'scripts/production-release/gpt-recharge-contract.json',
  'scripts/production-release/gpt-recharge-release.py',
  'scripts/production-release/gpt-recharge-release.test.py'
]);
export const gptRechargeFrozen = Object.freeze({
  '.env.example': '5d5eb3b30ca29cf2b1581e71ef5901956b004cd4b8a2e77e48e9b1b49c54babc',
  '.github/workflows/gpt-recharge-validation.yml':
    'e9ae51d23b71e133fb1a6080206c5861a96ecda8b6914052705d48368f63e1be',
  '.github/workflows/quality.yml':
    '671e0783eda037a1937bf417f7f731b694df8cd2bbcc8c859c839ed58f0f0ff6',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts':
    'edbd04030f20d675932d9c360e653e3fc3ca8a0a870b1e97dc3a0b30772df59f',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts':
    'c40188f03a3f8bcf4819ef2c25c867dc979f44ae9d970a541648e87ca3ee8f36',
  'apps/api/src/id-business-v2/online-recharge/task-acceptance.ts':
    'd97e345a1935a20f7974aad0d28bb2d9af56c42f7fa373305b2e2636daff8fe3',
  'apps/api/src/id-business-v2/online-recharge/tasks.service.ts':
    'e4d8adfc2c0be3efc6cba4d3519c4ea2027a4170fcf28624624c5a1e11633a35',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.controller.ts':
    '9d5ac1295565d819666d68e6e99ff56b97a234a535ec0a6028bb7fda2220d37a',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.service.ts':
    '9f3a2085c4f8ae9b033346bb16831bdf78dc194f538f6d0390a5fe63b9bce3e9',
  'apps/api/src/id-business-v2/online-recharge/vendure-integration.spec.ts':
    '8780447b911f82ac1381afd0d1ee7063244e0204c7720d8c59e6989c01c0dfa5',
  'apps/api/src/id-business-v2/online-recharge/worker-body-parser.ts':
    '2471cba84936dc8c36f25feef210d641a0f5c8c4a22ccde6e684396069e57619',
  'scripts/ci-recharge-check.mjs':
    'e07c4589d671513a77625ce6be758d01b271a935b698386be22bd166a9bbce8a',
  'scripts/ci-recharge-scope.mjs':
    'a41193db27dfcaff03271c77702c95b8215ca16d60642523c9535799d13af40b',
  'scripts/ci-recharge-scope.test.mjs':
    '8199b4d89c0645e30ec54eeda82aece0af0bfc19268e5178c6d35a7cfecb5576',
  'scripts/production-release/api-admin-scope.test.py':
    '41d1b862c1beb9caa35e130d8268583c5f349c782d89aedb247824ce5b722c98',
  'scripts/production-release/gpt-recharge-build.py':
    '30c8d0a909b784a84c42aee67d86c66c69f2e8717f5d9c401b9dd3f53097e362',
  'scripts/production-release/gpt-recharge-contract.json':
    '2ee7dd00ef1664b194734f8ce93084976d335413b2e8ff92d5957da564f16e89',
  'scripts/production-release/gpt-recharge-release.py':
    'ada30647832f361e74fed35f6aea0df9f5351a4358b66661ce1ddd9ed8422812',
  'scripts/production-release/gpt-recharge-release.test.py':
    '68dfc046ca1491c73010fbfbaae3d80d0a302deaf3bf489ebfb331ab9734622a'
});
export const gptRechargeControlRepairPaths = Object.freeze([
  'scripts/production-release/gpt-recharge-release.py',
  'scripts/production-release/gpt-recharge-release.test.py',
  'scripts/ci-gpt-recharge-scope.mjs',
  'scripts/ci-gpt-recharge-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs'
]);

export function isGptRechargeControlsOnly(paths, readSource = (name) => readFileSync(name)) {
  if (
    !paths.includes('scripts/production-release/gpt-recharge-release.py') ||
    !paths.includes('scripts/production-release/gpt-recharge-release.test.py') ||
    !paths.every((name) => gptRechargeControlRepairPaths.includes(name))
  )
    return false;
  try {
    return Object.entries(gptRechargeFrozen).every(
      ([name, expected]) => createHash('sha256').update(readSource(name)).digest('hex') === expected
    );
  } catch {
    return false;
  }
}

export function affectsGptRechargeArtifact(paths) {
  return paths.some(
    (name) => name === 'scripts/ci-gpt-recharge-scope.mjs' || Object.hasOwn(gptRechargeFrozen, name)
  );
}

export function isGptRechargeOnly(paths, readSource = (name) => readFileSync(name)) {
  if (!paths.length || !paths.every((name) => gptRechargePaths.includes(name))) return false;
  const application = Object.keys(gptRechargeFrozen).filter(
    (name) => name.startsWith('apps/api/') && !/\.(spec|test)\./.test(name)
  );
  if (!application.every((name) => paths.includes(name))) return false;
  try {
    return Object.entries(gptRechargeFrozen).every(
      ([name, expected]) => createHash('sha256').update(readSource(name)).digest('hex') === expected
    );
  } catch {
    return false;
  }
}
