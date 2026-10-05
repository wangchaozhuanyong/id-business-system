import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { isCiOnly } from './ci-recharge-scope.mjs';

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
    const execute = (overrides = {}) =>
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
          ...extraEnv,
          ...overrides
        },
        stdio: 'pipe'
      });
    run({ execute, parametersFile, awsLog, root, env });
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

test('mailbox release dispatch pins its independent approval and immutable existing build', () => {
  const image = {
    REUSE_IMAGE_COMMIT: 'f5826f9fb4ad0d846d9875c035c913a61eb68290',
    REUSE_IMAGE_RUN_ID: '37312405714',
    REUSE_IMAGE_RUN_ATTEMPT: '1'
  };
  dispatchFixture(
    'historical-finance-20261005-mailbox-batch',
    'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
    ({ execute, parametersFile }) => {
      execute();
      const command = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1);
      assert.ok(command.includes('--historical-finance-mailbox-batch'));
      assert.ok(command.includes('--image-run-id 37312405714'));
      assert.ok(command.includes('--image-commit ' + image.REUSE_IMAGE_COMMIT));
      assert.equal(command.includes('--historical-finance-maintenance-continuation'), false);
    },
    image
  );
  for (const changed of [
    { REUSE_IMAGE_RUN_ID: '123' },
    { REUSE_IMAGE_RUN_ATTEMPT: '2' },
    { REUSE_IMAGE_COMMIT: 'a'.repeat(40) },
    { RELEASE_ADMIN_ONLY: 'true' },
    { EXPECTED_CURRENT: 'a'.repeat(40) }
  ])
    dispatchFixture(
      'historical-finance-20261005-mailbox-batch',
      'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(execute);
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      { ...image, ...changed }
    );
});

test('mailbox audit, approval and tests remain control-only and always invoke the gate tests', () => {
  for (const path of [
    'scripts/v2-release-mailbox-audit.mjs',
    'scripts/v2-release-mailbox-audit.test.mjs',
    'deploy/aws/historical-finance-20261005-mailbox-batch.json'
  ]) {
    assert.equal(isCiOnly([path]), true);
    assert.ok(
      guardCommands([path]).includes('node --test scripts/v2-release-mailbox-audit.test.mjs')
    );
  }
});

function approvedRuntimeTransport(root, env, reject = false) {
  const interpreter = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8'
  }).trim();
  writeFileSync(
    join(root, 'bin', 'python3'),
    `#!/bin/sh\nif [ "$2" = --check-fixed-recharge-scope ]; then\n  printf '%s\\n' checked >> "$TASK_PROFILE_CHECK_LOG"\n  exit ${reject ? 31 : 0}\nfi\nexec "$TASK_REAL_PYTHON" "$@"\n`,
    { mode: 0o755 }
  );
  return {
    ...env,
    HISTORICAL_EXCEPTION: 'recharge-pro-menu-b8-20261005',
    EXPECTED_CURRENT: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
    TASK_REAL_PYTHON: interpreter,
    TASK_PROFILE_CHECK_LOG: join(root, 'profile-check.log')
  };
}

test('fixed b8 approved transport builds and pushes only recharge', () => {
  fixture(({ root, env, log }) => {
    const profileEnv = approvedRuntimeTransport(root, env);
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env: profileEnv });
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env: profileEnv });
    const operations = readFileSync(log, 'utf8').split('\n');
    const builds = operations.filter((line) => line.startsWith('build '));
    const pushes = operations.filter((line) => line.startsWith('push '));
    assert.equal(builds.length, 1);
    assert.ok(builds[0].includes('auto-recharge/worker/Dockerfile'));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].endsWith('-auto-recharge'));
    assert.deepEqual(readFileSync(profileEnv.TASK_PROFILE_CHECK_LOG, 'utf8').trim().split('\n'), [
      'checked',
      'checked'
    ]);
  });
});

test('fixed b8 rejected approval blocks image work before Docker', () => {
  fixture(({ root, env, log }) => {
    const profileEnv = approvedRuntimeTransport(root, env, true);
    for (const file of ['build-images.sh', 'push-images.sh']) {
      assert.throws(
        () =>
          execFileSync('bash', [`scripts/production-release/${file}`], {
            env: profileEnv,
            stdio: 'pipe'
          }),
        (error) => error.status === 31
      );
    }
    assert.equal(readFileSync(log, 'utf8'), '');
    assert.equal(existsSync(env.GITHUB_ENV), false);
  });
});

