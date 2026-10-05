import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function fixture(run) {
  mkdirSync('.deploy', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.deploy/release-scope-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'docker.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\ncat "$TASK_CHANGED_PATHS"\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_DOCKER_LOG"\nif [ "$1" = login ]; then cat >/dev/null; fi\nif [ "$1" = image ]; then printf "%s\\n" "$RELEASE_COMMIT"; fi\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'aws'),
    '#!/bin/sh\ncase "$*" in\n*get-login-password*) printf "test-fixture-only\\n" ;;\n*describe-images*) printf "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;;\nesac\n',
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    EXPECTED_CURRENT: 'a'.repeat(40),
    RELEASE_COMMIT: 'b'.repeat(40),
    RELEASE_REPOSITORY: '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
    GITHUB_RUN_ID: '999999',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ENV: join(root, 'github.env'),
    TASK_CHANGED_PATHS: join(root, 'changed.txt'),
    TASK_DOCKER_LOG: log,
    AWS_REGION: 'ap-northeast-1'
  };
  try {
    run({ root, env, log });
  } finally {
    rmSync(root, { recursive: true });
  }
}

function guardCommands(paths, { failHistory = false, failMaintenance = false } = {}) {
  let commands;
  fixture(({ root, env }) => {
    const log = join(root, 'guard-commands.txt');
    writeFileSync(log, '');
    writeFileSync(env.TASK_CHANGED_PATHS, paths.join('\n'));
    for (const file of ['npm', 'node', 'python3'])
      writeFileSync(
        join(root, 'bin', file),
        `#!/bin/sh\nprintf "%s\\n" "${file} $*" >> "$TASK_GUARD_LOG"\n${
          file === 'node'
            ? 'if [ "$TASK_FAIL_HISTORY" = true ] && [ "$*" = "--test scripts/v2-release-history-policy.test.mjs" ]; then exit 23; fi\nif [ "$TASK_FAIL_MAINTENANCE" = true ] && [ "$*" = "--test scripts/v2-release-maintenance-policy.test.mjs" ]; then exit 24; fi\n'
            : ''
        }`,
        { mode: 0o755 }
      );
    execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts/ci-recharge-check.mjs'), 'guards', 'a'.repeat(40)],
      {
        cwd: root,
        env: {
          ...env,
          CHECK_MODE: 'ci-only',
          TASK_GUARD_LOG: log,
          TASK_FAIL_HISTORY: String(failHistory),
          TASK_FAIL_MAINTENANCE: String(failMaintenance)
        },
        stdio: 'pipe'
      }
    );
    commands = readFileSync(log, 'utf8').trim().split('\n');
  });
  return commands;
}

