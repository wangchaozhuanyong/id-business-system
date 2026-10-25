import {
  rechargePlanBillingPublicationControls,
  rechargePlanBillingSourcePaths
} from './ci-recharge-plan-billing-scope.mjs';
import {
  registrationProtocolRestoreRepairBase,
  registrationProtocolRestoreRepairTree,
  registrationProtocolRestoreRepairPaths,
  registrationProtocolRestoreRepairCommands,
  registrationProtocolRestoreBase,
  registrationProtocolRestoreTree,
  registrationProtocolRestorePaths,
  registrationProtocolRestoreCommands
} from './ci-registration-protocol-restore-scope.mjs';
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
import { financialPublicationControlPaths } from './ci-financial-publication-scope.mjs';
import { financialClosurePaths } from './ci-financial-closure-scope.mjs';

test('账单排重发布控制走真实入口且不重复应用或数据库检查', () => {
  const calls = recordGuardCommands('ci-only', [...rechargePlanBillingPublicationControls]);
  assert.ok(
    calls.some((call) =>
      call.includes('scripts/production-release/recharge-plan-billing-release.test.py')
    )
  );
  assert.equal(
    calls.some((call) =>
      call.some((arg) =>
        /acceptance:v2|prisma:mysql|@apple-business\/api|@apple-business\/admin/.test(arg)
      )
    ),
    false
  );
});

test('账单迁移源码入口保留全部界面规则及共享卡回归', () => {
  const paths = [...rechargePlanBillingSourcePaths];
  const guards = recordGuardCommands('recharge', paths);
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
      guards.some((call) => call.includes(name)),
      name
    );
  assert.equal(
    guards.some((call) =>
      call.includes('scripts/production-release/online-recharge-scope.test.py')
    ),
    false
  );
  const api = recordGuardCommands('recharge', paths, 'api');
  assert.ok(api.some((call) => call.includes('src/id-business-v2/bank-card-pool')));
  assert.ok(api.some((call) => call.includes('typecheck')));
});

test('账务完整质量检查只选择本轮只读及有限发布控制', () => {
  const calls = recordGuardCommands('full', [...financialClosurePaths], 'release-controls');
  for (const name of [
    'scripts/production-release/financial-closure-readonly.test.py',
    'scripts/production-release/financial-closure-publication.py',
    'scripts/production-release/financial-closure-release.test.py'
  ])
    assert.ok(
      calls.some((call) => call.includes(name)),
      name
    );
  assert.equal(
    calls.some((call) =>
      call.some((arg) =>
        /api-admin-scope\.test|online-recharge-ci-build|bitbrowser-manual-build/.test(arg)
      )
    ),
    false
  );
});

