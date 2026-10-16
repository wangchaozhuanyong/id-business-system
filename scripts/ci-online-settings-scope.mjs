const applicationPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
  'apps/admin/src/v2/features/online-recharge/sections.ts',
  'apps/admin/src/v2/features/online-recharge/tableSchemas.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/README.md',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/payment-limit.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/security.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/media-browser.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/tax-free-address.js',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'apps/admin/src/components/ui/FeatureHelp.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineConfigView.vue',
  'apps/admin/src/v2/features/online-recharge/configFields.ts',
  'apps/admin/src/v2/features/online-recharge/contracts.ts',
  'apps/admin/src/v2/features/online-recharge/labels.ts',
  'apps/admin/src/v2/features/online-recharge/planRegionFields.ts',
  'apps/api/src/id-business-v2/online-recharge/contracts.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/paths.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/plans.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-connection.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-resolver.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/safe-media.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-outcomes.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/payment-core.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/plan-regions.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-resolver.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-result-identity.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/regressions.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-recheck.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/rpc-response.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/runtime-main.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/safe-media-finish.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-currency.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-plans.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/third-party.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chile-money.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/mysql-store.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/pricing-checkout.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/region-config.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/test/pricing-checkout.test.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/upgrade-checkout.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/settings.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/plan-region.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/plan-region.ts'
]);
const controlPaths = Object.freeze([
  '.github/workflows/online-checkout-validation.yml',
  'scripts/production-release/online-checkout-build.py',
  'scripts/production-release/online-checkout-contract.json',
  'scripts/production-release/online-checkout-release.py',
  'scripts/production-release/online-checkout-release.test.py',
  '.github/workflows/online-settings-validation.yml',
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/production-release/online-settings-build.py',
  'scripts/production-release/online-settings-contract.json',
  'scripts/production-release/online-settings-release.py',
  'scripts/production-release/online-settings-release.test.py',
  'scripts/acceptance-v2-online-settings-help.mjs',
  'scripts/acceptance-v2-online-settings-ui.mjs'
]);
const documentationPaths = Object.freeze([
  'docs/ONLINE_RECHARGE.md',
  'docs/ONLINE_PLAN_REGIONS_20261016.md',
  'docs/ONLINE_SETTINGS_RELEASE_20261016.md',
  'docs/V2_TASKS.md'
]);
export const onlineSettingsPaths = Object.freeze([
  ...applicationPaths,
  ...controlPaths,
  ...documentationPaths
]);
const required = [
  'plan-region.ts',
  'persistence/admin.repository.ts',
  'persistence/tasks.repository.ts'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const checkoutRequired = [
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js'
];
export function isOnlineSettingsOnly(paths) {
  const databaseTest = 'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts';
  const fixtureRepair =
    paths.includes(databaseTest) &&
    paths.every(
      (path) =>
        path === databaseTest || controlPaths.includes(path) || documentationPaths.includes(path)
    );
  return (
    new Set(paths).size === paths.length &&
    (required.every((path) => paths.includes(path)) ||
      checkoutRequired.every((path) => paths.includes(path)) ||
      fixtureRepair) &&
    paths.every((path) => onlineSettingsPaths.includes(path))
  );
}
export function isOnlineSettingsControlsOnly(paths) {
  return (
    paths.some(
      (path) =>
        controlPaths.includes(path) &&
        ![
          'scripts/ci-recharge-scope.mjs',
          'scripts/ci-recharge-check.mjs',
          'scripts/ci-recharge-scope.test.mjs'
        ].includes(path)
    ) &&
    new Set(paths).size === paths.length &&
    paths.every((path) => controlPaths.includes(path) || documentationPaths.includes(path))
  );
}
export const onlineSettingsParts = Object.freeze(['guards', 'api', 'admin', 'online-engine']);
export function onlineSettingsCommands(part, paths) {
  const controlsOnly = isOnlineSettingsControlsOnly(paths);
  if (!isOnlineSettingsOnly(paths) && !controlsOnly)
    throw new Error('Unsupported online settings scope');
  const npm = (...args) => ['npm', ...args];
  if (part === 'guards') {
    const formatted = paths.filter(
      (path) =>
        /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(path) && !path.includes('/engine/upstream/')
    );
    const linted = paths.filter(
      (path) => /\.(?:mjs|cjs|ts|vue)$/.test(path) && !path.includes('/engine/upstream/')
    );
    return [
      ...(formatted.length ? [npm('exec', '--', 'prettier', '--check', ...formatted)] : []),
      ...(linted.length ? [npm('exec', '--', 'eslint', ...linted)] : []),
      [
        'node',
        '--test',
        'scripts/ci-online-settings-scope.test.mjs',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/ci-change-scope.test.mjs'
      ],
      ['python3', '-B', 'scripts/production-release/online-settings-release.test.py'],
      ...(paths.some((path) => path.includes('online-checkout-'))
        ? [['python3', '-B', 'scripts/production-release/online-checkout-release.test.py']]
        : []),
      ...(controlsOnly
        ? []
        : [
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
          ])
    ];
  }
  if (controlsOnly) throw new Error('Unsupported controls-only check');
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
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
        'src/id-business-v2/proxy-pool',
        'src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts'
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
      npm('run', 'typecheck', '--workspace', '@apple-business/admin'),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', 'scripts/acceptance-v2-online-settings-help.mjs'],
      ['node', 'scripts/acceptance-v2-online-settings-ui.mjs']
    ];
  if (part === 'online-engine')
    return [
      npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'),
      npm(
        'ci',
        '--prefix',
        'apps/api/src/id-business-v2/online-recharge/engine/upstream',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund'
      ),
      [
        'node',
        'apps/api/src/id-business-v2/online-recharge/engine/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg'],
      npm('run', 'test:online-recharge:engine')
    ];
  throw new Error('Unsupported online settings check part');
}