function dispatchFixture(historyPolicy, current, run, extraEnv = {}) {
  fixture(({ root, env }) => {
    const awsLog = join(root, 'dispatch-aws.txt');
    const parametersFile = join(root, '.deploy/production-release/ssm-999999.json');
    writeFileSync(awsLog, '');
    writeFileSync(
      join(root, 'bin', 'aws'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_DISPATCH_AWS_LOG"\ncase "$*" in\n*send-command*) printf "fixture-command\\n" ;;\n*--query\\ Status*) printf "Success\\n" ;;\n*StandardOutputContent*) printf "fixture-receipt\\n" ;;\nesac\n',
      { mode: 0o755 }
    );
    const execute = () =>
      execFileSync('bash', [join(process.cwd(), 'scripts/production-release/dispatch.sh')], {
        cwd: root,
        env: {
          ...env,
          HISTORICAL_EXCEPTION: historyPolicy,
          EXPECTED_CURRENT: current,
          RELEASE_ADMIN_ONLY: 'false',
          SOURCE_TREE: 'c'.repeat(40),
          QUALITY_RUN_ID: '111',
          PRODUCTION_INSTANCE_ID: 'i-test-fixture-only',
          TASK_DISPATCH_AWS_LOG: awsLog,
          ...extraEnv
        },
        stdio: 'pipe'
      });
    run({ execute, parametersFile, awsLog });
  });
}

test('actual CI guards run historical tests for each exact control path, including deleted files', () => {
  for (const path of [
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json',
    'deploy/aws/historical-finance-20261005-maintenance-continuation.json',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    'scripts/lib/v2-release-maintenance-policy.mjs',
    'scripts/v2-release-maintenance-audit.mjs',
    'scripts/v2-release-maintenance-policy.test.mjs'
  ]) {
    const commands = guardCommands([path]);
    assert.equal(
      commands.filter(
        (command) => command === 'node --test scripts/v2-release-history-policy.test.mjs'
      ).length,
      1,
      path
    );
    assert.equal(
      commands.filter(
        (command) => command === 'node --test scripts/v2-release-maintenance-policy.test.mjs'
      ).length,
      1,
      path
    );
    assert.ok(commands.some((command) => command.includes('scripts/ci-recharge-release.test.mjs')));
    assert.equal(
      commands.some((command) => command.startsWith('npm ')),
      false
    );
    assert.equal(
      commands.some((command) => command.startsWith('python3 ')),
      false
    );
  }
});

test('historical CI selection preserves existing deployment and cache control checks', () => {
  const commands = guardCommands([
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json',
    'deploy/aws/historical-finance-20261005-maintenance-continuation.json',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/cleanup-reviewed-cache.py',
    'scripts/production-release/cleanup-verified-backups.py',
    'scripts/production-release/storage-maintenance.py'
  ]);
  for (const command of [
    'node --test scripts/v2-release-history-policy.test.mjs',
    'node --test scripts/v2-release-maintenance-policy.test.mjs',
    'python3 -B scripts/production-release/remote-deploy.test.py',
    'python3 -B scripts/production-release/maintain-image-cache.test.py',
    'python3 -B scripts/production-release/cleanup-reviewed-cache.test.py',
    'python3 -B scripts/production-release/cleanup-verified-backups.test.py',
    'python3 -B scripts/production-release/storage-maintenance.test.py'
  ])
    assert.equal(commands.filter((actual) => actual === command).length, 1, command);
  assert.equal(
    commands.some((command) => command.startsWith('npm ')),
    false
  );
});

test('historical CI test selection is exact and a rejected historical test stops the guard', () => {
  for (const path of [
    'docs/V2_TASKS.md',
    'deploy/aws/historical-finance-20261005.json',
    'deploy/aws/historical-finance-unreviewed.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics-other.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json.backup',
    'deploy/aws/historical-finance-20261005-maintenance-continuation.json.backup',
    'scripts/v2-release-history-audit-other.mjs',
    'scripts/lib/v2-data-integrity-audit.mjs'
  ])
    assert.equal(
      guardCommands([path]).includes('node --test scripts/v2-release-history-policy.test.mjs'),
      false,
      path
    );
  assert.throws(
    () => guardCommands(['scripts/lib/v2-release-history-policy.mjs'], { failHistory: true }),
    (error) =>
      error.status === 1 &&
      String(error.stderr).includes(
        'Command failed: node --test scripts/v2-release-history-policy.test.mjs'
      )
  );
});

test('real build and push scripts select only admin for frontend plus release-control changes', () => {
  fixture(({ env, log }) => {
    writeFileSync(
      env.TASK_CHANGED_PATHS,
      [
        'apps/admin/src/v2/components/workspace/V2QuickActions.vue',
        'scripts/production-release/build-images.sh',
        'scripts/production-release/remote-deploy.py',
        'docs/V2_TASKS.md'
      ].join('\n')
    );
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env });
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=true\n');
    const built = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('build '));
    assert.equal(built.length, 1);
    assert.ok(built[0].includes('apps/admin/Dockerfile'));
    execFileSync('bash', ['scripts/production-release/push-images.sh'], {
      env: { ...env, RELEASE_ADMIN_ONLY: 'true' }
    });
    const pushed = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('push '));
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0].endsWith('-admin'));
  });
});

test('dependency, API, shared, schema and authentication changes retain all image builds', () => {
  for (const path of [
    'package-lock.json',
    'apps/api/src/id-business-v2/orders/service.ts',
    'packages/shared/src/index.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/auth/login.ts'
  ]) {
    fixture(({ env, log }) => {
      writeFileSync(env.TASK_CHANGED_PATHS, path);
      execFileSync('bash', ['scripts/production-release/build-images.sh'], { env });
      assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
      assert.equal(
        readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('build ')).length,
        5
      );
    });
  }
});

test('full push mode retains all five images and rejects an unknown scope flag', () => {
  fixture(({ env, log }) => {
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env });
    assert.equal(
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('push ')).length,
      5
    );
    assert.throws(() =>
      execFileSync('bash', ['scripts/production-release/push-images.sh'], {
        env: { ...env, RELEASE_ADMIN_ONLY: 'unexpected' },
        stdio: 'pipe'
      })
    );
  });
});

