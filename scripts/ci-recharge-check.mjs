import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adminCheckCommands,
  adminUiGuardChecks,
  backendArchitectureGuardChecks,
  auditRetentionMigration,
  historicalReleaseControlPaths,
  hasRegistrationOnboardingScope,
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest
} from './ci-recharge-scope.mjs';

const [part, base] = process.argv.slice(2);
const mode = process.env.CHECK_MODE || 'recharge';
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
const npm = (...args) => run('npm', args);
const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const shared = () => npm('run', 'build', '--workspace', '@apple-business/shared');
const onlineEngine = () => {
  const directory = 'apps/api/src/id-business-v2/online-recharge/engine/upstream';
  npm('ci', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund');
  run('node', [
    directory + '/node_modules/playwright/cli.js',
    'install',
    '--with-deps',
    'chromium'
  ]);
  if (process.platform === 'linux')
    run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg']);
  npm('run', 'test:online-recharge:engine');
};
const onlineReleaseControlPaths = new Set([
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  '.github/workflows/production-release.yml',
  'scripts/ci-recharge-check.mjs',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh'
]);
const retirementControlPaths = [
  '.github/workflows/production-release.yml',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/retire-orphan-retention.py',
  'scripts/production-release/retire-orphan-retention.test.py'
];
const preparedControlPaths = [
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/reuse-images.py',
  'scripts/production-release/prepared-images.test.py'
];
const registrationControlPaths = [
  'deploy/aws/registration-worker-96-20261008.json',
  'deploy/aws/registration-baseline-96-20261008.json',
  'scripts/production-release/registration-onboarding-96.py',
  'scripts/production-release/registration-onboarding-96.test.py',
  'deploy/aws/registration-worker-b8-80-20261006.json',
  'deploy/aws/registration-worker-956-20261006.json',
  'deploy/aws/registration-worker-85-20261006.json',
  'deploy/aws/registration-worker-86-20261006.json',
  'deploy/aws/registration-worker-87-20261006.json',
  'deploy/aws/registration-worker-88-20261006.json',
  'deploy/aws/registration-worker-89-20261006.json',
  'deploy/aws/registration-worker-90-20261007.json',
  'deploy/aws/registration-worker-91-20261007.json',
  'deploy/aws/registration-worker-92-20261007.json',
  'deploy/aws/registration-worker-93-20261007.json',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs',
  'scripts/production-release/registration-only-transport.test.py',
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py'
];
const releaseMaintenanceControls = () => {
  if (changed.some((path) => retirementControlPaths.includes(path)))
    run('python3', ['-B', 'scripts/production-release/retire-orphan-retention.test.py']);
  if (changed.some((path) => preparedControlPaths.includes(path)))
    run('python3', ['-B', 'scripts/production-release/prepared-images.test.py']);
  if (
    changed.some((path) =>
      [
        '.github/workflows/production-release.yml',
        'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
        'scripts/production-release/build-images.sh',
        'scripts/production-release/build-image-cache.test.py',
        'scripts/production-release/browser-cache-input.py',
        'scripts/production-release/browser-cache-input.test.py'
      ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/build-image-cache.test.py']);
    run('python3', ['-B', 'scripts/production-release/browser-cache-input.test.py']);
  }
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/service-image-retention') ||
        path === '.github/workflows/production-release.yml'
    )
  )
    run('python3', ['-B', 'scripts/production-release/service-image-retention.test.py']);
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/maintain-image-cache') ||
        path.startsWith('scripts/production-release/service-image-retention') ||
        path === '.github/workflows/production-release.yml'
    )
  )
    run('python3', ['-B', 'scripts/production-release/maintain-image-cache.test.py']);
};
const archiveReleaseControls = () => {
  run('node', ['--test', 'scripts/v2-order-archive-release-policy.test.mjs']);
};
const onlineRecoveryGrantControls = () => {
  if (
    changed.some((path) =>
      [
        onlineRechargeRecoveryPolicy,
        productionDatabaseAccessHelper,
        productionDatabaseAccessTest
      ].includes(path)
    )
  )
    run('node', ['--test', productionDatabaseAccessTest]);
};

