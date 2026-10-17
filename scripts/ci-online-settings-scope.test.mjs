import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep, isAbsolute, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';
import {
  onlineSettingsPaths,
  isOnlineSettingsOnly,
  isOnlineSettingsControlsOnly,
  isOnlineSettingsTestsOnly,
  isOnlineLegacyCloseOnly,
  isOnlineCheckoutCsRecoveryOnly,
  isOnlineCheckoutCsRecoveryControlsOnly,
  onlineCheckoutCsRecoveryScope,
  isOnlineCheckoutLoadRecoveryOnly,
  isOnlineCheckoutLoadRecoveryControlsOnly,
  isOnlineCheckoutLoadParentRpcOnly,
  onlineCheckoutLoadRecoveryScope,
  isOnlineCheckoutNavigationReadyOnly,
  onlineCheckoutNavigationReadyScope,
  isOnlineCoreParityOnly,
  onlineCoreParityScope,
  isOnlineCheckoutPreparedFieldsOnly,
  onlineCheckoutPreparedFieldsScope,
  isOnlineSessionRefreshOnly,
  onlineSessionRefreshScope,
  isOnlineLoginVisibilityOnly,
  onlineLoginVisibilityScope,
  isOnlineAuthStabilityOnly,
  onlineAuthStabilityScope,
  onlineSettingsCommands
} from './ci-online-settings-scope.mjs';

test('complete declared three-feature scope is accepted with every affected check', () => {
  assert.equal(isOnlineSettingsOnly(onlineSettingsPaths), true);
  const guards = onlineSettingsCommands('guards', onlineSettingsPaths)
    .map((command) => command.join(' '))
    .join('\n');
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(guards.includes(name));
  assert.ok(
    onlineSettingsCommands('api', onlineSettingsPaths).some((c) =>
      c.includes('src/id-business-v2/online-recharge')
    )
  );
  assert.ok(
    onlineSettingsCommands('online-engine', onlineSettingsPaths).some((c) =>
      c.includes('test:online-recharge:engine')
    )
  );
});
test('an extra schema, dependency, unrelated business file or duplicate falls back', () => {
  for (const name of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/admin/src/v2/features/auto-recharge/V2AutoRechargeView.vue',
    'apps/api/src/id-business-v2/online-recharge/engine/unreviewed.cjs',
    onlineSettingsPaths[0]
  ])
    assert.equal(isOnlineSettingsOnly([...onlineSettingsPaths, name]), false);
});
test('a partial business feature cannot be admitted as controls-only', () => {
  assert.equal(
    isOnlineSettingsOnly(['apps/api/src/id-business-v2/online-recharge/plan-region.ts']),
    false
  );
  assert.equal(
    isOnlineSettingsControlsOnly([
      'scripts/ci-online-settings-scope.mjs',
      'apps/api/src/id-business-v2/online-recharge/plan-region.ts'
    ]),
    false
  );
});
test('control-only repairs retain guard tests without rerunning unrelated business checks', () => {
  assert.equal(
    isOnlineSettingsControlsOnly([
      'scripts/ci-recharge-scope.mjs',
      'scripts/ci-recharge-check.mjs'
    ]),
    false
  );
  const paths = [
    'scripts/ci-online-settings-scope.mjs',
    'scripts/production-release/online-settings-release.test.py'
  ];
  assert.equal(isOnlineSettingsControlsOnly(paths), true);
  assert.ok(
    onlineSettingsCommands('guards', paths).some((c) =>
      c.includes('scripts/production-release/online-settings-release.test.py')
    )
  );
  assert.throws(() => onlineSettingsCommands('api', paths));
});

test('isolated MySQL fixture repair retains all four checks and rejects extra runtime source', () => {
  const paths = [
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'scripts/production-release/online-settings-contract.json',
    'scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs'
  ];
  assert.equal(isOnlineSettingsOnly(paths), true);
  assert.equal(isOnlineSettingsControlsOnly(paths), false);
  for (const part of ['guards', 'api', 'admin', 'online-engine'])
    assert.ok(onlineSettingsCommands(part, paths).length);
  for (const name of [
    'apps/api/src/id-business-v2/online-recharge/plan-region.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ])
    assert.equal(isOnlineSettingsOnly([...paths, name]), false);
});

test('Python-only release controls never invoke an unbounded formatter or lint command', () => {
  const commands = onlineSettingsCommands('guards', [
    'scripts/production-release/online-settings-release.py'
  ]);
  assert.ok(commands.some((command) => command[0] === 'python3'));
  assert.ok(
    commands.every((command) => !command.includes('eslint') && !command.includes('prettier'))
  );
});

test('the finite checkout repair keeps API, Admin, browser and all interface guards', () => {
  const contract = JSON.parse(
    readFileSync(new URL('./production-release/online-checkout-contract.json', import.meta.url))
  );
  const paths = [
    ...Object.keys(contract.sources),
    '.github/workflows/online-checkout-validation.yml',
    ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
      (name) => 'scripts/production-release/online-checkout-' + name
    ),
    'scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs'
  ];
  assert.equal(checkMode(paths, '', ''), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(isOnlineSettingsControlsOnly(paths), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/auth/auth.service.ts'
  ])
    assert.equal(checkMode([...paths, extra], '', ''), 'full');
  assert.equal(isOnlineSettingsOnly(paths.filter((p) => !p.endsWith('/validation.ts'))), false);
  const guards = onlineSettingsCommands('guards', paths).flat();
  for (const name of [
    'admin-ui',
    'v2-ui-language',
    'v2-color-contrast',
    'v2-table-standard',
    'v2-loading-standard',
    'v2-module-architecture',
    'v2-isolation'
  ])
    assert.ok(guards.includes('check:' + name));
  assert.ok(guards.includes('scripts/production-release/online-checkout-release.test.py'));
  assert.ok(
    onlineSettingsCommands('api', paths)
      .flat()
      .includes('src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts')
  );
});
test('display authorization repair is finite and retains real headed browser checks', () => {
  const paths = ['worker.cjs', 'test/runtime-main.test.cjs', 'SOURCE_MANIFEST.json'].map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  );
  paths.push('scripts/production-release/online-browser-display-auth-release.py');
  assert.equal(isOnlineSettingsOnly(paths), true);
  assert.equal(isOnlineSettingsOnly(paths.slice(1)), false);
  assert.equal(isOnlineSettingsOnly([...paths, 'apps/api/src/auth/auth.service.ts']), false);
  assert.equal(isOnlineSettingsOnly([...paths, 'apps/api/prisma-mysql/schema.prisma']), false);
  const commands = onlineSettingsCommands('online-engine', paths).flat();
  assert.ok(commands.includes('xvfb') && commands.includes('xauth'));
  assert.ok(commands.includes('test:online-recharge:engine'));
  assert.ok(
    onlineSettingsCommands('guards', paths)
      .flat()
      .includes('scripts/production-release/online-browser-display-auth-release.test.py')
  );
});

test('billing, subscription context and progress follow-on repair uses all affected checks', () => {
  const paths = JSON.parse(
    readFileSync(
      new URL('./production-release/online-checkout-retest-contract.json', import.meta.url)
    )
  ).sources;
  const scope = [
    ...Object.keys(paths),
    'scripts/production-release/online-checkout-retest-build.py',
    'scripts/production-release/online-checkout-retest-release.py',
    'scripts/production-release/online-checkout-retest-contract.json',
    'scripts/production-release/online-checkout-retest-release.test.py',
    '.github/workflows/online-checkout-retest-validation.yml'
  ];
  assert.equal(isOnlineSettingsOnly(scope), true);
  for (const part of ['guards', 'api', 'admin', 'online-engine'])
    assert.ok(onlineSettingsCommands(part, scope).length);
  assert.equal(isOnlineSettingsOnly([...scope, 'apps/api/src/auth/auth.service.ts']), false);
});

