import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    ['registration_browser.py', false],
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
    assert.ok(calls[testing].args.includes('test_registration_browser'));
    assert.ok(
      calls[testing].args.includes(fullPro ? 'test_pro' : 'test_pro.ProMenuDiagnosticsTests')
    );
  }
});

test('connector stops before worker tests when its browser installation fails', () => {
  const { calls, failed } = recordConnectorCommands(
    ['apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py'],
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
      'scripts/production-release/api-admin-scope.test.py'
    ]) {
      const calls = recordGuardCommands('ci-only', [path], part);
      assert.equal(
        calls.filter(
          (call) =>
            call.join(' ') === 'python3 -B scripts/production-release/api-admin-scope.test.py'
        ).length,
        1
      );
      assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
    }
  }
});