test('账务发布控制入口不启动旧构造器、数据库或业务验收套件', () => {
  for (const part of ['guards', 'release-controls']) {
    const calls = recordGuardCommands('ci-only', [...financialPublicationControlPaths], part);
    assert.ok(
      calls.some((call) =>
        call.includes('scripts/production-release/financial-closure-publication.py')
      ),
      part
    );
    assert.equal(
      calls.some((call) =>
        call.some((arg) =>
          /online-recharge-ci-build|mysql\.test|acceptance:v2|prisma:mysql:migrate|bitbrowser-manual-build/.test(
            arg
          )
        )
      ),
      false,
      part
    );
    assert.equal(
      calls.some((call) =>
        call.includes('scripts/production-release/financial-closure-release.test.py')
      ),
      part === 'release-controls'
    );
  }
});
import {
  registrationParityDiagnosticsBase,
  registrationParityDiagnosticsRepairBase,
  registrationParityDiagnosticsRepairTree,
  registrationParityDiagnosticsRepairPaths,
  registrationParityDiagnosticsTree,
  registrationParityDiagnosticsPaths,
  registrationParityDiagnosticsWorker,
  registrationParityDiagnosticsAcceptance
} from './ci-registration-parity-diagnostics-scope.mjs';
import {
  registrationBrowserBase,
  registrationBrowserTree,
  registrationBrowserPaths,
  registrationBrowserCommands
} from './ci-registration-browser-scope.mjs';
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
  onlinePreflightReceiptFixGuardPaths,
  registrationFlowV4Base,
  registrationTerminalStopBase,
  registrationTerminalStopTree,
  registrationTerminalStopRepairBase,
  registrationTerminalStopRepairTree,
  registrationTerminalStopRepairPaths,
  registrationTerminalStopRepairParts,
  registrationTerminalStopContract,
  registrationTerminalStopApplications,
  registrationTerminalStopPaths,
  registrationTerminalStopCommands,
  registrationFlowV4Tree,
  registrationFlowV4Contract,
  registrationFlowV4Applications,
  registrationFlowV4Acceptance,
  registrationFlowV4Paths,
  registrationFlowV4Commands,
  registrationFlowV4SupportSources,
  registrationProtocolRepairBase,
  registrationProtocolRepairTree,
  registrationProtocolRepairContract,
  registrationProtocolRepairApplications,
  registrationProtocolRepairAcceptance,
  registrationProtocolRepairPaths,
  registrationProtocolRepairCommands,
  registrationProtocolRepairControlBase,
  registrationProtocolRepairControlTree,
  registrationProtocolRepairControlPaths,
  registrationProtocolRepairControlCommands,
  registrationProtocolRepairPreservationBase,
  registrationProtocolRepairPreservationTree,
  registrationProtocolRepairPreservationPaths,
  bitbrowserRecoveryControlPaths,
  bitbrowserRecoverySourceReviewCommit,
  bitbrowserRecoverySourceReviewTree,
  bitbrowserRecoveryControlRepairBase,
  bitbrowserRecoveryControlRepairTree,
  bitbrowserRecoveryControlRepairPaths,
  bitbrowserHistoryControlPaths,
  bitbrowserHistorySourceReviewCommit,
  bitbrowserHistorySourceReviewTree
} from './ci-recharge-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function assertRetiredRegistration(action) {
  assert.throws(action, (failure) =>
    /Automatic registration has been removed/.test(
      String(failure.stderr ?? failure.actual ?? failure.message)
    )
  );
}
test('registration published-baseline preservation runs only PR controls and propagates failure', () => {
  assertRetiredRegistration(() => {
    const options = {
      base: registrationProtocolRepairPreservationBase,
      protocolRepairFixture: true,
      cloud: false
    };
    assert.deepEqual(
      recordGuardCommands(
        'ci-only',
        registrationProtocolRepairPreservationPaths,
        'guards',
        options
      ),
      [...registrationProtocolRepairControlCommands.guards, ['process-exit', 0]]
    );
    assert.throws(
      () =>
        recordGuardCommands('ci-only', registrationProtocolRepairPreservationPaths, 'guards', {
          ...options,
          failCommand: registrationProtocolRepairControlCommands.guards[0].join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
    for (const part of ['api', 'admin', 'release-controls', 'migration'])
      assert.throws(
        () =>
          recordGuardCommands(
            'ci-only',
            registrationProtocolRepairPreservationPaths,
            part,
            options
          ),
        /Unsupported registration published-baseline preservation/
      );
  });
});

test('registration protocol preflight control repair runs only the finite controller checks and propagates failure', () => {
  assertRetiredRegistration(() => {
    const options = { base: registrationProtocolRepairControlBase, protocolRepairFixture: true };
    assert.deepEqual(
      recordGuardCommands('ci-only', registrationProtocolRepairControlPaths, 'guards', options),
      [...registrationProtocolRepairControlCommands.guards, ['process-exit', 0]]
    );
    for (const part of ['api', 'admin', 'migration', 'release-controls']) {
      assert.throws(
        () => recordGuardCommands('ci-only', registrationProtocolRepairControlPaths, part, options),
        /Unsupported registration protocol preflight control repair/
      );
    }
    assert.throws(
      () =>
        recordGuardCommands('ci-only', registrationProtocolRepairControlPaths, 'guards', {
          ...options,
          failCommand: registrationProtocolRepairControlCommands.guards[0].join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  });
});

test('registration flow v4 dispatches its four finite parts and blocks local candidate checks', () => {
  assertRetiredRegistration(() => {
    const options = {
      base: registrationFlowV4Base,
      flowV4Fixture: true,
      cloud: true
    };
    for (const part of ['guards', 'api', 'admin', 'release-controls']) {
      assert.deepEqual(recordGuardCommands('recharge', registrationFlowV4Paths, part, options), [
        ...registrationFlowV4Commands[part],
        ['process-exit', 0]
      ]);
    }
    for (const part of ['api', 'admin']) {
      assert.throws(
        () =>
          recordGuardCommands('recharge', registrationFlowV4Paths, part, {
            ...options,
            cloud: false
          }),
        /require isolated CI/
      );
    }
    assert.throws(
      () => recordGuardCommands('recharge', registrationFlowV4Paths, 'migration', options),
      /Unsupported registration flow v4/
    );
    const failCommand = registrationFlowV4Commands.guards[0].join(' ');
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationFlowV4Paths, 'guards', {
          ...options,
          failCommand
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  });
});

test('registration protocol repair dispatches its four finite parts and blocks local candidate checks', () => {
  assertRetiredRegistration(() => {
    const options = {
      base: registrationProtocolRepairBase,
      protocolRepairFixture: true,
      cloud: true
    };
    for (const part of ['guards', 'api', 'admin', 'release-controls']) {
      assert.deepEqual(
        recordGuardCommands('recharge', registrationProtocolRepairPaths, part, options),
        [...registrationProtocolRepairCommands[part], ['process-exit', 0]]
      );
    }
    for (const part of ['api', 'admin']) {
      assert.throws(
        () =>
          recordGuardCommands('recharge', registrationProtocolRepairPaths, part, {
            ...options,
            cloud: false
          }),
        /require isolated CI/
      );
    }
    assert.throws(
      () => recordGuardCommands('recharge', registrationProtocolRepairPaths, 'migration', options),
      /Unsupported registration protocol repair/
    );
    const failCommand = registrationProtocolRepairCommands.guards[0].join(' ');
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationProtocolRepairPaths, 'guards', {
          ...options,
          failCommand
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  });
});

test('registration protocol image-user repair stops on its pure gate and refuses API Admin or migration', () => {
  assertRetiredRegistration(() => {
    const options = { base: registrationProtocolRestoreRepairBase, restoreFixture: true };
    const calls = recordGuardCommands(
      'ci-only',
      registrationProtocolRestoreRepairPaths,
      'guards',
      options
    );
    assert.deepEqual(calls, [
      ...registrationProtocolRestoreRepairCommands.guards,
      ['process-exit', 0]
    ]);
    assert.equal(
      calls.some((row) =>
        row.some(
          (arg) =>
            typeof arg === 'string' &&
            /check-api|check-admin|unittest|prisma|acceptance|check:v2-/.test(arg)
        )
      ),
      false
    );
    for (const part of ['api', 'admin', 'migration', 'release-controls'])
      assert.throws(
        () => recordGuardCommands('ci-only', registrationProtocolRestoreRepairPaths, part, options),
        /Unsupported registration protocol restore control repair/
      );
    assert.deepEqual(registrationProtocolRestoreRepairCommands.guards[0], [
      'python3',
      '-B',
      'scripts/production-release/registration-protocol-restore-release.test.py'
    ]);
    const failed = registrationProtocolRestoreRepairCommands.guards[0].join(' ');
    assert.throws(
      () =>
        recordGuardCommands('ci-only', registrationProtocolRestoreRepairPaths, 'guards', {
          ...options,
          failCommand: failed
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  });
});

test('registration protocol restore dispatches only scoped checks and requires isolated candidate verification', () => {
  assertRetiredRegistration(() => {
    for (const part of ['guards', 'api', 'admin']) {
      assert.deepEqual(
        recordGuardCommands('recharge', registrationProtocolRestorePaths, part, {
          base: registrationProtocolRestoreBase,
          restoreFixture: true,
          cloud: true
        }),
        [...registrationProtocolRestoreCommands[part], ['process-exit', 0]]
      );
    }
    for (const part of ['api', 'admin'])
      assert.throws(
        () =>
          recordGuardCommands('recharge', registrationProtocolRestorePaths, part, {
            base: registrationProtocolRestoreBase,
            restoreFixture: true
          }),
        /require isolated CI/
      );
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationProtocolRestorePaths, 'migration', {
          base: registrationProtocolRestoreBase,
          restoreFixture: true,
          cloud: true
        }),
      /Unsupported registration protocol restore/
    );
  });
});

test('registration browser dispatcher runs every finite command and exits before historical publishers', () => {
  assertRetiredRegistration(() => {
    for (const part of ['guards', 'release-controls', 'api', 'admin']) {
      const calls = recordGuardCommands('recharge', registrationBrowserPaths, part, {
        base: registrationBrowserBase,
        browserFixture: true,
        cloud: true
      });
      assert.deepEqual(calls, [
        ...registrationBrowserCommands(part, registrationBrowserPaths),
        ['process-exit', 0]
      ]);
    }
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationBrowserPaths, 'migration', {
          base: registrationBrowserBase,
          browserFixture: true,
          cloud: true
        }),
      /Unsupported registration browser/
    );
  });
});

test('registration browser SQLite suites cannot run through this finite dispatcher on the local Mac', () => {
  assertRetiredRegistration(() => {
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationBrowserPaths, 'api', {
          base: registrationBrowserBase,
          browserFixture: true
        }),
      /require isolated CI/
    );
  });
});
test('checkout source recovery runs its native controls and the API suite without historical registration publishers', () => {
  const paths = [
    '.github/workflows/recharge-source-recovery-validation.yml',
    'scripts/production-release/recharge-source-recovery-contract.json',
    'scripts/production-release/recharge-source-recovery-release.py',
    'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.ts',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-recharge-checkout-scope.mjs',
    'scripts/ci-recharge-checkout-scope.test.mjs'
  ];
  const guards = recordGuardCommands('recharge', paths);
  assert.ok(
    guards.some((row) =>
      row.includes('scripts/production-release/recharge-source-recovery-release.test.py')
    )
  );
  assert.ok(guards.some((row) => row.includes('prettier')));
  assert.ok(guards.some((row) => row.includes('eslint')));
  assert.ok(guards.some((row) => row.includes('check:v2-module-architecture')));
  assert.ok(guards.some((row) => row.includes('check:v2-isolation')));
  assert.ok(guards.some((row) => row.includes('check:v2-prisma-runtime-boundary')));
  const controlTests = guards.find((row) => row[0] === 'node' && row[1] === '--test');
  assert.ok(controlTests.includes('scripts/ci-recharge-checkout-scope.test.mjs'));
  assert.ok(controlTests.includes('scripts/ci-recharge-check.test.mjs'));
  assert.equal(controlTests.includes('scripts/ci-recharge-scope.test.mjs'), false);
  assert.deepEqual(guards.at(-1), ['process-exit', 0]);
  assert.equal(
    guards.some((row) =>
      row.some(
        (arg) =>
          typeof arg === 'string' &&
          /api-admin-scope.test.py|recharge-checkout-release.test.py/.test(arg)
      )
    ),
    false
  );
  const api = recordGuardCommands('recharge', paths, 'api');
  assert.ok(api.some((row) => row.includes('prisma:mysql:validate')));
  assert.ok(api.some((row) => row.includes('src/id-business-v2/auto-recharge')));
  assert.ok(api.some((row) => row.join(' ') === 'npm run build --workspace @apple-business/api'));
});
test('checkout foreground repair runs real connector selection with the focus and payment regressions', () => {
  const paths = [
    'apps/api/src/id-business-v2/auto-recharge/worker/payment_form.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_payment_form_focus.py',
    'scripts/ci-recharge-checkout-scope.mjs',
    'scripts/ci-recharge-check.mjs'
  ];
  const guards = recordGuardCommands('recharge', paths);
  assert.ok(guards.some((row) => row.includes('check:v2-isolation')));
  const connector = recordGuardCommands('recharge', paths, 'connector');
  const tests = connector.find((row) => row.includes('unittest'));
  for (const name of [
    'test_payment_form_focus',
    'test_payment',
    'test_native_checkout',
    'test_native_pro_checkout'
  ])
    assert.ok(tests.includes(name), name);
});
test('form wait budget keeps shared controls and the full payment connector regression', () => {
  const paths = ['payment_form.py', 'pay.py', 'test_payment_form_budget.py'].map(
    (name) => `apps/api/src/id-business-v2/auto-recharge/worker/${name}`
  );
  const guards = recordGuardCommands('recharge', paths);
  assert.ok(guards.some((row) => row.includes('check:v2-isolation')));
  const connector = recordGuardCommands('recharge', paths, 'connector');
  const tests = connector.find((row) => row.includes('unittest'));
  for (const name of [
    'test_payment_form_budget',
    'test_payment_form_focus',
    'test_payment',
    'test_native_checkout'
  ])
    assert.ok(tests.includes(name), name);
});
test('expired unpaid checkout repair retains native and one-shot replacement regressions', () => {
  const paths = ['native_checkout.py', 'expired_checkout.py', 'test_expired_checkout.py'].map(
    (name) => `apps/api/src/id-business-v2/auto-recharge/worker/${name}`
  );
  const connector = recordGuardCommands('recharge', paths, 'connector');
  const tests = connector.find((row) => row.includes('unittest'));
  for (const name of ['test_expired_checkout', 'test_native_checkout', 'test_payment'])
    assert.ok(tests.includes(name), name);
});
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

test('registration parity dispatcher runs both interfaces all persistence modules and UI rules then closes its finite branch', () => {
  assertRetiredRegistration(() => {
    for (const part of ['guards', 'release-controls', 'api', 'admin']) {
      const calls = recordGuardCommands('recharge', registrationParityDiagnosticsPaths, part, {
        base: registrationParityDiagnosticsBase,
        parityFixture: true
      });
      assert.deepEqual(calls.at(-1), ['process-exit', 0]);
      if (part === 'guards' || part === 'release-controls') {
        const install = calls.findIndex(
          (c) => c.join(' ') === 'npm ci --ignore-scripts --no-audit --no-fund'
        );
        const format = calls.findIndex((c) => c.includes('prettier'));
        if (part === 'release-controls') assert.ok(install >= 0 && format > install);
        else assert.equal(install, -1);
        assert.ok(
          calls.some((c) =>
            c.includes('scripts/production-release/registration-parity-diagnostics-release.test.py')
          )
        );
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
            calls.some((c) => c.join(' ') === 'npm run ' + name),
            name
          );
      } else if (part === 'api') {
        for (const name of [
          'test_registration_parity_unit.py',
          'test_flow_evidence.py',
          'test_workspace.py',
          'test_apple_mailboxes.py',
          'test_release_safety.py',
          'test_registration_closed_loop_unit.py',
          'test_upload_compat.py'
        ])
          assert.ok(
            calls.some((c) => c.includes(registrationParityDiagnosticsWorker) && c.includes(name)),
            name
          );
      } else assert.ok(calls.some((c) => c.includes(registrationParityDiagnosticsAcceptance)));
      assert.ok(
        !calls.some((c) =>
          c.some(
            (arg) =>
              typeof arg === 'string' &&
              /ci-recharge-migration|prisma:migrate|online-recharge.*engine\/test/.test(arg)
          )
        )
      );
    }
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationParityDiagnosticsPaths, 'migration', {
          base: registrationParityDiagnosticsBase,
          parityFixture: true
        }),
      /Unsupported registration parity diagnostics check part/
    );
  });
});

test('registration client successor control repair runs guards without repeating application or database suites', () => {
  assertRetiredRegistration(() => {
    const calls = recordGuardCommands(
      'ci-only',
      registrationParityDiagnosticsRepairPaths,
      'guards',
      {
        base: registrationParityDiagnosticsRepairBase,
        parityFixture: true
      }
    );
    assert.deepEqual(calls.at(-1), ['process-exit', 0]);
    assert.ok(
      calls.some((c) => c.includes('--test-name-pattern=registration parity|registration client'))
    );
    assert.ok(
      calls.some((c) =>
        c.includes('scripts/production-release/registration-parity-diagnostics-release.test.py')
      )
    );
    assert.ok(
      !calls.some(
        (c) =>
          c.includes('prisma:mysql:generate') ||
          c.includes('auto-registration:setup') ||
          c.includes('build') ||
          c.includes('test')
      )
    );
    assert.throws(
      () =>
        recordGuardCommands('ci-only', registrationParityDiagnosticsRepairPaths, 'api', {
          base: registrationParityDiagnosticsRepairBase,
          parityFixture: true
        }),
      /Unsupported registration parity control repair check part/
    );
  });
});

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
  const calls = recordGuardCommands(
    'ci-only',
    ['scripts/production-release/registration-closure-release.py'],
    'guards'
  );
  assert.ok(
    calls.every(
      (row) => !row.some((value) => /production-release\/registration-.*\.py$/.test(value))
    )
  );
});