const unattendedControls = [
  '.github/workflows/online-unattended-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-unattended-' + name
  ),
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs'
];
const unattendedSources = [
  ...[
    'OnlineResultDialog.vue',
    'OnlineTaskProgress.vue',
    'auditPresentation.spec.ts',
    'contracts.ts',
    'labels.ts'
  ].map((name) => 'apps/admin/src/v2/features/online-recharge/' + name),
  ...[
    'checkout-recovery.spec.ts',
    'checkout-recovery.ts',
    'contracts.ts',
    'mysql.integration.spec.ts',
    'online-recharge.module.ts',
    'persistence/tasks.repository.ts',
    'persistence/worker-rpc.repository.spec.ts',
    'persistence/worker-rpc.repository.ts',
    'persistence/worker.repository.spec.ts',
    'persistence/worker.repository.ts',
    'plan-region.spec.ts',
    'proxy-country.spec.ts',
    'reconciliation.service.ts',
    'reconciliation.spec.ts',
    'reconciliation.ts',
    'engine/SOURCE_MANIFEST.json',
    'engine/checkout-recovery.cjs',
    'engine/confirmation.cjs',
    'engine/rpc.cjs',
    'engine/security.cjs',
    'engine/task-runner.cjs',
    'engine/test/checkout-recheck.test.cjs',
    'engine/test/checkout-recovery.test.cjs',
    'engine/test/debug-checkout.test.cjs',
    'engine/test/payment-core.test.cjs',
    'engine/test/payment-observation.test.cjs',
    'engine/test/renewal-state.test.cjs',
    'engine/test/solver-process.test.cjs',
    'engine/test/unattended-task-control.test.cjs',
    'engine/test/upgrade-checkout.test.cjs',
    'engine/test/verification-state.test.cjs',
    'engine/upstream/captcha-platform.js',
    'engine/upstream/hcaptcha-solver.js',
    'engine/upstream/hcaptcha/solver.py',
    'engine/upstream/human-verification.js',
    'engine/upstream/index.js',
    'engine/upstream/payment-retry.js',
    'engine/upstream/session-auth.js',
    'engine/upstream/stripe-payment.js',
    'engine/upstream/subscription-check.js',
    'engine/upstream/upgrade-checkout.js',
    'engine/upstream/verification-runtime.js'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name),
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];

test('complete finite unattended repair selects recharge and every affected application check', () => {
  const paths = [...unattendedSources, ...unattendedControls];
  assert.equal(isOnlineSettingsOnly(paths), true);
  assert.equal(checkMode(paths, '', ''), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(isOnlineSettingsControlsOnly(paths), false);
  const guards = onlineSettingsCommands('guards', paths).flat();
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(guards.includes(name));
  assert.ok(guards.includes('scripts/production-release/online-unattended-release.test.py'));
  for (const part of ['api', 'admin', 'online-engine'])
    assert.ok(onlineSettingsCommands(part, paths).length);
  assert.equal(
    isOnlineSettingsOnly(paths.filter((path) => !path.endsWith('/reconciliation.service.ts'))),
    false
  );
});

test('unattended controls alone run guards and release controls without application checks', () => {
  assert.equal(checkMode(unattendedControls, '', ''), 'ci-only');
  assert.deepEqual(selectedParts(unattendedControls), ['guards']);
  assert.equal(isOnlineSettingsControlsOnly(unattendedControls), true);
  const commands = onlineSettingsCommands('guards', unattendedControls);
  assert.ok(
    commands.flat().includes('scripts/production-release/online-unattended-release.test.py')
  );
  assert.ok(commands.every((command) => !command.some((part) => /^(?:check:|test:)/.test(part))));
  for (const part of ['api', 'admin', 'online-engine'])
    assert.throws(() => onlineSettingsCommands(part, unattendedControls));
});

test('unattended scope rejects auth, schema and unreviewed files even inside accepted directories', () => {
  const paths = [...unattendedSources, ...unattendedControls];
  for (const extra of [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/unreviewed.js',
    'scripts/production-release/online-unattended-unreviewed.py',
    'package-lock.json'
  ]) {
    assert.equal(checkMode([...paths, extra], '', ''), 'full');
    assert.equal(checkMode([...unattendedControls, extra], '', ''), 'full');
  }
});

const paymentObservationTestsOnly = [
  'apps/api/src/id-business-v2/online-recharge/engine/test/payment-observation.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json'
];
const paymentObservationCi = [
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs'
];

test('the exact supplemental test and manifest pair select only guards and online engine', () => {
  for (let mask = 0; mask < 8; mask++) {
    const paths = [
      ...paymentObservationTestsOnly,
      ...paymentObservationCi.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineSettingsTestsOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  }
});

test('supplemental test routing rejects missing inputs, duplicates and every adjacent change', () => {
  const exact = [...paymentObservationTestsOnly, ...paymentObservationCi];
  for (const paths of [
    [paymentObservationTestsOnly[0]],
    [paymentObservationTestsOnly[1]],
    [paymentObservationTestsOnly[0], ...paymentObservationCi],
    [paymentObservationTestsOnly[1], ...paymentObservationCi],
    [...exact, paymentObservationTestsOnly[0]],
    [...exact, paymentObservationCi[0]],
    ...[
      'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
      'apps/api/src/id-business-v2/online-recharge/engine/test/solver-process.test.cjs',
      'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
      'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
      'apps/api/src/auth/auth.service.ts',
      'apps/api/prisma-mysql/schema.prisma',
      'package.json',
      'package-lock.json',
      'docs/V2_TASKS.md',
      'scripts/ci-recharge-check.mjs',
      'scripts/ci-online-settings-unreviewed.mjs'
    ].map((path) => [...exact, path])
  ]) {
    assert.equal(isOnlineSettingsTestsOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
});

test('supplemental test commands retain controls and source checks without UI, API or MySQL work', () => {
  const paths = [...paymentObservationTestsOnly, ...paymentObservationCi];
  const guards = onlineSettingsCommands('guards', paths);
  const args = guards.flat();
  for (const name of [
    'prettier',
    'eslint',
    'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-change-scope.test.mjs',
    'check:v2-isolation'
  ])
    assert.ok(args.includes(name));
  assert.equal(guards.filter((command) => command.includes('-e')).length, 1);
  assert.ok(args.some((arg) => arg.includes('Online engine source fingerprints passed.')));
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'test:online-recharge:controls',
    '@apple-business/api',
    '@apple-business/admin',
    'prisma:mysql:generate',
    'prisma:mysql:validate'
  ])
    assert.ok(!args.includes(name));
  assert.ok(!guards.some((command) => command[0] === 'python3'));
  assert.ok(
    onlineSettingsCommands('online-engine', paths).flat().includes('test:online-recharge:engine')
  );
  for (const part of ['api', 'admin'])
    assert.throws(() => onlineSettingsCommands(part, paths), /tests-only/);
});

test('the supplemental source command validates all hashes and retains the original upstream pin', () => {
  const command = onlineSettingsCommands('guards', paymentObservationTestsOnly).find((args) =>
    args.includes('-e')
  );
  assert.ok(command && command[0] === 'node' && command.includes('--input-type=module'));
  const source = command.at(-1).replace(/^import .+;$/gm, '');
  const root = resolve('apps/api/src/id-business-v2/online-recharge/engine');
  const body = 'synthetic source\n';
  const manifest = {
    repository: 'https://github.com/nowtostudeyday/PAY-GPT-UPGRADE.git',
    commit: 'ba6cf96312a6953e62edb9d74299d438d12549df',
    files: [
      {
        path: 'test/synthetic.cjs',
        adaptedSha256: createHash('sha256').update(body).digest('hex')
      },
      {
        path: 'test/payment-observation.test.cjs',
        adaptedSha256: createHash('sha256').update(body).digest('hex')
      }
    ]
  };
  const verify = (value) =>
    runInNewContext(source, {
      assert,
      createHash,
      resolve,
      sep,
      isAbsolute,
      win32,
      console: { log() {} },
      readFileSync(file) {
        if (file === resolve(root, 'SOURCE_MANIFEST.json')) return JSON.stringify(value);
        assert.ok(
          ['test/synthetic.cjs', 'test/payment-observation.test.cjs'].some(
            (path) => file === resolve(root, path)
          )
        );
        return body;
      }
    });
  assert.doesNotThrow(() => verify(manifest));
  for (const change of [
    (copy) => (copy.files[0].adaptedSha256 = 'a'.repeat(64)),
    (copy) => delete copy.files[0].adaptedSha256,
    (copy) => (copy.files[0].path = '/outside/source.cjs'),
    (copy) => (copy.files[0].path = 'C:\\outside\\source.cjs'),
    (copy) => (copy.files[0].path = 'test/../synthetic.cjs'),
    (copy) => (copy.files[0].path = '..\\synthetic.cjs'),
    (copy) => copy.files.push({ ...copy.files[0] }),
    (copy) => (copy.files = []),
    (copy) =>
      (copy.files = copy.files.filter((row) => row.path !== 'test/payment-observation.test.cjs')),
    (copy) => (copy.commit = 'a'.repeat(40)),
    (copy) => (copy.repository = 'https://synthetic.invalid/other.git')
  ]) {
    const copy = structuredClone(manifest);
    change(copy);
    assert.throws(() => verify(copy));
  }
});

const legacyCloseScope = [
  ...[
    'persistence/tasks.repository.ts',
    'persistence/tasks.manual-closure.spec.ts',
    'mysql.integration.spec.ts'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name),
  '.github/workflows/online-legacy-close-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-legacy-close-' + name
  ),
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];

test('legacy manual closure uses API and guards while preserving all other runtime roles', () => {
  assert.equal(isOnlineLegacyCloseOnly(legacyCloseScope), true);
  assert.equal(checkMode(legacyCloseScope, '', ''), 'recharge');
  assert.deepEqual(selectedParts(legacyCloseScope), ['guards', 'api']);
  const guard = onlineSettingsCommands('guards', legacyCloseScope).flat();
  for (const name of [
    'module-architecture',
    'isolation',
    'prisma-runtime-boundary',
    'concurrency-standard',
    'decimal-standard'
  ])
    assert.ok(guard.includes('check:v2-' + name));
  assert.ok(guard.includes('scripts/production-release/online-legacy-close-release.test.py'));
  assert.ok(!guard.includes('check:admin-ui'));
  assert.ok(!guard.includes('check:v2-ui-language'));
  const api = onlineSettingsCommands('api', legacyCloseScope).flat();
  assert.ok(api.includes('src/id-business-v2/online-recharge'));
  assert.ok(!api.includes('src/id-business-v2/proxy-pool'));
  for (const part of ['admin', 'online-engine'])
    assert.throws(() => onlineSettingsCommands(part, legacyCloseScope));
});

test('legacy manual closure cannot admit unrelated source, schema, dependencies or missing required tests', () => {
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/admin/src/v2/features/online-recharge/labels.ts',
    legacyCloseScope[0]
  ]) {
    assert.equal(isOnlineLegacyCloseOnly([...legacyCloseScope, extra]), false);
    assert.equal(checkMode([...legacyCloseScope, extra], '', ''), 'full');
  }
  for (const required of legacyCloseScope.slice(0, 3)) {
    const partial = legacyCloseScope.filter((name) => name !== required);
    assert.equal(isOnlineLegacyCloseOnly(partial), false);
    assert.equal(checkMode(partial, '', ''), 'full');
  }
  assert.equal(checkMode(legacyCloseScope, 'before', 'after'), 'full');
});