test('recovery dispatch keeps deployment run and reused image run separate', () => {
  fixture(({ root, env }) => {
    writeFileSync(
      join(root, 'bin', 'aws'),
      '#!/bin/sh\ncase "$*" in\n*send-command*) printf "fixture-command\\n" ;;\n*--query\\ Status*) printf "Success\\n" ;;\n*StandardOutputContent*) printf "fixture-receipt\\n" ;;\nesac\n',
      { mode: 0o755 }
    );
    execFileSync('bash', [join(process.cwd(), 'scripts/production-release/dispatch.sh')], {
      cwd: root,
      env: {
        ...env,
        SOURCE_TREE: 'c'.repeat(40),
        QUALITY_RUN_ID: '111',
        PRODUCTION_INSTANCE_ID: 'i-test-fixture-only',
        REUSE_IMAGE_COMMIT: 'd'.repeat(40),
        REUSE_IMAGE_RUN_ID: '222',
        REUSE_IMAGE_RUN_ATTEMPT: '1'
      }
    });
    const parameters = JSON.parse(
      readFileSync(join(root, '.deploy/production-release/ssm-999999.json'), 'utf8')
    );
    const command = parameters.commands.at(-1);
    assert.ok(command.includes(`--commit ${'b'.repeat(40)}`));
    assert.ok(command.includes('--run-id 999999'));
    assert.ok(command.includes(`--image-commit ${'d'.repeat(40)}`));
    assert.ok(command.includes('--image-run-id 222 --image-run-attempt 1'));
  });
});

test('real historical dispatch selects only the flag approved for its exact baseline', () => {
  for (const [policy, current, selected, rejected] of [
    [
      'historical-finance-20261005-maintenance-continuation',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
      '--historical-finance-maintenance-continuation',
      '--historical-finance-recharge-diagnostics'
    ],
    [
      'historical-finance-20261005-recharge-diagnostics',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
      '--historical-finance-recharge-diagnostics',
      '--historical-finance-continuation'
    ],
    [
      'historical-finance-20261005-registration-continuation',
      'd0f359dc78b2d2b166893bfec8545609f5baa16d',
      '--historical-finance-continuation',
      '--historical-finance-exception'
    ],
    [
      'historical-finance-20261005',
      'ed2f75b0f4075347224ce3b2c82a90ed514d8d22',
      '--historical-finance-exception',
      '--historical-finance-continuation'
    ]
  ])
    dispatchFixture(policy, current, ({ execute, parametersFile, awsLog }) => {
      execute();
      const parameters = JSON.parse(readFileSync(parametersFile, 'utf8'));
      const args = parameters.commands.at(-1).split(' ');
      assert.equal(args.filter((arg) => arg === selected).length, 1, policy);
      assert.equal(args.includes(rejected), false, policy);
      assert.equal(
        args.filter((arg) =>
          [
            '--historical-finance-exception',
            '--historical-finance-continuation',
            '--historical-finance-recharge-diagnostics',
            '--historical-finance-maintenance-continuation'
          ].includes(arg)
        ).length,
        1,
        policy
      );
      assert.equal(
        readFileSync(awsLog, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('ssm send-command ')).length,
        1,
        policy
      );
    });
});

test('real historical dispatch rejects reused or wrong baselines before parameters and AWS', () => {
  for (const [policy, current] of [
    ['historical-finance-20261005-maintenance-continuation', 'f'.repeat(40)],
    [
      'historical-finance-20261005-maintenance-continuation',
      'd0f359dc78b2d2b166893bfec8545609f5baa16d'
    ],
    [
      'historical-finance-20261005-maintenance-continuation --historical-finance-recharge-diagnostics',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
    ],
    ['historical-finance-20261005-recharge-diagnostics', 'f'.repeat(40)],
    [
      'historical-finance-20261005-recharge-diagnostics',
      'd0f359dc78b2d2b166893bfec8545609f5baa16d'
    ],
    [
      'historical-finance-20261005-recharge-diagnostics',
      'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
    ],
    ['historical-finance-unreviewed', '6a82a774f2a65e00d4f260c629f7152bf7935d1d'],
    [
      'historical-finance-20261005-recharge-diagnostics --historical-finance-continuation',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
    ],
    [
      'historical-finance-20261005-registration-continuation',
      'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
    ],
    ['historical-finance-20261005-registration-continuation', 'f'.repeat(40)],
    ['historical-finance-20261005', 'd0f359dc78b2d2b166893bfec8545609f5baa16d']
  ])
    dispatchFixture(policy, current, ({ execute, parametersFile, awsLog }) => {
      assert.throws(
        execute,
        (error) => error.status === 1 && String(error.stderr).includes('AssertionError')
      );
      assert.equal(existsSync(parametersFile), false, `${policy}: parameters generated`);
      assert.equal(readFileSync(awsLog, 'utf8'), '', `${policy}: AWS called`);
    });
});

