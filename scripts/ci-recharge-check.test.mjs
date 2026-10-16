import {
  proxyResultIdentityPaths,
  proxyResultIdentityBase,
  proxyResultIdentityEngineTests,
  proxyResultIdentityEngineRoot
} from './ci-proxy-result-identity-scope.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  onlineProxyCountryPaths,
  onlineProxyCountryCommands
} from './ci-online-proxy-country-scope.mjs';
import { fileURLToPath } from 'node:url';
import {
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  productionDatabaseAccessAcceptance,
  unpublishedComponentSuccessorControlPaths,
  unpublishedComponentSuccessorEntryPaths,
  rechargeFlowSuccessorControlPaths,
  ownedMysqlTestControlPaths,
  rechargeConnectionProfileMigration,
  onlinePrepareFixGuardCommands,
  onlinePrepareFixGuardBinding,
  onlinePrepareFixGuardPaths,
  onlinePreflightReceiptFixGuardCommands,
  onlinePreflightReceiptFixGuardBinding,
  onlineBuildProofReuseCommands,
  onlinePreflightReceiptFixGuardPaths
} from './ci-recharge-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readonlyMetadataPaths = [
  'scripts/production-release/online-recharge-component-readonly.py',
  'scripts/production-release/online-recharge-component-readonly.test.py'
];
const readonlyMetadataCurrent = readFileSync(resolve(root, readonlyMetadataPaths[0]), 'utf8');
const readonlyMetadataPrevious = readonlyMetadataCurrent
  .replace("'/git/commits/'", "'/commits/'")
  .replace(
    "commit.get('tree', {}).get('sha')",
    "commit.get('commit', {}).get('tree', {}).get('sha')"
  );
const readonlyMetadataFixture = { readonlyBaseSource: readonlyMetadataPrevious };

test('proxy country dispatcher executes each affected part and closes before historical publishers', () => {
  for (const part of ['guards', 'api', 'admin', 'online-engine']) {
    const calls = recordGuardCommands('recharge', onlineProxyCountryPaths, part);
    assert.deepEqual(calls, [
      ...onlineProxyCountryCommands(part, onlineProxyCountryPaths),
      ['process-exit', 0]
    ]);
  }
  assert.throws(
    () => recordGuardCommands('recharge', onlineProxyCountryPaths, 'migration'),
    /Unsupported proxy country check part/
  );
});

test('exact migration query repair retains fresh release tests and selector gates without the historical prefix', () => {
  const paths = [
    'scripts/production-release/registration-closure-release.py',
    'scripts/production-release/registration-closure-release.test.py',
    'scripts/ci-registration-closure-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-recharge-scope.test.mjs'
  ];
  const options = { base: 'd38c243b5727953aa96c0fa83e706fee253c9624' };
  const calls = recordGuardCommands('ci-only', paths, 'guards', options);
  assert.equal(
    calls.filter(
      (row) =>
        row.join(' ') ===
        'python3 -B scripts/production-release/registration-closure-release.test.py'
    ).length,
    1
  );
  for (const command of ['prettier', 'eslint'])
    assert.ok(calls.some((row) => row.includes(command)));
  const tests = calls.find((row) => row[0] === 'node' && row[1] === '--test');
  assert.ok(tests.includes('scripts/ci-registration-closure-native-reuse.test.mjs'));
  assert.equal(tests.length, 6);
  assert.deepEqual(calls.at(-1), ['process-exit', 0]);
  assert.equal(
    calls.some((row) =>
      row.includes('scripts/production-release/api-admin-pending-online.test.py')
    ),
    false
  );
  const wider = recordGuardCommands(
    'ci-only',
    [...paths, 'scripts/production-release/registration-closure-contract.json'],
    'guards',
    options
  );
  assert.ok(
    wider.some((row) => row.includes('scripts/production-release/api-admin-pending-online.test.py'))
  );
});

test('exact declaration proof repair runs its publisher tests and selectors without unrelated historical prefix', () => {
  const paths = [
    'scripts/production-release/registration-closure-contract.json',
    'scripts/production-release/registration-closure-release.test.py',
    'scripts/ci-registration-closure-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-recharge-scope.test.mjs'
  ];
  const options = { base: 'cd7bba03bec1742328e0829c215823bda1fd3fae' };
  const calls = recordGuardCommands('ci-only', paths, 'guards', options);
  assert.equal(
    calls.filter(
      (row) =>
        row.join(' ') ===
        'python3 -B scripts/production-release/registration-closure-release.test.py'
    ).length,
    1
  );
  for (const command of ['prettier', 'eslint'])
    assert.ok(calls.some((row) => row.includes(command)));
  const tests = calls.find((row) => row[0] === 'node' && row[1] === '--test');
  assert.ok(tests.includes('scripts/ci-registration-closure-native-reuse.test.mjs'));
  assert.equal(tests.length, 6);
  assert.deepEqual(calls.at(-1), ['process-exit', 0]);
  assert.equal(
    calls.some((row) =>
      row.includes('scripts/production-release/api-admin-pending-online.test.py')
    ),
    false
  );
  const wider = recordGuardCommands(
    'ci-only',
    [...paths, '.github/workflows/registration-closure-validation.yml'],
    'guards',
    options
  );
  assert.ok(
    wider.some((row) => row.includes('scripts/production-release/api-admin-pending-online.test.py'))
  );
});

test('exact registration dependency controls retain own tests and formatting before ending ahead of historical suites', () => {
  const paths = [
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-closure-release.test.py',
    'scripts/ci-registration-closure-native-reuse.test.mjs',
    'scripts/ci-registration-closure-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-recharge-scope.test.mjs'
  ];
  const options = { base: '7d1c3822c8f8c8c6a970067580443a3b75e88bf0' };
  const calls = recordGuardCommands('ci-only', paths, 'guards', options);
  assert.equal(
    calls.filter(
      (row) =>
        row.join(' ') ===
        'python3 -B scripts/production-release/registration-closure-release.test.py'
    ).length,
    1
  );
  assert.ok(calls.some((row) => row.slice(0, 5).join(' ') === 'npm exec -- prettier --check'));
  assert.ok(calls.some((row) => row.slice(0, 4).join(' ') === 'npm exec -- eslint'));
  const tests = calls.find((row) => row[0] === 'node' && row[1] === '--test');
  for (const name of [
    'ci-recharge-scope',
    'ci-recharge-check',
    'ci-recharge-checkout-scope',
    'ci-registration-closure-native-reuse'
  ])
    assert.ok(tests.includes(`scripts/${name}.test.mjs`));
  assert.deepEqual(calls.at(-1), ['process-exit', 0]);
  assert.equal(
    calls.some((row) =>
      row.some(
        (arg) =>
          typeof arg === 'string' &&
          /api-admin-pending-online.test.py|remote-deploy.test.py/.test(arg)
      )
    ),
    false
  );
  const wider = recordGuardCommands(
    'ci-only',
    [...paths, 'apps/api/src/id-business-v2/online-recharge/public.controller.ts'],
    'guards',
    options
  );
  assert.ok(
    wider.some((row) => row.includes('scripts/production-release/api-admin-pending-online.test.py'))
  );
});

test('new ONLINE controls retain pure diagnostics lifecycle and CI build tests without invoking Docker', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const path of [
      'scripts/production-release/online-recharge-ci-build.test.py',
      'scripts/production-release/online-recharge-component-lifecycle.test.py',
      'scripts/production-release/online-recharge-ci-build.py',
      'scripts/production-release/online-recharge-component-runtime.py',
      'scripts/production-release/online-recharge-component-recovery.py',
      'scripts/production-release/online-recharge-component-recovery-readonly.py',
      '.github/workflows/online-recharge-recovery.yml',
      '.github/workflows/online-recharge-diagnostic.yml'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      for (const suite of [
        'online-recharge-ci-build.test.py',
        'online-recharge-component-diagnostic.test.py',
        'online-recharge-component-lifecycle.test.py',
        'online-recharge-component-recovery.test.py',
        'online-recharge-component-recovery-readonly.test.py'
      ])
        assert.equal(
          calls.filter((row) => row.join(' ') === `python3 -B scripts/production-release/${suite}`)
            .length,
          1,
          `${part}: ${path}: ${suite}`
        );
      assert.equal(
        calls.filter(
          (row) =>
            row.join(' ') ===
            'node --test scripts/production-release/online-recharge-component-diagnostic-entry.test.mjs'
        ).length,
        1
      );
      assert.ok(
        calls.every(
          (row) =>
            !row.includes('docker') &&
            !row.includes('scripts/production-release/online-recharge-ci-build.py')
        )
      );
    }
  }
});

test('Admin with exact historical fixture repairs retains both control suites without building images', () => {
  const paths = [
    'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
    'scripts/production-release/online-recharge-ci-build.test.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py'
  ];
  const calls = recordGuardCommands('admin', paths, 'guards');
  for (const suite of [
    'online-recharge-ci-build.test.py',
    'online-recharge-component-lifecycle.test.py'
  ])
    assert.equal(
      calls.filter((row) => row.join(' ') === `python3 -B scripts/production-release/${suite}`)
        .length,
      1,
      suite
    );
  assert.ok(
    calls.every(
      (row) =>
        !row.includes('docker') &&
        !row.includes('scripts/production-release/online-recharge-ci-build.py')
    )
  );
});

test('full Quality runs new ONLINE pure suites in its later guards without duplicating its release-controls prefix', () => {
  const paths = ['scripts/ci-recharge-check.mjs'];
  const prefix = recordGuardCommands('full', paths, 'release-controls');
  const guards = recordGuardCommands('ci-only', paths, 'guards');
  for (const suite of [
    'online-recharge-ci-build.test.py',
    'online-recharge-component-diagnostic.test.py',
    'online-recharge-component-lifecycle.test.py',
    'online-recharge-component-recovery.test.py',
    'online-recharge-component-recovery-readonly.test.py'
  ]) {
    assert.equal(
      prefix.filter((row) => row.includes('scripts/production-release/' + suite)).length,
      0
    );
    assert.equal(
      guards.filter((row) => row.includes('scripts/production-release/' + suite)).length,
      1
    );
  }
});

test('mixed typed receipt ONLINE and archive changes execute each controller and fresh control suite once', () => {
  const paths = [
    ...onlinePreflightReceiptFixGuardPaths,
    'scripts/production-release/online-recharge-ci-build.py',
    'scripts/production-release/online-recharge-component-diagnostic.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py',
    'scripts/production-release/release-artifact-retention.py',
    'scripts/production-release/release-artifact-retention-transport.py'
  ];
  for (const part of ['guards', 'release-controls']) {
    const calls = recordGuardCommands('ci-only', paths, part);
    for (const suite of [
      'online-recharge-component-runtime.test.py',
      'online-recharge-component-readonly.test.py',
      'online-recharge-ci-build.test.py',
      'online-recharge-component-diagnostic.test.py',
      'online-recharge-component-lifecycle.test.py',
      'release-artifact-retention.test.py',
      'release-artifact-retention-transport.test.py'
    ])
      assert.equal(
        calls.filter((call) => call.includes('scripts/production-release/' + suite)).length,
        1,
        `${part}: ${suite}`
      );
    assert.ok(calls.every((call) => !call.includes('docker') && !call.includes('process-exit')));
  }
});
const gates = [
  'check:v2-module-architecture',
  'check:v2-prisma-runtime-boundary',
  'check:v2-concurrency-standard'
];