test('legacy closure release controls alone do not start application or database tests', () => {
  const controls = legacyCloseScope.filter((name) => !name.startsWith('apps/'));
  assert.equal(checkMode(controls, '', ''), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.ok(
    onlineSettingsCommands('guards', controls)
      .flat()
      .includes('scripts/production-release/online-legacy-close-release.test.py')
  );
  assert.throws(() => onlineSettingsCommands('api', controls));
});

const checkoutCsRecoverySources = [
  'checkout-recovery.spec.ts',
  'checkout-recovery.ts',
  'contracts.ts',
  'engine/SOURCE_MANIFEST.json',
  'engine/checkout-recovery.cjs',
  'engine/test/checkout-cs-browser.test.cjs',
  'engine/test/checkout-recovery-evidence.test.cjs',
  'engine/test/checkout-recovery.test.cjs',
  'engine/test/payment-core.test.cjs',
  'engine/upstream/chatgpt.js',
  'engine/upstream/index.js',
  'engine/upstream/payment-retry.js',
  'engine/upstream/stripe-payment.js',
  'persistence/worker.repository.spec.ts'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name);
const checkoutCsRecoveryReleaseControls = [
  '.github/workflows/online-checkout-cs-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-cs-' + name
  )
];
const checkoutCsRecoveryOptional = [
  ...checkoutCsRecoveryReleaseControls,
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];

test('the complete checkout CS recovery scope selects only guards, API and the real browser engine', () => {
  assert.equal(onlineCheckoutCsRecoveryScope, 'ONLINE_CHECKOUT_CS_RECOVERY');
  for (const paths of [
    checkoutCsRecoverySources,
    [...checkoutCsRecoverySources, ...checkoutCsRecoveryOptional],
    [...checkoutCsRecoverySources, 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md']
  ]) {
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
  }
  for (const path of [
    checkoutCsRecoverySources.find((name) => name.endsWith('/checkout-cs-browser.test.cjs')),
    checkoutCsRecoverySources.find((name) => name.endsWith('/checkout-recovery-evidence.test.cjs')),
    ...checkoutCsRecoveryReleaseControls
  ])
    assert.ok(!onlineSettingsPaths.includes(path), 'new paths must not widen older feature scopes');
});

test('every checkout CS recovery source is mandatory and unrelated changes cannot use this shortcut', () => {
  const exact = [...checkoutCsRecoverySources, ...checkoutCsRecoveryOptional];
  for (const required of checkoutCsRecoverySources) {
    const paths = exact.filter((path) => path !== required);
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false, required);
    assert.equal(isOnlineSettingsOnly(paths), false, required);
    assert.equal(checkMode(paths, '', ''), 'full', required);
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/proxy-pool/proxy-pool.module.ts',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'scripts/production-release/online-checkout-release.py',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-online-settings-unreviewed.mjs',
    'docs/ONLINE_SETTINGS_RELEASE_20261016.md',
    exact[0]
  ]) {
    const paths = [...exact, extra];
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false, extra);
    assert.equal(isOnlineSettingsOnly(paths), false, extra);
    assert.equal(checkMode(paths, '', ''), 'full', extra);
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
});