test('fixed b8 dispatch passes only its runtime flag after approval precheck', () => {
  dispatchFixture(
    'recharge-pro-menu-b8-20261005',
    'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
    ({ execute, parametersFile, awsLog, root, env }) => {
      const transport = approvedRuntimeTransport(root, env);
      // The fixture controls only the transport approval result; Python profile tests
      // separately validate the complete approval and source bindings.
      execute({
        TASK_REAL_PYTHON: transport.TASK_REAL_PYTHON,
        TASK_PROFILE_CHECK_LOG: transport.TASK_PROFILE_CHECK_LOG
      });
      const args = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1).split(' ');
      assert.equal(args.filter((arg) => arg === '--recharge-pro-menu-b8').length, 1);
      assert.equal(
        args.some((arg) => arg.startsWith('--historical-finance-')),
        false
      );
      assert.equal(
        readFileSync(awsLog, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('ssm send-command ')).length,
        1
      );
    }
  );
});

test('fixed b8 workflow checks approval before builds and credentials, then skips cache', () => {
  const workflow = readFileSync('.github/workflows/production-release.yml', 'utf8');
  const check = workflow.indexOf('- name: Verify fixed recharge runtime approval');
  assert.ok(check > 0);
  assert.ok(check < workflow.indexOf('- name: Build images on the GitHub runner'));
  assert.ok(check < workflow.indexOf('- name: Obtain short-lived AWS credentials through OIDC'));
  assert.ok(
    workflow.includes(
      "inputs.operation == 'release' && inputs.historical_exception != 'recharge-pro-menu-b8-20261005'"
    )
  );
  assert.ok(workflow.includes('RECHARGE_ONLY_CACHE_SKIPPED'));
});

test('fixed b8 dispatch rejects wrong baseline, reuse, admin scope and failed approval before AWS', () => {
  for (const overrides of [
    { EXPECTED_CURRENT: 'f'.repeat(40) },
    { RELEASE_ADMIN_ONLY: 'true' },
    { REUSE_IMAGE_COMMIT: 'b'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '99999' },
    { REUSE_IMAGE_RUN_ATTEMPT: '1' },
    { rejectedApproval: true }
  ]) {
    dispatchFixture(
      'recharge-pro-menu-b8-20261005',
      'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
      ({ execute, parametersFile, awsLog, root, env }) => {
        const { rejectedApproval, ...fields } = overrides;
        const transport = approvedRuntimeTransport(root, env, rejectedApproval);
        assert.throws(() =>
          execute({
            TASK_REAL_PYTHON: transport.TASK_REAL_PYTHON,
            TASK_PROFILE_CHECK_LOG: transport.TASK_PROFILE_CHECK_LOG,
            ...fields
          })
        );
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      }
    );
  }
});

test('fixed b8 scope approval JSON alone still runs actual remote profile behavior checks', () => {
  const commands = guardCommands(['deploy/aws/recharge-pro-menu-b8-20261005.json']);
  assert.equal(
    commands.filter(
      (command) => command === 'python3 -B scripts/production-release/remote-deploy.test.py'
    ).length,
    1
  );
  assert.ok(commands.includes('node --test scripts/v2-release-history-policy.test.mjs'));
  assert.ok(commands.includes('node --test scripts/v2-release-maintenance-policy.test.mjs'));
});

