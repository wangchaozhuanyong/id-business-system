import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(new URL('./production-release/chatgpt-sales-contract.json', import.meta.url))
);
const sources = Object.keys(contract.sources);
export const chatgptSalesPaths = Object.freeze([
  ...sources,
  ...[
    'build.py',
    'contract.json',
    'database.mjs',
    'dispatch.py',
    'release.py',
    'release.test.py'
  ].map((n) => 'scripts/production-release/chatgpt-sales-' + n),
  '.github/workflows/chatgpt-sales-validation.yml',
  'docs/CHATGPT_ACCOUNT_SALES_20261016.md',
  'docs/V2_PRODUCT_SCOPE.md',
  'docs/V2_TASKS.md',
  'scripts/acceptance-v2-chatgpt-account-sales.mjs',
  'scripts/acceptance-v2-financial-integrity.mjs',
  'scripts/ci-chatgpt-sales-scope.mjs',
  'scripts/ci-chatgpt-sales-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-evidence.mjs',
  'scripts/lib/owned-mysql-test-instance.mjs',
  'scripts/lib/owned-mysql-test-instance.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-connection.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json'
]);
const controlPaths = new Set(
  chatgptSalesPaths.filter(
    (n) =>
      n.startsWith('scripts/production-release/chatgpt-sales-') ||
      n.startsWith('scripts/ci-chatgpt-sales-') ||
      n.startsWith('scripts/lib/owned-mysql-test-instance') ||
      [
        'scripts/ci-recharge-check.mjs',
        'scripts/ci-recharge-scope.mjs',
        'scripts/ci-recharge-evidence.mjs',
        '.github/workflows/chatgpt-sales-validation.yml',
        'docs/CHATGPT_ACCOUNT_SALES_20261016.md'
      ].includes(n)
  )
);
export function isChatgptSalesControlsOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.some(
      (n) =>
        n.startsWith('scripts/production-release/chatgpt-sales-') ||
        n.startsWith('scripts/ci-chatgpt-sales-')
    ) &&
    paths.every((n) => controlPaths.has(n))
  );
}
export const chatgptSalesParts = Object.freeze(['guards', 'api', 'admin', 'migration']);
export function isChatgptSalesOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    sources.every((n) => paths.includes(n)) &&
    paths.every((n) => chatgptSalesPaths.includes(n))
  );
}
export function chatgptSalesSchemaMatches(before, after) {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  return (
    sha(before) === 'fb2d77e1ecf9b336da7db0f2fcf6385a804eb3a818f83748165d162b99bb8de8' &&
    sha(after) === contract.sources['apps/api/prisma-mysql/schema.prisma']
  );
}
export function chatgptSalesCommands(part, paths) {
  const controlsOnly = isChatgptSalesControlsOnly(paths);
  if (!isChatgptSalesOnly(paths) && !controlsOnly)
    throw new Error('Unsupported account sales scope');
  const npm = (...args) => ['npm', ...args];
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (controlsOnly) {
    if (part !== 'guards') throw new Error('Unsupported sale control check part');
    const formatted = paths.filter((n) => /\.(?:mjs|json|md|yml)$/.test(n));
    const linted = paths.filter((n) => /\.mjs$/.test(n));
    return [
      ...(formatted.length ? [npm('exec', '--', 'prettier', '--check', ...formatted)] : []),
      ...(linted.length ? [npm('exec', '--', 'eslint', ...linted)] : []),
      ['python3', '-B', 'scripts/production-release/chatgpt-sales-release.test.py'],
      [
        'node',
        '--test',
        'scripts/ci-chatgpt-sales-scope.test.mjs',
        ...(paths.some((n) => n.startsWith('scripts/lib/owned-mysql-test-instance'))
          ? ['scripts/lib/owned-mysql-test-instance.test.mjs']
          : [])
      ]
    ];
  }

  if (part === 'guards')
    return [
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...paths.filter((n) => /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(n))
      ),
      npm('exec', '--', 'eslint', ...paths.filter((n) => /\.(?:mjs|cjs|ts|vue)$/.test(n))),
      ['python3', '-B', 'scripts/production-release/chatgpt-sales-release.test.py'],
      [
        'node',
        '--test',
        'scripts/ci-chatgpt-sales-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/ci-change-scope.test.mjs'
      ],
      [
        'node',
        '--test',
        'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-pool.test.cjs'
      ],
      ...[
        'check:admin-ui',
        'check:v2-ui-language',
        'check:v2-color-contrast',
        'check:v2-table-standard',
        'check:v2-loading-standard',
        'check:v2-module-architecture',
        'check:v2-isolation',
        'check:v2-prisma-runtime-boundary',
        'check:v2-concurrency-standard',
        'check:v2-decimal-standard'
      ].map((n) => npm('run', n))
    ];
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/auto-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      shared,
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/features/auto-recharge',
        'src/v2/features/audit-logs'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', 'scripts/acceptance-v2-chatgpt-account-sales.mjs']
    ];
  if (part === 'migration')
    return [
      npm('run', 'prisma:mysql:generate'),
      shared,
      ['node', 'scripts/production-release/chatgpt-sales-database.mjs', '--quality']
    ];
  throw new Error('Unsupported account sales check part');
}