test('exact declaration proof repair runs its publisher tests and selectors without unrelated historical prefix', () => {
  assertRetiredRegistration(() => {
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
      wider.some((row) =>
        row.includes('scripts/production-release/api-admin-pending-online.test.py')
      )
    );
  });
});

test('exact registration dependency controls retain own tests and formatting before ending ahead of historical suites', () => {
  assertRetiredRegistration(() => {
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
      wider.some((row) =>
        row.includes('scripts/production-release/api-admin-pending-online.test.py')
      )
    );
  });
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

test('registration terminal stop dispatches only reviewed parts and isolates persistence', () => {
  assertRetiredRegistration(() => {
    const options = { base: registrationTerminalStopBase, terminalStopFixture: true, cloud: true };
    for (const part of ['guards', 'api', 'release-controls']) {
      assert.deepEqual(
        recordGuardCommands('recharge', registrationTerminalStopPaths, part, options),
        [...registrationTerminalStopCommands[part], ['process-exit', 0]]
      );
    }
    assert.throws(
      () => recordGuardCommands('recharge', registrationTerminalStopPaths, 'admin', options),
      /Unsupported registration terminal stop/
    );
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationTerminalStopPaths, 'api', {
          ...options,
          cloud: false
        }),
      /require isolated CI/
    );
    const failCommand = registrationTerminalStopCommands.guards[0].join(' ');
    assert.throws(
      () =>
        recordGuardCommands('recharge', registrationTerminalStopPaths, 'guards', {
          ...options,
          failCommand
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  });
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
    baseTree = '',
    schemaBefore = 'model Synthetic { id String @id }\n',
    schemaAfter = schemaBefore,
    readonlyBaseSource = '',
    readonlyCurrentSource = null,
    cacheConfiguration = null,
    identityFixture = false,
    parityFixture = false,
    browserFixture = false,
    restoreFixture = false,
    protocolRepairFixture = false,
    flowV4Fixture = false,
    terminalStopFixture = false
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
  const repairHashes = Object.fromEntries(
    registrationProtocolRepairPaths
      .filter((name) => name !== registrationProtocolRepairContract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  const repairContract = {
    version: 1,
    scope: 'REGISTRATION_PROTOCOL_REPAIR_20261017',
    name: 'registration-protocol-repair-20261017',
    frozen: true,
    admission: 'VERIFIED',
    migration: null,
    businessActions: 0,
    sourceBaseline: registrationProtocolRepairBase,
    sourceBaselineTree: registrationProtocolRepairTree,
    expectedGitChanges: [...registrationProtocolRepairPaths],
    applicationPaths: [...registrationProtocolRepairApplications],
    sources: Object.fromEntries(
      registrationProtocolRepairApplications.map((name) => [name, repairHashes[name]])
    ),
    validationSources: {
      [registrationProtocolRepairAcceptance]: repairHashes[registrationProtocolRepairAcceptance]
    },
    reviewedFileHashes: repairHashes,
    controlHashes: {
      'registration-protocol-repair-build.py': 'a'.repeat(64),
      'registration-protocol-repair-release.py': 'a'.repeat(64),
      'registration-protocol-repair-release.test.py': 'a'.repeat(64),
      'unchanged-helper.py': 'a'.repeat(64)
    },
    validationSupportSources: { 'scripts/check-v2-module-architecture.mjs': 'a'.repeat(64) },
    buildSupportHashes: {
      'scripts/production-release/registration-closure-release.py': 'a'.repeat(64)
    }
  };
  const v4Hashes = Object.fromEntries(
    registrationFlowV4Paths
      .filter((name) => name !== registrationFlowV4Contract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  const v4Contract = {
    version: 1,
    scope: 'REGISTRATION_FLOW_V4_20261017',
    name: 'registration-flow-v4-20261017',
    frozen: true,
    admission: 'VERIFIED',
    migration: null,
    businessActions: 0,
    pendingEvidence: [],
    sourceBaseline: registrationFlowV4Base,
    sourceBaselineTree: registrationFlowV4Tree,
    expectedGitChanges: [...registrationFlowV4Paths],
    applicationPaths: [...registrationFlowV4Applications],
    sources: Object.fromEntries(
      registrationFlowV4Applications.map((name) => [name, v4Hashes[name]])
    ),
    validationSources: { [registrationFlowV4Acceptance]: v4Hashes[registrationFlowV4Acceptance] },
    validationSupportSources: registrationFlowV4SupportSources,
    reviewedFileHashes: v4Hashes
  };
  const terminalHashes = Object.fromEntries(
    registrationTerminalStopPaths
      .filter((name) => name !== registrationTerminalStopContract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  const terminalContract = {
    version: 1,
    scope: 'REGISTRATION_TERMINAL_STOP_20261017',
    name: 'registration-terminal-stop-20261017',
    frozen: true,
    admission: 'VERIFIED',
    migration: null,
    businessActions: 0,
    pendingEvidence: [],
    sourceBaseline: registrationTerminalStopBase,
    sourceBaselineTree: registrationTerminalStopTree,
    expectedGitChanges: [...registrationTerminalStopPaths],
    applicationPaths: [...registrationTerminalStopApplications],
    sources: Object.fromEntries(
      registrationTerminalStopApplications.map((name) => [name, terminalHashes[name]])
    ),
    workerFiles: { 'apple_mailboxes.py': terminalHashes[registrationTerminalStopApplications[0]] },
    validationSources: {},
    apiRuntimeDelta: [],
    apiJavascriptDelta: [],
    adminDelta: [],
    reviewedFileHashes: terminalHashes
  };
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
      if (${JSON.stringify(restoreFixture)} && specifier === './ci-registration-protocol-restore-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const url = new URL('./scripts/ci-registration-protocol-restore-scope.mjs', import.meta.url).href;
        const source = 'import * as m from ' + JSON.stringify(url) + ';export * from ' + JSON.stringify(url) + ';' +
          'function restoreOptions(options){' +
          'const removed=m.registrationProtocolRestoreRemovedSources;' +
          'const hashes=Object.fromEntries(m.registrationProtocolRestorePaths.filter(p=>!(p in removed)&&p!=="scripts/production-release/registration-protocol-restore-contract.json").map(p=>[p,"a".repeat(64)]));' +
          'const validation="apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py";' +
          'const sources=Object.fromEntries(Object.entries(hashes).filter(([p])=>p.startsWith("apps/")&&p!==validation));' +
          'const contract={version:1,frozen:true,scope:"REGISTRATION_PROTOCOL_RESTORE",migration:null,sourceBaseline:m.registrationProtocolRestoreBase,sourceBaselineTree:m.registrationProtocolRestoreTree,expectedCurrent:"123ea34df9bf74a1d65e74bd70f336eaa9344165",schemaSha256:"51a4d25b1302458145f560acc32f25b89a7bd65fea64dc72b254dc56da430100",runtimeEvidence:{status:"VERIFIED",commit:"123ea34df9bf74a1d65e74bd70f336eaa9344165"},expectedGitChanges:m.registrationProtocolRestorePaths,withdrawal:{sourceRemovals:{...removed}},reviewedFileHashes:hashes,reviewedApplicationCommit:"2bcced63c834187ac5e69e344176da33ff82d4c9",sources,validationSources:{[validation]:hashes[validation]},unchangedInputs:{},validationBaselineSources:{...m.registrationProtocolRestoreRepairGuard}};' +
          'const repairBaseContract=structuredClone(contract);contract.validationBaselineSources={...m.registrationProtocolRestoreRepairGuard};' +
          'return {...options,contract,repairBaseContract,sourceDigest:p=>m.registrationProtocolRestoreRepairGuard[p]??hashes[p]??null,baseSourceDigest:p=>removed[p]??null};}' +
          'export function isRegistrationProtocolRestoreOnly(paths,options){return m.isRegistrationProtocolRestoreOnly(paths,restoreOptions(options));}' +
          'export function isRegistrationProtocolRestoreControlRepair(paths,options){return m.isRegistrationProtocolRestoreControlRepair(paths,restoreOptions(options));}';
        return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
      }
      if (${JSON.stringify(browserFixture)} && specifier === './ci-registration-browser-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const url = new URL('./scripts/ci-registration-browser-scope.mjs', import.meta.url).href;
        const source = 'import * as m from ' + JSON.stringify(url) + ';export * from ' + JSON.stringify(url) + ';' +
          'export function isRegistrationBrowserOnly(paths,options){' +
          'const hashes=Object.fromEntries(m.registrationBrowserReviewedPaths.filter(p=>p!==m.registrationBrowserContract).map(p=>[p,"a".repeat(64)]));' +
          'const contract={version:1,frozen:true,scope:"REGISTRATION_BROWSER",sourceBaseline:m.registrationBrowserBase,sourceBaselineTree:m.registrationBrowserTree,expectedCurrent:m.registrationBrowserCurrent,migration:null,expectedGitChanges:m.registrationBrowserReviewedPaths,sourceDeltaPaths:m.registrationBrowserPaths,allowedApplicationPaths:m.registrationBrowserApplications,controlPaths:m.registrationBrowserControls,sources:Object.fromEntries(m.registrationBrowserApplications.map(p=>[p,hashes[p]])),validationSources:{[m.registrationBrowserAcceptance]:hashes[m.registrationBrowserAcceptance]},reviewedFileHashes:hashes};' +
          'return m.isRegistrationBrowserOnly(paths,{...options,contract,sourceDigest:p=>hashes[p]});}';
        return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
      }
      if (${JSON.stringify(parityFixture)} && specifier === './ci-registration-parity-diagnostics-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const url = new URL('./scripts/ci-registration-parity-diagnostics-scope.mjs', import.meta.url).href;
        const source = 'import * as m from ' + JSON.stringify(url) + ';export * from ' + JSON.stringify(url) + ';' +
          'function fixtureOptions(options) {' +
          'const hashes=Object.fromEntries(m.registrationParityDiagnosticsPaths.filter(p=>p!==m.registrationParityDiagnosticsContract).map(p=>[p,"a".repeat(64)]));' +
          'const contract={frozen:true,scope:"REGISTRATION_PARITY_DIAGNOSTICS",sourceBaseline:m.registrationParityDiagnosticsBase,sourceBaselineTree:m.registrationParityDiagnosticsTree,expectedCurrent:m.registrationParityDiagnosticsCurrent,migration:null,expectedGitChanges:m.registrationParityDiagnosticsPaths,sourceDeltaPaths:m.registrationParityDiagnosticsRepairPaths,allowedApplicationPaths:m.registrationParityDiagnosticsApplications,controlPaths:m.registrationParityDiagnosticsControls,sources:Object.fromEntries(m.registrationParityDiagnosticsApplications.map(p=>[p,hashes[p]])),validationSources:{[m.registrationParityDiagnosticsAcceptance]:hashes[m.registrationParityDiagnosticsAcceptance]},reviewedFileHashes:hashes};' +
          'return {...options,contract,sourceDigest:p=>hashes[p]};}' +
          'export function isRegistrationParityDiagnosticsOnly(paths,options){return m.isRegistrationParityDiagnosticsOnly(paths,fixtureOptions(options));}' +
          'export function isRegistrationParityDiagnosticsControlRepair(paths,options){return m.isRegistrationParityDiagnosticsControlRepair(paths,fixtureOptions(options));}';
        return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
      }
      if (${JSON.stringify(identityFixture)} && specifier === './ci-proxy-result-identity-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const identityUrl = new URL('./scripts/ci-proxy-result-identity-scope.mjs', import.meta.url).href;
        const source = 'import {isProxyResultIdentityOnly as original, proxyResultIdentityPins} from ' + JSON.stringify(identityUrl) + ';' +
          'export * from ' + JSON.stringify(identityUrl) + ';' +
          'export function isProxyResultIdentityOnly(paths, options) {' +
          'return original(paths, {...options, sourceDigest: (path) => proxyResultIdentityPins[path]}); }';
        return {url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true};
      }
      if (specifier === './ci-recharge-scope.mjs' && context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs')) {
        const repairFixtureSource = ${JSON.stringify(protocolRepairFixture)}
          ? 'import * as realScope from ' + JSON.stringify(scopeUrl) + ';' +
            'export function isRegistrationProtocolRepairOnly(paths, options){' +
            'const contract=' + ${JSON.stringify(JSON.stringify(repairContract))} + ';' +
            'return realScope.isRegistrationProtocolRepairOnly(paths,{...options,contract,sourceDigest:name=>contract.reviewedFileHashes[name]??null});}' +
            'export function isRegistrationProtocolRepairControlRepair(paths, options){' +
            'const prior=' + ${JSON.stringify(JSON.stringify(repairContract))} + ';' +
            'const contract={...structuredClone(prior),sourceBaseline:realScope.registrationProtocolRepairControlBase,sourceBaselineTree:realScope.registrationProtocolRepairControlTree,expectedGitChanges:realScope.registrationProtocolRepairControlPaths,reviewedFileHashes:Object.fromEntries(realScope.registrationProtocolRepairControlPaths.filter(n=>n!==realScope.registrationProtocolRepairContract).map(n=>[n,prior.reviewedFileHashes[n]]))};' +
            'const sourceDigest=name=>contract.reviewedFileHashes[name]??prior.reviewedFileHashes[name]??prior.validationSupportSources[name]??prior.buildSupportHashes[name]??prior.controlHashes[name.replace("scripts/production-release/","")]??null;' +
            'return realScope.isRegistrationProtocolRepairControlRepair(paths,{...options,contract,repairBaseContract:prior,repairSourcePaths:realScope.registrationProtocolRepairControlPaths,sourceDigest,validatedSourceDigest:name=>prior.reviewedFileHashes[name]??null});}' +
            'export function isRegistrationProtocolRepairPreservationOnly(paths, options){' +
            'const prior=' + ${JSON.stringify(JSON.stringify(repairContract))} + ';' +
            'const contract={...structuredClone(prior),sourceBaseline:realScope.registrationProtocolRepairPreservationBase,sourceBaselineTree:realScope.registrationProtocolRepairPreservationTree,expectedCurrent:realScope.registrationProtocolRepairControlBase,expectedGitChanges:realScope.registrationProtocolRepairPreservationPaths,reviewedFileHashes:Object.fromEntries(realScope.registrationProtocolRepairPreservationPaths.filter(n=>n!==realScope.registrationProtocolRepairContract).map(n=>[n,prior.reviewedFileHashes[n]]))};' +
            'const sourceDigest=name=>contract.reviewedFileHashes[name]??prior.sources[name]??prior.validationSources[name]??prior.validationSupportSources[name]??prior.buildSupportHashes[name]??prior.controlHashes[name.replace("scripts/production-release/","")]??null;' +
            'return realScope.registrationProtocolRepairPreservationAdmission(paths,{...options,contract,repairBaseContract:prior,repairSourcePaths:realScope.registrationProtocolRepairPreservationPaths,sourceDigest},realScope.registrationProtocolRepairPreservationProjection(contract));}'
          : '';
        const v4FixtureSource = ${JSON.stringify(flowV4Fixture)}
          ? 'export function isRegistrationFlowV4Only(paths,options){const contract=' + ${JSON.stringify(JSON.stringify(v4Contract))} + ';return realScope.isRegistrationFlowV4Only(paths,{...options,contract,sourceDigest:name=>contract.reviewedFileHashes[name]??contract.validationSupportSources[name]??null});}' : '';
        const terminalFixtureSource = ${JSON.stringify(terminalStopFixture)}
          ? 'export function isRegistrationTerminalStopOnly(paths,options){const contract=' + ${JSON.stringify(JSON.stringify(terminalContract))} + ';return realScope.isRegistrationTerminalStopOnly(paths,{...options,contract,sourceDigest:name=>contract.reviewedFileHashes[name]??null});}' : '';
        const source = (repairFixtureSource ? '' : 'import * as realScope from ' + JSON.stringify(scopeUrl) + ';') + 'export * from ' + JSON.stringify(scopeUrl) + ';' + repairFixtureSource + v4FixtureSource + terminalFixtureSource +
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
        if (args.join(' ') === 'rev-parse ' + process.env.GUARD_TEST_BASE + '^{tree}' && process.env.GUARD_TEST_BASE_TREE)
          return process.env.GUARD_TEST_BASE_TREE + '\\n';
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationTerminalStopBase + '^{tree}')}) return ${JSON.stringify(registrationTerminalStopTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationTerminalStopRepairBase + '^{tree}')}) return ${JSON.stringify(registrationTerminalStopRepairTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationFlowV4Base + '^{tree}')}) return ${JSON.stringify(registrationFlowV4Tree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationProtocolRepairPreservationBase + '^{tree}')}) return ${JSON.stringify(registrationProtocolRepairPreservationTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationProtocolRepairControlBase + '^{tree}')}) return ${JSON.stringify(registrationProtocolRepairControlTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationProtocolRepairBase + '^{tree}')}) return ${JSON.stringify(registrationProtocolRepairTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationProtocolRestoreRepairBase + '^{tree}')}) return ${JSON.stringify(registrationProtocolRestoreRepairTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationProtocolRestoreBase + '^{tree}')}) return ${JSON.stringify(registrationProtocolRestoreTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationBrowserBase + '^{tree}')}) return ${JSON.stringify(registrationBrowserTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationParityDiagnosticsBase + '^{tree}')}) return ${JSON.stringify(registrationParityDiagnosticsTree + '\n')};
        if (args.join(' ') === ${JSON.stringify('rev-parse ' + registrationParityDiagnosticsRepairBase + '^{tree}')}) return ${JSON.stringify(registrationParityDiagnosticsRepairTree + '\n')};
        if (args.join(' ') === 'rev-parse 7c3c102c98539d33cb379ef018427371ba750cb7^{tree}') return 'f6ab4537e28437af244c2263dd591516ae8e2a22\\n';
        if (args.join(' ') === 'rev-parse d38c243b5727953aa96c0fa83e706fee253c9624^{tree}') return 'a331c3ab6b23c3331aa550b752d9d66860e62cdb\\n';
        if (args.join(' ') === 'rev-parse cd7bba03bec1742328e0829c215823bda1fd3fae^{tree}') return '874102957cbd6cc921e05e5bba252e63bd09fd85\\n';
        if (args.join(' ') === 'rev-parse 7d1c3822c8f8c8c6a970067580443a3b75e88bf0^{tree}') return 'a1ffd620d2b79630b9c1e9db700d6af765f33a50\\n';
        if (args.join(' ') === 'rev-parse HEAD^{tree}') return 'a'.repeat(40) + '\\n';
        if (args[0] === 'show' && args[1].endsWith(':apps/api/prisma-mysql/schema.prisma'))
          return args[1].startsWith('HEAD:') ? ${JSON.stringify(schemaAfter)} : ${JSON.stringify(schemaBefore)};
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
    process.stdout.write(String.fromCharCode(10) + JSON.stringify(calls));
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
        GUARD_TEST_BASE_TREE: baseTree,
        GUARD_TEST_PART: part,
        GUARD_TEST_PATHS: JSON.stringify(paths)
      }
    })
      .trim()
      .split('\n')
      .at(-1)
  );
}

