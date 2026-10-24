// Exact unpaid validation batch. Adding another business path restores full checks.
export const unpaidValidationPaths = Object.freeze([
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineCheckoutDebugView.vue',
  'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
  'apps/admin/src/v2/features/online-recharge/api.spec.ts',
  'apps/admin/src/v2/features/online-recharge/auditPresentation.spec.ts',
  'apps/admin/src/v2/features/online-recharge/contracts.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts',
  'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/checkout-creation-diagnostics.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/human-verification.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-await-diagnostics.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/evidence-recovery.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/auth-page-detect.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.card-capacity.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
]);
export const unpaidValidationControls = Object.freeze([
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-unpaid-validation-scope.mjs',
  'scripts/ci-unpaid-validation-scope.test.mjs',
  '.github/workflows/online-unpaid-validation-publication.yml',
  'scripts/production-release/online-unpaid-validation-release.py',
  'scripts/production-release/online-unpaid-validation-build.py',
  'scripts/production-release/online-unpaid-validation-publication.py',
  'scripts/production-release/online-unpaid-validation-release.test.py',
  'scripts/production-release/online-unpaid-validation-contract.json'
]);
export function isUnpaidValidationOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    unpaidValidationPaths.filter((p) => p.startsWith('apps/')).every((p) => paths.includes(p)) &&
    paths.every((p) => unpaidValidationPaths.includes(p) || unpaidValidationControls.includes(p))
  );
}
export function isUnpaidValidationControlsOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.some(
      (p) =>
        p.startsWith('scripts/production-release/online-unpaid-validation-') ||
        p.startsWith('scripts/ci-unpaid-validation-') ||
        p === '.github/workflows/online-unpaid-validation-publication.yml'
    ) &&
    paths.every((p) => unpaidValidationControls.includes(p))
  );
}
export function unpaidValidationCommands(part, paths) {
  const controlsOnly = isUnpaidValidationControlsOnly(paths);
  if (!isUnpaidValidationOnly(paths) && !controlsOnly)
    throw new Error('Unsupported unpaid validation scope');
  const npm = (...args) => ['npm', ...args];
  const engine = 'apps/api/src/id-business-v2/online-recharge/engine';
  if (part === 'guards') {
    const formatted = paths.filter(
      (p) => /\.(?:mjs|cjs|ts|vue|json|md|yml)$/.test(p) && !p.includes('/engine/upstream/')
    );
    const linted = paths.filter(
      (p) => /\.(?:mjs|cjs|ts|vue)$/.test(p) && !p.includes('/engine/upstream/')
    );
    return [
      ...(formatted.length ? [npm('exec', '--', 'prettier', '--check', ...formatted)] : []),
      ...(linted.length ? [npm('exec', '--', 'eslint', ...linted)] : []),
      ['node', '--test', 'scripts/ci-unpaid-validation-scope.test.mjs'],
      ['python3', '-B', 'scripts/production-release/online-unpaid-validation-release.test.py'],
      ...(controlsOnly
        ? ['check:v2-module-architecture', 'check:v2-isolation']
        : [
            'check:admin-ui',
            'check:v2-ui-language',
            'check:v2-color-contrast',
            'check:v2-table-standard',
            'check:v2-loading-standard',
            'check:v2-module-architecture',
            'check:v2-isolation',
            'test:online-recharge:controls'
          ]
      ).map((n) => npm('run', n))
    ];
  }
  if (controlsOnly) throw new Error('Control-only update cannot select application checks');
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
      [
        'node',
        engine + '/upstream/node_modules/playwright/cli.js',
        'install',
        '--with-deps',
        'chromium'
      ],
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/online-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/features/online-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin')
    ];
  if (part === 'online-engine')
    return [
      npm('ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
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
  throw new Error('Unsupported unpaid validation part');
}
