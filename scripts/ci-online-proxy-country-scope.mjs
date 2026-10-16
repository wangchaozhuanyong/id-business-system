const admin = 'apps/admin/src/v2/features/online-recharge/';
const api = 'apps/api/src/id-business-v2/';
const engine = api + 'online-recharge/engine';
export const onlineProxyCountrySources = Object.freeze([
  admin + 'V2OnlineConfigView.vue',
  admin + 'configFields.ts',
  ...[
    'online-recharge/contracts',
    'online-recharge/proxy-input',
    'online-recharge/persistence/settings.repository',
    'online-recharge/persistence/tasks.repository',
    'online-recharge/persistence/worker-rpc.repository',
    'proxy-pool/persistence/online-proxy.repository',
    'proxy-pool/persistence/proxy-pool.repository'
  ].map((name) => api + name + '.ts')
]);
export const onlineProxyCountryPaths = Object.freeze([
  ...onlineProxyCountrySources,
  api + 'online-recharge/mysql.integration.spec.ts',
  api + 'online-recharge/proxy-country.spec.ts',
  engine + '/test/proxy-result-identity.test.cjs',
  engine + '/SOURCE_MANIFEST.json',
  '.github/workflows/online-proxy-country-validation.yml',
  'docs/ONLINE_PROXY_COUNTRY_RELEASE_20261016.md',
  'scripts/acceptance-v2-online-proxy-country.mjs',
  'scripts/acceptance-v2-online-recharge-ui.mjs',
  'scripts/ci-online-proxy-country-scope.mjs',
  'scripts/ci-online-proxy-country-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);
export function isOnlineProxyCountryOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    onlineProxyCountrySources.every((path) => paths.includes(path)) &&
    paths.every((path) => onlineProxyCountryPaths.includes(path))
  );
}
export const onlineProxyCountryParts = Object.freeze(['guards', 'api', 'admin', 'online-engine']);
export function onlineProxyCountryCommands(part, paths) {
  if (!isOnlineProxyCountryOnly(paths)) throw new Error('Unsupported proxy country scope');
  const npm = (...args) => ['npm', ...args];
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (part === 'guards') {
    const formatted = paths.filter((path) => /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(path));
    const linted = paths.filter((path) => /\.(?:mjs|ts|vue)$/.test(path));
    return [
      npm('exec', '--', 'prettier', '--check', ...formatted),
      npm('exec', '--', 'eslint', ...linted),
      [
        'node',
        '--test',
        'scripts/ci-online-proxy-country-scope.test.mjs',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/ci-change-scope.test.mjs'
      ],
      npm('run', 'test:online-recharge:controls'),
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
      ].map((name) => npm('run', name))
    ];
  }
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
        'src/id-business-v2/online-recharge',
        'src/id-business-v2/proxy-pool'
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
        'src/v2/features/online-recharge',
        'src/v2/features/proxy-pool'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', 'scripts/acceptance-v2-online-proxy-country.mjs']
    ];
  if (part === 'online-engine')
    return [
      npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'),
      npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
      [
        'node',
        engine + '/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg'],
      npm('run', 'test:online-recharge:engine')
    ];
  throw new Error('Unsupported proxy country check part');
}