test('worker CI runs card setup, full upgrade and registration browser regression modules', () => {
  fixture(({ root, env }) => {
    const log = join(root, 'worker-arguments.txt');
    writeFileSync(
      env.TASK_CHANGED_PATHS,
      'apps/api/src/id-business-v2/auto-recharge/worker/pay.py'
    );
    writeFileSync(
      join(root, 'bin', 'python3'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$TASK_WORKER_LOG"\n',
      { mode: 0o755 }
    );
    execFileSync(process.execPath, ['scripts/ci-recharge-check.mjs', 'connector', 'a'.repeat(40)], {
      env: { ...env, TASK_WORKER_LOG: log }
    });
    const args = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 2), ['-m', 'unittest']);
    for (const name of [
      'test_subscription_upgrade',
      'test_upgrade_card_selection',
      'test_upgrade_card_flow',
      'test_registration_browser',
      'test_registration_builtin',
      'test_worker_isolation',
      'test_registration_auto_code',
      'test_payment_3ds',
      'test_payment_handoff',
      'test_recharge_email_code',
      'test_subscribe',
      'test_payment.StateTests',
      'test_go.GoStateTests'
    ]) {
      assert.equal(args.filter((arg) => arg === name).length, 1, name);
    }
  });
});

test('changed recharge mail bridge is exercised by the API CI command', () => {
  fixture(({ root, env }) => {
    const log = join(root, 'npm-arguments.txt');
    writeFileSync(
      env.TASK_CHANGED_PATHS,
      'apps/api/src/id-business-v2/workspace/recharge-mail-code.service.ts'
    );
    writeFileSync(join(root, 'bin', 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_NPM_LOG"\n', {
      mode: 0o755
    });
    execFileSync(process.execPath, ['scripts/ci-recharge-check.mjs', 'api', 'a'.repeat(40)], {
      env: { ...env, CHECK_MODE: 'recharge', TASK_NPM_LOG: log }
    });
    const command = readFileSync(log, 'utf8')
      .split('\n')
      .find((line) => line.includes('test --workspace'));
    assert.ok(command.includes('src/id-business-v2/auto-recharge'));
    assert.ok(command.includes('src/id-business-v2/workspace/recharge-mail-code.spec.ts'));
    assert.ok(
      command.includes(
        'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts'
      )
    );
  });
});

test('diagnostics dispatch refuses admin-only and image reuse before parameters and AWS', () => {
  for (const extraEnv of [
    { RELEASE_ADMIN_ONLY: 'true' },
    { REUSE_IMAGE_COMMIT: 'd'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '222' },
    { REUSE_IMAGE_RUN_ATTEMPT: '2' }
  ])
    dispatchFixture(
      'historical-finance-20261005-recharge-diagnostics',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(
          execute,
          (error) => error.status === 1 && String(error.stderr).includes('AssertionError')
        );
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      extraEnv
    );
});

test('a rejected maintenance proof test stops actual CI guards', () => {
  assert.throws(
    () =>
      guardCommands(['deploy/aws/historical-finance-20261005-maintenance-continuation.json'], {
        failMaintenance: true
      }),
    (error) =>
      error.status === 1 &&
      String(error.stderr).includes(
        'Command failed: node --test scripts/v2-release-maintenance-policy.test.mjs'
      )
  );
});

test('maintenance dispatch refuses partial publication and reused images before AWS', () => {
  for (const extraEnv of [
    { RELEASE_ADMIN_ONLY: 'true' },
    { REUSE_IMAGE_COMMIT: 'd'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '222' },
    { REUSE_IMAGE_RUN_ATTEMPT: '2' }
  ]) {
    dispatchFixture(
      'historical-finance-20261005-maintenance-continuation',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(
          execute,
          (error) => error.status === 1 && String(error.stderr).includes('AssertionError')
        );
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      extraEnv
    );
  }
});

test('full Quality Gate includes the release guards alongside unchanged business checks', () => {
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  const full = workflow.slice(workflow.indexOf('  full-quality:'), workflow.indexOf('  recharge:'));
  assert.ok(full.includes('name: Verify changed release controls'));
  assert.ok(full.includes('CHECK_BASE: ${{ needs.change-scope.outputs.base }}'));
  assert.ok(full.includes('CHECK_MODE: ci-only'));
  assert.ok(full.includes('run: node scripts/ci-recharge-check.mjs guards "$CHECK_BASE"'));
  for (const command of [
    'npm run typecheck',
    'npm run test',
    'npm run build',
    'npm run acceptance:v2-data-governance',
    'npm run acceptance:v2-financial-integrity',
    'npm run acceptance:v2-rollback-integrity'
  ])
    assert.ok(full.includes(command), command);
});
