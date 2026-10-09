import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest
} from './ci-recharge-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const gates = [
  'check:v2-module-architecture',
  'check:v2-prisma-runtime-boundary',
  'check:v2-concurrency-standard'
];

function recordGuardCommands(mode, paths, part = 'guards') {
  // Run the real dispatcher with process execution replaced before its named import resolves.
  // No Git command, nested test, database command or business operation is executed.
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const paths = JSON.parse(process.env.GUARD_TEST_PATHS);
    const calls = [];
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') return paths.join('\\n');
      calls.push([file, ...args]);
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', process.env.GUARD_TEST_PART, 'a'.repeat(40)];
    await import('./scripts/ci-recharge-check.mjs');
    process.stdout.write(JSON.stringify(calls));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHECK_MODE: mode,
        GUARD_TEST_PART: part,
        GUARD_TEST_PATHS: JSON.stringify(paths)
      }
    })
  );
}

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
      'scripts/production-release/api-admin-pending-online.test.py'
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
      for (const suite of ['api-admin-pending-projection', 'api-admin-pending-online']) {
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
