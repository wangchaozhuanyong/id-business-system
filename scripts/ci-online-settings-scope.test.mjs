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