test('finite prepare-fix guard keeps the first Node controls and runs every fresh dependency exactly once without business or database parts', () => {
  assertRetiredRegistration(() => {
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
  const calls = recordGuardCommands('recharge', [rechargeConnectionProfileMigration], 'migration');
  assert.equal(
    calls.filter((row) => row.includes('scripts/acceptance-v2-recharge-employee-concurrency.mjs'))
      .length,
    1
  );
  assert.ok(
    calls.every(
      (row) => !row.some((value) => /auto-registration|acceptance-v2-registration/.test(value))
    )
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
  for (const paths of [
    ['apps/api/src/id-business-v2/auto-registration/worker/workspace.py'],
    [
      'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
      'apps/api/src/id-business-v2/auto-recharge/bank-recharge-finance.service.ts'
    ]
  ]) {
    const calls = recordGuardCommands('recharge', paths, 'api');
    assert.ok(calls.some((row) => row.includes('src/id-business-v2/auto-recharge')));
    assert.ok(
      calls.every((row) => !row.some((value) => /auto-registration|registration.*\.py/.test(value)))
    );
  }
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
  const calls = recordGuardCommands(
    'recharge',
    ['apps/api/src/id-business-v2/auto-registration/worker/workspace.py'],
    'api'
  );
  assert.ok(
    calls.every((row) => !row.some((value) => /auto-registration|test_payment_browser/.test(value)))
  );
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
  assertRetiredRegistration(() => {
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
});

test('finite build-proof reuse keeps Node controls then helper tests, real CI build and all twenty-two controls once', () => {
  assertRetiredRegistration(() => {
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
    for (const command of [
      original[index],
      helperTest,
      realBuild,
      ...onlineBuildProofReuseCommands
    ])
      assert.throws(
        () =>
          recordGuardCommands('ci-only', paths, 'guards', {
            ...context,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
  });
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
  const calls = recordGuardCommands(
    'recharge',
    [
      'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
      'apps/api/src/id-business-v2/proxy-pool/proxy-test.ts',
      'scripts/acceptance-v2-registration-mirror-mysql.mjs',
      'scripts/acceptance-v2-shared-proxy-mysql.mjs'
    ],
    'migration',
    { cloud: true }
  );
  assert.equal(
    calls.filter((row) => row.includes('scripts/acceptance-v2-shared-proxy-mysql.mjs')).length,
    1
  );
  assert.ok(
    calls.every((row) => !row.includes('scripts/acceptance-v2-registration-mirror-mysql.mjs'))
  );
});

test('registration closure retains its pure worker regression in the API check', () => {
  const calls = recordGuardCommands(
    'recharge',
    ['apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py'],
    'api'
  );
  assert.ok(
    calls.every((row) => !row.some((value) => /auto-registration|registration.*\.py/.test(value)))
  );
});

test('registration native browser runs with its Python setup in the browser-equipped Admin job', () => {
  const calls = recordGuardCommands(
    'recharge',
    ['scripts/acceptance-v2-registration-native-ui.mjs'],
    'admin'
  );
  assert.ok(
    calls.every(
      (row) => !row.some((value) => /auto-registration|acceptance-v2-registration/.test(value))
    )
  );
});

test('registration publication controls run their own pure test once and keep every UI rule', () => {
  for (const part of ['guards', 'release-controls']) {
    const calls = recordGuardCommands(
      'recharge',
      [
        'scripts/production-release/registration-closure-release.py',
        'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue'
      ],
      part
    );
    assert.ok(
      calls.every(
        (row) => !row.some((value) => /production-release\/registration-.*\.py$/.test(value))
      )
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

test('terminal contract entry repair dispatches controls without rerunning unchanged persistence', () => {
  assertRetiredRegistration(() => {
    const options = {
      base: registrationTerminalStopRepairBase,
      terminalStopFixture: true,
      cloud: true
    };
    for (const part of registrationTerminalStopRepairParts)
      assert.deepEqual(
        recordGuardCommands('recharge', registrationTerminalStopRepairPaths, part, options),
        [...registrationTerminalStopCommands[part], ['process-exit', 0]]
      );
    for (const part of ['api', 'admin', 'connector'])
      assert.throws(
        () => recordGuardCommands('recharge', registrationTerminalStopRepairPaths, part, options),
        /Unsupported registration terminal stop control repair/
      );
  });
});
test('finite BitBrowser control checks retain immutable base and real guard commands', () => {
  const source = readFileSync(new URL('./ci-recharge-check.mjs', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('// BEGIN finite BitBrowser publication control checks'),
    source.indexOf('// END finite BitBrowser publication control checks')
  );
  assert.ok(block.includes('bitbrowserBillingControlTree'));
  assert.ok(!block.includes('rejectRetiredRegistrationExecution()'));
  assert.ok(source.includes('rejectRetiredRegistrationCommand(file, args)'));
  assert.ok(block.includes('bitbrowser-billing-release.test.py'));
  assert.ok(block.includes('bitbrowser-billing-build.py'));
  assert.ok(block.includes('format:check'));
  assert.ok(block.includes("npm('run', 'lint')"));
  assert.ok(block.includes("part !== 'guards'"));
  assert.ok(!block.includes('migrate deploy'));
});

test('finite recovery controls run real guards and closed release checks without business actions', () => {
  const options = {
    base: bitbrowserRecoverySourceReviewCommit,
    baseTree: bitbrowserRecoverySourceReviewTree
  };
  const calls = recordGuardCommands('ci-only', bitbrowserRecoveryControlPaths, 'guards', options);
  assert.deepEqual(calls, [
    ['npm', 'run', 'format:check'],
    ['npm', 'run', 'lint'],
    ...[
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ].map((name) => ['npm', 'run', name]),
    ['node', '--test', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-recharge-check.test.mjs'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-recovery-release.test.py'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-recovery-build.py', '--check'],
    ['process-exit', 0]
  ]);
  assert.deepEqual(
    recordGuardCommands('ci-only', bitbrowserRecoveryControlPaths, 'guards', {
      ...options,
      base: 'b'.repeat(40)
    }),
    calls
  );
  for (const part of [
    'api',
    'admin',
    'release-controls',
    'migration',
    'connector',
    'online-engine'
  ])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserRecoveryControlPaths, part, options),
      /Unsupported finite BitBrowser recovery control check/
    );
  assert.throws(
    () =>
      recordGuardCommands('ci-only', bitbrowserRecoveryControlPaths, 'guards', {
        ...options,
        failCommand: 'python3 -B scripts/production-release/bitbrowser-recovery-build.py --check'
      }),
    /SYNTHETIC_COMMAND_FAILURE/
  );
  for (const invalid of [
    { mode: 'full', paths: bitbrowserRecoveryControlPaths, options },
    {
      mode: 'ci-only',
      paths: bitbrowserRecoveryControlPaths,
      options: { ...options, baseTree: 'a'.repeat(40) }
    },
    { mode: 'ci-only', paths: bitbrowserRecoveryControlPaths.slice(1), options },
    {
      mode: 'ci-only',
      paths: [
        ...bitbrowserRecoveryControlPaths,
        'apps/api/src/id-business-v2/auto-recharge/recharge-resolution.ts'
      ],
      options
    }
  ]) {
    try {
      const fallback = recordGuardCommands(invalid.mode, invalid.paths, 'guards', invalid.options);
      assert.equal(
        fallback.some((row) =>
          row.includes('scripts/production-release/bitbrowser-recovery-build.py')
        ),
        false
      );
      assert.equal(
        fallback.some((row) =>
          row.includes('scripts/production-release/bitbrowser-recovery-release.test.py')
        ),
        false
      );
    } catch (error) {
      assert.match(String(error.stderr ?? error), /Automatic registration has been removed/);
    }
  }
});

test('finite recovery declaration control repair runs only reviewed release guards', () => {
  const options = {
    base: bitbrowserRecoveryControlRepairBase,
    baseTree: bitbrowserRecoveryControlRepairTree
  };
  const calls = recordGuardCommands(
    'ci-only',
    bitbrowserRecoveryControlRepairPaths,
    'guards',
    options
  );
  const original = recordGuardCommands('ci-only', bitbrowserRecoveryControlPaths, 'guards', {
    base: bitbrowserRecoverySourceReviewCommit,
    baseTree: bitbrowserRecoverySourceReviewTree
  });
  assert.deepEqual(calls, original);
  for (const part of [
    'api',
    'admin',
    'release-controls',
    'migration',
    'connector',
    'online-engine'
  ])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserRecoveryControlRepairPaths, part, options),
      /Unsupported finite BitBrowser recovery control check/
    );
  assert.throws(
    () =>
      recordGuardCommands('ci-only', bitbrowserRecoveryControlRepairPaths, 'guards', {
        ...options,
        failCommand: 'python3 -B scripts/production-release/bitbrowser-recovery-build.py --check'
      }),
    /SYNTHETIC_COMMAND_FAILURE/
  );
  for (const invalid of [
    { paths: bitbrowserRecoveryControlRepairPaths, options: { ...options, base: 'b'.repeat(40) } },
    {
      paths: bitbrowserRecoveryControlRepairPaths,
      options: { ...options, baseTree: bitbrowserRecoverySourceReviewTree }
    },
    { paths: bitbrowserRecoveryControlRepairPaths.slice(1), options },
    {
      paths: [
        ...bitbrowserRecoveryControlRepairPaths,
        '.github/workflows/bitbrowser-recovery-validation.yml'
      ],
      options
    },
    {
      paths: [
        ...bitbrowserRecoveryControlRepairPaths,
        'scripts/production-release/bitbrowser-recovery-dispatch.py'
      ],
      options
    },
    {
      paths: [
        ...bitbrowserRecoveryControlRepairPaths,
        'apps/api/src/id-business-v2/auto-recharge/recharge-cycle-ledger.ts'
      ],
      options
    }
  ]) {
    try {
      const fallback = recordGuardCommands('ci-only', invalid.paths, 'guards', invalid.options);
      assert.equal(
        fallback.some((row) =>
          row.includes('scripts/production-release/bitbrowser-recovery-build.py')
        ),
        false
      );
    } catch (error) {
      assert.match(String(error.stderr ?? error), /Automatic registration has been removed/);
    }
  }
});

test('finite history controls separate guards from closed release checks and propagate failure', () => {
  const options = {
    base: bitbrowserHistorySourceReviewCommit,
    baseTree: bitbrowserHistorySourceReviewTree
  };
  assert.deepEqual(
    recordGuardCommands('ci-only', bitbrowserHistoryControlPaths, 'guards', options),
    [
      ['npm', 'run', 'format:check'],
      ['npm', 'run', 'lint'],
      ...[
        'check:v2-module-architecture',
        'check:v2-isolation',
        'check:v2-concurrency-standard',
        'check:v2-prisma-runtime-boundary'
      ].map((name) => ['npm', 'run', name]),
      [
        'node',
        '--test',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs'
      ],
      ['process-exit', 0]
    ]
  );
  const releaseCommands = [
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-build.py', '--check']
  ];
  assert.deepEqual(
    recordGuardCommands('ci-only', bitbrowserHistoryControlPaths, 'release-controls', options),
    [...releaseCommands, ['process-exit', 0]]
  );
  assert.deepEqual(
    recordGuardCommands('ci-only', bitbrowserHistoryControlPaths, 'release-controls', {
      ...options,
      base: 'b'.repeat(40)
    }),
    [...releaseCommands, ['process-exit', 0]]
  );
  for (const part of ['api', 'admin', 'migration', 'connector', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserHistoryControlPaths, part, options),
      /Unsupported finite BitBrowser history control check/
    );
  for (const command of releaseCommands)
    assert.throws(
      () =>
        recordGuardCommands('ci-only', bitbrowserHistoryControlPaths, 'release-controls', {
          ...options,
          failCommand: command.join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  for (const invalid of [
    { mode: 'full', paths: bitbrowserHistoryControlPaths, options },
    {
      mode: 'ci-only',
      paths: bitbrowserHistoryControlPaths,
      options: { ...options, base: 'main' }
    },
    {
      mode: 'ci-only',
      paths: bitbrowserHistoryControlPaths,
      options: { ...options, baseTree: 'a'.repeat(40) }
    },
    ...bitbrowserHistoryControlPaths.map((missing) => ({
      mode: 'ci-only',
      paths: bitbrowserHistoryControlPaths.filter((name) => name !== missing),
      options
    })),
    {
      mode: 'ci-only',
      paths: [
        ...bitbrowserHistoryControlPaths,
        'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts'
      ],
      options
    }
  ]) {
    try {
      const fallback = recordGuardCommands(invalid.mode, invalid.paths, 'guards', invalid.options);
      for (const command of releaseCommands)
        assert.equal(
          fallback.some((row) => row.includes(command[2])),
          false
        );
    } catch (error) {
      assert.match(
        String(error.stderr ?? error),
        /Automatic registration has been removed|Missing diff base/
      );
    }
  }
});

import {
  bitbrowserFollowupControlPaths,
  bitbrowserFollowupSourceReviewCommit,
  bitbrowserFollowupSourceReviewTree
} from './ci-recharge-scope.mjs';

test('finite followup control runner requires frozen inputs and propagates every release failure', () => {
  const frozen = /^[a-f0-9]{40}$/.test(bitbrowserFollowupSourceReviewCommit);
  const options = {
    base: bitbrowserFollowupSourceReviewCommit,
    baseTree: bitbrowserFollowupSourceReviewTree
  };
  const releaseCommands = [
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'followup-20261019',
      '--check'
    ]
  ];
  if (frozen) {
    assert.deepEqual(
      recordGuardCommands('ci-only', bitbrowserFollowupControlPaths, 'release-controls', options),
      [...releaseCommands, ['process-exit', 0]]
    );
    const guards = recordGuardCommands(
      'ci-only',
      bitbrowserFollowupControlPaths,
      'guards',
      options
    );
    for (const name of [
      'format:check',
      'lint',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ])
      assert.ok(guards.some((row) => row.join(' ') === 'npm run ' + name));
    for (const command of releaseCommands)
      assert.throws(
        () =>
          recordGuardCommands('ci-only', bitbrowserFollowupControlPaths, 'release-controls', {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
    for (const part of ['api', 'admin', 'migration', 'online-engine'])
      assert.throws(
        () => recordGuardCommands('ci-only', bitbrowserFollowupControlPaths, part, options),
        /Unsupported finite BitBrowser followup control check/
      );
  }
  // Application source or a different source tree must never enter this control-only path.
  for (const invalid of [
    { paths: bitbrowserFollowupControlPaths, options: { ...options, baseTree: 'a'.repeat(40) } },
    {
      paths: [
        ...bitbrowserFollowupControlPaths,
        'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts'
      ],
      options
    },
    ...bitbrowserFollowupControlPaths.map((n) => ({
      paths: bitbrowserFollowupControlPaths.filter((p) => p !== n),
      options
    }))
  ]) {
    try {
      const commands = recordGuardCommands('ci-only', invalid.paths, 'guards', invalid.options);
      assert.equal(
        commands.some((row) => row.includes('followup-20261019')),
        false
      );
    } catch (error) {
      assert.doesNotMatch(String(error), /Unsupported finite BitBrowser followup control check/);
    }
  }
});

import {
  bitbrowserEntryStartControlPaths,
  bitbrowserEntryStartSourceReviewCommit,
  bitbrowserEntryStartSourceReviewTree
} from './ci-recharge-scope.mjs';

test('finite entry-start runner executes both closed control commands and retains failure propagation', () => {
  const options = {
    base: bitbrowserEntryStartSourceReviewCommit,
    baseTree: bitbrowserEntryStartSourceReviewTree
  };
  const commands = [
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'entry-start-20261019',
      '--check'
    ]
  ];
  assert.deepEqual(
    recordGuardCommands('ci-only', bitbrowserEntryStartControlPaths, 'release-controls', options),
    [...commands, ['process-exit', 0]]
  );
  const guards = recordGuardCommands(
    'ci-only',
    bitbrowserEntryStartControlPaths,
    'guards',
    options
  );
  for (const name of [
    'format:check',
    'lint',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-concurrency-standard',
    'check:v2-prisma-runtime-boundary'
  ])
    assert.ok(guards.some((row) => row.join(' ') === 'npm run ' + name));
  for (const command of commands)
    assert.throws(
      () =>
        recordGuardCommands('ci-only', bitbrowserEntryStartControlPaths, 'release-controls', {
          ...options,
          failCommand: command.join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  for (const part of ['api', 'admin', 'migration', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserEntryStartControlPaths, part, options),
      /Unsupported finite BitBrowser entry-start control check/
    );
});

import {
  bitbrowserExistingAddressControlPaths,
  bitbrowserExistingAddressSourceReviewCommit,
  bitbrowserExistingAddressSourceReviewTree
} from './ci-recharge-scope.mjs';

test('finite existing-address runner executes both closed control commands and retains failure propagation', () => {
  const options = {
    base: bitbrowserExistingAddressSourceReviewCommit,
    baseTree: bitbrowserExistingAddressSourceReviewTree
  };
  const commands = [
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'existing-address-field-20261019',
      '--check'
    ]
  ];
  assert.deepEqual(
    recordGuardCommands(
      'ci-only',
      bitbrowserExistingAddressControlPaths,
      'release-controls',
      options
    ),
    [...commands, ['process-exit', 0]]
  );
  const guards = recordGuardCommands(
    'ci-only',
    bitbrowserExistingAddressControlPaths,
    'guards',
    options
  );
  for (const name of [
    'format:check',
    'lint',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-concurrency-standard',
    'check:v2-prisma-runtime-boundary'
  ])
    assert.ok(guards.some((row) => row.join(' ') === 'npm run ' + name));
  for (const command of commands)
    assert.throws(
      () =>
        recordGuardCommands('ci-only', bitbrowserExistingAddressControlPaths, 'release-controls', {
          ...options,
          failCommand: command.join(' ')
        }),
      /SYNTHETIC_COMMAND_FAILURE/
    );
  for (const part of ['api', 'admin', 'migration', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserExistingAddressControlPaths, part, options),
      /Unsupported finite BitBrowser existing-address control check/
    );
});

import {
  bitbrowserBoundedHoldSourceStatus,
  bitbrowserBoundedHoldSourceBase,
  bitbrowserBoundedHoldSourceBaseTree,
  bitbrowserBoundedHoldSourcePaths,
  bitbrowserBoundedHoldCheckCommands
} from './ci-recharge-scope.mjs';

test('bounded payment source commands retain API, card-pool and online quota coverage without database or engine suites', () => {
  const api = bitbrowserBoundedHoldCheckCommands('api', bitbrowserBoundedHoldSourcePaths);
  const tests = api.find((row) => row.includes('test'));
  for (const path of [
    'src/id-business-v2/auto-recharge',
    'src/id-business-v2/bank-card-pool',
    'src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
    'src/id-business-v2/online-recharge/persistence/worker.card-capacity.spec.ts',
    'src/id-business-v2/online-recharge/persistence/worker-rpc.repository.spec.ts'
  ])
    assert.ok(tests.includes(path), path);
  for (const operation of ['prisma:mysql:generate', 'prisma:mysql:validate', 'typecheck', 'build'])
    assert.ok(
      api.some((row) => row.includes(operation)),
      operation
    );
  assert.ok(
    api.every((row) => !row.some((arg) => /migrate|financial|engine|acceptance:v2-/.test(arg)))
  );
  const guards = bitbrowserBoundedHoldCheckCommands('guards', bitbrowserBoundedHoldSourcePaths);
  for (const name of [
    'format:check',
    'lint',
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-decimal-standard',
    'check:v2-concurrency-standard',
    'check:v2-prisma-runtime-boundary'
  ])
    assert.ok(
      guards.some((row) => row.join(' ') === 'npm run ' + name),
      name
    );
  assert.ok(guards.some((row) => row.includes('scripts/ci-recharge-scope.test.mjs')));
  for (const part of ['migration', 'release-controls', 'online-engine'])
    assert.throws(
      () => bitbrowserBoundedHoldCheckCommands(part, bitbrowserBoundedHoldSourcePaths),
      /Unsupported bounded/
    );
});

test('bounded source runner remains fail closed while draft; frozen runner propagates every selected command failure', () => {
  const options = {
    base: bitbrowserBoundedHoldSourceBase,
    baseTree: bitbrowserBoundedHoldSourceBaseTree
  };
  for (const part of ['guards', 'api', 'admin']) {
    if (bitbrowserBoundedHoldSourceStatus !== 'FROZEN_SOURCE_PATHS') {
      assert.throws(
        () => recordGuardCommands('recharge', bitbrowserBoundedHoldSourcePaths, part, options),
        /Unfrozen or moved bounded/
      );
      continue;
    }
    const expected = bitbrowserBoundedHoldCheckCommands(part, bitbrowserBoundedHoldSourcePaths);
    assert.deepEqual(
      recordGuardCommands('recharge', bitbrowserBoundedHoldSourcePaths, part, options),
      [...expected, ['process-exit', 0]]
    );
    for (const command of expected)
      assert.throws(
        () =>
          recordGuardCommands('recharge', bitbrowserBoundedHoldSourcePaths, part, {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
    for (const schemaAfter of ['', 'model Synthetic { changed String @id }\n'])
      assert.throws(
        () =>
          recordGuardCommands('recharge', bitbrowserBoundedHoldSourcePaths, part, {
            ...options,
            schemaAfter
          }),
        /schema must remain byte identical/
      );
  }
});

import {
  bitbrowserBoundedHoldControlPaths,
  bitbrowserBoundedHoldControlContract,
  bitbrowserBoundedHoldSourceReviewCommit,
  bitbrowserBoundedHoldSourceReviewTree
} from './ci-recharge-scope.mjs';

test('bounded-hold control runner executes both finite parts without business commands and propagates failures', () => {
  const options = {
    base: bitbrowserBoundedHoldSourceReviewCommit,
    baseTree: bitbrowserBoundedHoldSourceReviewTree
  };
  const commands = [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'bounded-hold-20261019',
      '--check'
    ]
  ];
  for (const base of [options.base, 'b'.repeat(40)])
    assert.deepEqual(
      recordGuardCommands('ci-only', bitbrowserBoundedHoldControlPaths, 'release-controls', {
        ...options,
        base
      }),
      [...commands, ['process-exit', 0]]
    );
  const guards = recordGuardCommands(
    'ci-only',
    bitbrowserBoundedHoldControlPaths,
    'guards',
    options
  );
  const expectedGuards = [
    ...[
      'format:check',
      'lint',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ].map((name) => ['npm', 'run', name]),
    ['node', '--test', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-recharge-check.test.mjs']
  ];
  assert.deepEqual(guards, [...expectedGuards, ['process-exit', 0]]);
  for (const [part, selected] of [
    ['guards', expectedGuards],
    ['release-controls', commands]
  ])
    for (const command of selected)
      assert.throws(
        () =>
          recordGuardCommands('ci-only', bitbrowserBoundedHoldControlPaths, part, {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
  for (const part of ['api', 'admin', 'migration', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', bitbrowserBoundedHoldControlPaths, part, options),
      /Unsupported finite BitBrowser bounded-hold control check/
    );
});

test('bounded-hold control runner rejects moved, incomplete, extended and schema-changing control snapshots', () => {
  const options = {
    base: bitbrowserBoundedHoldSourceReviewCommit,
    baseTree: bitbrowserBoundedHoldSourceReviewTree
  };
  for (const part of ['guards', 'release-controls']) {
    for (const { paths, context } of [
      { paths: bitbrowserBoundedHoldControlPaths, context: { ...options, base: 'main' } },
      {
        paths: bitbrowserBoundedHoldControlPaths,
        context: { ...options, baseTree: 'a'.repeat(40) }
      },
      ...bitbrowserBoundedHoldControlPaths
        .filter((n) => n !== bitbrowserBoundedHoldControlContract)
        .map((missing) => ({
          paths: bitbrowserBoundedHoldControlPaths.filter((n) => n !== missing),
          context: options
        })),
      {
        paths: [...bitbrowserBoundedHoldControlPaths, bitbrowserBoundedHoldControlPaths[0]],
        context: options
      },
      ...[
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'scripts/production-release/bitbrowser-existing-address-contract.json'
      ].map((extra) => ({
        paths: [...bitbrowserBoundedHoldControlPaths, extra],
        context: options
      }))
    ])
      assert.throws(
        () => recordGuardCommands('ci-only', paths, part, context),
        /Unfrozen or moved bounded BitBrowser control scope/
      );
    for (const schemaAfter of ['', 'model Changed { id String @id }\n'])
      assert.throws(
        () =>
          recordGuardCommands('ci-only', bitbrowserBoundedHoldControlPaths, part, {
            ...options,
            schemaAfter
          }),
        /control schema must remain byte identical/
      );
  }
});

import {
  bitbrowserBoundedHoldMysqlRepairStatus,
  bitbrowserBoundedHoldMysqlRepairBase,
  bitbrowserBoundedHoldMysqlRepairTree,
  bitbrowserBoundedHoldMysqlRepairSpec,
  bitbrowserBoundedHoldMysqlRepairPaths,
  bitbrowserBoundedHoldMysqlRepairCommands
} from './ci-recharge-scope.mjs';

test('bounded MySQL repair runner installs control dependencies first and propagates both parts failures', () => {
  const options = {
    base: bitbrowserBoundedHoldMysqlRepairBase,
    baseTree: bitbrowserBoundedHoldMysqlRepairTree
  };
  assert.deepEqual(bitbrowserBoundedHoldMysqlRepairCommands('release-controls'), [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'bounded-hold-20261019',
      '--check'
    ]
  ]);
  for (const part of ['guards', 'release-controls']) {
    if (bitbrowserBoundedHoldMysqlRepairStatus !== 'FROZEN_MYSQL_REPAIR') {
      assert.throws(
        () => recordGuardCommands('ci-only', bitbrowserBoundedHoldMysqlRepairPaths, part, options),
        /Unfrozen or moved bounded BitBrowser MySQL repair scope/
      );
      continue;
    }
    const expected = bitbrowserBoundedHoldMysqlRepairCommands(part);
    assert.deepEqual(
      recordGuardCommands('ci-only', bitbrowserBoundedHoldMysqlRepairPaths, part, options),
      [...expected, ['process-exit', 0]]
    );
    for (const command of expected)
      assert.throws(
        () =>
          recordGuardCommands('ci-only', bitbrowserBoundedHoldMysqlRepairPaths, part, {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
  }
  if (bitbrowserBoundedHoldMysqlRepairStatus === 'FROZEN_MYSQL_REPAIR')
    for (const part of ['api', 'admin', 'migration', 'online-engine'])
      assert.throws(
        () => recordGuardCommands('ci-only', bitbrowserBoundedHoldMysqlRepairPaths, part, options),
        /Unsupported finite BitBrowser bounded-hold MySQL repair control check/
      );
});

test('bounded MySQL repair runner rejects base tree path and schema drift without executing business checks', () => {
  const options = {
    base: bitbrowserBoundedHoldMysqlRepairBase,
    baseTree: bitbrowserBoundedHoldMysqlRepairTree
  };
  for (const part of ['guards', 'release-controls']) {
    for (const { paths, context } of [
      { paths: bitbrowserBoundedHoldMysqlRepairPaths, context: { ...options, base: 'main' } },
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        context: { ...options, base: 'b'.repeat(40) }
      },
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        context: { ...options, baseTree: 'a'.repeat(40) }
      },
      ...bitbrowserBoundedHoldMysqlRepairPaths.map((missing) => ({
        paths: bitbrowserBoundedHoldMysqlRepairPaths.filter((n) => n !== missing),
        context: options
      })),
      {
        paths: [...bitbrowserBoundedHoldMysqlRepairPaths, bitbrowserBoundedHoldMysqlRepairSpec],
        context: options
      },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-dispatch.py',
        'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts'
      ].map((extra) => ({
        paths: [...bitbrowserBoundedHoldMysqlRepairPaths, extra],
        context: options
      }))
    ])
      assert.throws(
        () => recordGuardCommands('ci-only', paths, part, context),
        /Unfrozen or moved bounded BitBrowser (MySQL repair|control) scope/
      );
    if (bitbrowserBoundedHoldMysqlRepairStatus === 'FROZEN_MYSQL_REPAIR')
      for (const schemaAfter of ['', 'model Changed { id String @id }\n'])
        assert.throws(
          () =>
            recordGuardCommands('ci-only', bitbrowserBoundedHoldMysqlRepairPaths, part, {
              ...options,
              schemaAfter
            }),
          /MySQL repair schema must remain byte identical/
        );
  }
});

import {
  bitbrowserBoundedHoldNativeDeclarationsBase,
  bitbrowserBoundedHoldNativeDeclarationsTree,
  bitbrowserBoundedHoldNativeDeclarationsPaths,
  bitbrowserBoundedHoldNativeDeclarationsCommands
} from './ci-recharge-scope.mjs';

test('native declaration runner installs control dependencies first and propagates failures for both finite parts', () => {
  const options = {
    base: bitbrowserBoundedHoldNativeDeclarationsBase,
    baseTree: bitbrowserBoundedHoldNativeDeclarationsTree
  };
  const paths = bitbrowserBoundedHoldNativeDeclarationsPaths;
  assert.deepEqual(bitbrowserBoundedHoldNativeDeclarationsCommands('release-controls'), [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'bounded-hold-20261019',
      '--check'
    ]
  ]);
  assert.deepEqual(bitbrowserBoundedHoldNativeDeclarationsCommands('guards'), [
    ...[
      'format:check',
      'lint',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ].map((name) => ['npm', 'run', name]),
    ['node', '--test', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-recharge-check.test.mjs']
  ]);
  for (const part of ['guards', 'release-controls']) {
    const commands = bitbrowserBoundedHoldNativeDeclarationsCommands(part);
    assert.deepEqual(recordGuardCommands('ci-only', paths, part, options), [
      ...commands,
      ['process-exit', 0]
    ]);
    for (const command of commands)
      assert.throws(
        () =>
          recordGuardCommands('ci-only', paths, part, {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
  }
  for (const part of ['api', 'admin', 'migration', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', paths, part, options),
      /Unsupported finite BitBrowser native-declarations control check/
    );
});

test('native declaration runner rejects every missing extra duplicate moved and schema-changing snapshot', () => {
  const options = {
    base: bitbrowserBoundedHoldNativeDeclarationsBase,
    baseTree: bitbrowserBoundedHoldNativeDeclarationsTree
  };
  const paths = bitbrowserBoundedHoldNativeDeclarationsPaths;
  for (const part of ['guards', 'release-controls']) {
    for (const invalid of [
      { paths, context: { ...options, base: 'main' } },
      { paths, context: { ...options, base: 'b'.repeat(40) } },
      { paths, context: { ...options, baseTree: 'a'.repeat(40) } },
      ...paths.map((missing) => ({
        paths: paths.filter((name) => name !== missing),
        context: options
      })),
      { paths: [...paths, paths[0]], context: options },
      { paths: [...paths.slice(1), paths[1]], context: options },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-build.py',
        'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts'
      ].map((extra) => ({ paths: [...paths, extra], context: options }))
    ])
      assert.throws(
        () => recordGuardCommands('ci-only', invalid.paths, part, invalid.context),
        /Unfrozen or moved bounded BitBrowser .*scope/
      );
    for (const schemaAfter of ['', 'model Changed { id String @id }\n'])
      assert.throws(
        () => recordGuardCommands('ci-only', paths, part, { ...options, schemaAfter }),
        /native-declarations schema must remain byte identical/
      );
  }
});

import {
  bitbrowserBoundedHoldSelectedNativeBase,
  bitbrowserBoundedHoldSelectedNativeTree,
  bitbrowserBoundedHoldSelectedNativePaths,
  bitbrowserBoundedHoldSelectedNativeCommands
} from './ci-recharge-scope.mjs';

test('selected native runner installs control dependencies first and propagates failures for both finite parts', () => {
  const options = {
    base: bitbrowserBoundedHoldSelectedNativeBase,
    baseTree: bitbrowserBoundedHoldSelectedNativeTree
  };
  const paths = bitbrowserBoundedHoldSelectedNativePaths;
  assert.deepEqual(bitbrowserBoundedHoldSelectedNativeCommands('release-controls'), [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['python3', '-B', 'scripts/production-release/bitbrowser-history-release.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/bitbrowser-history-build.py',
      '--recipe',
      'bounded-hold-20261019',
      '--check'
    ]
  ]);
  assert.deepEqual(bitbrowserBoundedHoldSelectedNativeCommands('guards'), [
    ...[
      'format:check',
      'lint',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ].map((name) => ['npm', 'run', name]),
    ['node', '--test', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-recharge-check.test.mjs']
  ]);
  for (const part of ['guards', 'release-controls']) {
    const commands = bitbrowserBoundedHoldSelectedNativeCommands(part);
    assert.deepEqual(recordGuardCommands('ci-only', paths, part, options), [
      ...commands,
      ['process-exit', 0]
    ]);
    for (const command of commands)
      assert.throws(
        () =>
          recordGuardCommands('ci-only', paths, part, {
            ...options,
            failCommand: command.join(' ')
          }),
        /SYNTHETIC_COMMAND_FAILURE/
      );
  }
  for (const part of ['api', 'admin', 'migration', 'online-engine'])
    assert.throws(
      () => recordGuardCommands('ci-only', paths, part, options),
      /Unsupported finite BitBrowser selected-native control check/
    );
});

test('selected native runner rejects every missing extra duplicate moved and schema-changing snapshot', () => {
  const options = {
    base: bitbrowserBoundedHoldSelectedNativeBase,
    baseTree: bitbrowserBoundedHoldSelectedNativeTree
  };
  const paths = bitbrowserBoundedHoldSelectedNativePaths;
  for (const part of ['guards', 'release-controls']) {
    for (const invalid of [
      { paths, context: { ...options, base: 'main' } },
      { paths, context: { ...options, base: 'b'.repeat(40) } },
      { paths, context: { ...options, baseTree: 'a'.repeat(40) } },
      ...paths.map((missing) => ({
        paths: paths.filter((name) => name !== missing),
        context: options
      })),
      { paths: [...paths, paths[0]], context: options },
      { paths: [...paths.slice(1), paths[1]], context: options },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-dispatch.py',
        'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts'
      ].map((extra) => ({ paths: [...paths, extra], context: options }))
    ])
      assert.throws(
        () => recordGuardCommands('ci-only', invalid.paths, part, invalid.context),
        /Unfrozen or moved bounded BitBrowser .*scope/
      );
    for (const schemaAfter of ['', 'model Changed { id String @id }\n'])
      assert.throws(
        () => recordGuardCommands('ci-only', paths, part, { ...options, schemaAfter }),
        /selected-native schema must remain byte identical/
      );
  }
});

test('mailbox fixture repairs retain their actual component tests without rerunning unrelated production workers', () => {
  const fixtures = [
    'scripts/production-release/online-recharge-component-diagnostic.test.py',
    'scripts/production-release/online-recharge-component-recovery.test.py'
  ];
  const paths = [
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    ...fixtures
  ];
  const commands = recordGuardCommands('mailbox', paths);
  for (const name of [
    ...fixtures,
    'scripts/production-release/online-recharge-component-recovery-readonly.test.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py'
  ])
    assert.ok(
      commands.some((row) => row.includes(name)),
      name
    );
  assert.equal(
    commands.some((row) => row.includes('test:online-recharge:controls')),
    false
  );
  const engine = recordGuardCommands('mailbox', [
    ...paths,
    'apps/api/src/id-business-v2/online-recharge/engine/healthcheck.cjs'
  ]);
  assert.ok(engine.some((row) => row.includes('test:online-recharge:controls')));
  assert.ok(
    engine.some((row) => row.includes('scripts/production-release/online-recharge-scope.test.py'))
  );
});

test('finite mailbox publisher checks retain native guards without selecting a different historical ONLINE publisher', () => {
  const paths = [
    '.github/workflows/mail-query-publication.yml',
    ...['build.py', 'publication.py', 'release.py', 'release.test.py', 'contract.json'].map(
      (name) => 'scripts/production-release/mail-query-' + name
    ),
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs'
  ];
  const commands = recordGuardCommands('ci-only', paths);
  assert.ok(
    commands.some((row) => row.includes('scripts/production-release/mail-query-release.test.py'))
  );
  assert.ok(
    commands.some((row) => row.includes('scripts/production-release/api-admin-scope.test.py'))
  );
  assert.ok(
    commands.some((row) => row.includes('scripts/production-release/remote-deploy.test.py'))
  );
  assert.equal(
    commands.some((row) =>
      row.includes('scripts/production-release/online-recharge-scope.test.py')
    ),
    false
  );
  const mixed = recordGuardCommands('ci-only', [
    ...paths,
    'apps/api/src/id-business-v2/online-recharge/engine/healthcheck.cjs'
  ]);
  assert.ok(
    mixed.some((row) => row.includes('scripts/production-release/online-recharge-scope.test.py'))
  );
});