test('ordinary ONLINE component pure tests run once in either control dispatcher', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const changed of [
      'scripts/production-release/online-recharge-component-consumer.py',
      'scripts/production-release/online-recharge-component-consumer.test.py',
      'scripts/production-release/online-recharge-component-runtime.py',
      'scripts/production-release/online-recharge-component-runtime.test.py',
      'scripts/production-release/online-recharge-component-readonly.py',
      'scripts/production-release/online-recharge-component-readonly.test.py'
    ]) {
      const metadataGuard = part === 'guards' && readonlyMetadataPaths.includes(changed);
      const calls = recordGuardCommands(
        'ci-only',
        metadataGuard ? readonlyMetadataPaths : [changed],
        part,
        metadataGuard ? readonlyMetadataFixture : {}
      );
      for (const helper of ['consumer', 'runtime', 'readonly'])
        assert.equal(
          calls.filter(
            (call) =>
              call.join(' ') ===
              `python3 -B scripts/production-release/online-recharge-component-${helper}.test.py`
          ).length,
          1
        );
      assert.ok(
        calls.every(
          (call) =>
            !call.includes('docker') &&
            !call.some(
              (arg) =>
                typeof arg === 'string' &&
                (arg.includes('acceptance-v2') || arg.startsWith('--workspace'))
            )
        )
      );
    }
  }
});

test('exact readonly Quality metadata repair keeps the common prefix and only four transport suites', () => {
  const tail = [
    ...['readonly', 'recovery-readonly', 'consumer', 'runtime'].map((name) => [
      'python3',
      '-B',
      `scripts/production-release/online-recharge-component-${name}.test.py`
    ]),
    ['process-exit', 0]
  ];
  for (const selectors of [
    [],
    ['scripts/ci-recharge-check.mjs'],
    ['scripts/ci-recharge-check.test.mjs'],
    ['scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs']
  ]) {
    const calls = recordGuardCommands(
      'ci-only',
      [...readonlyMetadataPaths, ...selectors],
      'guards',
      readonlyMetadataFixture
    );
    const prefix = calls.findIndex((call) => call.includes('scripts/ci-recharge-scope.test.mjs'));
    assert.ok(prefix >= 0);
    assert.ok(calls[prefix].includes('scripts/ci-recharge-check.test.mjs'));
    assert.deepEqual(calls.slice(prefix + 1), tail);
    assert.equal(
      calls.filter((call) => call.includes('prettier')).length,
      selectors.length ? 1 : 0
    );
    assert.equal(calls.filter((call) => call.includes('eslint')).length, selectors.length ? 1 : 0);
    assert.ok(calls.slice(0, prefix).every((call) => call[0] === 'npm'));
  }
});

test('metadata shortcut rejects incomplete paths extra paths modes and any other readonly bytes', () => {
  const cases = [
    { paths: [readonlyMetadataPaths[0]] },
    { paths: [readonlyMetadataPaths[1]] },
    { paths: ['scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs'] },
    {
      paths: [
        ...readonlyMetadataPaths,
        'scripts/production-release/online-recharge-component-runtime.py'
      ]
    },
    { paths: [...readonlyMetadataPaths, 'docs/V2_TASKS.md'] },
    { mode: 'full' },
    { mode: 'recharge' },
    { part: 'release-controls' },
    { fixture: { readonlyBaseSource: readonlyMetadataCurrent } },
    { fixture: { readonlyBaseSource: '' } },
    {
      fixture: { ...readonlyMetadataFixture, readonlyCurrentSource: readonlyMetadataCurrent + '\n' }
    },
    { fixture: { readonlyBaseSource: readonlyMetadataPrevious + "\n# '/commits/'\n" } },
    {
      fixture: { readonlyBaseSource: readonlyMetadataPrevious.replace("'/commits/'", "'/other/'") }
    }
  ];
  for (const {
    paths = readonlyMetadataPaths,
    mode = 'ci-only',
    part = 'guards',
    fixture = readonlyMetadataFixture
  } of cases) {
    const calls = recordGuardCommands(mode, paths, part, fixture);
    assert.ok(calls.every((call) => call[0] !== 'process-exit'));
    if (paths.some((path) => path.startsWith('scripts/production-release/'))) {
      assert.ok(
        calls.some((call) =>
          call.includes('scripts/production-release/online-recharge-scope.test.py')
        )
      );
      assert.ok(
        calls.some((call) =>
          call.includes('scripts/production-release/api-admin-pending-online.test.py')
        )
      );
      if (part === 'guards')
        assert.ok(
          calls.some((call) => call.includes('scripts/production-release/remote-deploy.test.py'))
        );
    }
  }
  assert.throws(
    () =>
      recordGuardCommands('ci-only', readonlyMetadataPaths, 'guards', {
        ...readonlyMetadataFixture,
        failCommand:
          'python3 -B scripts/production-release/online-recharge-component-readonly.test.py'
      }),
    /SYNTHETIC_COMMAND_FAILURE/
  );
});

test('readonly metadata shortcut leaves the separate four-image Quality step and artifact intact', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/quality.yml'), 'utf8');
  const build = readFileSync(
    resolve(root, 'scripts/production-release/online-recharge-ci-build.py'),
    'utf8'
  );
  assert.ok(
    workflow.includes(
      "matrix.part == 'guards' && needs.change-scope.outputs.online_ci_build == 'true'"
    )
  );
  const check = workflow.indexOf(
    'run: node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"'
  );
  const images = workflow.indexOf(
    'run: python3 -B scripts/production-release/online-recharge-ci-build.py',
    check
  );
  assert.ok(check > 0 && images > check);
  assert.ok(workflow.indexOf('name: Preserve CI-only ONLINE image verification', images) > images);
  assert.ok(build.includes("IMAGES = ('api', 'admin', 'migrate', 'online-recharge')"));
});

test('disk retention controls run lifecycle suites without database acceptance', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const changed of [
      'scripts/production-release/disk-retention.py',
      'scripts/production-release/disk-retention-install.py',
      'scripts/production-release/disk-retention-transport.py',
      '.github/workflows/disk-retention-maintenance.yml',
      'scripts/production-release/candidate-retention.py',
      'scripts/production-release/disk-lifecycle.test.py',
      'scripts/production-release/release-storage.py',
      'deploy/aws/disk-retention-policy-20261014.json'
    ]) {
      const calls = recordGuardCommands('ci-only', [changed], part);
      for (const suite of [
        'disk-retention.test.py',
        'disk-retention-install.test.py',
        'disk-retention-transport.test.py',
        'candidate-retention.test.py',
        'disk-lifecycle.test.py',
        'release-storage.test.py'
      ]) {
        assert.equal(
          calls.filter(
            (call) => call.join(' ') === `python3 -B scripts/production-release/${suite}`
          ).length,
          1
        );
      }
      assert.ok(
        calls.every(
          (call) => !call.includes('docker') && !call.some((arg) => arg.includes('mysql'))
        )
      );
    }
  }
});

test('Admin successor diagnostics always retain their offline controls', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const changed of [
      'scripts/production-release/admin-successor-diagnostic.py',
      'scripts/production-release/admin-successor-diagnostic.test.py',
      'scripts/production-release/admin-pending-online-release.py',
      '.github/workflows/production-release.yml'
    ]) {
      const calls = recordGuardCommands('ci-only', [changed], part);
      assert.equal(
        calls.filter(
          (call) =>
            call.join(' ') ===
            'python3 -B scripts/production-release/admin-successor-diagnostic.test.py'
        ).length,
        1,
        `${part}: ${changed}`
      );
      assert.ok(
        calls.every(
          (call) => !call.includes('scripts/production-release/admin-successor-diagnostic.py')
        )
      );
    }
  }
});

