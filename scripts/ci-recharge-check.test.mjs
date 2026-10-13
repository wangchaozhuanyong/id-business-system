import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  productionDatabaseAccessAcceptance,
  unpublishedComponentSuccessorControlPaths,
  unpublishedComponentSuccessorEntryPaths,
  ownedMysqlTestControlPaths,
  rechargeConnectionProfileMigration
} from './ci-recharge-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const gates = [
  'check:v2-module-architecture',
  'check:v2-prisma-runtime-boundary',
  'check:v2-concurrency-standard'
];

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
    ['python3', '-B', 'scripts/production-release/unpublished-component-runtime-diagnostic.test.py']
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
