import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Finite task scope. Neighboring source, schema and credentials still select the normal checks.
export const gptRechargePaths = Object.freeze([
  '.env.example',
  '.github/workflows/gpt-recharge-validation.yml',
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
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts':
    '5ebb28f4ca4592bfd2b92ad837d78f1036112f0c5780ec97f093dcd9e1fe113d',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts':
    '15f3113b9ecd4353aabde76ea1358512f2d2c11820ce6b1257623feaad87676f',
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
    '74f08eefc8055630e59fc1ce1c08b7abc9e93ce8ecc1f80f43c9fecd155032c2',
  'scripts/ci-recharge-scope.mjs':
    '6346a52e712a2420e46efcce99ffc8b4d0a789fc37f95d7b98e77842eaa6c5a1',
  'scripts/ci-recharge-scope.test.mjs':
    '07455e0799e29203b9af5e702a18b3dd54fc3512b71d3426a0cc556891abdc93',
  'scripts/production-release/api-admin-scope.test.py':
    '41d1b862c1beb9caa35e130d8268583c5f349c782d89aedb247824ce5b722c98',
  'scripts/production-release/gpt-recharge-build.py':
    'fa68c7d52d0f7f908ecd865cad2bfa070cb1625cf648932bae331427f53417a7',
  'scripts/production-release/gpt-recharge-contract.json':
    '67544e17f724f4cf994b5167f88e362e711bc8bffb6cffd7b0eae8f7b7597e6e',
  'scripts/production-release/gpt-recharge-release.py':
    '5f99d7358641d1d30b4b5313d846abd9618f7806b9fc2b6d620099543cbc9f5f',
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