function recordGuardCommands(
  mode,
  paths,
  part = 'guards',
  {
    cloud = false,
    resume = false,
    onlineResume = false,
    prepareResume = false,
    receiptResume = false,
    buildResume = false,
    failCommand = '',
    repository = '',
    event = '',
    base = 'a'.repeat(40),
    readonlyBaseSource = '',
    readonlyCurrentSource = null,
    cacheConfiguration = null,
    identityFixture = false
  } = {}
) {
  // Run the real dispatcher with process execution replaced before its named import resolves.
  // Prior repair cases read their immutable local Git fixtures.
  // No nested test, database command or business operation is executed.
  const priorRepairCommit = {
    '7d1c3822c8f8c8c6a970067580443a3b75e88bf0': 'cd7bba03bec1742328e0829c215823bda1fd3fae',
    cd7bba03bec1742328e0829c215823bda1fd3fae: 'd38c243b5727953aa96c0fa83e706fee253c9624'
  }[base];
  const environmentTestSource = priorRepairCommit
    ? execFileSync(
        'git',
        [
          'show',
          priorRepairCommit + ':scripts/production-release/registration-closure-release.test.py'
        ],
        { encoding: 'utf8' }
      )
    : null;
  const environmentWorkflowSource = priorRepairCommit
    ? execFileSync(
        'git',
        ['show', priorRepairCommit + ':.github/workflows/registration-closure-validation.yml'],
        { encoding: 'utf8' }
      )
    : null;
  const script = `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const paths = JSON.parse(process.env.GUARD_TEST_PATHS);
    const calls = [];
    globalThis.guardTestCalls = calls;
    const readonlyPath = ${JSON.stringify(resolve(root, readonlyMetadataPaths[0]))};
    const readonlySource = ${JSON.stringify(readonlyCurrentSource)};
    const cacheConfigurationUrl = new URL('./deploy/nginx/admin.conf', import.meta.url).href;
    const cacheConfiguration = ${JSON.stringify(cacheConfiguration)};
    const environmentTestSource = ${JSON.stringify(environmentTestSource)};
    const environmentWorkflowSource = ${JSON.stringify(environmentWorkflowSource)};
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (path, options) => {
      if (String(path) === '.github/workflows/registration-closure-validation.yml' && typeof environmentWorkflowSource === 'string')
        return typeof options === 'string' ? environmentWorkflowSource : Buffer.from(environmentWorkflowSource);
      if (String(path) === 'scripts/production-release/registration-closure-release.test.py' && typeof environmentTestSource === 'string')
        return typeof options === 'string' ? environmentTestSource : Buffer.from(environmentTestSource);
      if (String(path) === readonlyPath && typeof readonlySource === 'string')
        return typeof options === 'string' ? readonlySource : Buffer.from(readonlySource);
      if (String(path) === cacheConfigurationUrl && typeof cacheConfiguration === 'string')
        return typeof options === 'string' ? cacheConfiguration : Buffer.from(cacheConfiguration);
      return originalReadFileSync(path, options);
    };
    const scopeUrl = new URL('./scripts/ci-recharge-scope.mjs', import.meta.url).href;
    registerHooks({resolve(specifier, context, nextResolve) {
      if (${JSON.stringify(identityFixture)} && specifier === './ci-proxy-result-identity-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const identityUrl = new URL('./scripts/ci-proxy-result-identity-scope.mjs', import.meta.url).href;
        const source = 'import {isProxyResultIdentityOnly as original, proxyResultIdentityPins} from ' + JSON.stringify(identityUrl) + ';' +
          'export * from ' + JSON.stringify(identityUrl) + ';' +
          'export function isProxyResultIdentityOnly(paths, options) {' +
          'return original(paths, {...options, sourceDigest: (path) => proxyResultIdentityPins[path]}); }';
        return {url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true};
      }
      if (specifier === './ci-recharge-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const source = 'export * from ' + JSON.stringify(scopeUrl) + ';' +
          'export function canResumeCombinedGuard(base) {' +
          'globalThis.guardTestCalls.push(["resume-helper", base]);' +
          'return process.env.GUARD_TEST_RESUME === "true"; }' +
          'export function canResumeOnlineComponentGuard(base) {' +
          'globalThis.guardTestCalls.push(["online-resume-helper", base]);' +
          'return process.env.GUARD_TEST_ONLINE_RESUME === "true"; }' +
          'export function canResumeOnlinePrepareFixGuard(base) {' +
          'globalThis.guardTestCalls.push(["prepare-resume-helper", base]);' +
          'return process.env.GUARD_TEST_PREPARE_RESUME === "true"; }' +
          'export function canResumeOnlinePreflightReceiptFixGuard(base) {' +
          'globalThis.guardTestCalls.push(["receipt-resume-helper", base]);' +
          'return process.env.GUARD_TEST_RECEIPT_RESUME === "true"; }' +
          'export function canResumeOnlineBuildProofReuseGuard(base) {' +
          'globalThis.guardTestCalls.push(["build-resume-helper", base]);' +
          'return process.env.GUARD_TEST_BUILD_RESUME === "true"; }';
        return {url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true};
      }
      return nextResolve(specifier, context);
    }});
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') {
        if (args.join(' ') === 'rev-parse 7c3c102c98539d33cb379ef018427371ba750cb7^{tree}') return 'f6ab4537e28437af244c2263dd591516ae8e2a22\\n';
        if (args.join(' ') === 'rev-parse d38c243b5727953aa96c0fa83e706fee253c9624^{tree}') return 'a331c3ab6b23c3331aa550b752d9d66860e62cdb\\n';
        if (args.join(' ') === 'rev-parse cd7bba03bec1742328e0829c215823bda1fd3fae^{tree}') return '874102957cbd6cc921e05e5bba252e63bd09fd85\\n';
        if (args.join(' ') === 'rev-parse 7d1c3822c8f8c8c6a970067580443a3b75e88bf0^{tree}') return 'a1ffd620d2b79630b9c1e9db700d6af765f33a50\\n';
        if (args.join(' ') === 'rev-parse HEAD^{tree}') return 'a'.repeat(40) + '\\n';
        if (args[0] === 'show' && args[1] === process.env.GUARD_TEST_BASE + ':${readonlyMetadataPaths[0]}')
          return Buffer.from(${JSON.stringify(readonlyBaseSource)});
        return paths.join('\\n');
      }
      calls.push([file, ...args]);
      if ([file, ...args].join(' ') === process.env.GUARD_TEST_FAIL_COMMAND)
        throw new Error('SYNTHETIC_COMMAND_FAILURE');
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', process.env.GUARD_TEST_PART, process.env.GUARD_TEST_BASE];
    process.exit = (code) => {
      calls.push(['process-exit', code]);
      throw new Error('SYNTHETIC_PREPARE_EXIT');
    };
    try { await import('./scripts/ci-recharge-check.mjs'); }
    catch (error) {
      if (error.message !== 'SYNTHETIC_PREPARE_EXIT' ||
          calls.at(-1)?.[0] !== 'process-exit' || calls.at(-1)?.[1] !== 0) throw error;
    }
    process.stdout.write(JSON.stringify(calls));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHECK_MODE: mode,
        GITHUB_ACTIONS: cloud ? 'true' : '',
        GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_NAME: event,
        GUARD_TEST_RESUME: resume ? 'true' : '',
        GUARD_TEST_ONLINE_RESUME: onlineResume ? 'true' : '',
        GUARD_TEST_PREPARE_RESUME: prepareResume ? 'true' : '',
        GUARD_TEST_RECEIPT_RESUME: receiptResume ? 'true' : '',
        GUARD_TEST_BUILD_RESUME: buildResume ? 'true' : '',
        GUARD_TEST_FAIL_COMMAND: failCommand,
        GUARD_TEST_BASE: base,
        GUARD_TEST_PART: part,
        GUARD_TEST_PATHS: JSON.stringify(paths)
      }
    })
  );
}

test('finite prepare-fix guard keeps the first Node controls and runs every fresh dependency exactly once without business or database parts', () => {
  assert.deepEqual(
    onlinePrepareFixGuardCommands.map((command) => command.at(-1)),
    [
      'scripts/production-release/online-recharge-component-consumer.test.py',
      'scripts/production-release/online-recharge-component-runtime.test.py',
      'scripts/production-release/online-recharge-component-readonly.test.py',
      'scripts/production-release/api-admin-scope.test.py',
      'scripts/production-release/api-admin-pending-online.test.py',
      'scripts/production-release/admin-pending-online-release.test.py',
      'scripts/production-release/online-recharge-scope.test.py',
      'scripts/production-release/unpublished-component-successor.test.py',
      'scripts/production-release/unpublished-component-successor-readonly.test.py',
      'scripts/production-release/prepared-images.test.py',
      'scripts/production-release/recharge-flow-entry.test.mjs',
      'scripts/production-release/online-recharge-entry.test.mjs',
      'scripts/production-release/unified-component-source.test.py',
      'scripts/v2-order-archive-release-policy.test.mjs',
      'scripts/production-release/registration-onboarding-96.test.py'
    ]
  );
  const paths = [...onlinePrepareFixGuardPaths];
  const context = {
    cloud: true,
    prepareResume: true,
    repository: onlinePrepareFixGuardBinding.repository,
    event: 'pull_request',
    base: onlinePrepareFixGuardBinding.base
  };
  const commands = (calls) => calls.filter((call) => !call[0].endsWith('resume-helper'));
  const original = recordGuardCommands('ci-only', paths);
  const index = original.findIndex(
    (call) =>
      call[0] === 'node' &&
      call[1] === '--test' &&
      call.includes('scripts/ci-recharge-scope.test.mjs')
  );
  assert.ok(index >= 0);
  const resumed = commands(recordGuardCommands('ci-only', paths, 'guards', context));
  assert.deepEqual(resumed, [
    ...original.slice(0, index + 1),
    ...onlinePrepareFixGuardCommands,
    ['process-exit', 0]
  ]);
  for (const command of onlinePrepareFixGuardCommands)
    assert.equal(
      resumed.filter((row) => JSON.stringify(row) === JSON.stringify(command)).length,
      1
    );
  assert.ok(resumed.some((row) => row.includes('scripts/ci-recharge-release.test.mjs')));
  assert.ok(
    !resumed.some((row) =>
      row.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg === 'docker' || arg.includes('acceptance-v2') || arg === '--workspace')
      )
    )
  );
  for (const reject of [
    { ...context, prepareResume: false },
    { ...context, cloud: false },
    { ...context, repository: 'foreign/project' },
    { ...context, event: 'push' },
    { ...context, base: '0'.repeat(40) }
  ])
    assert.deepEqual(commands(recordGuardCommands('ci-only', paths, 'guards', reject)), original);
  assert.deepEqual(
    recordGuardCommands('ci-only', paths, 'release-controls', context),
    recordGuardCommands('ci-only', paths, 'release-controls')
  );
});

test('verified ONLINE guard continuation reruns first controls and unified source once and preserves the exact suffix', () => {
  const paths = [
    'scripts/doctor.mjs',
    'scripts/ci-recharge-check.mjs',
    '.github/workflows/production-release.yml',
    'scripts/production-release/online-recharge-component-runtime.py',
    'scripts/production-release/unified-component-source.test.py',
    'scripts/production-release/recharge-flow-successor.py',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/backup-retention-protection.py'
  ];
  const context = {
    cloud: true,
    onlineResume: true,
    repository: 'wangchaozhuanyong/id-business-system',
    event: 'pull_request',
    base: 'b922b2d900e683f565ff3c5f95576ebc5f07803f'
  };
  const commands = (calls) => calls.filter((call) => !call[0].endsWith('resume-helper'));
  const ordinary = recordGuardCommands('ci-only', paths);
  const resumed = commands(recordGuardCommands('ci-only', paths, 'guards', context));
  const start = ordinary.findIndex((call) => call.includes('test:native-runtime'));
  const end = ordinary.findIndex((call) =>
    call.includes('scripts/production-release/recharge-flow-successor.test.py')
  );
  const unified = ['python3', '-B', 'scripts/production-release/unified-component-source.test.py'];
  assert.ok(start > 0 && end > start);
  assert.deepEqual(resumed, [...ordinary.slice(0, start), unified, ...ordinary.slice(end)]);
  assert.equal(
    resumed.filter((call) => JSON.stringify(call) === JSON.stringify(unified)).length,
    1
  );
  assert.ok(resumed.some((call) => call.includes('scripts/ci-recharge-release.test.mjs')));
  assert.ok(resumed.some((call) => call.includes('prettier')));
  assert.ok(resumed.some((call) => call.includes('eslint')));
  for (const call of ordinary.slice(start, end).filter((call) => !call.includes(unified[2])))
    assert.ok(!resumed.some((row) => JSON.stringify(row) === JSON.stringify(call)), call.join(' '));
  for (const rejected of [
    { ...context, onlineResume: false },
    { ...context, cloud: false },
    { ...context, repository: 'foreign/repository' },
    { ...context, event: 'push' },
    { ...context, base: 'a'.repeat(40) }
  ])
    assert.deepEqual(commands(recordGuardCommands('ci-only', paths, 'guards', rejected)), ordinary);
  assert.deepEqual(
    recordGuardCommands('ci-only', paths, 'release-controls', context),
    recordGuardCommands('ci-only', paths, 'release-controls')
  );
});

test('verified combined guard continuation skips only its passed prefix and retains all actual later commands', () => {
  const paths = [
    'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue',
    'scripts/production-release/unpublished-component-successor.py',
    'scripts/acceptance-v2-workspace-dock.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
    'scripts/production-release/recharge-flow-entry.test.mjs',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/backup-retention-protection.py',
    'scripts/doctor.mjs',
    '.github/workflows/production-release.yml'
  ];
  const ordinary = recordGuardCommands('admin', paths);
  const resumed = recordGuardCommands('admin', paths, 'guards', {
    cloud: true,
    resume: true,
    repository: 'wangchaozhuanyong/id-business-system',
    event: 'pull_request'
  });
  assert.deepEqual(resumed[0], ['resume-helper', 'a'.repeat(40)]);
  const pureNodeList = ordinary.find((call) =>
    call.includes('scripts/ci-recharge-precision.test.mjs')
  );
  assert.ok(pureNodeList);
  assert.ok(resumed.some((call) => JSON.stringify(call) === JSON.stringify(pureNodeList)));
  const suffixStart = (calls) =>
    calls.findIndex((call) =>
      call.includes('scripts/production-release/recharge-flow-successor.test.py')
    );
  assert.ok(suffixStart(ordinary) > 0);
  assert.ok(suffixStart(resumed) > 0);
  assert.deepEqual(resumed.slice(suffixStart(resumed)), ordinary.slice(suffixStart(ordinary)));
  for (const oldPrefix of [
    'test:native-runtime',
    'scripts/production-release/api-admin-scope.test.py',
    'scripts/production-release/online-recharge-scope.test.py',
    'scripts/production-release/admin-pending-online-release.test.py',
    'scripts/production-release/unpublished-component-successor.test.py'
  ]) {
    assert.ok(
      ordinary.some((call) => call.includes(oldPrefix)),
      oldPrefix
    );
    assert.ok(!resumed.some((call) => call.includes(oldPrefix)), oldPrefix);
  }
  for (const later of [
    'scripts/acceptance-v2-recharge-employee-concurrency.test.mjs',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/backup-retention-protection.test.py',
    'check:admin-ui',
    'check:v2-loading-standard',
    'check:v2-module-architecture'
  ])
    assert.ok(
      resumed.some((call) => call.includes(later)),
      later
    );
  for (const context of [
    { resume: true },
    { cloud: true, resume: true, repository: 'foreign/repository', event: 'pull_request' },
    { cloud: true, resume: true, repository: 'wangchaozhuanyong/id-business-system', event: 'push' }
  ])
    assert.deepEqual(recordGuardCommands('admin', paths, 'guards', context), ordinary);
  const rejectedProof = recordGuardCommands('admin', paths, 'guards', {
    cloud: true,
    repository: 'wangchaozhuanyong/id-business-system',
    event: 'pull_request'
  });
  assert.deepEqual(rejectedProof.slice(1), ordinary);
});

test('combined component migration runs only in cloud and retains the owned database entry', () => {
  const paths = [
    'scripts/production-release/unpublished-component-successor.py',
    'scripts/acceptance-v2-workspace-dock.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs'
  ];
  assert.throws(() => recordGuardCommands('admin', paths, 'migration'), /组合发布数据库验收/);
  const calls = recordGuardCommands('admin', paths, 'migration', { cloud: true });
  assert.deepEqual(calls.at(-1), [
    'node',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
    '--runtime=docker',
    '--combined-release'
  ]);
  assert.equal(calls.filter((call) => call.includes('--combined-release')).length, 1);
  assert.ok(
    !calls.some((call) => call.includes('scripts/acceptance-v2-registration-mirror-mysql.mjs'))
  );
  const guardCalls = recordGuardCommands('admin', paths, 'guards');
  assert.equal(
    guardCalls.filter(
      (call) =>
        call.join(' ') ===
        'node --test scripts/acceptance-v2-recharge-employee-concurrency.test.mjs'
    ).length,
    1
  );
});

function recordBankSecurityCommands(drift = '') {
  // Source-byte/hash enforcement is tested with actual sealed bytes in scope
  // tests. Here Git acquisition and digests are synthetic to isolate dispatch;
  // every external command, including the disposable database, is recorded.
  const script = `
    import childProcess from 'node:child_process';
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    const helper = process.env.BANK_TEST_HELPER;
    const acceptance = process.env.BANK_TEST_ACCEPTANCE;
    const drift = process.env.BANK_TEST_DRIFT;
    const before = 'export const V2_RUNTIME_DELETE_TABLES = Object.freeze([\\n';
    const after = before + "  'id_business_v2_bank_recharge_cards',\\n";
    const hashes = {
      [before]: '7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546',
      [after]: '36bfe57d9fd802fc647d09dd8871f1af4cee6cd03a68bf05a2509dd0e554570d',
      'acceptance-before': '15adadb670cdbd7645761b161f487b74550b271455289e60a97108e9e4ac46f1',
      'acceptance-after': 'd39b620aa33ac21cecc0b9229dc0cc59967af1e890ea65c4e61d20fb1dbe269e'
    };
    crypto.createHash = () => ({
      update(value) { this.value = value; return this; },
      digest() { return hashes[this.value] ?? '0'.repeat(64); }
    });
    const calls = [];
    childProcess.execFileSync = (file, args) => {
      if (file !== 'git') { calls.push([file, ...args]); return ''; }
      if (args[0] === 'diff') return [helper, acceptance, ...(drift === 'mixed-app' ? ['apps/api/src/auth/auth.service.ts'] : [])].join('\\n');
      if (args[0] === 'ls-tree') {
        const changedMode = args[1] === 'HEAD' && ((args[3] === helper && drift === 'helper-mode') || (args[3] === acceptance && drift === 'acceptance-mode'));
        return (changedMode ? '100755' : '100644') + ' blob ' + 'e'.repeat(40) + '\\t' + args[3];
      }
      if (args[0] === 'show') {
        const isAfter = args[1].startsWith('HEAD:');
        if (args[1].endsWith(':' + helper)) return isAfter ? after + (drift === 'helper-bytes' ? 'extra' : '') : before;
        if (args[1].endsWith(':' + acceptance)) {
          if (drift === 'missing-acceptance') throw new Error('synthetic missing source');
          return (isAfter ? 'acceptance-after' : 'acceptance-before') + (isAfter && drift === 'acceptance-bytes' ? 'extra' : '');
        }
      }
      throw new Error('Unexpected Git command');
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', 'security', 'a'.repeat(40)];
    let error = null;
    try { await import('./scripts/ci-recharge-check.mjs'); } catch (failure) { error = failure.message; }
    process.stdout.write(JSON.stringify({calls, error}));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHECK_MODE: 'ci-only',
        BANK_TEST_HELPER: productionDatabaseAccessHelper,
        BANK_TEST_ACCEPTANCE: productionDatabaseAccessAcceptance,
        BANK_TEST_DRIFT: drift
      }
    })
  );
}