function fixedRechargeReadbackFixture(run) {
  const workflow = readFileSync('.github/workflows/production-release.yml', 'utf8');
  const step = workflow.split('      - name: Verify fixed recharge deployment independently\n')[1];
  assert.ok(step);
  const script = step
    .split('        run: |\n')[1]
    .split('\n      - name:')[0]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  fixture(({ root, env }) => {
    mkdirSync(join(root, 'scripts/production-release'), { recursive: true });
    mkdirSync(join(root, 'deploy/aws'), { recursive: true });
    const remoteSource = readFileSync('scripts/production-release/remote-deploy.py');
    writeFileSync(join(root, 'scripts/production-release/remote-deploy.py'), remoteSource);
    const profile = JSON.parse(
      readFileSync('deploy/aws/recharge-pro-menu-b8-20261005.json', 'utf8')
    );
    profile.enabled = true;
    profile.approvalStatus = 'APPROVED';
    for (const key of [
      'manifestSha256',
      'beforeAuditSha256',
      'afterAuditSha256',
      'overrideRawSha256',
      'overrideCanonicalSha256'
    ])
      profile.baselineRelease[key] = 'd'.repeat(64);
    for (const key of ['candidateSourceSha256', 'carriedSourceOnlySha256', 'controlSourceSha256'])
      for (const name of Object.keys(profile[key])) profile[key][name] = 'e'.repeat(64);
    const profileFile = join(root, 'deploy/aws/recharge-pro-menu-b8-20261005.json');
    writeFileSync(profileFile, JSON.stringify(profile));
    const digest = execFileSync(
      'python3',
      [
        '-c',
        'import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.load(open(sys.argv[1])),sort_keys=True,separators=(",", ":")).encode()).hexdigest())',
        profileFile
      ],
      { encoding: 'utf8' }
    ).trim();
    const receipt = {
      version: 1,
      id: 'recharge-pro-menu-b8-20261005',
      status: 'VERIFIED',
      currentCommit: env.RELEASE_COMMIT,
      sourceTree: 'c'.repeat(40),
      previousCommit: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0',
      profileSha256: digest,
      servicesUpdated: ['auto-recharge'],
      preservedServiceCount: 6,
      checkCount: 48,
      executedCheckCount: 48,
      unavailableCheckCount: 0,
      violationCount: 6,
      storedGatesMatched: true,
      unchangedServiceContainersPreserved: true,
      environmentUnchanged: true,
      migrationStatus: 'SKIPPED',
      databaseGrantSyncStatus: 'SKIPPED',
      cacheStatus: 'SKIPPED',
      liveServicesHealthy: true,
      rechargeImageMatched: true
    };
    const outputFile = join(root, 'synthetic-ssm-output.txt');
    const awsLog = join(root, 'readback-aws.log');
    writeFileSync(awsLog, '');
    writeFileSync(
      join(root, 'bin/aws'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_READBACK_AWS_LOG"\ncase "$2" in\nsend-command) printf "synthetic-command\\n" ;;\nwait) exit "${TASK_READBACK_WAIT_STATUS:-0}" ;;\nget-command-invocation) cat "$TASK_READBACK_OUTPUT" ;;\n*) exit 91 ;;\nesac\n',
      { mode: 0o755 }
    );
    const execute = (
      output = `FIXED_RECHARGE_RELEASE_VERIFIED ${JSON.stringify(receipt)}\n`,
      overrides = {}
    ) => {
      writeFileSync(outputFile, output);
      return execFileSync('bash', ['-c', script], {
        cwd: root,
        env: {
          ...env,
          SOURCE_TREE: receipt.sourceTree,
          RELEASE_OPERATION: 'verify_recharge_release',
          EXPECTED_CURRENT: receipt.currentCommit,
          PRODUCTION_INSTANCE_ID: 'i-test-fixture-only',
          TASK_READBACK_AWS_LOG: awsLog,
          TASK_READBACK_OUTPUT: outputFile,
          ...overrides
        },
        encoding: 'utf8',
        stdio: 'pipe'
      });
    };
    run({ root, execute, receipt, profile, profileFile, digest, awsLog, remoteSource });
  });
}

test('fixed recharge actual readonly workflow validates its complete projection and bound SSM wire', () => {
  fixedRechargeReadbackFixture(({ root, execute, receipt, digest, remoteSource }) => {
    assert.deepEqual(JSON.parse(execute()), receipt);
    const file = join(root, '.deploy/production-release/fixed-recharge-readback.json');
    const parameters = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Buffer.byteLength(JSON.stringify(parameters)) < 20 * 1024);
    assert.deepEqual(parameters.executionTimeout, ['120']);
    assert.equal(parameters.commands.length, 1);
    const inspected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import ast,json,shlex,sys; tokens=shlex.split(json.load(open(sys.argv[1]))["commands"][0]); assert tokens[:2]==["python3","-c"] and len(tokens)==3; tree=ast.parse(tokens[2]); literals=[node.value for node in ast.walk(tree) if isinstance(node,ast.Constant) and isinstance(node.value,str)]; print(json.dumps({"program":tokens[2],"literals":literals}))',
          file
        ],
        { encoding: 'utf8' }
      )
    );
    const hash = createHash('sha256').update(remoteSource).digest('hex');
    assert.ok(inspected.literals.includes(hash));
    assert.ok(inspected.literals.includes(digest));
    assert.ok(inspected.literals.includes(receipt.currentCommit));
    assert.ok(inspected.literals.includes(receipt.sourceTree));
    assert.ok(inspected.literals.includes('--check-fixed-recharge-deployment'));
    assert.ok(
      inspected.literals.includes(
        `/opt/id-business-v2/.staging/oidc-${receipt.currentCommit}/remote-deploy.py`
      )
    );
    assert.ok(inspected.program.includes('exec(compile(b,str(p),"exec")'));
    assert.equal((inspected.program.match(/read_bytes\(\)/g) || []).length, 1);
    const deploymentFiles = ['fixed-recharge-readback.json', 'fixed-recharge-readback-filter.py'];
    for (const name of deploymentFiles)
      assert.equal(
        readFileSync(join(root, '.deploy/production-release', name), 'utf8').includes(
          'synthetic-ssm-output'
        ),
        false
      );
    assert.throws(
      () =>
        execFileSync(
          'python3',
          [
            '-O',
            '-c',
            `import pathlib,sys\nclass StubPath:\n    def __init__(self, value): pass\n    def read_bytes(self): return b'raise RuntimeError("wire-must-not-execute")'\npathlib.Path=StubPath\nexec(sys.argv[1])`,
            inspected.program
          ],
          { encoding: 'utf8', stdio: 'pipe' }
        ),
      (error) =>
        error.status !== 0 &&
        error.stdout === '' &&
        String(error.stderr).includes('RuntimeError: Fixed recharge verifier source unavailable') &&
        !String(error.stderr).includes('RuntimeError: wire-must-not-execute')
    );
  });
});