if (part === 'guards') {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  const existing = changed.filter((p) => existsSync(p));
  const formatted = existing.filter((p) => /\.(?:[cm]?js|ts|vue|css|json|md|yml)$/.test(p));
  const linted = existing.filter((p) => /\.(?:mjs|ts|vue)$/.test(p));
  if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
  if (linted.length) npm('exec', '--', 'eslint', ...linted);
  run('node', [
    '--test',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/check-cloud-independence.test.mjs',
    'scripts/check-v2-prisma-runtime-boundary.test.mjs',
    'scripts/check-v2-module-architecture.test.mjs',
    'scripts/ci-recharge-precision.test.mjs',
    'scripts/ci-change-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/admin-layout-rules.test.mjs'
  ]);
  if (
    changed.some(
      (path) =>
        /^scripts\/(?:native-[\w.-]+|start-native-worker(?:\.test)?\.mjs|doctor(?:\.test)?\.mjs|lib\/native-mysql-[\w.-]+)$/.test(
          path
        ) ||
        [
          'scripts/acceptance-v2-financial-integrity.mjs',
          'scripts/acceptance-v2-rollback-integrity.mjs',
          'scripts/acceptance-v2-data-governance.mjs',
          'scripts/acceptance-v2-data-governance.test.mjs',
          'scripts/acceptance-native-child-output.test.mjs',
          'scripts/ci-recharge-migration.py',
          'scripts/production-release/audit-retention-mysql.test.py',
          'scripts/lib/native_mysql_fixture.py'
        ].includes(path)
    )
  )
    npm('run', 'test:native-runtime');
  if (
    changed.some((path) =>
      [
        'apps/api/src/id-business-v2/workspace/media-resolver/server.py',
        'apps/api/src/id-business-v2/workspace/media-resolver/test_native_startup.py'
      ].includes(path)
    )
  )
    run('python3', [
      '-B',
      'apps/api/src/id-business-v2/workspace/media-resolver/test_native_startup.py'
    ]);
  if (changed.some((path) => historicalReleaseControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-release-history-policy.test.mjs']);
    run('node', ['--test', 'scripts/v2-release-maintenance-policy.test.mjs']);
    run('node', ['--test', 'scripts/v2-release-mailbox-audit.test.mjs']);
  }
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/') ||
        path === '.github/workflows/production-release.yml' ||
        path === 'scripts/ci-recharge-check.mjs'
    )
  )
    run('python3', ['-B', 'scripts/production-release/api-admin-scope.test.py']);
  if (
    changed.some((path) => path.includes('online-recharge') || onlineReleaseControlPaths.has(path))
  ) {
    onlineRecoveryGrantControls();
    run('python3', ['-B', 'scripts/production-release/online-recharge-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-readonly.test.py']);
    run('node', ['--test', 'scripts/production-release/online-recharge-entry.test.mjs']);
  }
  releaseMaintenanceControls();
  archiveReleaseControls();
  if (
    changed.some((path) =>
      [
        'scripts/backup-aws-mysql.sh',
        'scripts/verify-aws-mysql-backup.sh',
        'scripts/mysql-dump-restore-normalizer.sed',
        'scripts/aws-mysql-backup.test.mjs'
      ].includes(path)
    )
  )
    run('node', ['--test', 'scripts/aws-mysql-backup.test.mjs']);
  if (changed.some((path) => /^scripts\/admin-skin-rules(?:\.test)?\.mjs$/.test(path)))
    run('node', ['--test', 'scripts/admin-skin-rules.test.mjs']);
  if (changed.some((path) => path.startsWith('scripts/production-release/cleanup-reviewed-cache')))
    run('python3', ['-B', 'scripts/production-release/cleanup-reviewed-cache.test.py']);
  if (
    changed.some((path) => path.startsWith('scripts/production-release/cleanup-verified-backups'))
  )
    run('python3', ['-B', 'scripts/production-release/cleanup-verified-backups.test.py']);
  if (
    changed.includes('deploy/aws/recharge-pro-menu-b8-20261005.json') ||
    changed.includes('deploy/aws/recharge-pro-menu-7f-20261005.json') ||
    changed.includes('deploy/aws/recharge-pro-main80-20261006.json') ||
    changed.includes('deploy/aws/recharge-pro-974-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-b8-80-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-956-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-85-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-86-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-87-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-88-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-89-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-90-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-91-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-92-20261007.json') ||
    changed.some((path) => path.startsWith('scripts/production-release/'))
  )
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py']);
  if (changed.some((path) => registrationControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-registration-finance-audit.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py', 'ReleaseScopeTests']);
  }
  if (hasRegistrationOnboardingScope(changed))
    run('python3', ['-B', 'scripts/production-release/registration-onboarding-96.test.py']);
  if (changed.some((path) => path.startsWith('scripts/production-release/storage-maintenance')))
    run('python3', ['-B', 'scripts/production-release/storage-maintenance.test.py']);
  if (
    changed.includes('.github/workflows/production-release.yml') ||
    changed.some((path) => path.startsWith('scripts/production-release/mailbox-diagnostic'))
  ) {
    run('node', ['--test', 'scripts/production-release/mailbox-diagnostic.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/mailbox-diagnostic.test.py']);
  }
  if (
    changed.includes(auditRetentionMigration) ||
    changed.includes('scripts/production-release/audit-retention-mysql.test.py')
  )
    run('python3', ['-B', 'scripts/production-release/audit-retention-mysql.test.py']);
  const uiChecks = adminUiGuardChecks(mode, changed);
  if (
    changed.some(
      (path) =>
        path.includes('online-recharge') ||
        /^scripts\/check-v2-(?:table|loading|input-retention|decimal)-standard/.test(path)
    )
  )
    npm('run', 'test:online-recharge:controls');
  const architectureChecks = backendArchitectureGuardChecks(mode, changed);
  for (const name of new Set([...uiChecks, ...architectureChecks])) npm('run', name);
  if (!uiChecks.length && mode !== 'ci-only' && mode !== 'audit-retention') {
    npm(
      'run',
      'check:v2-decimal-standard',
      '--',
      'apps/admin/src/v2/features/auto-recharge',
      'apps/api/src/id-business-v2/auto-recharge',
      'packages/shared/src/v2'
    );
    npm('run', 'check:v2-ui-language', '--', 'apps/admin/src/v2/features/auto-recharge');
  }
} else if (part === 'release-controls') {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  if (
    changed.some(
      (path) =>
        historicalReleaseControlPaths.includes(path) ||
        path.startsWith('scripts/production-release/') ||
        [
          '.github/workflows/quality.yml',
          'scripts/ci-recharge-check.mjs',
          'scripts/ci-recharge-scope.mjs',
          'scripts/ci-recharge-release.test.mjs'
        ].includes(path)
    )
  )
    run('node', ['--test', 'scripts/ci-recharge-release.test.mjs']);
  if (changed.some((path) => registrationControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-registration-finance-audit.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py', 'ReleaseScopeTests']);
  }
  if (hasRegistrationOnboardingScope(changed))
    run('python3', ['-B', 'scripts/production-release/registration-onboarding-96.test.py']);
  // Full npm test already runs backup, finite history and its nested remote
  // deployment suite. Add only the missing preparation/retirement controls.
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/') ||
        path === '.github/workflows/production-release.yml' ||
        path === 'scripts/ci-recharge-check.mjs'
    )
  )
    run('python3', ['-B', 'scripts/production-release/api-admin-scope.test.py']);
  if (
    changed.some((path) => path.includes('online-recharge') || onlineReleaseControlPaths.has(path))
  ) {
    onlineRecoveryGrantControls();
    run('python3', ['-B', 'scripts/production-release/online-recharge-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-readonly.test.py']);
    run('node', ['--test', 'scripts/production-release/online-recharge-entry.test.mjs']);
  }
  releaseMaintenanceControls();
  archiveReleaseControls();
} else if (part === 'admin') {
  for (const args of adminCheckCommands(mode, changed)) npm(...args);
} else if (part === 'api') {
  npm('run', 'prisma:mysql:generate');
  npm('run', 'prisma:mysql:validate');
  shared();
  if (mode === 'mailbox')
    npm(
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.spec.ts',
      'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts',
      'src/id-business-v2/workspace/id-business-v2-mail-viewer.service.spec.ts'
    );
  else
    npm(
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/auto-recharge',
      ...(changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/'))
        ? ['src/id-business-v2/online-recharge']
        : []),
      ...(changed.some((p) => p.startsWith('apps/api/src/auth/'))
        ? ['src/auth', 'src/security']
        : []),
      ...(changed.some((p) =>
        /^apps\/api\/src\/id-business-v2\/workspace\/(?:recharge-mail-code|id-business-v2-vendure-mailbox\.service|id-business-v2-workspace\.module|public-api)/.test(
          p
        )
      )
        ? [
            'src/id-business-v2/workspace/recharge-mail-code.spec.ts',
            'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts'
          ]
        : [])
    );
  npm('run', 'build', '--workspace', '@apple-business/api');
  if (changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/')))
    onlineEngine();
} else if (part === 'online-engine') {
  if (changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/')))
    onlineEngine();
} else if (part === 'migration') {
  run('python3', ['scripts/ci-recharge-migration.py']);
} else if (part === 'connector') {
  const workerDirectory = 'apps/api/src/id-business-v2/auto-recharge/worker';
  const fullPro = changed.some((path) =>
    [`${workerDirectory}/plan_selection.py`, `${workerDirectory}/test_pro.py`].includes(path)
  );
  const workerOptions = {
    cwd: workerDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: resolve(workerDirectory, '.browsers')
    }
  };
  execFileSync('python3', ['-m', 'playwright', 'install', 'chromium'], workerOptions);
  execFileSync(
    'python3',
    [
      '-m',
      'unittest',
      'test_bitbrowser_catalog',
      'test_bitbrowser_options',
      'test_bitbrowser_connector',
      'test_bitbrowser_upgrade',
      'test_owned_recharge_profile',
      'test_connector_health',
      'test_session_retry',
      fullPro ? 'test_pro' : 'test_pro.ProMenuDiagnosticsTests',
      'test_server',
      'test_worker_isolation',
      'test_server_proxy',
      'test_fingerprint_runtime',
      'test_password_login',
      'test_subscribe',
      'test_payment.StateTests',
      'test_recharge_email_code',
      'test_payment_3ds',
      'test_payment_handoff',
      'test_subscription_upgrade',
      'test_upgrade_card_selection',
      'test_upgrade_card_flow',
      'test_go.GoStateTests'
    ],
    workerOptions
  );
} else if (part === 'security') {
  run('python3', ['-B', 'scripts/audit-python-dependencies.test.py']);
  run('node', ['--test', 'scripts/container-hardening.test.mjs']);
  run('sh', ['-n', 'scripts/start-auto-recharge-connector.sh']);
} else throw new Error('Unknown recharge check part');