test('bank-card controls keep unit checks in guards and run only the disposable permission acceptance in security', () => {
  const paths = [productionDatabaseAccessHelper, productionDatabaseAccessAcceptance];
  const guards = recordGuardCommands('ci-only', paths);
  assert.equal(guards.filter((call) => call.includes(productionDatabaseAccessTest)).length, 1);
  assert.equal(
    guards.some((call) => call.includes('acceptance:v2-production-database-access')),
    false
  );
  const { calls, error } = recordBankSecurityCommands();
  assert.equal(error, null);
  assert.deepEqual(calls, [
    ['npm', 'ci', '--no-audit'],
    ['npm', 'run', 'prisma:mysql:generate'],
    ['npm', 'run', 'acceptance:v2-production-database-access']
  ]);
});

test('bank-card security dispatch refuses source or mode drift before installing or touching a database', () => {
  for (const drift of [
    'helper-bytes',
    'acceptance-bytes',
    'helper-mode',
    'acceptance-mode',
    'missing-acceptance',
    'mixed-app'
  ]) {
    const { calls, error } = recordBankSecurityCommands(drift);
    assert.match(error, /Missing exact bank-card policy source proof/);
    assert.deepEqual(calls, [], drift);
  }
  const ordinary = recordGuardCommands(
    'recharge',
    ['scripts/container-hardening.test.mjs'],
    'security'
  );
  assert.equal(
    ordinary.some((call) => call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))),
    false
  );
  assert.ok(ordinary.some((call) => call.includes('scripts/container-hardening.test.mjs')));
});

test('recovery controls execute database grants and every existing online release suite in both dispatchers', () => {
  const commands = [
    ['node', '--test', productionDatabaseAccessTest],
    ['python3', '-B', 'scripts/production-release/online-recharge-scope.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-readonly.test.py'],
    ['node', '--test', 'scripts/production-release/online-recharge-entry.test.mjs']
  ];
  const controlled = [
    onlineRechargeRecoveryPolicy,
    productionDatabaseAccessHelper,
    productionDatabaseAccessTest
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const paths of [...controlled.map((path) => [path]), controlled]) {
      const calls = recordGuardCommands('ci-only', paths, part);
      for (const expected of commands)
        assert.equal(
          calls.filter((call) => JSON.stringify(call) === JSON.stringify(expected)).length,
          1,
          part + ': ' + paths.join(', ') + ': ' + expected.join(' ')
        );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
      assert.ok(calls.every((call) => !call.includes('online-engine')));
    }
  }
});

test('unpublished successor controls execute narrow suites once in either dispatcher', () => {
  const commands = [
    ['python3', '-B', 'scripts/production-release/unpublished-component-successor.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/unpublished-component-successor-readonly.test.py'
    ],
    ['node', '--test', 'scripts/production-release/unpublished-component-entry.test.mjs'],
    [
      'python3',
      '-B',
      'scripts/production-release/unpublished-component-runtime-diagnostic.test.py'
    ],
    ['python3', '-B', 'scripts/production-release/unified-component-source.test.py']
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const paths of [
      ...[
        ...unpublishedComponentSuccessorControlPaths,
        ...unpublishedComponentSuccessorEntryPaths
      ].map((path) => [path]),
      [...unpublishedComponentSuccessorControlPaths]
    ]) {
      const calls = recordGuardCommands('ci-only', paths, part);
      for (const command of commands)
        assert.equal(
          calls.filter((call) => JSON.stringify(call) === JSON.stringify(command)).length,
          1
        );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
    for (const path of [
      'docs/V2_TASKS.md',
      'scripts/production-release/unpublished-component-successor.py.backup',
      'scripts/production-release/unpublished-component-successor-other.py'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.ok(
        calls.every(
          (call) => !commands.some((command) => JSON.stringify(call) === JSON.stringify(command))
        )
      );
    }
  }
});

test('recharge flow controls execute their four suites once without business/database checks', () => {
  const reusedPublisherInputs = [
    'scripts/production-release/unpublished-component-successor.py',
    'scripts/production-release/unpublished-component-successor-readonly.py'
  ];
  const commands = [
    ['python3', '-B', 'scripts/production-release/recharge-flow-successor.test.py'],
    ['python3', '-B', 'scripts/production-release/recharge-flow-successor-projection.test.py'],
    ['python3', '-B', 'scripts/production-release/recharge-flow-successor-readonly.test.py'],
    ['node', '--test', 'scripts/production-release/recharge-flow-entry.test.mjs']
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const paths of [
      ...[...rechargeFlowSuccessorControlPaths, ...reusedPublisherInputs].map((path) => [path]),
      reusedPublisherInputs
    ]) {
      const calls = recordGuardCommands('ci-only', paths, part);
      for (const command of commands)
        assert.equal(
          calls.filter((call) => JSON.stringify(call) === JSON.stringify(command)).length,
          1
        );
      assert.ok(
        calls.every(
          (call) => !call.some((arg) => /(?:prisma:|acceptance:|financial-integrity)/.test(arg))
        )
      );
    }
    for (const path of [
      'scripts/production-release/recharge-flow-successor-other.py',
      'scripts/production-release/unpublished-component-successor.py.backup',
      'scripts/production-release/unpublished-component-successor-other.py',
      'scripts/production-release/unpublished-component-successor-readonly.test.py'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.ok(
        calls.every(
          (call) => !commands.some((command) => JSON.stringify(call) === JSON.stringify(command))
        )
      );
    }
  }
});

test('affected recharge flow connector inputs run complete payment and new observer/cycle regressions', () => {
  const directory = 'apps/api/src/id-business-v2/auto-recharge/worker';
  for (const path of [
    'pay.py',
    'payment_network.py',
    'test_payment.py',
    'test_subscription_cycle.py'
  ]) {
    const calls = recordGuardCommands('recharge', [`${directory}/${path}`], 'connector');
    const tests = calls.find((call) => call[0] === 'python3' && call.includes('unittest'));
    for (const name of [
      'test_payment',
      'test_callback_observation',
      'test_response_settlement',
      'test_subscription_cycle'
    ])
      assert.ok(tests.includes(name), path + ': ' + name);
    assert.ok(!tests.includes('test_payment.StateTests'));
  }
  const calls = recordGuardCommands('recharge', [`${directory}/test_go.py`], 'connector');
  const tests = calls.find((call) => call[0] === 'python3' && call.includes('unittest'));
  assert.ok(tests.includes('test_payment.StateTests'));
  for (const name of [
    'test_callback_observation',
    'test_response_settlement',
    'test_subscription_cycle'
  ])
    assert.ok(!tests.includes(name));
});

test('owned MySQL helper edits run boundary tests without starting any database', () => {
  const suite = 'scripts/lib/owned-mysql-test-instance.test.mjs';
  for (const part of ['guards', 'release-controls']) {
    for (const path of ownedMysqlTestControlPaths) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(calls.filter((call) => call.join(' ') === `node --test ${suite}`).length, 1);
      assert.ok(
        calls.every(
          (call) => !call.some((arg) => /(?:prisma:|acceptance:|financial-integrity)/.test(arg))
        )
      );
    }
  }
});

