import { imageInputsChanged } from './ci-recharge-python-image.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affectsPart,
  isRechargeOnly,
  matchingRun,
  canReuseMain,
  isCiOnly,
  isAdminOnly,
  isMailboxOnly,
  isTargetedOnly,
  selectedParts,
  checkMode,
  adminCheckCommands,
  adminUiGuardChecks,
  backendArchitectureGuardChecks,
  registrationOnboardingControls,
  hasRegistrationOnboardingScope
} from './ci-recharge-scope.mjs';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

const schema =
  'model Other { id String }\nmodel IdBusinessV2RechargeBrowserSetting { ownerId String }\n';
const files = [
  'apps/admin/src/v2/features/auto-recharge/example.vue',
  'apps/api/prisma-mysql/schema.prisma'
];
test('fixed pricing 045 carries only the exact main5b sources and metadata without expanding services or database suites', () => {
  const profile = 'deploy/aws/recharge-pro-pricing-045-20261008.json';
  const sources = [
    'plan_selection.py',
    'test_pro.py',
    'registration_browser.py',
    'test_registration_browser.py'
  ].map((name) => 'apps/api/src/id-business-v2/auto-recharge/worker/' + name);
  const controls = [
    profile,
    'docs/V2_TASKS.md',
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    ...[
      'build-images.sh',
      'push-images.sh',
      'dispatch.sh',
      'validate-release-selection.sh',
      'remote-deploy.py',
      'remote-deploy.test.py',
      'maintain-image-cache.py',
      'maintain-image-cache.test.py'
    ].map((name) => 'scripts/production-release/' + name)
  ];
  controls.push(
    'deploy/aws/registration-baseline-96-20261008.json',
    'deploy/aws/registration-worker-96-20261008.json',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/registration-onboarding-96.py',
    'scripts/production-release/registration-onboarding-96.test.py',
    'scripts/production-release/registration-only-transport.test.py'
  );
  assert.equal(hasRegistrationOnboardingScope(controls), false);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const selected of [sources, ...sources.map((source) => [source])]) {
    const paths = [...controls, ...selected];
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.equal(isTargetedOnly(paths, schema, schema), true);
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
    assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
  }
  for (const outside of [
    'deploy/aws/recharge-pro-6f5-20261008.json',
    profile + '.backup',
    'deploy/aws/registration-worker-95-20261008.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'scripts/production-release/service-image-retention.py',
    'apps/admin/src/v2/features/auto-recharge/AutoRechargePage.vue'
  ]) {
    assert.equal(checkMode([...controls, ...sources, outside], schema, schema), 'full');
    assert.equal(hasRegistrationOnboardingScope([...controls, ...sources, outside]), true);
    assert.equal(isCiOnly([...controls, outside]), false);
  }
});
test('registration96 uses its fifteen exact release controls and only the reviewed browser pair', () => {
  const controls = [...registrationOnboardingControls];
  const pair = [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
  ];
  assert.equal(controls.length, 15);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const identity of [controls[0], controls[1], controls[2], controls[3]]) {
    assert.equal(hasRegistrationOnboardingScope([identity]), true);
    assert.equal(checkMode([identity], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([identity]), ['guards']);
  }
  for (const sources of [pair, ...pair.map((path) => [path])]) {
    const paths = [...controls, ...sources];
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.equal(isTargetedOnly(paths, schema, schema), true);
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
    assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
  }
  for (const outside of [
    'deploy/aws/registration-worker-96-20261009.json',
    'deploy/aws/registration-worker-96-20261008.json.backup',
    'deploy/aws/registration-baseline-96-unreviewed.json',
    'deploy/aws/registration-worker-95-20261008.json',
    'scripts/production-release/registration-interstitial-95.py',
    'deploy/aws/recharge-pro-6f5-20261008.json',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/registration-onboarding-96-other.py',
    'scripts/production-release/api-admin-scope.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/v2/features/auto-registration/AutoRegistrationPage.vue',
    '.env.example',
    'package-lock.json'
  ]) {
    for (const paths of [
      [...controls, outside],
      [...controls, ...pair, outside]
    ]) {
      assert.equal(checkMode(paths, schema, schema), 'full', outside);
      assert.equal(isCiOnly(paths), false, outside);
      assert.equal(isRechargeOnly(paths, schema, schema), false, outside);
      assert.equal(isTargetedOnly(paths, schema, schema), false, outside);
    }
  }
});
test('documentation and CI selectors do not start business or database checks', () => {
  for (const path of ['docs/V2_TASKS.md', 'AGENTS.md', 'README.md', 'scripts/ci-change-scope.mjs'])
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  for (const path of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/auth.controller.ts'
  ])
    assert.equal(checkMode([path], schema, schema), 'full');
});
test('the fixed 2f recharge profile selects deployment controls without business or database suites', () => {
  const profile = 'deploy/aws/recharge-pro-2f-20261007.json';
  const controls = [
    profile,
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'docs/V2_TASKS.md'
  ];
  assert.equal(isCiOnly([profile]), true);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const unknown of [
    'deploy/aws/recharge-pro-2f-20261008.json',
    profile + '.backup',
    'deploy/aws/recharge-pro-2f-unreviewed.json'
  ]) {
    assert.equal(isCiOnly([unknown]), false);
    assert.equal(checkMode([...controls, unknown], schema, schema), 'full');
  }
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.equal(checkMode([...controls, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
});
for (const identity of ['recharge-pro-4c-20261008', 'recharge-pro-6f5-20261008']) {
  test(`the fixed ${identity} successor keeps its two Worker sources and reviewed controls in a single service scope`, () => {
    const profile = `deploy/aws/${identity}.json`;
    const sources = [
      'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
      'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py'
    ];
    const controls = [
      profile,
      '.github/workflows/production-release.yml',
      'scripts/production-release/build-images.sh',
      'scripts/production-release/push-images.sh',
      'scripts/production-release/dispatch.sh',
      'scripts/production-release/validate-release-selection.sh',
      'scripts/production-release/remote-deploy.py',
      'scripts/production-release/remote-deploy.test.py',
      'scripts/production-release/maintain-image-cache.py',
      'scripts/production-release/maintain-image-cache.test.py',
      'scripts/ci-recharge-scope.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-release.test.mjs',
      'docs/V2_TASKS.md'
    ];
    assert.equal(isCiOnly([profile]), true);
    assert.equal(checkMode(controls, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(controls), ['guards']);
    for (const selected of [sources, ...sources.map((source) => [source])]) {
      const paths = [...controls, ...selected];
      assert.equal(isCiOnly(paths), false);
      assert.equal(isRechargeOnly(paths, schema, schema), true);
      assert.equal(isTargetedOnly(paths, schema, schema), true);
      assert.equal(checkMode(paths, schema, schema), 'recharge');
      assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
      assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
      assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
    }
    for (const outside of [
      `deploy/aws/${identity === 'recharge-pro-4c-20261008' ? 'recharge-pro-6f5-20261008' : 'recharge-pro-4c-20261008'}.json`,
      'deploy/aws/recharge-pro-6f5-20261009.json',
      'deploy/aws/recharge-pro-6f5-unreviewed.json',
      'deploy/aws/registration-worker-95-20261008.json',
      'deploy/aws/recharge-pro-4c-20261009.json',
      profile + '.backup',
      'deploy/aws/recharge-pro-4c-unreviewed.json',
      'deploy/aws/recharge-pro-815-20261007.json',
      'deploy/aws/recharge-pro-d3fb-20261007.json',
      'deploy/aws/recharge-pro-2f-20261007.json',
      'deploy/aws/registration-worker-93-20261007.json',
      'deploy/aws/registration-worker-94-20261007.json',
      'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
      'apps/api/src/id-business-v2/auto-recharge/worker/payment.py',
      'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
      'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
      'apps/api/src/auth/auth.service.ts',
      'apps/admin/src/v2/features/auto-recharge/AutoRechargePage.vue',
      'apps/api/prisma-mysql/schema.prisma',
      'scripts/ci-recharge-check.mjs',
      'scripts/production-release/service-image-retention.py',
      'scripts/production-release/browser-cache-input.py',
      'scripts/production-release/browser-cache-input.test.py',
      'scripts/production-release/build-image-cache.test.py',
      'scripts/production-release/api-admin-scope.py',
      'scripts/production-release/api-admin-readonly.py',
      'scripts/production-release/api-admin-scope.test.py',
      'scripts/check-v2-module-architecture.mjs',
      'scripts/check-v2-prisma-runtime-boundary.mjs',
      'scripts/check-v2-concurrency-standard.mjs',
      'apps/admin/src/components/ui/AppButton.vue',
      'scripts/admin-skin-rules.mjs',
      'scripts/acceptance-v2-skin-consistency.mjs',
      'docs/AUTO_REGISTRATION.md',
      '.env.example',
      'package-lock.json'
    ]) {
      for (const paths of [
        [...controls, outside],
        [...controls, ...sources, outside]
      ]) {
        assert.equal(checkMode(paths, schema, schema), 'full', outside);
        assert.equal(isCiOnly(paths), false, outside);
        assert.equal(isRechargeOnly(paths, schema, schema), false, outside);
        assert.equal(isTargetedOnly(paths, schema, schema), false, outside);
      }
    }
    for (const unknown of [
      'deploy/aws/recharge-pro-4c-20261009.json',
      profile + '.backup',
      'deploy/aws/recharge-pro-4c-unreviewed.json',
      'deploy/aws/recharge-pro-815-20261007.json',
      'deploy/aws/recharge-pro-d3fb-20261007.json'
    ]) {
      assert.equal(isCiOnly([unknown]), false);
      assert.equal(checkMode([unknown], schema, schema), 'full');
    }
  });
}

test('historical audit controls use their four exact reviewed paths', () => {
  const controls = [
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs',
    'scripts/v2-release-history-policy.test.mjs'
  ];
  for (const path of controls) {
    assert.equal(isCiOnly([path]), true, path);
    assert.equal(checkMode([path], schema, schema), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  assert.equal(checkMode([...controls, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
  const security = 'apps/api/src/auth/auth.service.ts';
  assert.equal(checkMode([...controls, security], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, security]), ['guards', 'api', 'security']);
  const admin = 'apps/admin/src/v2/features/orders/Orders.vue';
  assert.equal(checkMode([...controls, admin], schema, schema), 'admin');
  assert.deepEqual(selectedParts([...controls, admin]), ['guards', 'admin']);
  for (const path of [
    'deploy/aws/historical-finance-20261005.json',
    'deploy/aws/historical-finance-unreviewed.json',
    'deploy/aws/historical-finance-20261005-registration-continuation-other.json',
    'deploy/aws/historical-finance-20261005-registration-continuation.json.backup',
    'scripts/lib/v2-release-history-policy-other.mjs',
    'scripts/v2-release-history-audit-other.mjs',
    'scripts/v2-release-history-policy-other.test.mjs',
    'scripts/lib/v2-data-integrity-audit.mjs'
  ]) {
    assert.equal(isCiOnly([path]), false, path);
    assert.equal(checkMode([path], schema, schema), 'full', path);
    assert.equal(checkMode([...controls, worker, path], schema, schema), 'full', path);
    assert.equal(checkMode([...controls, security, path], schema, schema), 'full', path);
  }
});
test('the complete registration continuation candidate retains targeted checks with exact production controls', () => {
  const productionControls = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py'
  ];
  const candidate = [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'docs/V2_TASKS.md',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    ...productionControls
  ];
  assert.equal(candidate.length, 18);
  assert.equal(checkMode(candidate, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(candidate), ['guards', 'admin', 'api', 'connector']);
  assert.equal(
    checkMode(
      candidate.filter((path) => !path.startsWith('apps/')),
      schema,
      schema
    ),
    'ci-only'
  );
  for (const path of productionControls) {
    assert.equal(checkMode([path], schema, schema), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  for (const path of [
    'scripts/production-release/unreviewed.py',
    'scripts/production-release/remote-deploy-other.py',
    'scripts/production-release/maintain-image-cache-other.test.py',
    'deploy/aws/historical-finance-unreviewed.json',
    'scripts/lib/v2-data-integrity-audit.mjs',
    'apps/api/src/id-business-v2/orders/order.service.ts'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'full', path);
    assert.equal(checkMode([...candidate, path], schema, schema), 'full', path);
  }
  for (const path of [
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/cleanup-reviewed-cache.py'
  ]) {
    assert.equal(isCiOnly([path]), true, path);
    assert.equal(checkMode([...candidate, path], schema, schema), 'full', path);
  }
});
test('approved audit trigger migration runs isolated MySQL guards without hiding other changes', () => {
  const migration =
    'apps/api/prisma-mysql/migrations/20261002123500_routine_audit_retention_exception/migration.sql';
  assert.equal(
    checkMode(
      [migration, 'scripts/production-release/audit-retention-mysql.test.py'],
      schema,
      schema
    ),
    'audit-retention'
  );
  assert.equal(checkMode([migration, 'apps/api/src/auth/auth.service.ts'], schema, schema), 'full');
  assert.equal(
    checkMode(['apps/api/prisma-mysql/migrations/other/migration.sql'], schema, schema),
    'full'
  );
});
test('ordinary admin modules use frontend checks instead of backend and financial suites', () => {
  const paths = ['apps/admin/src/v2/features/orders/Orders.vue', 'docs/V2_TASKS.md'];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  const commands = adminCheckCommands('admin', paths);
  assert.deepEqual(commands, [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    ['run', 'test', '--workspace', '@apple-business/admin'],
    ['run', 'build', '--workspace', '@apple-business/admin'],
    ['exec', '--', 'node', 'scripts/acceptance-v2-order-archive-ui.mjs']
  ]);
  assert.ok(
    adminCheckCommands('admin', [...paths, files[0]]).some((args) =>
      args.includes('acceptance:v2-auto-recharge')
    )
  );
  assert.equal(
    checkMode([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts'], schema, schema),
    'full'
  );
  assert.equal(checkMode(['apps/admin/src/auth/login.ts'], schema, schema), 'full');
  assert.equal(checkMode([files[0]], schema, schema), 'recharge');
});
test('release workflow diagnostics retain control checks and do not hide application changes', () => {
  const paths = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/cleanup-reviewed-cache.py',
    'scripts/production-release/cleanup-reviewed-cache.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/production-release/cleanup-verified-backups.py',
    'scripts/production-release/cleanup-verified-backups.test.py',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/storage-maintenance.test.py',
    'deploy/aws/cache-cleanup-storage-20261002.json',
    'deploy/aws/cache-cleanup-bitbrowser-direct-20261003.json',
    'deploy/aws/cache-cleanup-unused-legacy-20261003.json',
    'deploy/aws/cache-cleanup-20261001.json',
    'deploy/aws/cache-cleanup-fx-subscription-20261002.json',
    'deploy/aws/cache-cleanup-unified-20261002.json',
    'deploy/aws/cache-cleanup-unified-recovery-20261002.json',
    'deploy/aws/cache-cleanup-recharge-names-20261002.json',
    'deploy/aws/cache-cleanup-recharge-execution-20261002.json',
    'scripts/production-release/reuse-images.py',
    'docs/PRODUCTION_RELEASE_OIDC.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isCiOnly(['deploy/aws/cache-cleanup-unreviewed.json']), false);
  assert.notEqual(checkMode([...paths, 'docker-compose.aws-mysql.yml'], schema, schema), 'ci-only');
  assert.equal(
    checkMode([...paths, 'apps/api/src/auth/auth.controller.ts'], schema, schema),
    'full'
  );
  assert.equal(
    checkMode(
      [...paths, 'apps/admin/src/v2/components/workspace/V2QuickActions.vue'],
      schema,
      schema
    ),
    'admin'
  );
});
test('fixed mailbox diagnostics run controls without selecting business or database suites', () => {
  const paths = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/mailbox-diagnostic.mjs',
    'scripts/production-release/mailbox-diagnostic.test.mjs',
    'scripts/production-release/mailbox-diagnostic.py',
    'scripts/production-release/mailbox-diagnostic.test.py'
  ];
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isCiOnly(['scripts/production-release/mailbox-diagnostic-arbitrary.mjs']), false);
  assert.notEqual(
    checkMode([...paths, 'apps/api/src/auth/auth.service.ts'], schema, schema),
    'ci-only'
  );
});
test('every scoped V2 frontend route runs the same UI, skin, loading and draft guards', () => {
  const required = [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ];
  for (const path of [
    'apps/admin/src/v2/features/customers/NewCustomerView.vue',
    'apps/admin/src/v2/features/auto-recharge/NewRechargeView.vue',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/admin/src/v2/styles/base.css'
  ]) {
    const mode = checkMode([path], schema, schema);
    const checks = adminUiGuardChecks(mode, [path]);
    for (const name of required) assert.ok(checks.includes(name), `${mode}: missing ${name}`);
    assert.equal(new Set(checks).size, checks.length);
    assert.deepEqual(selectedParts([path]), ['guards', 'admin']);
  }
});
test('documentation and backend-only recharge changes do not start frontend UI guards', () => {
  for (const path of [
    'AGENTS.md',
    'docs/UI_DESIGN.md',
    'scripts/ci-recharge-check.mjs',
    'apps/api/src/id-business-v2/auto-recharge/example.service.ts'
  ]) {
    assert.deepEqual(adminUiGuardChecks(checkMode([path], schema, schema), [path]), []);
  }
});
test('backend architecture gates run without frontend changes in recharge and mailbox scopes', () => {
  for (const file of [
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'packages/shared/src/v2/auto-recharge.ts',
    'packages/shared/src/v2/vendure-mailbox.ts'
  ]) {
    const paths = [file];
    assert.deepEqual(backendArchitectureGuardChecks(checkMode(paths, schema, schema), paths), [
      'check:v2-module-architecture',
      'check:v2-prisma-runtime-boundary',
      'check:v2-concurrency-standard'
    ]);
  }
  assert.equal(
    backendArchitectureGuardChecks('recharge', ['apps/api/prisma-mysql/schema.prisma']).length,
    3
  );
  for (const file of [
    'docs/V2_TASKS.md',
    'scripts/ci-recharge-check.mjs',
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py'
  ]) {
    assert.deepEqual(backendArchitectureGuardChecks(checkMode([file], schema, schema), [file]), []);
  }
});
test('architecture guard repairs run only the affected control gate', () => {
  for (const guard of ['module-architecture', 'prisma-runtime-boundary', 'concurrency-standard']) {
    const paths = [`scripts/check-v2-${guard}.mjs`];
    assert.equal(checkMode(paths, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(paths), ['guards']);
    assert.deepEqual(backendArchitectureGuardChecks('ci-only', paths), [`check:v2-${guard}`]);
  }
});
test('public static information pages stay in admin checks without widening auth or API scope', () => {
  const paths = [
    'apps/admin/public/google-sheets.html',
    'apps/admin/public/google-sheets-info.css',
    'docs/V2_TASKS.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(checkMode([...paths, 'apps/admin/public/v2-boot.js'], schema, schema), 'full');
  assert.equal(checkMode([...paths, 'apps/admin/src/auth/login.ts'], schema, schema), 'full');
  assert.equal(
    checkMode([...paths, 'apps/api/src/id-business-v2/workspace/example.ts'], schema, schema),
    'full'
  );
});
test('shared record spacing and its browser acceptance stay in the admin scope', () => {
  const paths = [
    'apps/admin/src/v2/styles/records.css',
    'apps/admin/src/v2/features/auto-recharge/vendure-mailbox.css',
    'scripts/acceptance-v2-table-layout.mjs',
    'scripts/check-v2-table-standard.mjs',
    'docs/UI_DESIGN.md',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.ok(
    adminCheckCommands('admin', paths).some((args) => args.includes('acceptance:v2-table-layout'))
  );
});
test('Vendure mailbox integration runs only its shared, admin, API and guard checks', () => {
  const paths = [
    '.env.example',
    '.env.aws.production.example',
    'docker-compose.aws-mysql.yml',
    'apps/admin/src/api/requestPolicy.ts',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
    'packages/shared/src/v2/vendure-mailbox.ts',
    'docs/V2_VENDURE_MAILBOX_INTEGRATION.md',
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isMailboxOnly(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'mailbox');
  assert.deepEqual(adminCheckCommands('mailbox', paths), [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/registry.spec.ts',
      'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
    ],
    ['run', 'build', '--workspace', '@apple-business/admin']
  ]);
  assert.equal(
    isMailboxOnly([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts']),
    false
  );
});
test('CI-only repairs do not select application or migration suites', () => {
  assert.equal(
    isCiOnly(['.github/workflows/quality.yml', 'scripts/ci-recharge-evidence.mjs']),
    true
  );
  assert.equal(isCiOnly(['.github/workflows/quality.yml', files[0]]), false);
  assert.equal(isCiOnly([]), false);
});
test('immutable source evidence survives a cleared PR association and rejects mismatches', () => {
  const run = { id: 42, run_attempt: 1, pull_requests: [] };
  const pr = { number: 192, head: { sha: 'head' } };
  const proof = {
    repository: 'owner/repo',
    runId: 42,
    runAttempt: 1,
    pullRequest: 192,
    headSha: 'head',
    baseSha: 'a'.repeat(40),
    testedTree: 'tree'
  };
  const expected = { repo: 'owner/repo', run, pr, tree: 'tree' };
  assert.equal(matchesSourceEvidence(proof, expected), true);
  for (const change of [
    { repository: 'other/repo' },
    { runId: 43 },
    { runAttempt: 2 },
    { pullRequest: 191 },
    { headSha: 'other' },
    { testedTree: 'different' }
  ]) {
    assert.equal(matchesSourceEvidence({ ...proof, ...change }, expected), false);
  }
});
test('main reuse rejects a different tree or an incomplete required gate', () => {
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'success' }]), true);
  assert.equal(canReuseMain('old', 'new', [{ name: 'quality', conclusion: 'success' }]), false);
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'failure' }]), false);
  assert.equal(
    canReuseMain('tree', 'tree', [{ name: 'recharge (api)', conclusion: 'success' }]),
    false
  );
  assert.equal(canReuseMain('tree', 'tree', []), false);
});
test('recharge settings schema changes stay scoped but other model changes do not', () => {
  assert.equal(
    isRechargeOnly(files, schema, schema.replace('ownerId String', 'ownerId String extra Json?')),
    true
  );
  assert.equal(isRechargeOnly(files, schema, schema.replace('id String', 'id Int')), false);
  assert.equal(
    isRechargeOnly([...files, 'apps/api/src/auth/auth.service.ts'], schema, schema),
    false
  );
  assert.equal(
    isRechargeOnly(
      [...files, 'apps/api/prisma-mysql/migrations/other/migration.sql'],
      schema,
      schema
    ),
    false
  );
  assert.equal(isRechargeOnly([], schema, schema), false);
});
test('a frontend-only fix retains API and connector evidence', () => {
  const changed = [files[0]];
  assert.equal(affectsPart('guards', changed), true);
  assert.equal(affectsPart('admin', changed), true);
  for (const part of ['api', 'connector', 'migration'])
    assert.equal(affectsPart(part, changed), false);
  for (const part of ['guards', 'admin', 'api', 'connector', 'migration']) {
    assert.equal(affectsPart(part, ['.github/workflows/quality.yml']), true);
    assert.equal(affectsPart(part, ['scripts/ci-recharge-check.mjs']), true);
  }
});
test('evidence is bound to the same PR, source SHA and workflow', () => {
  const run = {
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    head_sha: 'abc',
    pull_requests: [{ number: 191, head: { sha: 'abc' } }]
  };
  assert.equal(matchingRun(run, 191, 'abc'), true);
  assert.equal(matchingRun(run, 192, 'abc'), false);
  assert.equal(matchingRun(run, 191, 'def'), false);
  assert.equal(matchingRun({ ...run, event: 'push' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, path: 'other.yml' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, status: 'in_progress' }, 191, 'abc'), false);
});

test('combined security and retry release selects affected modules without a migration run', () => {
  const changed = [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_retry.py',
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile',
    'packages/shared/src/v2/auto-recharge.ts',
    '.github/workflows/quality.yml'
  ];
  assert.equal(isTargetedOnly(changed, schema, schema), true);
  assert.deepEqual(selectedParts(changed), ['guards', 'admin', 'api', 'connector', 'security']);
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/src/auth/auth.controller.ts'], schema, schema),
    false
  );
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/prisma-mysql/schema.prisma'], schema, schema),
    false
  );
  assert.deepEqual(selectedParts([files[0]]), ['guards', 'admin']);
});

test('CI selector and Python-only changes retain unrelated API and frontend checks', () => {
  const changed = [
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-python-image.mjs',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
  ];
  assert.equal(affectsPart('api', changed), false);
  assert.equal(affectsPart('admin', changed), false);
  assert.equal(affectsPart('connector', changed), true);
});

test('image reuse requires unchanged complete inputs of that service', () => {
  assert.equal(
    imageInputsChanged('media-resolver', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    false
  );
  assert.equal(
    imageInputsChanged('auto-recharge', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    true
  );
  for (const service of ['media-resolver', 'auto-recharge']) {
    assert.equal(imageInputsChanged(service, ['scripts/audit-python-dependencies.py']), true);
    assert.equal(imageInputsChanged(service, ['docs/V2_TASKS.md']), false);
  }
});

test('keeps shared layout changes in the admin release and runs both layout regressions', () => {
  const paths = [
    'apps/admin/src/v2/components/V2ListToolbar.vue',
    'apps/admin/layout-contract-fixture.html',
    'scripts/admin-layout-rules.mjs',
    'scripts/admin-layout-rules.test.mjs',
    'scripts/check-admin-ui-guardrails.mjs',
    'scripts/acceptance-v2-filter-layout.mjs',
    'scripts/acceptance-v2-page-layout.mjs'
  ];
  assert.equal(isAdminOnly(paths), true);
  assert.equal(isAdminOnly([...paths, 'apps/api/src/id-business-v2/finance/example.ts']), false);
  const commands = adminCheckCommands('admin', paths).map((args) => args.join(' '));
  assert.ok(
    commands.some((command) => command.includes('scripts/acceptance-v2-filter-layout.mjs'))
  );
  assert.ok(commands.some((command) => command.includes('scripts/acceptance-v2-page-layout.mjs')));
});

test('recharge diagnostics adds only its exact reviewed historical policy path', () => {
  const path = 'deploy/aws/historical-finance-20261005-recharge-diagnostics.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const candidate = [
    path,
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py',
    'scripts/ci-recharge-check.mjs',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    'scripts/production-release/dispatch.sh'
  ];
  assert.equal(checkMode(candidate, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(candidate), ['guards', 'admin', 'api', 'connector']);
  for (const unreviewed of [
    'deploy/aws/historical-finance-20261005-recharge-diagnostics-other.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json.backup',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics/future.json',
    'deploy/aws/historical-finance-20261005.json',
    'deploy/aws/historical-finance-unreviewed.json'
  ]) {
    assert.equal(isCiOnly([unreviewed]), false, unreviewed);
    assert.equal(checkMode([unreviewed], schema, schema), 'full', unreviewed);
    assert.equal(checkMode([...candidate, unreviewed], schema, schema), 'full', unreviewed);
  }
});

test('maintenance continuation control is exact and preserves full compatibility checks', () => {
  const policy = 'deploy/aws/historical-finance-20261005-maintenance-continuation.json';
  for (const path of [
    policy,
    'scripts/lib/v2-release-maintenance-policy.mjs',
    'scripts/v2-release-maintenance-audit.mjs',
    'scripts/v2-release-maintenance-policy.test.mjs'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
  for (const path of [
    policy + '.backup',
    'scripts/lib/v2-release-maintenance-policy-other.mjs',
    'scripts/v2-release-maintenance-audit-other.mjs',
    'scripts/v2-release-maintenance-policy-other.test.mjs',
    'deploy/aws/historical-finance-20261005-maintenance-continuation-other.json',
    'scripts/lib/v2-data-integrity-audit.mjs',
    'scripts/v2-data-integrity-audit.test.mjs',
    'scripts/backup-aws-mysql.sh',
    'scripts/aws-mysql-backup.test.mjs'
  ]) {
    assert.equal(isCiOnly([path]), false, path);
    assert.equal(checkMode([policy, path], schema, schema), 'full', path);
  }
});

test('fixed b8 runtime scope uses one exact control path without business checks', () => {
  const path = 'deploy/aws/recharge-pro-menu-b8-20261005.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.deepEqual(selectedParts([path, worker]), ['guards', 'connector']);
  for (const other of [
    'deploy/aws/recharge-pro-menu-b8-20261006.json',
    'deploy/aws/recharge-pro-menu-b8-20261005.json.backup',
    'deploy/aws/recharge-pro-menu-unapproved.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([other], schema, schema), 'full', other);
  }
});

test('fixed 7f runtime scope is exact and retains worker checks', () => {
  const path = 'deploy/aws/recharge-pro-menu-7f-20261005.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.deepEqual(selectedParts([path, worker]), ['guards', 'connector']);
  for (const other of [
    'deploy/aws/recharge-pro-menu-7f-20261006.json',
    path + '.backup',
    path + '/future.json',
    'deploy/aws/recharge-pro-menu-other-20261005.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([path, other], schema, schema), 'full', other);
  }
});

test('fixed main80 recharge profile remains an exact control path and keeps Pro business checks', () => {
  const path = 'deploy/aws/recharge-pro-main80-20261006.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  for (const worker of ['plan_selection.py', 'test_pro.py']) {
    const changed = `apps/api/src/id-business-v2/auto-recharge/worker/${worker}`;
    assert.equal(checkMode([path, changed], schema, schema), 'recharge');
    assert.deepEqual(selectedParts([path, changed]), ['guards', 'connector']);
  }
  for (const other of [
    'deploy/aws/recharge-pro-main80-20261007.json',
    path + '.backup',
    path + '/future.json',
    'deploy/aws/recharge-pro-main81-20261006.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([path, other], schema, schema), 'full', other);
  }
});

test('fixed registration 80, 956 and 85 controls retain worker checks and reject other baselines', () => {
  const profile = 'deploy/aws/registration-worker-b8-80-20261006.json';
  const continuation = 'deploy/aws/registration-worker-956-20261006.json';
  const initial = 'deploy/aws/registration-worker-85-20261006.json';
  const email = 'deploy/aws/registration-worker-86-20261006.json';
  const callback = 'deploy/aws/registration-worker-87-20261006.json';
  const emailRequest = 'deploy/aws/registration-worker-88-20261006.json';
  const emailObservation = 'deploy/aws/registration-worker-89-20261006.json';
  const transport = 'scripts/production-release/registration-only-transport.test.py';
  const auditors = [
    'scripts/v2-registration-finance-audit.mjs',
    'scripts/v2-registration-finance-audit.test.mjs'
  ];
  assert.equal(isCiOnly([profile, transport, ...auditors]), true);
  assert.equal(checkMode([profile, transport, ...auditors], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([profile, transport, ...auditors]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  assert.deepEqual(selectedParts([profile, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([continuation]), true);
  assert.equal(checkMode([continuation], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([continuation]), ['guards']);
  assert.deepEqual(selectedParts([continuation, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([initial]), true);
  assert.equal(checkMode([initial], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([initial]), ['guards']);
  assert.deepEqual(selectedParts([initial, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([email]), true);
  assert.equal(checkMode([email], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([email]), ['guards']);
  assert.deepEqual(selectedParts([email, worker]), ['guards', 'connector']);
  const autoCodeTest =
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py';
  assert.deepEqual(selectedParts([email, autoCodeTest]), ['guards', 'connector']);
  assert.equal(isCiOnly([callback]), true);
  assert.equal(checkMode([callback], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([callback]), ['guards']);
  assert.equal(isCiOnly([emailRequest]), true);
  assert.equal(checkMode([emailRequest], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([emailRequest]), ['guards']);
  assert.equal(isCiOnly([emailObservation]), true);
  assert.equal(checkMode([emailObservation], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([emailObservation]), ['guards']);
  for (const path of ['registration_browser.py', 'test_registration_browser.py'])
    assert.deepEqual(
      selectedParts([emailObservation, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const path of ['registration_browser.py', 'test_registration_browser.py'])
    assert.deepEqual(
      selectedParts([emailRequest, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const path of ['registration_job.py', 'test_registration.py'])
    assert.deepEqual(
      selectedParts([callback, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const other of [
    'deploy/aws/registration-worker-b8-3ca-20261006.json',
    profile + '.backup',
    profile + '/future.json',
    'deploy/aws/registration-worker-b8-80-other.json',
    'deploy/aws/registration-worker-956-20261007.json',
    continuation + '.backup',
    'deploy/aws/registration-worker-85-20261007.json',
    initial + '.backup',
    'deploy/aws/registration-worker-86-20261007.json',
    email + '.backup',
    'deploy/aws/registration-worker-87-20261007.json',
    callback + '.backup',
    'deploy/aws/registration-worker-88-20261007.json',
    emailRequest + '.backup',
    'deploy/aws/registration-worker-89-20261007.json',
    emailObservation + '.backup',
    'scripts/production-release/registration-only-other.test.py',
    'scripts/v2-registration-finance-audit-other.mjs',
    'scripts/v2-registration-finance-audit.mjs.backup',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([profile, other], schema, schema), 'full', other);
  }
});

test('fixed 91 profile observation CI accepts only two Worker files and reviewed controls', () => {
  const profile = 'deploy/aws/registration-worker-91-20261007.json';
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/';
  const sources = [worker + 'registration_browser.py', worker + 'test_registration_browser.py'];
  const controls = [
    profile,
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/registration-only-transport.test.py',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/v2-registration-finance-audit.mjs',
    'scripts/v2-registration-finance-audit.test.mjs',
    'docs/AUTO_REGISTRATION.md',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'docs/V2_TASKS.md'
  ];
  assert.equal(isCiOnly([profile]), true);
  assert.equal(checkMode(controls), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const inputs of [sources, sources.slice(0, 1), sources.slice(1)]) {
    const paths = [...controls, ...inputs];
    assert.equal(checkMode(paths), 'recharge');
    assert.equal(isRechargeOnly(paths), true);
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
  }
  for (const extra of [
    worker + 'test_registration_auto_code.py',
    worker + 'registration_job.py',
    worker + 'plan_selection.py',
    worker + 'test_pro.py',
    worker + 'Dockerfile',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/id-business-v2-auto-recharge.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/api/requestPolicy.ts',
    'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts',
    'deploy/aws/registration-worker-90-20261007.json',
    'deploy/aws/recharge-pro-main80-20261006.json',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/unreviewed.py',
    'scripts/ci-recharge-unreviewed.mjs',
    'docker-compose.aws-mysql.yml',
    'package-lock.json'
  ]) {
    const paths = [...controls, ...sources, extra];
    assert.equal(checkMode(paths), 'full', extra);
    assert.equal(isRechargeOnly(paths), false, extra);
    assert.equal(isTargetedOnly(paths), false, extra);
    assert.equal(checkMode([profile, extra]), 'full', extra);
    assert.equal(isCiOnly([profile, extra]), false, extra);
  }
});

test('fixed 974 recharge profile and twelve controls stay exact without weakening worker checks', () => {
  const profile = 'deploy/aws/recharge-pro-974-20261007.json';
  const controls = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/PRODUCTION_RELEASE_OIDC.md'
  ];
  assert.equal(checkMode([profile, ...controls], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([profile]), ['guards']);
  // The existing shared CI command path retains all module evidence; ci-only mode selects control execution.
  assert.deepEqual(selectedParts([profile, ...controls]), ['guards', 'admin', 'api', 'connector']);
  const workers = [
    'plan_selection.py',
    'server.py',
    'test_pro.py',
    'test_server.py',
    'test_worker_isolation.py'
  ].map((name) => `apps/api/src/id-business-v2/auto-recharge/worker/${name}`);
  for (const path of workers) {
    assert.equal(checkMode([profile, path], schema, schema), 'recharge', path);
    assert.deepEqual(selectedParts([profile, path]), ['guards', 'connector'], path);
  }
  assert.equal(
    checkMode([profile, ...controls, ...workers, 'docs/V2_TASKS.md'], schema, schema),
    'recharge'
  );
  assert.deepEqual(selectedParts([profile, ...workers, 'docs/V2_TASKS.md']), [
    'guards',
    'connector'
  ]);
  for (const wrong of [
    'deploy/aws/recharge-pro-974-20261008.json',
    'deploy/aws/recharge-pro-c4-20261007.json',
    profile + '.backup',
    profile + '/future.json',
    'deploy/aws/../aws/recharge-pro-974-20261007.json'
  ]) {
    assert.equal(isCiOnly([wrong]), false, wrong);
    assert.equal(checkMode([profile, wrong], schema, schema), 'full', wrong);
  }
});

test('fixed92 accepts only four API files, three Worker files, owned tests and exact controls', () => {
  const profile = 'deploy/aws/registration-worker-92-20261007.json';
  const api = 'apps/api/src/id-business-v2/auto-registration/registration-validation.ts';
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'docs/AUTO_REGISTRATION.md',
    'docs/V2_TASKS.md'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(checkMode([...controls, api, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, api, worker]), ['guards', 'api', 'connector']);
  assert.deepEqual(adminUiGuardChecks('recharge', [...controls, api, worker]), []);
  assert.deepEqual(selectedParts([...controls, api]), ['guards', 'api']);
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/auth/auth.service.ts',
    'apps/admin/src/v2/features/orders/Orders.vue',
    'deploy/aws/registration-worker-91-20261007.json',
    'docs/UNREVIEWED.md'
  ]) {
    assert.equal(checkMode([...controls, api, worker, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('shared button skin and exact skin controls stay frontend only without omitting UI guards', () => {
  const paths = [
    'apps/admin/src/components/ui/AppButton.vue',
    'apps/admin/src/v2/styles/base.css',
    'scripts/admin-skin-rules.mjs',
    'scripts/admin-skin-rules.test.mjs',
    'scripts/check-v2-color-contrast.mjs',
    'scripts/acceptance-v2-color-contrast.mjs',
    'scripts/acceptance-v2-skin-consistency.mjs',
    'scripts/acceptance-v2-business-skin.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/UI_DESIGN.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths.filter((path) => !isCiOnly([path]))), ['guards', 'admin']);
  const required = [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ];
  for (const guard of required) assert.ok(adminUiGuardChecks('admin', paths).includes(guard));
  for (const other of [
    'apps/api/src/id-business-v2/finance/finance.ts',
    'apps/admin/src/auth/login.ts',
    'apps/admin/src/components/ui/PermissionGate.vue',
    'scripts/admin-skin-rules-unknown.mjs',
    'packages/shared/src/v2/finance.ts',
    'package-lock.json',
    'package.json',
    'apps/api/prisma-mysql/migrations/new/migration.sql'
  ])
    assert.equal(checkMode([...paths, other], schema, schema), 'full', other);
});

test('explicit API Admin controls stay in control-only CI', () => {
  for (const path of [
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-readonly.py',
    'scripts/production-release/api-admin-scope.test.py'
  ]) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
});

test('fixed93 permits only two registration browser files and exact new release controls', () => {
  const profile = 'deploy/aws/registration-worker-93-20261007.json';
  const browser = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  const unit = 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/maintain-image-cache.py'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(checkMode([...controls, browser, unit], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, browser, unit]), ['guards', 'connector']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'deploy/aws/registration-worker-92-20261007.json',
    'docs/UNREVIEWED.md'
  ]) {
    assert.equal(checkMode([...controls, browser, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed94 control-only runtime followup never widens unchanged Worker or API checks', () => {
  const profile = 'deploy/aws/registration-worker-94-20261007.json';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-scope.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/ci-recharge-release.test.mjs'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.equal(isCiOnly(controls), true);
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'deploy/aws/registration-worker-93-20261007.json',
    'deploy/aws/recharge-pro-2f-20261007.json',
    'deploy/aws/recharge-pro-815-20261007.json',
    'deploy/aws/recharge-pro-4c-20261008.json',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'docs/UNREVIEWED.md',
    'scripts/production-release/api-admin-readonly.py'
  ]) {
    assert.equal(checkMode([...controls, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed95 control-only interstitial never widens unchanged Worker or API checks', () => {
  const profile = 'deploy/aws/registration-worker-95-20261008.json';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-scope.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/ci-recharge-release.test.mjs'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.equal(isCiOnly(controls), true);
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'deploy/aws/registration-worker-93-20261007.json',
    'deploy/aws/registration-worker-94-20261007.json',
    'deploy/aws/recharge-pro-2f-20261007.json',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'docs/UNREVIEWED.md',
    'scripts/production-release/api-admin-readonly.py'
  ]) {
    assert.equal(checkMode([...controls, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed95 exact browser pair selects only guards connector and rejects other runtime sources', () => {
  const controls = [
    'deploy/aws/registration-worker-95-20261008.json',
    'scripts/production-release/remote-deploy.py'
  ];
  for (const file of ['registration_browser.py', 'test_registration_browser.py']) {
    const paths = [...controls, 'apps/api/src/id-business-v2/auto-recharge/worker/' + file];
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
  }
  for (const file of ['server.py', 'registration_builtin.py', 'plan_selection.py', 'Dockerfile']) {
    const paths = [...controls, 'apps/api/src/id-business-v2/auto-recharge/worker/' + file];
    assert.equal(checkMode(paths, schema, schema), 'full');
    assert.equal(isRechargeOnly(paths, schema, schema), false);
  }
});

test('fixed95 plaintext module remains a finite control and rejects mixed Pro approval', () => {
  const module = 'scripts/production-release/registration-interstitial-95.py';
  const profile = 'deploy/aws/registration-worker-95-20261008.json';
  const pro = 'deploy/aws/recharge-pro-4c-20261008.json';
  const control = [profile, module, 'scripts/production-release/remote-deploy.py'];
  assert.equal(checkMode(control, schema, schema), 'ci-only');
  assert.equal(isCiOnly(control), true);
  assert.deepEqual(selectedParts(control), ['guards']);
  const business = [
    ...control,
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py'
  ];
  assert.equal(checkMode(business, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(business), ['guards', 'connector']);
  for (const drift of [
    [...control, pro],
    [...business, pro],
    [...control, 'scripts/production-release/registration-interstitial-96.py']
  ]) {
    assert.equal(checkMode(drift, schema, schema), 'full');
    assert.equal(isCiOnly(drift), false);
    assert.equal(isTargetedOnly(drift, schema, schema), false);
  }
});