test('fixed recharge readonly filter rejects cross-wired, incomplete, untyped and raw SSM output privately', () => {
  fixedRechargeReadbackFixture(({ execute, receipt }) => {
    const prefix = 'FIXED_RECHARGE_RELEASE_VERIFIED ';
    const changed = (key, value) => `${prefix}${JSON.stringify({ ...receipt, [key]: value })}\n`;
    const missing = { ...receipt };
    delete missing.storedGatesMatched;
    const cases = [
      changed('currentCommit', 'f'.repeat(40)),
      changed('sourceTree', 'f'.repeat(40)),
      changed('profileSha256', 'f'.repeat(64)),
      changed('servicesUpdated', ['auto-recharge', 'auto-registration']),
      changed('checkCount', true),
      changed('preservedServiceCount', 5),
      changed('environmentUnchanged', false),
      changed('migrationStatus', 'APPLIED'),
      changed('unexpected', 'PRIVATE_SYNTHETIC_SENTINEL'),
      `${prefix}${JSON.stringify(missing)}\n`,
      `${prefix}{"version":1,"version":1}\n`,
      `${prefix}{"version":NaN}\n`,
      `${prefix}${JSON.stringify(receipt)}\nPRIVATE_SYNTHETIC_SENTINEL\n`,
      `PRIVATE_SYNTHETIC_SENTINEL\n${prefix}${JSON.stringify(receipt)}\n`,
      `PRIVATE_SYNTHETIC_SENTINEL${'x'.repeat(8192)}`
    ];
    for (const output of cases)
      assert.throws(
        () => execute(output),
        (error) =>
          error.status !== 0 &&
          error.stdout === '' &&
          String(error.stderr).includes('raw output suppressed') &&
          !String(error.stderr).includes('PRIVATE_SYNTHETIC_SENTINEL')
      );
  });
});

test('fixed recharge readonly rejects unapproved profile and failed SSM before reporting success', () => {
  fixedRechargeReadbackFixture(({ execute, profile, profileFile, awsLog }) => {
    assert.throws(
      () => execute(undefined, { TASK_READBACK_WAIT_STATUS: '19' }),
      (error) =>
        error.status === 19 &&
        error.stdout === '' &&
        String(error.stderr).includes('raw output suppressed')
    );
    assert.equal(readFileSync(awsLog, 'utf8').includes('get-command-invocation'), false);
    writeFileSync(awsLog, '');
    profile.enabled = false;
    profile.approvalStatus = 'NOT_APPROVED';
    writeFileSync(profileFile, JSON.stringify(profile));
    assert.throws(
      () => execute(),
      (error) => error.status !== 0 && error.stdout === ''
    );
    assert.equal(readFileSync(awsLog, 'utf8'), '');
  });
});

test('mailbox API-only release does not run unrelated cache cleanup', () => {
  const workflow = readFileSync('.github/workflows/production-release.yml', 'utf8');
  const start = workflow.indexOf('name: Verify or maintain recoverable unused project image cache');
  assert.ok(start > 0);
  const condition = workflow.slice(start, workflow.indexOf('env:', start));
  assert.ok(
    condition.includes("inputs.historical_exception != 'historical-finance-20261005-mailbox-batch'")
  );
});