test('connection migration and registration mirror use only their disposable Docker acceptances', () => {
  const mirror =
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts';
  for (const paths of [
    [rechargeConnectionProfileMigration],
    [mirror],
    [rechargeConnectionProfileMigration, mirror]
  ]) {
    const calls = recordGuardCommands('recharge', paths, 'migration');
    const employeeCommand = [
      'node',
      'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
      '--runtime=docker'
    ];
    const mirrorCommand = [
      'node',
      'scripts/acceptance-v2-registration-mirror-mysql.mjs',
      '--runtime=docker',
      '--python=' + resolve(root, '.runtime/auto-registration/venv/bin/python')
    ];
    assert.equal(
      calls.filter((call) => JSON.stringify(call) === JSON.stringify(employeeCommand)).length,
      paths.includes(rechargeConnectionProfileMigration) ? 1 : 0
    );
    assert.equal(
      calls.filter((call) => JSON.stringify(call) === JSON.stringify(mirrorCommand)).length,
      paths.includes(mirror) ? 1 : 0
    );
    for (const expected of [
      ['npm', 'run', 'prisma:mysql:generate'],
      ['npm', 'run', 'prisma:mysql:validate'],
      ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
      ['npm', 'run', 'build', '--workspace', '@apple-business/api']
    ])
      assert.equal(
        calls.filter((call) => JSON.stringify(call) === JSON.stringify(expected)).length,
        1
      );
    assert.equal(
      calls.filter((call) => call.join(' ') === 'npm run auto-registration:setup').length,
      paths.includes(mirror) ? 1 : 0
    );
    assert.ok(
      calls.every(
        (call) =>
          !call.some((arg) =>
            /financial-integrity|rollback-integrity|ci-recharge-migration|mysql-bin/.test(arg)
          )
      )
    );
  }
  assert.deepEqual(
    recordGuardCommands(
      'recharge',
      [
        'apps/api/prisma-mysql/migrations/20260913100000_auto_recharge_browser_options/migration.sql'
      ],
      'migration'
    ),
    [['python3', 'scripts/ci-recharge-migration.py']]
  );
  const workflow = readFileSync(
    new URL('../.github/workflows/quality.yml', import.meta.url),
    'utf8'
  );
  assert.ok(
    workflow.includes(`contains(fromJSON('["guards","admin","api","migration"]'), matrix.part)`)
  );
});

test('unrelated control edits do not execute database grant tests', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const path of [
      'docs/UI_DESIGN.md',
      'scripts/ci-change-scope.mjs',
      onlineRechargeRecoveryPolicy + '.backup'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(
        calls.some((call) => call.includes(productionDatabaseAccessTest)),
        false
      );
    }
  }
});

test('diagnosed workspace permission repair runs its combined suite once for exact control inputs', () => {
  const suite = 'scripts/production-release/api-workspace-public-permission-repair.test.py';
  const paths = [
    'scripts/production-release/api-workspace-public-permission-repair.py',
    'scripts/production-release/api-workspace-public-permission-repair-transport.py',
    suite,
    '.github/workflows/production-release.yml',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const path of paths) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(
        calls.filter((call) => JSON.stringify(call) === JSON.stringify(['python3', '-B', suite]))
          .length,
        1,
        part + ': ' + path
      );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
    for (const path of [
      'docs/ONLINE_RECHARGE_RELEASE_20261009.md',
      'scripts/production-release/api-workspace-public-permission-repair.py.backup',
      'scripts/production-release/api-workspace-public-permission-repair-transport-other.py'
    ])
      assert.equal(
        recordGuardCommands('ci-only', [path], part).some((call) => call.includes(suite)),
        false
      );
  }
});

test('fixed source permission repair runs both dedicated suites in each control dispatcher only for its inputs', () => {
  const suites = [
    'scripts/production-release/online-recharge-source-permission-repair.test.py',
    'scripts/production-release/online-recharge-source-permission-repair-transport.test.py'
  ];
  const paths = [
    'scripts/production-release/online-recharge-source-permission-repair.py',
    ...suites,
    'scripts/production-release/online-recharge-source-permission-repair-transport.py',
    '.github/workflows/production-release.yml',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const path of paths) {
      const calls = recordGuardCommands('ci-only', [path], part);
      for (const suite of suites)
        assert.equal(
          calls.filter((call) => JSON.stringify(call) === JSON.stringify(['python3', '-B', suite]))
            .length,
          1,
          part + ': ' + path + ': ' + suite
        );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
    const calls = recordGuardCommands(
      'ci-only',
      ['docs/ONLINE_RECHARGE_RELEASE_20261009.md'],
      part
    );
    assert.ok(calls.every((call) => suites.every((suite) => !call.includes(suite))));
  }
});

test('historical backup recovery runs both dedicated suites only for exact control inputs', () => {
  const suites = [
    'scripts/production-release/online-recharge-backup-source-recovery.test.py',
    'scripts/production-release/online-recharge-backup-source-recovery-transport.test.py'
  ];
  const paths = [
    'scripts/production-release/online-recharge-backup-source-recovery.py',
    ...suites,
    'scripts/production-release/online-recharge-backup-source-recovery-transport.py',
    '.github/workflows/production-release.yml',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  for (const part of ['guards', 'release-controls']) {
    for (const path of paths) {
      const calls = recordGuardCommands('ci-only', [path], part);
      for (const suite of suites)
        assert.equal(
          calls.filter((call) => JSON.stringify(call) === JSON.stringify(['python3', '-B', suite]))
            .length,
          1,
          part + ': ' + path + ': ' + suite
        );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
    for (const path of [
      'docs/ONLINE_RECHARGE_RELEASE_20261009.md',
      'scripts/production-release/online-recharge-backup-source-recovery.py.backup',
      'scripts/production-release/online-recharge-backup-source-recovery-transport-other.py'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.ok(calls.every((call) => suites.every((suite) => !call.includes(suite))));
    }
  }
});

function recordOnlineEngineCommands(failBrowser = false) {
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = [];
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') return 'apps/api/src/id-business-v2/online-recharge/engine/safe-media.cjs';
      calls.push([file, ...args]);
      if (process.env.ONLINE_TEST_FAIL_BROWSER === '1' && file === 'node' && args[0].endsWith('/playwright/cli.js'))
        throw new Error('synthetic missing browser');
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', 'online-engine', 'a'.repeat(40)];
    let failed = false;
    try { await import('./scripts/ci-recharge-check.mjs'); } catch { failed = true; }
    process.stdout.write(JSON.stringify({calls, failed}));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ONLINE_TEST_FAIL_BROWSER: failBrowser ? '1' : '0' }
    })
  );
}

test('online engine installs its own pinned browser before real media tests', () => {
  const { calls, failed } = recordOnlineEngineCommands();
  assert.equal(failed, false);
  const install = calls.findIndex((row) => row[0] === 'node');
  const tests = calls.findIndex((row) => row.includes('test:online-recharge:engine'));
  assert.ok(install >= 0 && tests > install);
  assert.deepEqual(calls[install], [
    'node',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/node_modules/playwright/cli.js',
    'install',
    '--with-deps',
    'chromium'
  ]);
  assert.equal(
    calls.some((row) => row[0] === 'npx'),
    false
  );
  const yaml = readFileSync(resolve(root, '.github/workflows/quality.yml'), 'utf8');
  assert.match(yaml, /run: node scripts\/ci-recharge-check\.mjs online-engine "\$CHECK_BASE"/);
});

test('failed online browser installation blocks media tests and payment engine tests', () => {
  const { calls, failed } = recordOnlineEngineCommands(true);
  assert.equal(failed, true);
  assert.equal(
    calls.some((row) => row.includes('test:online-recharge:engine')),
    false
  );
});

function recordConnectorCommands(paths, failInstall = false) {
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const paths = JSON.parse(process.env.CONNECTOR_TEST_PATHS);
    const calls = [];
    childProcess.execFileSync = (file, args, options = {}) => {
      if (file === 'git') return paths.join('\\n');
      calls.push({file, args, cwd: options.cwd ?? null,
        browsersPath: options.env?.PLAYWRIGHT_BROWSERS_PATH ?? null,
        bytecodeDisabled: options.env?.PYTHONDONTWRITEBYTECODE ?? null});
      if (process.env.CONNECTOR_TEST_FAIL_INSTALL === '1' && file === 'python3' && args[1] === 'playwright')
        throw new Error('simulated browser install failure');
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', 'connector', 'a'.repeat(40)];
    let failed = false;
    try { await import('./scripts/ci-recharge-check.mjs'); } catch { failed = true; }
    process.stdout.write(JSON.stringify({calls, failed}));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONNECTOR_TEST_PATHS: JSON.stringify(paths),
        CONNECTOR_TEST_FAIL_INSTALL: failInstall ? '1' : '0'
      }
    })
  );
}

test('connector installs its Python browser before testing with the same cache and working directory', () => {
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker';
  for (const [changed, fullPro] of [
    ['bitbrowser_connector.py', false],
    ['server.py', false],
    ['plan_selection.py', true]
  ]) {
    const { calls, failed } = recordConnectorCommands([`${worker}/${changed}`]);
    assert.equal(failed, false);
    const install = calls.findIndex(
      (call) => call.file === 'python3' && call.args[1] === 'playwright'
    );
    const testing = calls.findIndex(
      (call) => call.file === 'python3' && call.args[1] === 'unittest'
    );
    assert.ok(install >= 0 && testing > install);
    assert.deepEqual(calls[install].args, ['-m', 'playwright', 'install', 'chromium']);
    for (const call of [calls[install], calls[testing]]) {
      assert.equal(call.cwd, worker);
      assert.equal(call.browsersPath, resolve(root, worker, '.browsers'));
      assert.equal(call.bytecodeDisabled, '1');
    }
    assert.ok(calls[testing].args.includes('test_bitbrowser_connector'));
    assert.ok(calls[testing].args.includes('test_owned_recharge_profile'));
    assert.ok(calls[testing].args.every((name) => !name.startsWith('test_registration')));
    assert.ok(
      calls[testing].args.includes(fullPro ? 'test_pro' : 'test_pro.ProMenuDiagnosticsTests')
    );
  }
});

