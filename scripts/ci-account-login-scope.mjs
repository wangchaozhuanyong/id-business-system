import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(new URL('./production-release/account-login-contract.json', import.meta.url))
);
export const accountLoginParts = Object.freeze([
  'guards',
  'api',
  'admin',
  'connector',
  'migration'
]);
export const accountLoginPaths = Object.freeze([
  ...Object.keys(contract.sources),
  ...Object.keys(contract.supportSources),
  ...[
    'build.py',
    'contract.json',
    'database.mjs',
    'dispatch.py',
    'release.py',
    'release.test.py'
  ].map((n) => 'scripts/production-release/account-login-' + n),
  '.github/workflows/account-login-validation.yml',
  'scripts/ci-account-login-scope.mjs',
  'scripts/ci-account-login-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'docs/V2_TASKS.md',
  'docs/V2_PRODUCT_SCOPE.md',
  'docs/V2_LOADING_STANDARD.md',
  'docs/ACCOUNT_LOGIN_SEARCH_20261016.md'
]);
export function isAccountLoginOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    Object.keys(contract.sources).every((n) => paths.includes(n)) &&
    paths.every((n) => accountLoginPaths.includes(n))
  );
}
export function accountLoginSchemaMatches(before, after) {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  return (
    sha(before) === contract.sourceSchemaBeforeSha256 &&
    sha(after) === contract.sources['apps/api/prisma-mysql/schema.prisma']
  );
}
export function accountLoginCommands(part, paths) {
  if (!isAccountLoginOnly(paths)) throw new Error('Unsupported account login publication scope');
  const npm = (...args) => ['npm', ...args];
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (part === 'guards')
    return [
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...paths.filter((n) => /\.(?:mjs|ts|vue|json|md|yml)$/.test(n))
      ),
      npm('exec', '--', 'eslint', ...paths.filter((n) => /\.(?:mjs|ts|vue)$/.test(n))),
      ['python3', '-B', 'scripts/production-release/account-login-release.test.py'],
      [
        'node',
        '--test',
        'scripts/ci-account-login-scope.test.mjs',
        'scripts/backfill-chatgpt-email-search.test.mjs'
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
        'check:v2-concurrency-standard'
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
        'src/id-business-v2/auto-recharge',
        'src/id-business-v2/workspace/recharge-mail-code.spec.ts'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/admin'),
      npm('run', 'test', '--workspace', '@apple-business/admin'),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', 'scripts/acceptance-v2-chatgpt-account-sales.mjs']
    ];
  if (part === 'migration')
    return [
      npm('run', 'prisma:mysql:generate'),
      shared,
      ['node', 'scripts/production-release/account-login-database.mjs', '--quality']
    ];
  if (part === 'connector')
    return [
      [
        'python3',
        '-m',
        'unittest',
        'discover',
        '-s',
        'apps/api/src/id-business-v2/auto-recharge/worker',
        '-p',
        'test_*login.py'
      ],
      [
        'python3',
        '-m',
        'unittest',
        'discover',
        '-s',
        'apps/api/src/id-business-v2/auto-recharge/worker',
        '-p',
        'test_recharge_email_code.py'
      ],
      [
        'python3',
        '-m',
        'unittest',
        'discover',
        '-s',
        'apps/api/src/id-business-v2/auto-recharge/worker',
        '-p',
        'test_bitbrowser*.py'
      ]
    ];
  throw new Error('Unsupported account login check part');
}
