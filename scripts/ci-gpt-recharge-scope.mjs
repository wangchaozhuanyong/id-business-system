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
    'dde08b02ba8d9fd807fbe28939fbe61351158e2e11435de504b9640591402c6f',
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
    'a4f49a02da6505e99066ee3aa5a317992cabeae1979755bdc0cd0bcb8901cb67',
  'scripts/ci-recharge-scope.mjs':
    '5811f98422a655287da3e7403c9da605759505e18f88b313444df52c9a87f3ca',
  'scripts/ci-recharge-scope.test.mjs':
    '8199b4d89c0645e30ec54eeda82aece0af0bfc19268e5178c6d35a7cfecb5576',
  'scripts/production-release/api-admin-scope.test.py':
    '41d1b862c1beb9caa35e130d8268583c5f349c782d89aedb247824ce5b722c98',
  'scripts/production-release/gpt-recharge-build.py':
    'a3bd39ee133103378b58bd2c083dada0ef14a0a148871ff41b4de63d93e4991e',
  'scripts/production-release/gpt-recharge-contract.json':
    '94173a2758bed2ebdf98970b108bc4c1865751e5aeb4daa11a83bdd155396ea2',
  'scripts/production-release/gpt-recharge-release.py':
    'f842baebb19a980ed8ee0491f7c9bd25bbd94b32e19ce6f5d6d3284edfdf3a17',
  'scripts/production-release/gpt-recharge-release.test.py':
    'e247037925646fd86ac24b4820f531d03e4d54bc6fc98b8365c3527d13983801'
});
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