test('connector stops before worker tests when its browser installation fails', () => {
  const { calls, failed } = recordConnectorCommands(
    ['apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py'],
    true
  );
  assert.equal(failed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-m', 'playwright', 'install', 'chromium']);
});

test('real scoped dispatcher executes backend guards once without frontend edits, including deletion', () => {
  for (const [mode, paths] of [
    ['recharge', ['apps/api/src/id-business-v2/auto-recharge/recharge.service.ts']],
    [
      'mailbox',
      ['apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts']
    ],
    ['recharge', ['apps/api/src/id-business-v2/auto-recharge/deleted.service.ts']],
    [
      'recharge',
      [
        'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
        'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts'
      ]
    ]
  ]) {
    const calls = recordGuardCommands(mode, paths);
    for (const gate of gates) {
      assert.equal(calls.filter((call) => call.join(' ') === `npm run ${gate}`).length, 1, gate);
    }
    assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
  }
});

test('CI-only control edits do not execute backend or business guards', () => {
  const calls = recordGuardCommands('ci-only', ['scripts/ci-recharge-scope.mjs']);
  for (const gate of gates) assert.ok(calls.every((call) => !call.includes(gate)));
});

test('native media startup changes dispatch the standard-library regression once', () => {
  const media = 'apps/api/src/id-business-v2/workspace/media-resolver';
  const command = ['python3', '-B', `${media}/test_native_startup.py`];
  for (const mode of ['full', 'recharge', 'ci-only']) {
    for (const paths of [
      [`${media}/server.py`],
      [`${media}/test_native_startup.py`],
      [`${media}/server.py`, `${media}/test_native_startup.py`]
    ]) {
      const calls = recordGuardCommands(mode, paths);
      assert.equal(calls.filter((call) => call.join(' ') === command.join(' ')).length, 1);
      assert.ok(calls.every((call) => !call.includes('test:native-runtime')));
    }
  }
  const unrelated = recordGuardCommands('ci-only', ['scripts/ci-recharge-scope.mjs']);
  assert.ok(unrelated.every((call) => call.join(' ') !== command.join(' ')));
});

test('native entry and backup transport edits run their bounded native tests without a database suite', () => {
  for (const path of [
    'scripts/native-services.mjs',
    'scripts/lib/native-mysql-tools.mjs',
    'scripts/acceptance-v2-rollback-integrity.mjs',
    'scripts/acceptance-v2-data-governance.mjs',
    'scripts/ci-recharge-migration.py',
    'scripts/production-release/audit-retention-mysql.test.py',
    'scripts/lib/native_mysql_fixture.py'
  ]) {
    const calls = recordGuardCommands('ci-only', [path]);
    assert.equal(
      calls.filter((call) => call.join(' ') === 'npm run test:native-runtime').length,
      1
    );
    assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
  }
  const calls = recordGuardCommands('ci-only', ['docs/DOCKER_INDEPENDENCE.md']);
  assert.ok(calls.every((call) => !call.includes('test:native-runtime')));
});

test('full quality workflow includes each backend architecture gate', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/quality.yml', import.meta.url),
    'utf8'
  );
  const full = workflow.split('  full-quality:')[1].split('\n  recharge:')[0];
  for (const gate of gates) assert.ok(full.includes(`run: npm run ${gate}`), gate);
});

test('API Admin control edits execute their suite in both CI entry points', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const path of [
      'scripts/production-release/api-admin-scope.py',
      'scripts/production-release/api-admin-readonly.py',
      'scripts/production-release/api-admin-scope.test.py',
      'scripts/production-release/api-admin-readonly.test.py',
      'scripts/production-release/api-admin-pending-projection.py',
      'scripts/production-release/api-admin-pending-projection.test.py',
      'scripts/production-release/api-admin-pending-online.test.py',
      'scripts/production-release/api-admin-pending-receipt-wire.py',
      'scripts/production-release/api-admin-pending-receipt-wire.test.py',
      'scripts/production-release/api-workspace-declaration-readonly.py',
      'scripts/production-release/api-workspace-declaration-readonly.test.py',
      'scripts/production-release/api-workspace-declaration-artifacts.py',
      'scripts/production-release/api-workspace-declaration-artifacts.test.py',
      'scripts/production-release/online-recharge-declaration-measurement.py',
      'scripts/production-release/online-recharge-declaration-measurement.test.py'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(
        calls.filter(
          (call) =>
            call.join(' ') === 'python3 -B scripts/production-release/api-admin-scope.test.py'
        ).length,
        1
      );
      assert.equal(
        calls.filter(
          (call) =>
            call.join(' ') === 'python3 -B scripts/production-release/api-admin-readonly.test.py'
        ).length,
        1
      );
      for (const suite of [
        'api-admin-pending-projection',
        'api-admin-pending-online',
        'api-admin-pending-receipt-wire',
        'api-workspace-declaration-readonly',
        'api-workspace-declaration-artifacts',
        'online-recharge-declaration-measurement'
      ]) {
        assert.equal(
          calls.filter(
            (call) => call.join(' ') === `python3 -B scripts/production-release/${suite}.test.py`
          ).length,
          1
        );
      }
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
  }
});

test('native entry and backup transport edits run their bounded native tests without a database suite', () => {
  for (const path of [
    'scripts/native-services.mjs',
    'scripts/lib/native-mysql-tools.mjs',
    'scripts/acceptance-v2-rollback-integrity.mjs',
    'scripts/acceptance-v2-data-governance.mjs',
    'scripts/ci-recharge-migration.py',
    'scripts/production-release/audit-retention-mysql.test.py',
    'scripts/lib/native_mysql_fixture.py'
  ]) {
    const calls = recordGuardCommands('ci-only', [path]);
    assert.equal(
      calls.filter((call) => call.join(' ') === 'npm run test:native-runtime').length,
      1
    );
    assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
  }
  const calls = recordGuardCommands('ci-only', ['docs/DOCKER_INDEPENDENCE.md']);
  assert.ok(calls.every((call) => !call.includes('test:native-runtime')));
});

test('API deletion and connector checks retain recharge suites without retired registration tests', () => {
  const api = recordGuardCommands(
    'recharge',
    ['apps/api/src/id-business-v2/auto-registration/registration.module.ts'],
    'api'
  );
  assert.ok(api.some((call) => call.includes('src/id-business-v2/auto-recharge')));
  assert.ok(api.every((call) => !call.includes('src/id-business-v2/auto-registration')));
  const connector = recordGuardCommands(
    'recharge',
    ['apps/api/src/id-business-v2/auto-recharge/worker/server.py'],
    'connector'
  );
  const suites = connector.find((call) => call[0] === 'python3' && call.includes('unittest'));
  assert.ok(suites.includes('test_recharge_email_code'));
  assert.ok(suites.includes('test_server'));
  assert.ok(suites.every((name) => !name.startsWith('test_registration')));
});

test('combined API dispatcher verifies actual Apple adapter and worker suites after setup exactly once', () => {
  const worker = 'apps/api/src/id-business-v2/auto-registration/worker';
  const python = '.runtime/auto-registration/venv/bin/python';
  for (const paths of [
    [`${worker}/release_safety.py`],
    [
      'apps/api/src/id-business-v2/auto-recharge/bank-recharge-finance.service.ts',
      'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
      `${worker}/workspace.py`,
      `${worker}/apple_mailboxes.py`
    ]
  ]) {
    const calls = recordGuardCommands('recharge', paths, 'api');
    const api = calls.find((call) => call.includes('@apple-business/api') && call.includes('test'));
    assert.ok(api.includes('src/id-business-v2/auto-recharge'));
    assert.ok(api.includes('src/id-business-v2/auto-registration'));
    assert.ok(!api.includes('src/id-business-v2/orders'));
    const setup = calls.findIndex((call) => call.join(' ') === 'npm run auto-registration:setup');
    assert.ok(setup >= 0);
    assert.equal(
      calls.filter((call) => call.join(' ') === 'npm run auto-registration:setup').length,
      1
    );
    for (const name of [
      'test_workspace.py',
      'test_apple_mailboxes.py',
      'test_release_safety.py',
      'test_upload_compat.py'
    ]) {
      const expected = [python, '-B', '-m', 'unittest', 'discover', '-s', worker, '-p', name];
      assert.equal(
        calls.filter((call) => JSON.stringify(call) === JSON.stringify(expected)).length,
        1
      );
      assert.ok(
        calls.findIndex((call) => JSON.stringify(call) === JSON.stringify(expected)) > setup
      );
    }
    assert.equal(
      calls.filter((call) => call.join(' ') === `${python} -B ${worker}/acceptance_runtime.py`)
        .length,
      1
    );
    const browser = `node --test ${worker}/test_payment_browser.mjs`;
    assert.equal(calls.filter((call) => call.join(' ') === browser).length, 1);
    assert.ok(calls.findIndex((call) => call.join(' ') === browser) > setup);
    assert.ok(
      calls.findIndex((call) => call.join(' ') === browser) <
        calls.findIndex((call) => call.join(' ') === `${python} -B ${worker}/acceptance_runtime.py`)
    );
    assert.ok(
      calls.every((call) => !call.some((arg) => /financial-integrity|rollback-integrity/.test(arg)))
    );
  }
  const workflow = readFileSync(
    new URL('../.github/workflows/quality.yml', import.meta.url),
    'utf8'
  );
  const full = workflow.slice(workflow.indexOf('  full-quality:'), workflow.indexOf('  recharge:'));
  const setup = full.indexOf('npm run auto-registration:setup');
  const acceptance = full.indexOf(`${python} -B ${worker}/acceptance_runtime.py`);
  assert.ok(setup >= 0);
  for (const name of [
    'test_workspace.py',
    'test_apple_mailboxes.py',
    'test_release_safety.py',
    'test_upload_compat.py'
  ]) {
    const command = `${python} -B -m unittest discover -s ${worker} -p '${name}'`;
    assert.equal(full.split('\n').filter((line) => line.trim() === command).length, 1, name);
    assert.ok(full.indexOf(command) > setup, name);
    assert.ok(acceptance > full.indexOf(command), name);
  }
  const browser = `node --test ${worker}/test_payment_browser.mjs`;
  assert.equal(full.split('\n').filter((line) => line.trim() === browser).length, 1);
  assert.ok(full.indexOf(browser) > setup);
  assert.ok(acceptance > full.indexOf(browser));
});

test('unreviewed registration paths do not receive the Apple scoped worker runner', () => {
  for (const path of [
    'apps/api/src/id-business-v2/auto-registration/registration.module.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/unknown.py',
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts'
  ]) {
    const calls = recordGuardCommands('recharge', [path], 'api');
    assert.ok(calls.every((call) => !call.includes('auto-registration:setup')));
    assert.ok(calls.every((call) => call[0] !== '.runtime/auto-registration/venv/bin/python'));
    assert.ok(
      calls.every(
        (call) =>
          !call.includes(
            'apps/api/src/id-business-v2/auto-registration/worker/test_payment_browser.mjs'
          )
      )
    );
  }
});