test('checkout CS recovery controls alone run the new protected release tests without business work', () => {
  for (const paths of [
    ...checkoutCsRecoveryReleaseControls.map((path) => [path]),
    checkoutCsRecoveryOptional
  ]) {
    assert.equal(isOnlineCheckoutCsRecoveryControlsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'ci-only');
    assert.deepEqual(selectedParts(paths), ['guards']);
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    const commands = onlineSettingsCommands('guards', paths);
    assert.deepEqual(
      commands.filter((command) => command[0] === 'python3'),
      [['python3', '-B', 'scripts/production-release/online-checkout-cs-release.test.py']]
    );
    assert.ok(!commands.flat().some((arg) => /@apple-business|check:v2-|check:admin-ui/.test(arg)));
    for (const part of ['api', 'admin', 'online-engine'])
      assert.throws(() => onlineSettingsCommands(part, paths), /controls-only/);
  }
  for (const extra of [
    checkoutCsRecoverySources[0],
    'scripts/production-release/online-checkout-release.py',
    'package-lock.json',
    checkoutCsRecoveryOptional[0]
  ]) {
    const paths = [...checkoutCsRecoveryOptional, extra];
    assert.equal(isOnlineCheckoutCsRecoveryControlsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
  }
});

test('checkout CS recovery commands retain affected API and engine checks without Admin or database setup', () => {
  const paths = [...checkoutCsRecoverySources, ...checkoutCsRecoveryOptional];
  const guards = onlineSettingsCommands('guards', paths);
  const api = onlineSettingsCommands('api', paths);
  const engine = onlineSettingsCommands('online-engine', paths);
  for (const name of [
    'prettier',
    'eslint',
    'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-change-scope.test.mjs',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard',
    'scripts/production-release/online-checkout-cs-release.test.py'
  ])
    assert.ok(guards.flat().includes(name), name);
  assert.deepEqual(
    guards.filter((command) => command[0] === 'python3'),
    [['python3', '-B', 'scripts/production-release/online-checkout-cs-release.test.py']]
  );
  for (const name of ['prisma:mysql:generate', 'prisma:mysql:validate', 'typecheck', 'build'])
    assert.ok(api.flat().includes(name), name);
  assert.ok(api.flat().includes('@apple-business/api'));
  assert.ok(api.flat().includes('src/id-business-v2/online-recharge'));
  assert.ok(!api.flat().includes('src/id-business-v2/proxy-pool'));
  assert.ok(engine.flat().includes('test:online-recharge:engine'));
  assert.ok(
    engine.some(
      (command) =>
        command[0] === 'node' &&
        command[1].endsWith('/upstream/node_modules/playwright/cli.js') &&
        command.slice(2).join(' ') === 'install --with-deps chromium'
    )
  );
  for (const name of ['ffmpeg', 'xvfb', 'xauth']) assert.ok(engine.flat().includes(name));
  for (const arg of [...guards, ...api, ...engine].flat())
    assert.ok(
      !/@apple-business\/admin|check:admin-ui|check:v2-(?:ui-language|color-contrast|table-standard|loading-standard)|test:online-recharge:controls|migrate|docker|acceptance-v2-online-settings/.test(
        arg
      ),
      arg
    );
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
});

const checkoutLoadRecoverySources = [
  ...[
    'SOURCE_MANIFEST.json',
    'checkout-form.cjs',
    'checkout-recovery.cjs',
    'rpc.cjs',
    'test/checkout-form.test.cjs',
    'test/checkout-load-recovery.test.cjs',
    'test/checkout-page-loading.test.cjs',
    'test/checkout-recovery.test.cjs',
    'test/recharge-flow-acceptance.test.cjs',
    'test/rpc-response.test.cjs',
    'test/verification-state.test.cjs',
    'upstream/chatgpt.js',
    'upstream/human-verification.js',
    'upstream/stripe-payment.js'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts'
];
const checkoutLoadRecoveryReleaseControls = [
  '.github/workflows/online-checkout-load-validation.yml',
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-load-' + name
  )
];
const checkoutLoadRecoveryOptional = [
  ...checkoutLoadRecoveryReleaseControls,
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
const checkoutNavigationReadySources = [
  ...[
    'SOURCE_MANIFEST.json',
    'checkout-form.cjs',
    'checkout-recovery.cjs',
    'safe-media.cjs',
    'test/checkout-form.test.cjs',
    'test/checkout-load-recovery.test.cjs',
    'test/checkout-navigation.test.cjs',
    'test/checkout-recovery.test.cjs',
    'test/recharge-flow-acceptance.test.cjs',
    'test/regressions.test.cjs',
    'test/safe-media-finish.test.cjs',
    'test/verification-state.test.cjs',
    'upstream/chatgpt.js',
    'upstream/human-verification.js',
    'upstream/index.js'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md'
];
const checkoutNavigationReadyControls = [
  ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
    (name) => 'scripts/production-release/online-checkout-load-' + name
  ),
  'scripts/ci-online-settings-scope.mjs',
  'scripts/ci-online-settings-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs'
];
const coreParitySources = [
  ...[
    'SOURCE_MANIFEST.json',
    'checkout-form.cjs',
    'task-runner.cjs',
    'test/checkout-form.test.cjs',
    'test/checkout-navigation.test.cjs',
    'test/checkout-recovery.test.cjs',
    'test/debug-checkout.test.cjs',
    'test/recharge-flow-acceptance.test.cjs',
    'test/renewal-state.test.cjs',
    'test/upgrade-checkout.test.cjs',
    'test/worker-heartbeat.test.cjs',
    'upstream/chatgpt.js',
    'upstream/index.js',
    'upstream/pricing-checkout.js',
    'upstream/subscription-check.js',
    'upstream/test/pricing-checkout.test.js',
    'upstream/upgrade-checkout.js',
    'worker.cjs'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
const checkoutPreparedFieldsSources = [
  ...[
    'SOURCE_MANIFEST.json',
    'checkout-form.cjs',
    'safe-media.cjs',
    'test/checkout-form.test.cjs',
    'test/checkout-navigation.test.cjs',
    'test/checkout-recovery.test.cjs',
    'test/media-browser.test.cjs',
    'test/recharge-flow-acceptance.test.cjs',
    'upstream/chatgpt.js',
    'upstream/human-verification.js',
    'upstream/index.js',
    'upstream/stripe-payment.js'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
const sessionRefreshSources = [
  ...[
    'SOURCE_MANIFEST.json',
    'upstream/session-auth.js',
    'upstream/subscription-check.js',
    'test/regressions.test.cjs',
    'test/recharge-flow-acceptance.test.cjs'
  ].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name),
  'docs/ONLINE_RECHARGE.md',
  'docs/V2_TASKS.md'
];
const sessionRefreshApiFixture =
  'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts';
const loginVisibilitySources = [
  ...sessionRefreshSources,
  'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/auth-page-detect.js',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
  sessionRefreshApiFixture
];
const authStabilitySources = [
  ...sessionRefreshSources,
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/auth-page-detect.js',
  'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs',
  sessionRefreshApiFixture
];

test('authentication stability admits exactly ten sources and seven optional controls with isolated old scopes', () => {
  assert.equal(onlineAuthStabilityScope, 'ONLINE_AUTH_STABILITY');
  assert.equal(authStabilitySources.length, 10);
  assert.equal(new Set(authStabilitySources).size, 10);
  for (let mask = 0; mask < 128; mask++) {
    const paths = [
      ...authStabilitySources,
      ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineAuthStabilityOnly(paths), true);
    assert.equal(isOnlineLoginVisibilityOnly(paths), false);
    assert.equal(isOnlineSessionRefreshOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  }
  for (const old of [
    loginVisibilitySources,
    sessionRefreshSources,
    checkoutPreparedFieldsSources,
    coreParitySources,
    checkoutNavigationReadySources,
    checkoutLoadRecoverySources
  ])
    assert.equal(isOnlineAuthStabilityOnly(old), false);
});

test('authentication stability rejects missing proofs, duplicates and unrelated changes', () => {
  const complete = [...authStabilitySources, ...checkoutNavigationReadyControls];
  const rejected = (paths) => {
    assert.equal(isOnlineAuthStabilityOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const required of authStabilitySources)
    rejected(complete.filter((path) => path !== required));
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('authentication stability retains the complete login visibility validation commands', () => {
  const paths = [...authStabilitySources, ...checkoutNavigationReadyControls];
  const guards = onlineSettingsCommands('guards', paths);
  for (const part of ['api', 'online-engine'])
    assert.deepEqual(
      onlineSettingsCommands(part, paths),
      onlineSettingsCommands(part, loginVisibilitySources)
    );
  for (const name of [
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guards.flat().includes(name), name);
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
});

test('login visibility admits exactly eleven sources and seven optional controls without changing old scopes', () => {
  assert.equal(onlineLoginVisibilityScope, 'ONLINE_LOGIN_VISIBILITY');
  assert.equal(loginVisibilitySources.length, 11);
  assert.equal(new Set(loginVisibilitySources).size, 11);
  for (let mask = 0; mask < 128; mask++) {
    const paths = [
      ...loginVisibilitySources,
      ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineLoginVisibilityOnly(paths), true);
    assert.equal(isOnlineSessionRefreshOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  }
  for (const old of [
    sessionRefreshSources,
    [...sessionRefreshSources, sessionRefreshApiFixture, ...checkoutNavigationReadyControls],
    checkoutPreparedFieldsSources,
    coreParitySources,
    checkoutNavigationReadySources,
    checkoutLoadRecoverySources
  ])
    assert.equal(isOnlineLoginVisibilityOnly(old), false);
});

test('login visibility rejects missing proof, duplicates and neighboring runtime or control changes', () => {
  const complete = [...loginVisibilitySources, ...checkoutNavigationReadyControls];
  for (const required of loginVisibilitySources)
    assert.equal(
      isOnlineLoginVisibilityOnly(complete.filter((path) => path !== required)),
      false,
      required
    );
  const rejected = (paths) => {
    assert.equal(isOnlineLoginVisibilityOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'scripts/production-release/online-checkout-cs-release.py',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.spec.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('login visibility retains serial engine, upstream, API graph, types and all five guards', () => {
  const paths = [...loginVisibilitySources, ...checkoutNavigationReadyControls];
  const guards = onlineSettingsCommands('guards', paths);
  const api = onlineSettingsCommands('api', paths);
  const engine = onlineSettingsCommands('online-engine', paths);
  assert.deepEqual(api, onlineSettingsCommands('api', sessionRefreshSources));
  assert.deepEqual(engine, onlineSettingsCommands('online-engine', sessionRefreshSources));
  for (const name of [
    'prettier',
    'eslint',
    'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-change-scope.test.mjs',
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guards.flat().includes(name), name);
  assert.ok(api.flat().includes('typecheck'));
  assert.ok(
    api.flat().includes('src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts')
  );
  assert.ok(engine.flat().includes('test:upstream'));
  assert.ok(engine.some((command) => command.at(-1).includes?.('--test-concurrency=1')));
  for (const arg of [...guards, ...api, ...engine].flat())
    assert.ok(
      !/@apple-business\/admin|check:admin-ui|check:v2-(?:ui-language|color-contrast|table-standard|loading-standard)|mysql\.integration|migrate|docker|finance|test:online-recharge:controls/.test(
        arg
      ),
      arg
    );
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
});

test('session refresh admits its exact seven sources with only API fixture and seven optional controls', () => {
  assert.equal(onlineSessionRefreshScope, 'ONLINE_SESSION_REFRESH');
  assert.equal(sessionRefreshSources.length, 7);
  assert.equal(new Set(sessionRefreshSources).size, 7);
  for (const includeApi of [false, true])
    for (let mask = 0; mask < 128; mask++) {
      const paths = [
        ...sessionRefreshSources,
        ...(includeApi ? [sessionRefreshApiFixture] : []),
        ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
      ];
      assert.equal(isOnlineSessionRefreshOnly(paths), true);
      assert.equal(isOnlineSettingsOnly(paths), true);
      assert.equal(isOnlineSettingsControlsOnly(paths), false);
      assert.equal(isOnlineCheckoutPreparedFieldsOnly(paths), false);
      assert.equal(isOnlineCoreParityOnly(paths), false);
      assert.equal(isOnlineCheckoutNavigationReadyOnly(paths), false);
      assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
      assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), false);
      assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false);
      assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
      assert.equal(checkMode(paths, 'before', 'after'), 'full');
      assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
    }
  for (const old of [
    checkoutPreparedFieldsSources,
    coreParitySources,
    checkoutNavigationReadySources,
    checkoutLoadRecoverySources
  ])
    assert.equal(isOnlineSessionRefreshOnly(old), false);
});

test('session refresh rejects all missing required files, duplicates and neighboring implementation', () => {
  const complete = [
    ...sessionRefreshSources,
    sessionRefreshApiFixture,
    ...checkoutNavigationReadyControls
  ];
  const rejected = (paths) => {
    assert.equal(isOnlineSessionRefreshOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const required of sessionRefreshSources)
    rejected(complete.filter((path) => path !== required));
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'scripts/production-release/online-checkout-cs-release.py',
    'docs/ONLINE_SETTINGS_RELEASE_20261016.md',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-recovery.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.spec.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('session refresh retains serial engine, upstream, API graph, types and all five guards', () => {
  for (const paths of [
    sessionRefreshSources,
    [...sessionRefreshSources, sessionRefreshApiFixture, ...checkoutNavigationReadyControls]
  ]) {
    const guards = onlineSettingsCommands('guards', paths);
    const api = onlineSettingsCommands('api', paths);
    const engine = onlineSettingsCommands('online-engine', paths);
    assert.deepEqual(api, onlineSettingsCommands('api', checkoutLoadRecoverySources));
    assert.deepEqual(
      engine,
      onlineSettingsCommands('online-engine', checkoutPreparedFieldsSources)
    );
    for (const name of [
      'prettier',
      'eslint',
      'scripts/ci-online-settings-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs',
      'scripts/ci-change-scope.test.mjs',
      'scripts/production-release/online-checkout-load-release.test.py',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-prisma-runtime-boundary',
      'check:v2-concurrency-standard',
      'check:v2-decimal-standard'
    ])
      assert.ok(guards.flat().includes(name), name);
    assert.ok(api.flat().includes('typecheck'));
    assert.ok(api.flat().includes('@apple-business/api'));
    assert.ok(
      api.flat().includes('src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts')
    );
    assert.ok(engine.flat().includes('test:upstream'));
    assert.ok(engine.some((command) => command.at(-1).includes?.('--test-concurrency=1')));
    for (const arg of [...guards, ...api, ...engine].flat())
      assert.ok(
        !/@apple-business\/admin|check:admin-ui|check:v2-(?:ui-language|color-contrast|table-standard|loading-standard)|mysql\.integration|migrate|docker|finance|test:online-recharge:controls/.test(
          arg
        ),
        arg
      );
    assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
  }
});

test('prepared checkout fields admit exactly fifteen sources and only the seven reviewed controls', () => {
  assert.equal(onlineCheckoutPreparedFieldsScope, 'ONLINE_CHECKOUT_PREPARED_FIELDS');
  assert.equal(checkoutPreparedFieldsSources.length, 15);
  assert.equal(new Set(checkoutPreparedFieldsSources).size, 15);
  for (let mask = 0; mask < 128; mask++) {
    const paths = [
      ...checkoutPreparedFieldsSources,
      ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineCheckoutPreparedFieldsOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(isOnlineCoreParityOnly(paths), false);
    assert.equal(isOnlineCheckoutNavigationReadyOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), false);
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false);
    assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  }
  for (const old of [
    coreParitySources,
    checkoutNavigationReadySources,
    checkoutLoadRecoverySources
  ])
    assert.equal(isOnlineCheckoutPreparedFieldsOnly(old), false);
});

test('prepared checkout fields reject missing sources, duplicates and every adjacent scope', () => {
  const complete = [...checkoutPreparedFieldsSources, ...checkoutNavigationReadyControls];
  const rejected = (paths) => {
    assert.equal(isOnlineCheckoutPreparedFieldsOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const required of checkoutPreparedFieldsSources)
    rejected(complete.filter((path) => path !== required));
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'scripts/production-release/online-checkout-cs-release.py',
    'docs/ONLINE_SETTINGS_RELEASE_20261016.md',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-recovery.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-load-recovery.test.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.spec.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('prepared checkout fields keep the full engine, upstream, API graph, type and five guards', () => {
  const paths = [...checkoutPreparedFieldsSources, ...checkoutNavigationReadyControls];
  const guards = onlineSettingsCommands('guards', paths);
  const api = onlineSettingsCommands('api', paths);
  const engine = onlineSettingsCommands('online-engine', paths);
  assert.deepEqual(api, onlineSettingsCommands('api', checkoutLoadRecoverySources));
  for (const name of [
    'prettier',
    'eslint',
    'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-change-scope.test.mjs',
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guards.flat().includes(name), name);
  assert.ok(api.flat().includes('typecheck'));
  assert.ok(api.flat().includes('@apple-business/api'));
  assert.ok(
    api.flat().includes('src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts')
  );
  assert.ok(engine.flat().includes('test:upstream'));
  assert.ok(engine.some((command) => command.at(-1).includes?.('--test-concurrency=1')));
  for (const name of ['ffmpeg', 'xvfb', 'xauth']) assert.ok(engine.flat().includes(name));
  for (const arg of [...guards, ...api, ...engine].flat())
    assert.ok(
      !/@apple-business\/admin|check:admin-ui|check:v2-(?:ui-language|color-contrast|table-standard|loading-standard)|mysql\.integration|migrate|docker|finance|test:online-recharge:controls/.test(
        arg
      ),
      arg
    );
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
});

test('core parity admits exactly twenty-one core paths and only the seven reviewed controls', () => {
  assert.equal(onlineCoreParityScope, 'ONLINE_CORE_PARITY');
  assert.equal(coreParitySources.length, 21);
  assert.equal(new Set(coreParitySources).size, 21);
  for (let mask = 0; mask < 128; mask++) {
    const paths = [
      ...coreParitySources,
      ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineCoreParityOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(isOnlineCheckoutNavigationReadyOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), false);
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false);
    assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  }
  for (const old of [checkoutNavigationReadySources, checkoutLoadRecoverySources])
    assert.equal(isOnlineCoreParityOnly(old), false);
});

test('core parity rejects every missing core, duplicate and adjacent business or control path', () => {
  const complete = [...coreParitySources, ...checkoutNavigationReadyControls];
  const rejected = (paths) => {
    assert.equal(isOnlineCoreParityOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const required of coreParitySources) rejected(complete.filter((path) => path !== required));
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'scripts/production-release/online-checkout-cs-release.py',
    'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.spec.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('core parity keeps the complete engine, API local-chain and existing guard commands', () => {
  const paths = [...coreParitySources, ...checkoutNavigationReadyControls];
  for (const part of ['api', 'online-engine'])
    assert.deepEqual(
      onlineSettingsCommands(part, paths),
      onlineSettingsCommands(part, checkoutLoadRecoverySources)
    );
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
  const guards = onlineSettingsCommands('guards', paths).flat();
  for (const name of [
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guards.includes(name), name);
  for (const path of checkoutNavigationReadyControls.slice(0, 4)) {
    assert.equal(isOnlineSettingsOnly([path]), false);
    assert.equal(isOnlineSettingsControlsOnly([path]), true);
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
});

test('navigation readiness admits its exact seventeen core paths with only seven reviewed controls', () => {
  assert.equal(onlineCheckoutNavigationReadyScope, 'ONLINE_CHECKOUT_NAVIGATION_READY');
  assert.equal(checkoutNavigationReadySources.length, 17);
  assert.equal(new Set(checkoutNavigationReadySources).size, 17);
  assert.equal(checkoutNavigationReadyControls.length, 7);
  for (let mask = 0; mask < 128; mask++) {
    const paths = [
      ...checkoutNavigationReadySources,
      ...checkoutNavigationReadyControls.filter((_, index) => mask & (1 << index))
    ];
    assert.equal(isOnlineCheckoutNavigationReadyOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), false);
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false);
    assert.equal(checkMode(paths, 'unchanged', 'unchanged'), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  }
  assert.equal(isOnlineCheckoutNavigationReadyOnly(checkoutLoadRecoverySources), false);
});

test('navigation readiness rejects every missing core, duplicate and adjacent business or control path', () => {
  const complete = [...checkoutNavigationReadySources, ...checkoutNavigationReadyControls];
  const rejected = (paths) => {
    assert.equal(isOnlineCheckoutNavigationReadyOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  };
  for (const required of checkoutNavigationReadySources)
    rejected(complete.filter((path) => path !== required));
  for (const path of complete) rejected([...complete, path]);
  for (const extra of [
    '.github/workflows/online-checkout-load-validation.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/production-release/online-checkout-load-unreviewed.py',
    'scripts/production-release/online-checkout-cs-release.py',
    'docs/V2_TASKS.md',
    'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/test/rpc-response.test.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/unreviewed.spec.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json'
  ])
    rejected([...complete, extra]);
});

test('navigation readiness preserves guards, API local-chain and complete two-worker engine checks', () => {
  const paths = [...checkoutNavigationReadySources, ...checkoutNavigationReadyControls];
  for (const part of ['api', 'online-engine'])
    assert.deepEqual(
      onlineSettingsCommands(part, paths),
      onlineSettingsCommands(part, checkoutLoadRecoverySources)
    );
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
  const guard = onlineSettingsCommands('guards', paths);
  for (const name of [
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guard.flat().includes(name), name);
  for (const path of checkoutNavigationReadyControls.slice(0, 4)) {
    assert.equal(isOnlineSettingsOnly([path]), false);
    assert.equal(isOnlineSettingsControlsOnly([path]), true);
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
  const ciControls = checkoutNavigationReadyControls.slice(4);
  assert.equal(isOnlineSettingsControlsOnly(ciControls), true);
  assert.deepEqual(selectedParts(ciControls), ['guards']);
  assert.equal(isOnlineSettingsControlsOnly(['scripts/ci-recharge-scope.mjs']), false);
});

test('checkout load recovery has an independent exact fifteen-source scope and no Admin check', () => {
  assert.equal(onlineCheckoutLoadRecoveryScope, 'ONLINE_CHECKOUT_LOAD_RECOVERY');
  assert.equal(checkoutLoadRecoverySources.length, 15);
  for (const paths of [
    checkoutLoadRecoverySources,
    [...checkoutLoadRecoverySources, ...checkoutLoadRecoveryOptional],
    [...checkoutLoadRecoverySources, 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md']
  ]) {
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(isOnlineCheckoutCsRecoveryOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
  }
  for (const path of [
    ...checkoutLoadRecoveryReleaseControls,
    ...checkoutLoadRecoverySources.filter((path) =>
      /checkout-load-recovery|checkout-page-loading|recharge-flow-acceptance|local-chain-acceptance/.test(
        path
      )
    )
  ])
    assert.equal(onlineSettingsPaths.includes(path), false, 'older scopes must stay unchanged');
});

test('the parent lease recovery delta is mandatory without admitting neighboring RPC or worker changes', () => {
  const delta = ['rpc.cjs', 'test/rpc-response.test.cjs'].map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  );
  const original = checkoutLoadRecoverySources.filter((path) => !delta.includes(path));
  assert.equal(original.length, 13);
  for (const paths of [original, ...delta.map((path) => [...original, path])]) {
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
  const complete = [...original, ...delta];
  assert.equal(isOnlineCheckoutLoadRecoveryOnly(complete), true);
  assert.deepEqual(selectedParts(complete), ['guards', 'api', 'online-engine']);
  for (const path of [
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts'
  ]) {
    assert.equal(isOnlineCheckoutLoadRecoveryOnly([...complete, path]), false);
    assert.equal(checkMode([...complete, path], '', ''), 'full');
  }
  assert.equal(isOnlineCheckoutCsRecoveryOnly([...checkoutCsRecoverySources, ...delta]), false);
});

const checkoutLoadParentRpcSources = [
  'SOURCE_MANIFEST.json',
  'rpc.cjs',
  'test/rpc-response.test.cjs'
].map((name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name);

test('the parent RPC successor from the published baseline needs exactly its three changed engine sources', () => {
  for (const paths of [
    checkoutLoadParentRpcSources,
    [...checkoutLoadParentRpcSources, ...checkoutLoadRecoveryOptional],
    [...checkoutLoadParentRpcSources, 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md']
  ]) {
    assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), true);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'recharge');
    assert.equal(checkMode(paths, 'before', 'after'), 'full');
    assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
    assert.throws(() => onlineSettingsCommands('api', paths), /parent RPC API/);
    assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
    assert.ok(
      onlineSettingsCommands('online-engine', paths)
        .flat()
        .some((arg) => arg.includes('--test-concurrency=2'))
    );
    const guards = onlineSettingsCommands('guards', paths).flat();
    assert.ok(guards.includes('scripts/production-release/online-checkout-load-release.test.py'));
    assert.ok(
      !guards.some((arg) => /@apple-business|mysql\.integration|finance|migrate/.test(arg))
    );
  }
  assert.equal(isOnlineCheckoutLoadParentRpcOnly(checkoutLoadRecoverySources), false);
});

test('the parent RPC successor rejects missing proof, duplicates and every unrelated partial feature', () => {
  const exact = [...checkoutLoadParentRpcSources, ...checkoutLoadRecoveryOptional];
  for (const paths of [
    ...checkoutLoadParentRpcSources.map((missing) => exact.filter((path) => path !== missing)),
    ...[
      exact[0],
      checkoutLoadRecoveryOptional[0],
      'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
      'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
      'apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
      'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
      'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
      'apps/api/prisma-mysql/schema.prisma',
      'package-lock.json',
      'scripts/production-release/online-checkout-cs-release.py'
    ].map((path) => [...exact, path])
  ]) {
    assert.equal(isOnlineCheckoutLoadParentRpcOnly(paths), false);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'full');
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
});

test('every load-recovery source is mandatory and adjacent API, Admin, schema and dependencies fall back', () => {
  const exact = [...checkoutLoadRecoverySources, ...checkoutLoadRecoveryOptional];
  for (const required of checkoutLoadRecoverySources) {
    const paths = exact.filter((path) => path !== required);
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false, required);
    assert.equal(isOnlineSettingsOnly(paths), false, required);
    assert.equal(checkMode(paths, '', ''), 'full', required);
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'package.json',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/package.json',
    'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/contracts.ts',
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'apps/api/src/auth/auth.service.ts',
    'scripts/production-release/online-checkout-cs-release.py',
    'scripts/ci-recharge-check.mjs',
    exact[0],
    checkoutLoadRecoveryOptional[0]
  ]) {
    const paths = [...exact, extra];
    assert.equal(isOnlineCheckoutLoadRecoveryOnly(paths), false, extra);
    assert.equal(isOnlineSettingsOnly(paths), false, extra);
    assert.equal(checkMode(paths, '', ''), 'full', extra);
    assert.throws(() => onlineSettingsCommands('guards', paths));
  }
});

test('load-recovery control-only changes select only their own protected publisher and guards', () => {
  for (const paths of [
    ...checkoutLoadRecoveryReleaseControls.map((path) => [path]),
    checkoutLoadRecoveryOptional
  ]) {
    assert.equal(isOnlineCheckoutLoadRecoveryControlsOnly(paths), true);
    assert.equal(isOnlineSettingsControlsOnly(paths), true);
    assert.equal(isOnlineSettingsOnly(paths), false);
    assert.equal(checkMode(paths, '', ''), 'ci-only');
    assert.deepEqual(selectedParts(paths), ['guards']);
    const commands = onlineSettingsCommands('guards', paths);
    assert.deepEqual(
      commands.filter((command) => command[0] === 'python3'),
      [['python3', '-B', 'scripts/production-release/online-checkout-load-release.test.py']]
    );
    assert.ok(!commands.flat().some((arg) => /@apple-business|check:v2-|check:admin-ui/.test(arg)));
    for (const part of ['api', 'admin', 'online-engine'])
      assert.throws(() => onlineSettingsCommands(part, paths), /controls-only/);
  }
  for (const paths of [
    [],
    ['docs/ONLINE_RECHARGE.md'],
    ['scripts/ci-online-settings-scope.mjs'],
    [...checkoutLoadRecoveryOptional, checkoutLoadRecoverySources[0]],
    [...checkoutLoadRecoveryOptional, checkoutLoadRecoveryReleaseControls[0]],
    [...checkoutLoadRecoveryOptional, 'package-lock.json']
  ])
    assert.equal(isOnlineCheckoutLoadRecoveryControlsOnly(paths), false);
});

test('load-recovery commands prepare fixed Chromium for only the new API spec and cap engine concurrency', () => {
  const paths = [...checkoutLoadRecoverySources, ...checkoutLoadRecoveryOptional];
  const guards = onlineSettingsCommands('guards', paths);
  const api = onlineSettingsCommands('api', paths);
  const engine = onlineSettingsCommands('online-engine', paths);
  for (const name of [
    'scripts/production-release/online-checkout-load-release.test.py',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard',
    'check:v2-decimal-standard'
  ])
    assert.ok(guards.flat().includes(name), name);
  assert.ok(
    guards.some((command) =>
      command.at(-1).includes?.('Online checkout load source fingerprints passed.')
    )
  );
  assert.ok(api.flat().includes('prisma:mysql:generate'));
  assert.ok(api.flat().includes('typecheck'));
  const apiTest = api.filter((command) => command.includes('test'));
  assert.deepEqual(apiTest, [
    [
      'npm',
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts'
    ]
  ]);
  for (const commands of [api, engine]) {
    assert.ok(
      commands.some(
        (command) =>
          command[0] === 'npm' &&
          command.includes('ci') &&
          command.includes('apps/api/src/id-business-v2/online-recharge/engine/upstream')
      )
    );
    assert.ok(
      commands.some(
        (command) =>
          command[0] === 'node' &&
          command[1].endsWith('/upstream/node_modules/playwright/cli.js') &&
          command.slice(2).join(' ') === 'install --with-deps chromium'
      )
    );
  }
  const engineText = engine.map((command) => command.join(' ')).join('\n');
  assert.ok(engineText.includes('--test-concurrency=2'));
  assert.ok(engineText.includes('.test.cjs'));
  assert.ok(engine.some((command) => command.includes('test:upstream')));
  for (const arg of [...guards, ...api, ...engine].flat())
    assert.ok(
      !/@apple-business\/admin|check:admin-ui|check:v2-(?:ui-language|color-contrast|table-standard|loading-standard)|mysql\.integration|migrate|docker|finance|test:online-recharge:controls/.test(
        arg
      ),
      arg
    );
  assert.ok(!api.flat().includes('src/id-business-v2/online-recharge'));
  assert.ok(!api.flat().includes('prisma:mysql:validate'));
  assert.throws(() => onlineSettingsCommands('admin', paths), /Admin/);
});

for (const [name, paths] of [
  ['load-recovery', checkoutLoadRecoverySources],
  ['navigation readiness', checkoutNavigationReadySources],
  ['core parity', coreParitySources],
  ['prepared fields', checkoutPreparedFieldsSources],
  ['session refresh', sessionRefreshSources],
  ['login visibility', loginVisibilitySources],
  ['authentication stability', authStabilitySources]
])
  test(`${name} source verification executes every fingerprint and rejects incomplete or tampered manifests`, () => {
    const command = onlineSettingsCommands('guards', paths).find((args) =>
      args.at(-1).includes?.('Online checkout load source fingerprints passed.')
    );
    assert.ok(command && command[0] === 'node');
    const source = command.at(-1).replace(/^import .+;$/gm, '');
    const root = resolve('apps/api/src/id-business-v2/online-recharge/engine');
    const names = paths
      .filter((path) => path.includes('/engine/') && !path.endsWith('/SOURCE_MANIFEST.json'))
      .map((path) => path.split('/engine/')[1]);
    const bodies = new Map(names.map((name) => [resolve(root, name), `synthetic ${name}\n`]));
    const manifest = {
      repository: 'https://github.com/nowtostudeyday/PAY-GPT-UPGRADE.git',
      commit: 'ba6cf96312a6953e62edb9d74299d438d12549df',
      files: names.map((path) => ({
        path,
        adaptedSha256: createHash('sha256')
          .update(bodies.get(resolve(root, path)))
          .digest('hex')
      }))
    };
    const verify = (value, files = bodies) =>
      runInNewContext(source, {
        assert,
        createHash,
        resolve,
        sep,
        isAbsolute,
        win32,
        readFileSync: (path) => {
          if (path === resolve(root, 'SOURCE_MANIFEST.json')) return JSON.stringify(value);
          assert.ok(files.has(path), 'source verification cannot read unknown or escaped files');
          return files.get(path);
        },
        console: { log() {} }
      });
    assert.doesNotThrow(() => verify(manifest));
    assert.throws(() => verify({ ...manifest, commit: 'unreviewed' }));
    for (const required of names)
      assert.throws(() =>
        verify({ ...manifest, files: manifest.files.filter((row) => row.path !== required) })
      );
    assert.throws(() => verify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
    for (const path of ['../escaped.cjs', '/absolute.cjs', 'C:\\escaped.cjs'])
      assert.throws(() =>
        verify({
          ...manifest,
          files: [...manifest.files, { path, adaptedSha256: '0'.repeat(64) }]
        })
      );
    assert.throws(() =>
      verify({
        ...manifest,
        files: manifest.files.map((row, index) =>
          index === 0 ? { ...row, adaptedSha256: '0'.repeat(64) } : row
        )
      })
    );
    const tampered = new Map(bodies);
    tampered.set(resolve(root, names.at(-1)), 'changed after the reviewed manifest');
    assert.throws(() => verify(manifest, tampered));
  });

test('load-recovery engine command discovers all current tests once with two workers and preserves failure', () => {
  const command = onlineSettingsCommands('online-engine', checkoutLoadRecoverySources).find(
    (args) => args.at(-1).includes?.('--test-concurrency=2')
  );
  assert.ok(command && command[0] === 'node');
  const source = command.at(-1).replace(/^import .+;$/gm, '');
  const root = 'apps/api/src/id-business-v2/online-recharge/engine/test';
  const execute = (files, status = 0) => {
    const observed = { calls: [], exits: [] };
    runInNewContext(source, {
      readdirSync: (path) => {
        assert.equal(path, root);
        return files;
      },
      spawnSync: (file, args, options) => {
        observed.calls.push({ file, args: Array.from(args), inherit: options.stdio });
        return { status };
      },
      process: { execPath: '/synthetic/node', exit: (code) => observed.exits.push(code) }
    });
    return observed;
  };
  const result = execute(['z.test.cjs', 'README.md', 'a.test.cjs', 'unrelated.mjs']);
  assert.deepEqual(result.calls, [
    {
      file: '/synthetic/node',
      args: ['--test', '--test-concurrency=2', root + '/a.test.cjs', root + '/z.test.cjs'],
      inherit: 'inherit'
    }
  ]);
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(execute(['a.test.cjs'], 2).exits, [2]);
  assert.deepEqual(execute(['a.test.cjs'], null).exits, [1]);
  assert.throws(() => execute(['README.md']), /Missing online engine regression files/);
});

for (const [name, paths] of [
  ['prepared fields', checkoutPreparedFieldsSources],
  ['session refresh', sessionRefreshSources],
  ['login visibility', loginVisibilitySources],
  ['authentication stability', authStabilitySources]
])
  test(`${name} execute every discovered engine test once, serially, and preserve failure`, () => {
    const command = onlineSettingsCommands('online-engine', paths).find((args) =>
      args.at(-1).includes?.('--test-concurrency=1')
    );
    assert.ok(command && command[0] === 'node');
    const source = command.at(-1).replace(/^import .+;$/gm, '');
    const root = 'apps/api/src/id-business-v2/online-recharge/engine/test';
    const execute = (files, status = 0) => {
      const observed = { calls: [], exits: [] };
      runInNewContext(source, {
        readdirSync: (path) => {
          assert.equal(path, root);
          return files;
        },
        spawnSync: (file, args, options) => {
          observed.calls.push({ file, args: Array.from(args), inherit: options.stdio });
          return { status };
        },
        process: { execPath: '/synthetic/node', exit: (code) => observed.exits.push(code) }
      });
      return observed;
    };
    assert.deepEqual(execute(['z.test.cjs', 'README.md', 'a.test.cjs']).calls, [
      {
        file: '/synthetic/node',
        args: ['--test', '--test-concurrency=1', root + '/a.test.cjs', root + '/z.test.cjs'],
        inherit: 'inherit'
      }
    ]);
    assert.deepEqual(execute(['a.test.cjs']).exits, [0]);
    assert.deepEqual(execute(['a.test.cjs'], 2).exits, [2]);
    assert.deepEqual(execute(['a.test.cjs'], null).exits, [1]);
    assert.throws(() => execute(['README.md']), /Missing online engine regression files/);
  });