test('payment browser check failure stops the actual Apple dispatcher before runtime acceptance', () => {
  const worker = 'apps/api/src/id-business-v2/auto-registration/worker';
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = [];
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') return '${worker}/workspace.py';
      calls.push([file, ...args]);
      if (file === 'node' && args.includes('${worker}/test_payment_browser.mjs'))
        throw new Error('synthetic-payment-browser-check-failed');
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', 'api', 'a'.repeat(40)];
    let error = null;
    try { await import('./scripts/ci-recharge-check.mjs'); }
    catch (failure) { error = failure.message; }
    process.stdout.write(JSON.stringify({ calls, error }));
  `;
  const { calls, error } = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CHECK_MODE: 'recharge' }
    })
  );
  assert.equal(error, 'synthetic-payment-browser-check-failed');
  assert.equal(
    calls.filter((call) => call.includes(`${worker}/test_payment_browser.mjs`)).length,
    1
  );
  assert.ok(calls.every((call) => !call.includes(`${worker}/acceptance_runtime.py`)));
});

test('exact Vite runner classification keeps joint UI and backend guards without business execution', () => {
  const paths = [
    'scripts/acceptance-v2-auto-recharge.mjs',
    'scripts/acceptance-v2-bank-recharge-ui.mjs',
    'scripts/lib/vite-cli.mjs',
    'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
    'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py'
  ];
  const calls = recordGuardCommands('recharge', paths);
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-decimal-standard',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard'
  ])
    assert.equal(calls.filter((call) => call.join(' ') === 'npm run ' + name).length, 1, name);
  assert.ok(calls.every((call) => !call.some((arg) => /^(?:acceptance:|prisma:)/.test(arg))));
  assert.ok(
    calls.every(
      (call) =>
        !call.includes('scripts/acceptance-v2-auto-recharge.mjs') ||
        call.includes('prettier') ||
        call.includes('eslint')
    )
  );
  assert.ok(
    calls.every(
      (call) =>
        !call.includes('scripts/acceptance-v2-bank-recharge-ui.mjs') ||
        call.includes('prettier') ||
        call.includes('eslint')
    )
  );
});

test('removed registration transport paths select retirement checks without executing deleted scripts', () => {
  for (const part of ['guards', 'release-controls']) {
    const calls = recordGuardCommands(
      'ci-only',
      ['scripts/production-release/registration-only-transport.test.py'],
      part
    );
    assert.ok(
      calls.some(
        (call) =>
          call.join(' ') ===
          'python3 -B scripts/production-release/remote-deploy.test.py ReleaseScopeTests'
      )
    );
    assert.ok(
      calls.every(
        (call) => !call.includes('scripts/production-release/registration-only-transport.test.py')
      )
    );
  }
});

test('finite failure-receipt integration keeps Node controls then fifteen source suites and four storage suites once without business or database parts', () => {
  assert.deepEqual(
    onlinePreflightReceiptFixGuardCommands.map((command) => command.at(-1)),
    [
      'scripts/production-release/online-recharge-component-consumer.test.py',
      'scripts/production-release/online-recharge-component-runtime.test.py',
      'scripts/production-release/online-recharge-component-readonly.test.py',
      'scripts/production-release/api-admin-scope.test.py',
      'scripts/production-release/api-admin-pending-online.test.py',
      'scripts/production-release/admin-pending-online-release.test.py',
      'scripts/production-release/online-recharge-scope.test.py',
      'scripts/production-release/unpublished-component-successor.test.py',
      'scripts/production-release/unpublished-component-successor-readonly.test.py',
      'scripts/production-release/prepared-images.test.py',
      'scripts/production-release/recharge-flow-entry.test.mjs',
      'scripts/production-release/online-recharge-entry.test.mjs',
      'scripts/production-release/unified-component-source.test.py',
      'scripts/v2-order-archive-release-policy.test.mjs',
      'scripts/production-release/registration-onboarding-96.test.py',
      'scripts/production-release/release-artifact-retention.test.py',
      'scripts/production-release/release-artifact-retention-transport.test.py',
      'scripts/production-release/disk-retention-transport.test.py',
      'scripts/production-release/release-storage.test.py'
    ]
  );
  const paths = [...onlinePreflightReceiptFixGuardPaths];
  const context = {
    cloud: true,
    receiptResume: true,
    repository: onlinePreflightReceiptFixGuardBinding.repository,
    event: 'pull_request',
    base: onlinePreflightReceiptFixGuardBinding.integrationBase
  };
  const commands = (calls) => calls.filter((call) => !call[0].endsWith('resume-helper'));
  const original = recordGuardCommands('ci-only', paths);
  const index = original.findIndex(
    (call) =>
      call[0] === 'node' &&
      call[1] === '--test' &&
      call.includes('scripts/ci-recharge-scope.test.mjs')
  );
  assert.ok(index >= 0);
  const resumed = commands(recordGuardCommands('ci-only', paths, 'guards', context));
  assert.deepEqual(resumed, [
    ...original.slice(0, index + 1),
    ...onlinePreflightReceiptFixGuardCommands,
    ['process-exit', 0]
  ]);
  for (const command of onlinePreflightReceiptFixGuardCommands)
    assert.equal(
      resumed.filter((row) => JSON.stringify(row) === JSON.stringify(command)).length,
      1
    );
  assert.ok(resumed.some((row) => row.includes('scripts/ci-recharge-release.test.mjs')));
  assert.ok(
    !resumed.some((row) =>
      row.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg === 'docker' || arg.includes('acceptance-v2') || arg === '--workspace')
      )
    )
  );
  for (const reject of [
    { ...context, receiptResume: false },
    { ...context, cloud: false },
    { ...context, repository: 'foreign/project' },
    { ...context, event: 'push' },
    { ...context, base: '0'.repeat(40) }
  ])
    assert.deepEqual(commands(recordGuardCommands('ci-only', paths, 'guards', reject)), original);
  assert.deepEqual(
    recordGuardCommands('ci-only', paths, 'release-controls', context),
    recordGuardCommands('ci-only', paths, 'release-controls')
  );
});

test('finite build-proof reuse keeps Node controls then helper tests, real CI build and all twenty-two controls once', () => {
  assert.equal(onlineBuildProofReuseCommands.length, 22);
  assert.deepEqual(onlineBuildProofReuseCommands, [
    ...onlinePreflightReceiptFixGuardCommands,
    ['python3', '-B', 'scripts/production-release/online-recharge-component-diagnostic.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-component-lifecycle.test.py'],
    [
      'node',
      '--test',
      'scripts/production-release/online-recharge-component-diagnostic-entry.test.mjs'
    ]
  ]);
  const paths = [
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/online-recharge-ci-build.py',
    'scripts/production-release/online-recharge-ci-build.test.py'
  ];
  const context = {
    cloud: true,
    buildResume: true,
    repository: 'wangchaozhuanyong/id-business-system',
    event: 'pull_request',
    base: '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53'
  };
  const commands = (calls) => calls.filter((call) => !call[0].endsWith('resume-helper'));
  const original = recordGuardCommands('ci-only', paths);
  const index = original.findIndex(
    (call) =>
      call[0] === 'node' &&
      call[1] === '--test' &&
      call.includes('scripts/ci-recharge-scope.test.mjs')
  );
  assert.ok(index >= 0);
  const helperTest = [
    'python3',
    '-B',
    'scripts/production-release/online-recharge-ci-build.test.py'
  ];
  const realBuild = [
    'python3',
    '-B',
    'scripts/production-release/online-recharge-ci-build.py',
    '--ci-real-build-not-for-release',
    '--admitted-source-tree',
    'a'.repeat(40)
  ];
  const resumed = commands(recordGuardCommands('ci-only', paths, 'guards', context));
  assert.deepEqual(resumed, [
    ...original.slice(0, index + 1),
    helperTest,
    realBuild,
    ...onlineBuildProofReuseCommands,
    ['process-exit', 0]
  ]);
  for (const command of [helperTest, realBuild, ...onlineBuildProofReuseCommands])
    assert.equal(
      resumed.filter((row) => JSON.stringify(row) === JSON.stringify(command)).length,
      1
    );
  assert.ok(resumed.some((row) => row.includes('prettier')));
  assert.ok(resumed.some((row) => row.includes('eslint')));
  assert.ok(resumed.some((row) => row.includes('scripts/ci-recharge-release.test.mjs')));
  assert.ok(
    !resumed.some((row) =>
      row.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg === 'docker' || arg.includes('acceptance-v2') || arg === '--workspace')
      )
    )
  );
  for (const reject of [
    { ...context, buildResume: false },
    { ...context, cloud: false },
    { ...context, repository: 'foreign/project' },
    { ...context, event: 'push' },
    { ...context, base: '0'.repeat(40) }
  ])
    assert.deepEqual(commands(recordGuardCommands('ci-only', paths, 'guards', reject)), original);
  for (const mode of ['admin', 'recharge'])
    assert.deepEqual(
      commands(recordGuardCommands(mode, paths, 'guards', context)),
      recordGuardCommands(mode, paths)
    );
  assert.deepEqual(
    recordGuardCommands('ci-only', paths, 'release-controls', context),
    recordGuardCommands('ci-only', paths, 'release-controls')
  );
  for (const command of [original[index], helperTest, realBuild, ...onlineBuildProofReuseCommands])
    assert.throws(
      () =>
        recordGuardCommands('ci-only', paths, 'guards', {
          ...context,
          failCommand: command.join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
});

test('artifact-only controls keep the shared prefix and verify actual dependencies without unchanged website controllers', () => {
  for (const part of ['guards', 'release-controls']) {
    const paths = [
      'scripts/production-release/release-artifact-retention.py',
      'scripts/production-release/release-artifact-retention-transport.py',
      '.github/workflows/release-artifact-retention.yml',
      'scripts/ci-recharge-check.mjs',
      'scripts/ci-recharge-scope.mjs'
    ];
    const calls = recordGuardCommands('ci-only', paths, part);
    for (const file of [
      'release-artifact-retention',
      'release-artifact-retention-transport',
      'disk-retention-transport',
      'release-storage'
    ])
      assert.equal(
        calls.filter(
          (call) => call.join(' ') === `python3 -B scripts/production-release/${file}.test.py`
        ).length,
        1
      );
    assert.equal(
      calls.filter((call) => call.includes('scripts/ci-recharge-release.test.mjs')).length,
      1
    );
    assert.ok(
      !calls.some(
        (call) =>
          call.includes('scripts/production-release/remote-deploy.test.py') ||
          call.includes('scripts/production-release/api-admin-scope.test.py') ||
          call.includes('scripts/production-release/online-recharge-ci-build.test.py') ||
          call.includes(
            'scripts/production-release/online-recharge-component-diagnostic.test.py'
          ) ||
          call.includes('scripts/production-release/online-recharge-component-lifecycle.test.py')
      )
    );
    assert.ok(
      !calls.some(
        (call) =>
          call.includes('docker') ||
          call.some((arg) => arg.startsWith('--workspace') || arg.includes('acceptance-v2'))
      )
    );
    const mixed = recordGuardCommands(
      'ci-only',
      [...paths, 'scripts/production-release/remote-deploy.py'],
      part
    );
    assert.equal(
      mixed.filter((call) =>
        call.includes('scripts/production-release/release-artifact-retention.test.py')
      ).length,
      1
    );
    assert.ok(
      mixed.some((call) => call.includes('scripts/production-release/api-admin-scope.test.py'))
    );
    if (part === 'guards')
      assert.ok(
        mixed.some((call) => call.includes('scripts/production-release/remote-deploy.test.py'))
      );
    const onlineMixed = recordGuardCommands(
      'ci-only',
      [...paths, 'scripts/production-release/online-recharge-component-runtime.py'],
      part
    );
    for (const suite of [
      'release-artifact-retention.test.py',
      'online-recharge-ci-build.test.py',
      'online-recharge-component-diagnostic.test.py',
      'online-recharge-component-lifecycle.test.py'
    ])
      assert.equal(
        onlineMixed.filter((call) => call.includes('scripts/production-release/' + suite)).length,
        1
      );
    assert.ok(onlineMixed.every((call) => !call.includes('docker')));
  }
});

test('HTML cache repair runs the real disposable Nginx regression once in guards only', () => {
  const command = ['python3', '-B', 'scripts/acceptance-nginx-admin-cache.py', '--docker'];
  for (const path of ['deploy/nginx/admin.conf', 'scripts/acceptance-nginx-admin-cache.py']) {
    const calls = recordGuardCommands('admin', [path]);
    assert.equal(calls.filter((row) => row.join(' ') === command.join(' ')).length, 1, path);
    assert.equal(
      recordGuardCommands('admin', [path], 'release-controls').some(
        (row) => row.join(' ') === command.join(' ')
      ),
      false,
      path
    );
  }
  assert.equal(
    recordGuardCommands('ci-only', ['scripts/ci-recharge-scope.mjs']).some((row) =>
      row.includes('scripts/acceptance-nginx-admin-cache.py')
    ),
    false
  );
});

const finiteHtmlCachePaths = [
  'deploy/nginx/admin.conf',
  'scripts/acceptance-nginx-admin-cache.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
];
const realNginxCommand = ['python3', '-B', 'scripts/acceptance-nginx-admin-cache.py', '--docker'];
const finiteHtmlCacheUiChecks = [
  'check:admin-ui',
  'check:v2-ui-language',
  'check:v2-color-contrast',
  'check:v2-table-standard',
  'check:v2-loading-standard',
  'check:v2-module-architecture',
  'check:v2-isolation',
  'check:v2-decimal-standard'
];

test('finite HTML cache guards finish only after common controls real Nginx and all UI rules', () => {
  const calls = recordGuardCommands('admin', finiteHtmlCachePaths);
  const common = calls.findIndex(
    (row) =>
      row[0] === 'node' && row[1] === '--test' && row.includes('scripts/ci-recharge-scope.test.mjs')
  );
  const nginx = calls.findIndex((row) => row.join(' ') === realNginxCommand.join(' '));
  assert.ok(calls.findIndex((row) => row.includes('prettier')) < common);
  assert.ok(calls.findIndex((row) => row.includes('eslint')) < common);
  assert.ok(common >= 0 && nginx > common);
  for (const check of finiteHtmlCacheUiChecks) {
    const positions = calls.flatMap((row, index) =>
      row.join(' ') === 'npm run ' + check ? [index] : []
    );
    assert.equal(positions.length, 1, check);
    assert.ok(positions[0] > nginx, check);
  }
  assert.deepEqual(calls.at(-1), ['process-exit', 0]);
  assert.equal(
    calls.some((row) =>
      row.some((arg) => typeof arg === 'string' && arg.startsWith('scripts/production-release/'))
    ),
    false
  );
  const admin = recordGuardCommands('admin', finiteHtmlCachePaths, 'admin');
  assert.equal(admin.filter((row) => row.includes('@apple-business/admin')).length, 2);
  assert.equal(
    admin.some((row) => row[0] === 'process-exit'),
    false
  );
});

test('finite HTML cache guards never turn a failed common Nginx or UI command into success', () => {
  const calls = recordGuardCommands('admin', finiteHtmlCachePaths);
  const common = calls.find(
    (row) =>
      row[0] === 'node' && row[1] === '--test' && row.includes('scripts/ci-recharge-scope.test.mjs')
  );
  for (const command of [common, realNginxCommand, ['npm', 'run', 'check:v2-loading-standard']])
    assert.throws(
      () =>
        recordGuardCommands('admin', finiteHtmlCachePaths, 'guards', {
          failCommand: command.join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
});

test('mixed source Docker dependency arbitrary Nginx and other modes keep original publication controls', () => {
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
    'apps/admin/src/v2/features/customers/CustomerPage.vue',
    'apps/api/Dockerfile.mysql',
    'apps/admin/Dockerfile',
    'package-lock.json',
    'deploy/nginx/other.conf'
  ]) {
    const calls = recordGuardCommands('admin', [...finiteHtmlCachePaths, extra]);
    assert.ok(
      calls.some((row) =>
        row.includes('scripts/production-release/api-admin-pending-online.test.py')
      ),
      extra
    );
    assert.equal(
      calls.some((row) => row[0] === 'process-exit'),
      false,
      extra
    );
  }
  const changedConfiguration = readFileSync(
    resolve(root, 'deploy/nginx/admin.conf'),
    'utf8'
  ).replace('    etag off;', '    etag on;');
  for (const calls of [
    recordGuardCommands('admin', finiteHtmlCachePaths, 'guards', {
      cacheConfiguration: changedConfiguration
    }),
    recordGuardCommands('full', finiteHtmlCachePaths),
    recordGuardCommands('ci-only', finiteHtmlCachePaths),
    recordGuardCommands('admin', finiteHtmlCachePaths, 'release-controls')
  ]) {
    assert.ok(
      calls.some((row) =>
        row.includes('scripts/production-release/api-admin-pending-online.test.py')
      )
    );
    assert.equal(
      calls.some((row) => row[0] === 'process-exit'),
      false
    );
  }
});

test('registration closure dispatches both owned database suites without running databases in these control tests', () => {
  const paths = [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
    'apps/api/src/id-business-v2/proxy-pool/proxy-test.ts',
    'scripts/acceptance-v2-registration-mirror-mysql.mjs',
    'scripts/acceptance-v2-shared-proxy-mysql.mjs'
  ];
  const calls = recordGuardCommands('recharge', paths, 'migration', { cloud: true });
  for (const suite of [
    'scripts/acceptance-v2-registration-mirror-mysql.mjs',
    'scripts/acceptance-v2-shared-proxy-mysql.mjs'
  ])
    assert.equal(calls.filter((call) => call.includes(suite)).length, 1, suite);
  assert.ok(
    calls.findIndex((call) => call.includes(paths[2])) <
      calls.findIndex((call) => call.includes(paths[3]))
  );
  assert.equal(calls.filter((call) => call.includes('prisma:mysql:generate')).length, 1);
});

test('registration closure retains its pure worker regression in the API check', () => {
  const paths = ['apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py'];
  const calls = recordGuardCommands('recharge', paths, 'api');
  assert.equal(
    calls.filter((call) => call.includes('test_registration_closed_loop_unit.py')).length,
    1
  );
  assert.ok(calls.some((call) => call.includes('test_release_safety.py')));
  assert.ok(calls.some((call) => call.includes('test_workspace.py')));
  assert.ok(
    !calls.some((call) => call.includes('scripts/acceptance-v2-registration-native-ui.mjs'))
  );
});

test('registration native browser runs with its Python setup in the browser-equipped Admin job', () => {
  const paths = ['scripts/acceptance-v2-registration-native-ui.mjs'];
  const calls = recordGuardCommands('recharge', paths, 'admin');
  const setup = calls.findIndex((call) => call.includes('auto-registration:setup'));
  const browser = calls.findIndex((call) => call.includes(paths[0]));
  assert.ok(setup >= 0 && browser > setup);
  assert.equal(calls.filter((call) => call.includes(paths[0])).length, 1);
});

test('registration publication controls run their own pure test once and keep every UI rule', () => {
  const paths = [
    'scripts/production-release/registration-closure-release.py',
    'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue'
  ];
  for (const part of ['guards', 'release-controls']) {
    const calls = recordGuardCommands('recharge', paths, part);
    assert.equal(
      calls.filter((call) =>
        call.includes('scripts/production-release/registration-closure-release.test.py')
      ).length,
      1
    );
    if (part === 'guards')
      for (const name of [
        'check:admin-ui',
        'check:v2-ui-language',
        'check:v2-color-contrast',
        'check:v2-table-standard',
        'check:v2-loading-standard',
        'check:v2-module-architecture',
        'check:v2-isolation'
      ])
        assert.ok(
          calls.some((call) => call.includes(name)),
          name
        );
  }
});

test('exact published table alias controls run their pure positive and negative cases', () => {
  for (const part of ['guards', 'release-controls']) {
    for (const path of [
      'scripts/check-v2-table-standard.mjs',
      'scripts/lib/v2-table-schema-alias.mjs',
      'scripts/v2-table-schema-alias.test.mjs'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(
        calls.filter(
          (call) => call.join(' ') === 'node --test scripts/v2-table-schema-alias.test.mjs'
        ).length,
        1
      );
    }
  }
});

test('byte-bound proxy identity patch runs publisher/selectors and real engine suites without historical database or image checks', () => {
  const paths = [...proxyResultIdentityPaths];
  const options = { base: proxyResultIdentityBase, identityFixture: true };
  const guards = recordGuardCommands('recharge', paths, 'guards', options);
  assert.deepEqual(guards[0], [
    'python3',
    '-B',
    'scripts/production-release/proxy-result-identity-release.test.py'
  ]);
  for (const command of ['prettier', 'eslint'])
    assert.ok(guards.some((row) => row.includes(command)));
  assert.ok(guards.some((row) => row.includes('scripts/ci-proxy-result-identity-scope.test.mjs')));
  assert.equal(
    guards.some((row) => row.join(' ').includes('api-admin-pending-online')),
    false
  );
  assert.deepEqual(guards.at(-1), ['process-exit', 0]);
  const engine = recordGuardCommands('recharge', paths, 'online-engine', options);
  assert.deepEqual(engine[0], ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(engine[1], [
    'npm',
    'ci',
    '--prefix',
    proxyResultIdentityEngineRoot + '/upstream',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ]);
  assert.deepEqual(engine[2], ['node', '--test', ...proxyResultIdentityEngineTests]);
  assert.deepEqual(engine[3], ['process-exit', 0]);
  assert.throws(
    () =>
      recordGuardCommands('recharge', paths, 'online-engine', {
        ...options,
        failCommand: 'npm ci --ignore-scripts --no-audit --no-fund'
      }),
    /SYNTHETIC_COMMAND_FAILURE/
  );
  const wider = recordGuardCommands(
    'recharge',
    [...paths, 'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs'],
    'guards',
    options
  );
  assert.ok(wider.some((row) => row.join(' ').includes('api-admin-pending-online')));
  assert.throws(
    () =>
      recordGuardCommands('recharge', paths, 'guards', {
        ...options,
        failCommand: 'python3 -B scripts/production-release/proxy-result-identity-release.test.py'
      }),
    /SYNTHETIC_COMMAND_FAILURE/
  );
});
