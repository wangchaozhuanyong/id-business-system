import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';
import { adminCheckCommands, checkMode, isCiOnly, selectedParts } from './ci-recharge-scope.mjs';

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
    '#!/bin/sh\nprintf "aws %s\\n" "$*" >> "$TASK_DOCKER_LOG"\ncase "$*" in\n*get-login-password*) printf "test-fixture-only\\n" ;;\n*describe-images*) printf "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;;\nesac\n',
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
    AWS_REGION: 'ap-northeast-1',
    HISTORICAL_EXCEPTION: 'none',
    POST_CLEANUP_SEAL_SHA256: '',
    ORDER_ARCHIVE_SEAL_SHA256: '',
    ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: '',
    RELEASE_OPERATION: 'release',
    REUSE_IMAGE_RUN: ''
  };
  try {
    run({ root, env, log });
  } finally {
    rmSync(root, { recursive: true });
  }
}

function guardCommands(
  paths,
  {
    failHistory = false,
    failMaintenance = false,
    failMailbox = false,
    failArchivePolicy = false,
    failRetirement = false,
    failPrepared = false,
    part = 'guards'
  } = {}
) {
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
            ? 'if [ "$TASK_FAIL_HISTORY" = true ] && [ "$*" = "--test scripts/v2-release-history-policy.test.mjs" ]; then exit 23; fi\nif [ "$TASK_FAIL_MAINTENANCE" = true ] && [ "$*" = "--test scripts/v2-release-maintenance-policy.test.mjs" ]; then exit 24; fi\nif [ "$TASK_FAIL_MAILBOX" = true ] && [ "$*" = "--test scripts/v2-release-mailbox-audit.test.mjs" ]; then exit 27; fi\nif [ "$TASK_FAIL_ARCHIVE_POLICY" = true ] && [ "$*" = "--test scripts/v2-order-archive-release-policy.test.mjs" ]; then exit 26; fi\n'
            : file === 'python3'
              ? 'if [ "$TASK_FAIL_RETIREMENT" = true ] && [ "$*" = "-B scripts/production-release/retire-orphan-retention.test.py" ]; then exit 24; fi\nif [ "$TASK_FAIL_PREPARED" = true ] && [ "$*" = "-B scripts/production-release/prepared-images.test.py" ]; then exit 25; fi\n'
              : ''
        }`,
        { mode: 0o755 }
      );
    execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts/ci-recharge-check.mjs'), part, 'a'.repeat(40)],
      {
        cwd: root,
        env: {
          ...env,
          CHECK_MODE: part === 'release-controls' ? 'full' : 'ci-only',
          TASK_GUARD_LOG: log,
          TASK_FAIL_HISTORY: String(failHistory),
          TASK_FAIL_MAINTENANCE: String(failMaintenance),
          TASK_FAIL_MAILBOX: String(failMailbox),
          TASK_FAIL_ARCHIVE_POLICY: String(failArchivePolicy),
          TASK_FAIL_RETIREMENT: String(failRetirement),
          TASK_FAIL_PREPARED: String(failPrepared)
        },
        stdio: 'pipe'
      }
    );
    commands = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
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

test('actual source entry rejects failed evidence on Bash before emitting reusable proof and remains control-only', () => {
  const path = 'scripts/production-release/check-source.sh';
  assert.equal(checkMode([path], '', ''), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  for (const alias of [path + '.backup', 'scripts/production-release/check-source-other.sh'])
    assert.equal(checkMode([alias], '', ''), 'full', alias);
  assert.deepEqual(guardCommands([path], { part: 'release-controls' }), [
    'node --test scripts/ci-recharge-release.test.mjs',
    'node --test scripts/v2-order-archive-release-policy.test.mjs'
  ]);
  for (const changed of [
    null,
    { RELEASE_COMMIT: 'invalid' },
    { EXPECTED_CURRENT: 'invalid' },
    { GITHUB_REF: 'refs/heads/feature' },
    { TASK_SOURCE_HEAD: 'c'.repeat(40) },
    { TASK_SOURCE_REMOTE_MAIN: 'c'.repeat(40) },
    { TASK_SOURCE_QUALITY_RUN: '' },
    { TASK_SOURCE_QUALITY_RUN: 'null' },
    { TASK_SOURCE_QUALITY_RUN: '0' },
    { TASK_SOURCE_QUALITY_RUN: '123-invalid' }
  ])
    fixture(({ root, env }) => {
      const sourceLog = join(root, 'source-commands.txt');
      writeFileSync(sourceLog, '');
      writeFileSync(
        join(root, 'bin', 'git'),
        '#!/bin/sh\nprintf "git %s\\n" "$*" >> "$TASK_SOURCE_LOG"\ncase "$*" in\n"rev-parse HEAD") printf "%s\\n" "$TASK_SOURCE_HEAD" ;;\n"rev-parse HEAD^{tree}") printf "%s\\n" "$TASK_SOURCE_TREE" ;;\n"ls-remote origin refs/heads/main") printf "%s\\trefs/heads/main\\n" "$TASK_SOURCE_REMOTE_MAIN" ;;\n*) exit 2 ;;\nesac\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(root, 'bin', 'gh'),
        '#!/bin/sh\nprintf "gh %s\\n" "$*" >> "$TASK_SOURCE_LOG"\nprintf "%s\\n" "$TASK_SOURCE_QUALITY_RUN"\n',
        { mode: 0o755 }
      );
      const execute = () =>
        execFileSync('/bin/bash', [join(process.cwd(), path)], {
          cwd: root,
          env: {
            ...env,
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'fixture/project-only',
            TASK_SOURCE_LOG: sourceLog,
            TASK_SOURCE_HEAD: env.RELEASE_COMMIT,
            TASK_SOURCE_REMOTE_MAIN: env.RELEASE_COMMIT,
            TASK_SOURCE_TREE: 'd'.repeat(40),
            TASK_SOURCE_QUALITY_RUN: '12345',
            ...changed
          },
          encoding: 'utf8',
          stdio: 'pipe'
        });
      if (changed) {
        assert.throws(execute, (error) => error.status === 1, JSON.stringify(changed));
        assert.equal(existsSync(env.GITHUB_ENV), false, JSON.stringify(changed));
      } else {
        assert.match(execute(), /Source and main Quality Gate verified/);
        assert.equal(
          readFileSync(env.GITHUB_ENV, 'utf8'),
          `QUALITY_RUN_ID=12345\nSOURCE_TREE=${'d'.repeat(40)}\n`
        );
        const commands = readFileSync(sourceLog, 'utf8');
        assert.ok(commands.includes(`--workflow quality.yml --commit ${env.RELEASE_COMMIT}`));
        for (const filter of [
          '.headSha == env.RELEASE_COMMIT',
          '.event == "push"',
          '.status == "completed"',
          '.conclusion == "success"'
        ])
          assert.ok(commands.includes(filter), filter);
        assert.equal(commands.includes('aws '), false);
      }
    });
});

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

const postCleanupPolicy = 'historical-finance-20261005-post-cleanup';
const postCleanupBaseline = '6a82a774f2a65e00d4f260c629f7152bf7935d1d';
const fixtureSeal = 'e'.repeat(64);
const workflow = loadYaml(readFileSync('.github/workflows/production-release.yml', 'utf8'));
const workflowInputs = workflow.on.workflow_dispatch.inputs;
const workflowSteps = workflow.jobs.release.steps;
const postCleanupEnv = {
  HISTORICAL_EXCEPTION: postCleanupPolicy,
  EXPECTED_CURRENT: postCleanupBaseline,
  POST_CLEANUP_SEAL_SHA256: fixtureSeal,
  REUSE_IMAGE_RUN: '222'
};
const preparePostCleanupEnv = {
  ...postCleanupEnv,
  RELEASE_OPERATION: 'prepare_post_cleanup_release',
  POST_CLEANUP_SEAL_SHA256: '',
  REUSE_IMAGE_RUN: ''
};

test('workflow wires a separate empty-by-default seal and rejects all non-release operations before AWS', () => {
  assert.equal(workflowInputs.historical_exception.default, 'none');
  assert.ok(workflowInputs.historical_exception.options.includes(postCleanupPolicy));
  assert.equal(workflowInputs.post_cleanup_seal_sha256.default, '');
  assert.equal(workflowInputs.post_cleanup_seal_sha256.required, false);
  assert.equal(
    workflow.jobs.release.env.POST_CLEANUP_SEAL_SHA256,
    '${{ inputs.post_cleanup_seal_sha256 }}'
  );
  assert.equal(workflow.jobs.release.env.RELEASE_OPERATION, '${{ inputs.operation }}');
  assert.equal(workflow.jobs.release.env.REUSE_IMAGE_RUN, '${{ inputs.reuse_image_run }}');
  const selection = workflowSteps.find(
    (step) => step.name === 'Validate release policy and reviewed seal selection'
  );
  assert.equal(selection.run, 'bash scripts/production-release/validate-release-selection.sh');
  assert.ok(
    workflowSteps.indexOf(selection) <
      workflowSteps.findIndex((step) => step.name === 'Build images on the GitHub runner')
  );
  assert.ok(
    workflowSteps.indexOf(selection) <
      workflowSteps.findIndex((step) => step.uses?.startsWith('aws-actions/'))
  );
  for (const operation of workflowInputs.operation.options.filter(
    (value) => !['release', 'prepare_post_cleanup_release'].includes(value)
  )) {
    fixture(({ env, log }) => {
      assert.throws(
        () =>
          execFileSync('bash', ['-c', selection.run], {
            env: { ...env, ...postCleanupEnv, RELEASE_OPERATION: operation },
            stdio: 'pipe'
          }),
        (error) =>
          error.status === 1 &&
          String(error.stderr).includes('supports preparation or release only')
      );
      assert.equal(readFileSync(log, 'utf8'), '');
    });
  }
});

test('actual post-cleanup build and push create only this run API and migrate images', () => {
  fixture(({ env, log }) => {
    writeFileSync(env.TASK_CHANGED_PATHS, 'apps/api/src/id-business-v2/finance/example.ts');
    const selectedEnv = { ...env, ...preparePostCleanupEnv };
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env: selectedEnv });
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
    const built = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('build '));
    assert.equal(built.length, 2);
    assert.ok(built[0].includes('--target runtime') && built[0].endsWith('-api .'));
    assert.ok(built[1].includes('--target migration') && built[1].endsWith('-migrate .'));
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env: selectedEnv });
    const pushed = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('push '));
    assert.deepEqual(
      pushed.map((line) => line.split('-').at(-1)),
      ['api', 'migrate']
    );
    for (const line of [...built, ...pushed])
      assert.ok(line.includes(`${env.RELEASE_COMMIT}-999999-1-`));
  });
});

test('post-cleanup dispatch carries only its independent flag and exact reviewed seal', () => {
  dispatchFixture(
    postCleanupPolicy,
    postCleanupBaseline,
    ({ execute, parametersFile, awsLog }) => {
      execute();
      const args = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1).split(' ');
      assert.equal(args.filter((arg) => arg === '--historical-finance-post-cleanup').length, 1);
      assert.equal(args[args.indexOf('--post-cleanup-seal-sha256') + 1], fixtureSeal);
      assert.equal(args.includes('--admin-only'), false);
      assert.equal(
        args.some((arg) =>
          [
            '--historical-finance-exception',
            '--historical-finance-continuation',
            '--historical-finance-recharge-diagnostics'
          ].includes(arg)
        ),
        false
      );
      assert.equal(
        readFileSync(awsLog, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('ssm send-command ')).length,
        1
      );
    },
    {
      POST_CLEANUP_SEAL_SHA256: fixtureSeal,
      REUSE_IMAGE_RUN: '222',
      REUSE_IMAGE_COMMIT: 'b'.repeat(40),
      REUSE_IMAGE_RUN_ID: '222',
      REUSE_IMAGE_RUN_ATTEMPT: '2'
    }
  );
});

const rejectedPostCleanupSelections = [
  { EXPECTED_CURRENT: 'a'.repeat(40) },
  { POST_CLEANUP_SEAL_SHA256: '' },
  { POST_CLEANUP_SEAL_SHA256: 'F'.repeat(64) },
  { POST_CLEANUP_SEAL_SHA256: 'e'.repeat(63) },
  { POST_CLEANUP_SEAL_SHA256: fixtureSeal + ' --admin-only' },
  { RELEASE_ADMIN_ONLY: 'true' },
  { RELEASE_ADMIN_ONLY: 'unexpected' },
  { REUSE_IMAGE_RUN: '' },
  { REUSE_IMAGE_RUN: '0' },
  { REUSE_IMAGE_COMMIT: 'd'.repeat(40) },
  { REUSE_IMAGE_RUN_ID: '333' },
  { REUSE_IMAGE_RUN_ATTEMPT: '0' },
  { RELEASE_OPERATION: 'verify_access' },
  { RELEASE_OPERATION: 'cleanup_audit' },
  { RELEASE_OPERATION: 'prepare_post_cleanup_release' },
  { HISTORICAL_EXCEPTION: 'none' },
  { HISTORICAL_EXCEPTION: 'historical-finance-20261005-recharge-diagnostics' }
];

test('all actual build push and dispatch entries reject unsafe selections before Docker AWS or parameters', () => {
  for (const rejected of rejectedPostCleanupSelections) {
    for (const entry of ['build-images', 'push-images'])
      fixture(({ env, log }) => {
        writeFileSync(env.TASK_CHANGED_PATHS, 'apps/api/src/id-business-v2/finance/example.ts');
        assert.throws(
          () =>
            execFileSync('bash', [`scripts/production-release/${entry}.sh`], {
              env: { ...env, ...postCleanupEnv, ...rejected },
              stdio: 'pipe'
            }),
          (error) => error.status === 1
        );
        assert.equal(readFileSync(log, 'utf8'), '', `${entry}: mutation attempted`);
        assert.equal(existsSync(env.GITHUB_ENV), false);
      });
    const selected = { ...postCleanupEnv, ...rejected };
    dispatchFixture(
      selected.HISTORICAL_EXCEPTION,
      selected.EXPECTED_CURRENT,
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(execute, (error) => error.status === 1);
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      selected
    );
  }
});

test('workflow skips legacy automatic cache mutation for the new release policy', () => {
  const step = workflowSteps.find(
    (value) => value.name === 'Verify or maintain recoverable unused project image cache'
  );
  const selected = (operation, historical_exception) =>
    new Function('inputs', `return (${step.if});`)({ operation, historical_exception });
  assert.equal(selected('release', postCleanupPolicy), false);
  assert.equal(selected('release', 'historical-finance-20261005-order-archive'), false);
  assert.equal(selected('release', 'recharge-pro-menu-b8-20261005'), false);
  assert.equal(selected('release', 'recharge-pro-menu-7f-20261005'), false);
  assert.equal(selected('release', 'recharge-pro-main80-20261006'), false);
  assert.equal(selected('release', 'registration-worker-b8-80-20261006'), false);
  assert.equal(selected('release', 'registration-worker-956-20261006'), false);
  assert.equal(selected('release', 'registration-worker-85-20261006'), false);
  assert.equal(selected('release', 'registration-worker-86-20261006'), false);
  assert.equal(selected('release', 'registration-worker-87-20261006'), false);
  assert.equal(selected('release', 'registration-worker-88-20261006'), false);
  assert.equal(selected('release', 'registration-worker-89-20261006'), false);
  assert.equal(selected('release', 'historical-finance-20261005-mailbox-batch'), false);
  for (const policy of workflowInputs.historical_exception.options.filter(
    (value) =>
      ![
        postCleanupPolicy,
        'historical-finance-20261005-order-archive',
        'recharge-pro-menu-b8-20261005',
        'recharge-pro-menu-7f-20261005',
        'recharge-pro-main80-20261006',
        'registration-worker-b8-80-20261006',
        'registration-worker-956-20261006',
        'registration-worker-85-20261006',
        'registration-worker-86-20261006',
        'registration-worker-87-20261006',
        'registration-worker-88-20261006',
        'registration-worker-89-20261006',
        'historical-finance-20261005-mailbox-batch'
      ].includes(value)
  ))
    assert.equal(selected('release', policy), true);
  for (const operation of [
    'verify_unused_cache',
    'cleanup_unused_cache',
    'verify_unused_legacy_cache',
    'cleanup_unused_legacy_cache',
    'verify_unused_builder_cache',
    'cleanup_unused_builder_cache'
  ])
    assert.equal(selected(operation, 'none'), true);
  assert.equal(selected('verify_access', 'none'), false);
});

test('preparation permits only build push and evidence and cannot reach dispatch SSM or maintenance', () => {
  const inputs = {
    operation: 'prepare_post_cleanup_release',
    historical_exception: postCleanupPolicy,
    reuse_image_run: '',
    diagnostic_command_id: ''
  };
  const enabled = workflowSteps
    .filter((step) => !step.if || new Function('inputs', `return (${step.if});`)(inputs))
    .map((step) => step.name);
  assert.deepEqual(enabled, [
    'Check out the requested main commit',
    'Verify exact source and passing Quality Gate',
    'Validate release policy and reviewed seal selection',
    'Build images on the GitHub runner',
    'Obtain short-lived AWS credentials through OIDC',
    'Verify build-only ECR target',
    'Push immutable images',
    'Record prepared API image source',
    'Save prepared API image source'
  ]);
  assert.equal(
    workflowSteps.find((step) => step.name === 'Save prepared API image source').with[
      'if-no-files-found'
    ],
    'error'
  );
  fixture(({ env, log }) => {
    const validation = workflowSteps.find(
      (step) => step.name === 'Validate release policy and reviewed seal selection'
    );
    execFileSync('bash', ['-c', validation.run], {
      env: { ...env, ...preparePostCleanupEnv },
      stdio: 'pipe'
    });
    assert.equal(readFileSync(log, 'utf8'), '');
  });
  for (const rejected of [
    { POST_CLEANUP_SEAL_SHA256: fixtureSeal },
    { REUSE_IMAGE_RUN: '222' },
    { HISTORICAL_EXCEPTION: 'none' },
    { EXPECTED_CURRENT: 'a'.repeat(40) },
    { RELEASE_ADMIN_ONLY: 'true' }
  ]) {
    fixture(({ env, log }) => {
      assert.throws(() =>
        execFileSync('bash', ['scripts/production-release/build-images.sh'], {
          env: { ...env, ...preparePostCleanupEnv, ...rejected },
          stdio: 'pipe'
        })
      );
      assert.equal(readFileSync(log, 'utf8'), '');
    });
  }
  dispatchFixture(
    postCleanupPolicy,
    postCleanupBaseline,
    ({ execute, parametersFile, awsLog }) => {
      assert.throws(execute);
      assert.equal(existsSync(parametersFile), false);
      assert.equal(readFileSync(awsLog, 'utf8'), '');
    },
    preparePostCleanupEnv
  );
});

test('post-cleanup release requires preparation reuse and cannot build unreviewed replacement images', () => {
  const inputs = {
    operation: 'release',
    historical_exception: postCleanupPolicy,
    reuse_image_run: '222',
    diagnostic_command_id: ''
  };
  const enabled = workflowSteps
    .filter((step) => !step.if || new Function('inputs', `return (${step.if});`)(inputs))
    .map((step) => step.name);
  assert.ok(enabled.includes('Verify reusable build and unchanged application source'));
  assert.ok(enabled.includes('Deploy through the production instance'));
  assert.equal(enabled.includes('Build images on the GitHub runner'), false);
  assert.equal(enabled.includes('Push immutable images'), false);
  for (const entry of ['build-images', 'push-images'])
    fixture(({ env, log }) => {
      assert.throws(
        () =>
          execFileSync('bash', [`scripts/production-release/${entry}.sh`], {
            env: { ...env, ...postCleanupEnv },
            stdio: 'pipe'
          }),
        `${entry} must reject release`
      );
      assert.equal(readFileSync(log, 'utf8'), '');
    });
});

test('full quality runs the missing controls before tests while finite and remote suites retain their existing npm entry', () => {
  const quality = loadYaml(readFileSync('.github/workflows/quality.yml', 'utf8'));
  const steps = quality.jobs['full-quality'].steps;
  const selected = steps.filter(
    (step) => step.name === 'Verify affected release entry and maintenance controls'
  );
  assert.equal(selected.length, 1);
  assert.equal(
    selected[0].run,
    'node scripts/ci-recharge-check.mjs release-controls "$CHECK_BASE"'
  );
  assert.equal(selected[0].env.CHECK_MODE, 'full');
  assert.equal(selected[0].env.CHECK_BASE, '${{ needs.change-scope.outputs.base }}');
  assert.ok(
    steps.indexOf(selected[0]) > steps.findIndex((step) => step.name === 'Install dependencies')
  );
  assert.ok(steps.indexOf(selected[0]) < steps.findIndex((step) => step.name === 'Test'));
  assert.equal(steps.find((step) => step.name === 'Test').run, 'npm run test');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(
    scripts.test,
    'npm run test:repository-scripts && npm run test --workspaces --if-present'
  );
  assert.equal(
    scripts['test:repository-scripts']
      .split(' ')
      .filter((arg) => arg === 'scripts/v2-release-history-policy.test.mjs').length,
    1
  );
  assert.match(
    readFileSync('scripts/v2-release-history-policy.test.mjs', 'utf8'),
    /import '\.\/v2-release-post-cleanup-policy\.test\.mjs'/
  );
  assert.match(
    readFileSync('scripts/v2-release-history-policy.test.mjs', 'utf8'),
    /'scripts\/production-release\/remote-deploy\.test\.py'/
  );
});

test('actual full-mode release controls select each missing suite once without repeating repository or business checks', () => {
  const paths = [
    'apps/api/src/id-business-v2/finance/example.ts',
    'apps/api/src/id-business-v2/orders/example.ts',
    '.github/workflows/production-release.yml',
    '.github/workflows/quality.yml',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/retire-orphan-retention.py',
    'scripts/production-release/prepared-images.test.py',
    'scripts/production-release/dispatch.sh',
    'scripts/backup-aws-mysql.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  assert.equal(checkMode(paths, '', ''), 'full');
  assert.deepEqual(guardCommands(paths, { part: 'release-controls' }), [
    'node --test scripts/ci-recharge-release.test.mjs',
    'node --test scripts/v2-registration-finance-audit.test.mjs',
    'python3 -B scripts/production-release/registration-only-transport.test.py',
    'python3 -B scripts/production-release/retire-orphan-retention.test.py',
    'python3 -B scripts/production-release/prepared-images.test.py',
    'node --test scripts/v2-order-archive-release-policy.test.mjs'
  ]);
  const recharge = guardCommands(paths);
  for (const command of [
    'node --test scripts/v2-registration-finance-audit.test.mjs',
    'python3 -B scripts/production-release/retire-orphan-retention.test.py',
    'python3 -B scripts/production-release/prepared-images.test.py'
  ])
    assert.equal(recharge.filter((actual) => actual === command).length, 1);
});

test('actual full-mode release controls preserve exact maintenance selection and skip unrelated changes', () => {
  for (const paths of [
    ['apps/api/src/id-business-v2/finance/example.ts'],
    ['docs/V2_TASKS.md'],
    ['scripts/backup-aws-mysql.sh'],
    ['scripts/ci-recharge-check-other.mjs']
  ])
    assert.deepEqual(guardCommands(paths, { part: 'release-controls' }), [
      'node --test scripts/v2-order-archive-release-policy.test.mjs'
    ]);
  for (const path of [
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/retire-orphan-retention-other.py',
    'scripts/production-release/prepared-images.test.py.backup'
  ]) {
    assert.deepEqual(guardCommands([path], { part: 'release-controls' }), [
      'node --test scripts/ci-recharge-release.test.mjs',
      'node --test scripts/v2-order-archive-release-policy.test.mjs'
    ]);
  }
  assert.deepEqual(
    guardCommands(['scripts/production-release/retire-orphan-retention.py'], {
      part: 'release-controls'
    }),
    [
      'node --test scripts/ci-recharge-release.test.mjs',
      'python3 -B scripts/production-release/retire-orphan-retention.test.py',
      'node --test scripts/v2-order-archive-release-policy.test.mjs'
    ]
  );
  assert.deepEqual(
    guardCommands(['scripts/production-release/reuse-images.py'], { part: 'release-controls' }),
    [
      'node --test scripts/ci-recharge-release.test.mjs',
      'python3 -B scripts/production-release/prepared-images.test.py',
      'node --test scripts/v2-order-archive-release-policy.test.mjs'
    ]
  );
});

test('actual full-mode maintenance failures stop the release control gate', () => {
  for (const [path, option, expected] of [
    [
      'scripts/production-release/retire-orphan-retention.py',
      'failRetirement',
      'retire-orphan-retention.test.py'
    ],
    [
      'scripts/production-release/prepared-images.test.py',
      'failPrepared',
      'prepared-images.test.py'
    ]
  ])
    assert.throws(
      () => guardCommands([path], { part: 'release-controls', [option]: true }),
      (error) => error.status === 1 && String(error.stderr).includes(expected)
    );
});

test('maintenance and post-cleanup controls select guards and run their exact tests once', () => {
  for (const path of [
    'scripts/production-release/retire-orphan-retention.py',
    'scripts/production-release/retire-orphan-retention.test.py',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/prepared-images.test.py',
    'deploy/aws/historical-finance-20261005-post-cleanup.json',
    'scripts/v2-release-post-cleanup-policy.test.mjs',
    'scripts/lib/v2-release-history-48.test-fixture.json'
  ]) {
    assert.equal(checkMode([path], '', ''), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  for (const path of [
    '.github/workflows/production-release.yml',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/retire-orphan-retention.py',
    'scripts/production-release/retire-orphan-retention.test.py'
  ]) {
    const commands = guardCommands([path]);
    assert.equal(
      commands.filter(
        (command) =>
          command === 'python3 -B scripts/production-release/retire-orphan-retention.test.py'
      ).length,
      1,
      path
    );
    assert.equal(
      commands.filter(
        (command) => command === 'node --test scripts/v2-release-history-policy.test.mjs'
      ).length,
      1,
      path
    );
  }
  for (const path of [
    'scripts/backup-aws-mysql.sh',
    'scripts/verify-aws-mysql-backup.sh',
    'scripts/mysql-dump-restore-normalizer.sed',
    'scripts/aws-mysql-backup.test.mjs'
  ]) {
    assert.equal(checkMode([path], '', ''), 'full', path);
    assert.equal(
      checkMode(
        ['deploy/aws/historical-finance-20261005-maintenance-continuation.json', path],
        '',
        ''
      ),
      'full',
      path
    );
    const commands = guardCommands([path]);
    assert.equal(
      commands.filter((command) => command === 'node --test scripts/aws-mysql-backup.test.mjs')
        .length,
      1,
      path
    );
    assert.equal(
      commands.some((command) => command.startsWith('npm ') || command.startsWith('python3 ')),
      false,
      path
    );
  }
  for (const path of [
    'docs/V2_TASKS.md',
    'scripts/production-release/retire-orphan-retention-other.py',
    'scripts/verify-aws-mysql-backup.sh.backup'
  ]) {
    const commands = guardCommands([path]);
    assert.equal(
      commands.includes('python3 -B scripts/production-release/retire-orphan-retention.test.py'),
      false,
      path
    );
    assert.equal(commands.includes('node --test scripts/aws-mysql-backup.test.mjs'), false, path);
  }
  assert.throws(
    () =>
      guardCommands(['scripts/production-release/retire-orphan-retention.py'], {
        failRetirement: true
      }),
    (error) =>
      error.status === 1 && String(error.stderr).includes('retire-orphan-retention.test.py')
  );
  for (const path of [
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/prepared-images.test.py'
  ]) {
    assert.equal(
      guardCommands([path]).filter(
        (command) => command === 'python3 -B scripts/production-release/prepared-images.test.py'
      ).length,
      1,
      path
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
      assert.throws(execute, (error) => error.status === 1);
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
    { REUSE_IMAGE_RUN: '222' },
    { REUSE_IMAGE_COMMIT: 'd'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '222' },
    { REUSE_IMAGE_RUN_ATTEMPT: '2' },
    { POST_CLEANUP_SEAL_SHA256: 'e'.repeat(64) }
  ]) {
    dispatchFixture(
      'historical-finance-20261005-maintenance-continuation',
      '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(
          execute,
          (error) =>
            error.status === 1 &&
            (extraEnv.RELEASE_ADMIN_ONLY === 'true' ||
              String(error.stderr).includes(
                'Maintenance continuation requires a fresh image build and no post-cleanup seal'
              ))
        );
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      extraEnv
    );
  }
});

test('ordinary archive mutations and their migration retain full checks alongside maintenance controls', () => {
  for (const path of [
    'apps/api/src/id-business-v2/orders/id-business-v2-order-archive.service.ts',
    'apps/api/src/id-business-v2/orders/dto/archive-id-business-v2-order.dto.ts',
    'apps/api/prisma-mysql/migrations/20261005193000_order_independent_archive/migration.sql',
    'scripts/lib/v2-data-integrity-audit.mjs',
    'scripts/v2-data-integrity-audit.test.mjs'
  ]) {
    assert.equal(checkMode([path], '', ''), 'full', path);
    assert.equal(
      checkMode(
        ['deploy/aws/historical-finance-20261005-maintenance-continuation.json', path],
        '',
        ''
      ),
      'full',
      path
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
    REUSE_IMAGE_RUN: '37312405714',
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
    { REUSE_IMAGE_RUN: '123' },
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
    const commands = guardCommands([path]);
    assert.equal(
      commands.filter(
        (command) => command === 'node --test scripts/v2-release-mailbox-audit.test.mjs'
      ).length,
      1,
      path
    );
    assert.equal(
      commands.some((command) => command.startsWith('npm ') || command.startsWith('python3 ')),
      false
    );
    assert.throws(
      () => guardCommands([path], { failMailbox: true }),
      (error) =>
        error.status === 1 && String(error.stderr).includes('v2-release-mailbox-audit.test.mjs')
    );
  }
  for (const path of [
    'scripts/v2-release-mailbox-audit-other.mjs',
    'scripts/v2-release-mailbox-audit.test.mjs.backup',
    'deploy/aws/historical-finance-20261005-mailbox-batch.json.backup'
  ]) {
    assert.equal(isCiOnly([path]), false, path);
    assert.equal(
      guardCommands([path]).includes('node --test scripts/v2-release-mailbox-audit.test.mjs'),
      false,
      path
    );
  }
});

test('archive release pure policy is mandatory for CI-only and full controls and rejects failure', () => {
  const policyPaths = [
    'deploy/aws/historical-finance-20261005-order-archive.json',
    'scripts/lib/v2-order-archive-release-policy.mjs',
    'scripts/v2-order-archive-release-audit.mjs',
    'scripts/v2-order-archive-release-policy.test.mjs'
  ];
  for (const path of policyPaths) {
    assert.equal(checkMode([path], '', ''), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  for (const part of ['guards', 'release-controls']) {
    const paths =
      part === 'guards' ? policyPaths : ['apps/api/src/id-business-v2/orders/example.ts'];
    const commands = guardCommands(paths, { part });
    assert.equal(
      commands.filter(
        (command) => command === 'node --test scripts/v2-order-archive-release-policy.test.mjs'
      ).length,
      1
    );
    assert.throws(
      () => guardCommands(paths, { part, failArchivePolicy: true }),
      (error) =>
        error.status === 1 &&
        String(error.stderr).includes('v2-order-archive-release-policy.test.mjs')
    );
  }
  assert.equal(checkMode([policyPaths[0] + '.backup'], '', ''), 'full');
});

test('archive UI acceptance runs in full CI and exact frontend scope without API or database checks', () => {
  const quality = loadYaml(readFileSync('.github/workflows/quality.yml', 'utf8'));
  assert.ok(
    quality.jobs['full-quality'].steps.some(
      (step) =>
        step.run === 'node scripts/acceptance-v2-order-archive-ui.mjs' ||
        step.run === 'node scripts/acceptance-v2-order-archive-ui.mjs .artifacts/order-archive-ui'
    ),
    'full CI must execute the actual 48-scenario archive UI script'
  );
  const archiveCommand = ['exec', '--', 'node', 'scripts/acceptance-v2-order-archive-ui.mjs'];
  for (const path of [
    'apps/admin/src/v2/features/orders/useOrderArchive.ts',
    'apps/admin/src/v2/api/orders.ts',
    'apps/admin/src/v2/types/orders.ts',
    'apps/admin/src/v2/styles/records.css',
    'apps/admin/src/v2/styles/base.css',
    'apps/admin/src/v2/styles/layout.css',
    'scripts/acceptance-v2-order-archive-ui.mjs'
  ]) {
    assert.equal(checkMode([path], '', ''), 'admin', path);
    const commands = adminCheckCommands('admin', [path]);
    assert.equal(
      commands.filter((command) => JSON.stringify(command) === JSON.stringify(archiveCommand))
        .length,
      1
    );
    assert.equal(
      commands.some((command) =>
        command.some((arg) => /financial-integrity|@apple-business\/api/.test(arg))
      ),
      false
    );
  }
  assert.equal(
    adminCheckCommands('admin', ['apps/admin/src/v2/features/customers/CustomerList.vue']).some(
      (command) => command.includes('scripts/acceptance-v2-order-archive-ui.mjs')
    ),
    false
  );
  const selector = readFileSync('scripts/ci-recharge-scope.mjs', 'utf8');
  assert.match(
    selector.slice(selector.indexOf('const adminAcceptance =')),
    /arg === 'scripts\/acceptance-v2-order-archive-ui\.mjs'/
  );
});

function archiveHarnessFixture({ skipped = false, missing = false, runFails = false } = {}) {
  let outcome;
  fixture(({ root, env }) => {
    const calls = join(root, 'archive-harness-calls.jsonl');
    writeFileSync(calls, '');
    const createdId = 'f'.repeat(64);
    for (const file of ['docker', 'npm', 'npx']) {
      const script = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const database = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname : null;
fs.appendFileSync(process.env.TASK_HARNESS_CALLS, JSON.stringify({tool:${JSON.stringify(file)},args:args.map((arg)=>arg.startsWith('--password=')||arg.startsWith('MYSQL_ROOT_PASSWORD=')?'[local-fixture]':arg),database})+'\\n');
if (${JSON.stringify(file)} === 'docker') {
  if (args[0] === 'run') {
    if (process.env.TASK_DOCKER_FAIL === 'true') process.exit(7);
    process.stdout.write(${JSON.stringify(createdId)}+'\\n');
  }
  if (args[0] === 'port') process.stdout.write('127.0.0.1:54321\\n');
}
if (${JSON.stringify(file)} === 'npm' && args.includes('test')) {
  const target = args.find((arg)=>arg.startsWith('--outputFile='));
  if (process.env.TASK_REPORT_MISSING !== 'true') fs.writeFileSync(target.slice('--outputFile='.length),JSON.stringify({numTotalTests:10,numPassedTests:process.env.TASK_REPORT_SKIPPED==='true'?0:10,numFailedTests:0,numPendingTests:process.env.TASK_REPORT_SKIPPED==='true'?10:0,numTodoTests:0}));
}
`;
      writeFileSync(join(root, 'bin', file), script, { mode: 0o755 });
    }
    let error;
    let stdout;
    try {
      stdout = execFileSync(
        process.execPath,
        [
          join(process.cwd(), 'scripts/acceptance-v2-financial-integrity.mjs'),
          '--order-archive-only'
        ],
        {
          cwd: root,
          env: {
            ...env,
            TASK_HARNESS_CALLS: calls,
            TASK_REPORT_SKIPPED: String(skipped),
            TASK_REPORT_MISSING: String(missing),
            TASK_DOCKER_FAIL: String(runFails)
          },
          encoding: 'utf8',
          stdio: 'pipe'
        }
      );
    } catch (caught) {
      error = caught;
    }
    outcome = {
      error,
      stdout,
      createdId,
      calls: readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    };
  });
  return outcome;
}

test('actual archive-only harness routes one owned 512MB container to a fresh migrated schema and requires ten executed tests', () => {
  const proof = archiveHarnessFixture();
  assert.equal(proof.error, undefined);
  const created = proof.calls.filter((call) => call.tool === 'docker' && call.args[0] === 'run');
  assert.equal(created.length, 1);
  assert.ok(created[0].args.includes('--memory=512m'));
  const migration = proof.calls.filter(
    (call) => call.tool === 'npx' && call.args.includes('migrate')
  );
  assert.equal(migration.length, 1);
  assert.match(migration[0].database, /^\/id_business_v2_order_archive_integrity_[0-9]+$/);
  const tests = proof.calls.filter((call) => call.tool === 'npm' && call.args.includes('test'));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].database, migration[0].database);
  assert.ok(
    tests[0].args.includes('src/id-business-v2/orders/order-archive-mysql.integration.spec.ts')
  );
  assert.ok(tests[0].args.includes('--maxWorkers=2'));
  assert.ok(tests[0].args.includes('--reporter=json'));
  const receipt = JSON.parse(proof.stdout.trim());
  assert.equal(receipt.archiveProof.executedTests, 10);
  assert.equal(receipt.archiveProof.skippedTests, 0);
  assert.deepEqual(
    proof.calls
      .filter((call) => call.tool === 'docker' && call.args[0] === 'rm')
      .map((call) => call.args),
    [['rm', '--force', proof.createdId]]
  );
});

test('archive harness rejects skipped or missing reports and only cleans its successfully created container', () => {
  for (const options of [{ skipped: true }, { missing: true }]) {
    const proof = archiveHarnessFixture(options);
    assert.equal(proof.error.status, 1);
    assert.equal(
      proof.calls.filter((call) => call.tool === 'docker' && call.args[0] === 'rm').length,
      1
    );
    assert.equal(
      proof.calls.some(
        (call) =>
          call.tool === 'docker' && call.args[0] === 'rm' && call.args[2] !== proof.createdId
      ),
      false
    );
  }
  const failedCreation = archiveHarnessFixture({ runFails: true });
  assert.equal(failedCreation.error.status, 1);
  assert.equal(
    failedCreation.calls.some((call) => call.tool === 'docker' && call.args[0] === 'rm'),
    false
  );
});

test('actual independent archive preparation builds and pushes exactly API migrate and Admin with no worker', () => {
  const preparationInputs = {
    operation: 'prepare_order_archive_release',
    historical_exception: 'historical-finance-20261005-order-archive',
    reuse_image_run: '',
    diagnostic_command_id: ''
  };
  const enabled = workflowSteps
    .filter((step) => !step.if || new Function('inputs', `return (${step.if});`)(preparationInputs))
    .map((step) => step.name);
  assert.deepEqual(enabled, [
    'Check out the requested main commit',
    'Verify exact source and passing Quality Gate',
    'Validate release policy and reviewed seal selection',
    'Build images on the GitHub runner',
    'Obtain short-lived AWS credentials through OIDC',
    'Verify build-only ECR target',
    'Push immutable images',
    'Record prepared order archive image source',
    'Save prepared order archive image source'
  ]);
  assert.equal(
    workflowSteps.find((step) => step.name === 'Save prepared order archive image source').with[
      'if-no-files-found'
    ],
    'error'
  );
  fixture(({ root, env, log }) => {
    // Source verification uses real Node/Git in prepared-images.test.py; this
    // transport fixture checks the verified value reaches only the Admin image.
    const buildId = `v2-${'c'.repeat(40)}`;
    const projectionBody = join(root, 'archive-projection-body.mjs');
    writeFileSync(
      join(root, 'bin', 'node'),
      '#!/bin/sh\n[ "$*" = "--input-type=module -" ] || exit 93\ncat > "$TASK_ARCHIVE_PROJECTION_BODY"\nprintf "%s" "$TASK_ARCHIVE_BUILD_ID"\n',
      { mode: 0o755 }
    );
    const selected = {
      ...env,
      HISTORICAL_EXCEPTION: 'historical-finance-20261005-order-archive',
      EXPECTED_CURRENT: '3ca300486d0edfadda83c094a48474a63959fce7',
      RELEASE_OPERATION: 'prepare_order_archive_release',
      TASK_ARCHIVE_PROJECTION_BODY: projectionBody,
      TASK_ARCHIVE_BUILD_ID: buildId
    };
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env: selected });
    const built = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('build '));
    assert.equal(built.length, 3);
    assert.ok(built[0].includes('--target runtime') && built[0].endsWith('-api .'));
    assert.ok(built[1].includes('--target migration') && built[1].endsWith('-migrate .'));
    assert.ok(built[2].includes('apps/admin/Dockerfile') && built[2].endsWith('-admin .'));
    assert.ok(built[2].includes(`--build-arg V2_BUILD_ID=${buildId}`));
    assert.equal(
      built.slice(0, 2).some((line) => line.includes('V2_BUILD_ID=')),
      false
    );
    assert.ok(
      readFileSync(projectionBody, 'utf8').includes(
        'verifyOrderArchiveSourceBindings(policy, entries)'
      )
    );
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env: selected });
    const pushed = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('push '));
    assert.deepEqual(
      pushed.map((line) => line.split('-').at(-1)),
      ['api', 'migrate', 'admin']
    );
    assert.equal(
      [...built, ...pushed].some((line) => /media-resolver|auto-recharge/.test(line)),
      false
    );
    assert.equal(readFileSync(log, 'utf8').includes('ssm '), false);
  });
});

test('actual independent archive dispatch binds the same candidate preparation attempt and both external hashes', () => {
  const valid = {
    REUSE_IMAGE_RUN: '222',
    REUSE_IMAGE_COMMIT: 'b'.repeat(40),
    REUSE_IMAGE_RUN_ID: '222',
    REUSE_IMAGE_RUN_ATTEMPT: '3',
    ORDER_ARCHIVE_SEAL_SHA256: 'e'.repeat(64),
    ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: 'f'.repeat(64)
  };
  const policy = 'historical-finance-20261005-order-archive';
  const baseline = '3ca300486d0edfadda83c094a48474a63959fce7';
  dispatchFixture(
    policy,
    baseline,
    ({ execute, parametersFile }) => {
      execute();
      const args = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1).split(' ');
      assert.equal(args.filter((arg) => arg === '--historical-finance-order-archive').length, 1);
      for (const [flag, value] of [
        ['--expected-current', baseline],
        ['--order-archive-seal-sha256', valid.ORDER_ARCHIVE_SEAL_SHA256],
        ['--order-archive-prepared-images-sha256', valid.ORDER_ARCHIVE_PREPARED_IMAGES_SHA256],
        ['--image-commit', valid.REUSE_IMAGE_COMMIT],
        ['--image-run-id', '222'],
        ['--image-run-attempt', '3']
      ])
        assert.equal(args[args.indexOf(flag) + 1], value);
      assert.equal(args.includes('--admin-only'), false);
      assert.equal(
        args.some((arg) =>
          [
            '--historical-finance-post-cleanup',
            '--post-cleanup-seal-sha256',
            '--historical-finance-maintenance-continuation'
          ].includes(arg)
        ),
        false
      );
    },
    valid
  );
  for (const invalid of [
    { EXPECTED_CURRENT: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' },
    { REUSE_IMAGE_COMMIT: 'd'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '999' },
    { REUSE_IMAGE_RUN_ATTEMPT: '' },
    { REUSE_IMAGE_RUN: '' },
    { ORDER_ARCHIVE_SEAL_SHA256: '' },
    { ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: '' },
    { POST_CLEANUP_SEAL_SHA256: 'e'.repeat(64) },
    { RELEASE_ADMIN_ONLY: 'true' },
    { RELEASE_OPERATION: 'prepare_order_archive_release' }
  ])
    dispatchFixture(
      policy,
      baseline,
      ({ execute, parametersFile, awsLog }) => {
        assert.throws(execute, (error) => error.status === 1);
        assert.equal(existsSync(parametersFile), false);
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      },
      { ...valid, ...invalid }
    );
});

function approvedRuntimeTransport(
  root,
  env,
  reject = false,
  identity = 'recharge-pro-menu-b8-20261005'
) {
  const interpreter = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8'
  }).trim();
  writeFileSync(
    join(root, 'bin', 'python3'),
    `#!/bin/sh\nif [ "$2" = --check-fixed-recharge-scope ]; then\n  [ "$3" = --fixed-recharge-profile ] && [ "$4" = "$TASK_EXPECTED_FIXED_PROFILE" ] || exit 32\n  printf '%s\\n' checked >> "$TASK_PROFILE_CHECK_LOG"\n  exit ${reject ? 31 : 0}\nfi\nexec "$TASK_REAL_PYTHON" "$@"\n`,
    { mode: 0o755 }
  );
  return {
    ...env,
    HISTORICAL_EXCEPTION: identity,
    EXPECTED_CURRENT:
      identity === 'recharge-pro-menu-b8-20261005'
        ? 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'
        : identity === 'recharge-pro-main80-20261006'
          ? 'b91b626a71ed2c7c2473d080551b3b10b693b0cb'
          : '7f70688b9bf53a071a0a324ca558aeabc4ced2e3',
    TASK_EXPECTED_FIXED_PROFILE: identity,
    TASK_REAL_PYTHON: interpreter,
    TASK_PROFILE_CHECK_LOG: join(root, 'profile-check.log')
  };
}

test('fixed recharge selection permits only its exact release scope and preserves the independent approval gate', () => {
  const baseline = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0';
  const policy = 'recharge-pro-menu-b8-20261005';
  for (const override of [
    null,
    { EXPECTED_CURRENT: 'a'.repeat(40) },
    { RELEASE_ADMIN_ONLY: 'true' },
    { RELEASE_ADMIN_ONLY: 'unexpected' },
    { RELEASE_OPERATION: 'prepare_order_archive_release' },
    { RELEASE_OPERATION: 'prepare_post_cleanup_release' },
    { RELEASE_OPERATION: 'verify_access' },
    { REUSE_IMAGE_RUN: '222' },
    { REUSE_IMAGE_COMMIT: 'b'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '222' },
    { REUSE_IMAGE_RUN_ATTEMPT: '1' },
    { POST_CLEANUP_SEAL_SHA256: 'e'.repeat(64) },
    { ORDER_ARCHIVE_SEAL_SHA256: 'e'.repeat(64) }
  ])
    fixture(({ root, env, log }) => {
      const execute = () =>
        execFileSync('bash', ['scripts/production-release/validate-release-selection.sh'], {
          env: {
            ...env,
            HISTORICAL_EXCEPTION: policy,
            EXPECTED_CURRENT: baseline,
            RELEASE_ADMIN_ONLY: 'false',
            ...override
          },
          stdio: 'pipe'
        });
      if (override) assert.throws(execute, (error) => error.status === 1);
      else execute();
      assert.equal(readFileSync(log, 'utf8'), '');
      assert.equal(existsSync(env.GITHUB_ENV), false);
      assert.equal(existsSync(join(root, '.deploy/production-release/ssm-999999.json')), false);
    });

  // Exercise actual entries with an unapproved synthetic profile without
  // reversing a separately approved repository profile or running that scope.
  for (const entry of ['build-images', 'push-images', 'dispatch'])
    fixture(({ root, env, log }) => {
      const scripts = join(root, 'scripts/production-release');
      mkdirSync(scripts, { recursive: true });
      for (const name of [
        'build-images.sh',
        'push-images.sh',
        'dispatch.sh',
        'validate-release-selection.sh',
        'remote-deploy.py'
      ])
        writeFileSync(
          join(scripts, name),
          readFileSync(join(process.cwd(), 'scripts/production-release', name))
        );
      mkdirSync(join(root, 'deploy/aws'), { recursive: true });
      const manifest = JSON.parse(readFileSync(`deploy/aws/${policy}.json`, 'utf8'));
      manifest.enabled = false;
      manifest.approvalStatus = 'NOT_APPROVED';
      writeFileSync(join(root, `deploy/aws/${policy}.json`), JSON.stringify(manifest));
      assert.throws(
        () =>
          execFileSync('bash', [join(scripts, `${entry}.sh`)], {
            cwd: root,
            env: {
              ...env,
              HISTORICAL_EXCEPTION: policy,
              EXPECTED_CURRENT: baseline,
              RELEASE_ADMIN_ONLY: 'false',
              SOURCE_TREE: 'c'.repeat(40),
              QUALITY_RUN_ID: '111'
            },
            stdio: 'pipe'
          }),
        (error) =>
          error.status === 1 &&
          String(error.stderr).includes(
            'Fixed recharge runtime scope unavailable; raw output suppressed'
          )
      );
      assert.equal(readFileSync(log, 'utf8'), '');
      assert.equal(existsSync(env.GITHUB_ENV), false);
      assert.equal(existsSync(join(root, '.deploy/production-release/ssm-999999.json')), false);
    });
});

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
        TASK_EXPECTED_FIXED_PROFILE: transport.TASK_EXPECTED_FIXED_PROFILE,
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
  const cache = workflowSteps.find(
    (step) => step.name === 'Verify or maintain recoverable unused project image cache'
  );
  for (const historical_exception of [
    'recharge-pro-menu-b8-20261005',
    'recharge-pro-menu-7f-20261005'
  ])
    assert.equal(
      new Function('inputs', `return (${cache.if});`)({
        operation: 'release',
        historical_exception
      }),
      false
    );
  assert.ok(
    workflow.includes(
      "inputs.operation == 'release' && inputs.historical_exception != 'recharge-pro-menu-b8-20261005' && inputs.historical_exception != 'recharge-pro-menu-7f-20261005'"
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
            TASK_EXPECTED_FIXED_PROFILE: transport.TASK_EXPECTED_FIXED_PROFILE,
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

function fixedRechargeReadbackFixture(run, identity = 'recharge-pro-menu-b8-20261005') {
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
    const profile = JSON.parse(readFileSync(`deploy/aws/${identity}.json`, 'utf8'));
    profile.enabled = true;
    profile.approvalStatus = 'APPROVED';
    if (identity === 'recharge-pro-menu-7f-20261005')
      profile.baselineRelease.deploymentRun = 'github-actions-37333706418-1';
    for (const key of [
      'manifestSha256',
      'beforeAuditSha256',
      'afterAuditSha256',
      'composeSha256',
      'overrideRawSha256',
      'overrideCanonicalSha256'
    ])
      if (
        identity !== 'recharge-pro-main80-20261006' &&
        (key !== 'composeSha256' || identity !== 'recharge-pro-menu-b8-20261005')
      )
        profile.baselineRelease[key] = 'd'.repeat(64);
    for (const key of ['candidateSourceSha256', 'carriedSourceOnlySha256', 'controlSourceSha256'])
      for (const name of Object.keys(profile[key]))
        if (
          identity !== 'recharge-pro-main80-20261006' ||
          (key !== 'carriedSourceOnlySha256' &&
            ![
              'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
              'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py',
              'scripts/v2-registration-finance-audit.mjs',
              'scripts/v2-registration-finance-audit.test.mjs'
            ].includes(name))
        )
          profile[key][name] = 'e'.repeat(64);
    const profileFile = join(root, `deploy/aws/${identity}.json`);
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
      id: identity,
      status: 'VERIFIED',
      currentCommit: env.RELEASE_COMMIT,
      sourceTree: 'c'.repeat(40),
      previousCommit: profile.expectedCurrent,
      profileSha256: digest,
      servicesUpdated: ['auto-recharge'],
      preservedServiceCount: 6,
      checkCount: identity === 'recharge-pro-main80-20261006' ? 49 : 48,
      executedCheckCount: identity === 'recharge-pro-main80-20261006' ? 49 : 48,
      unavailableCheckCount: 0,
      violationCount: identity === 'recharge-pro-main80-20261006' ? 0 : 6,
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
          FIXED_RECHARGE_PROFILE: identity,
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

test('fixed 7f builds and pushes only recharge using its own approval precheck', () => {
  fixture(({ root, env, log }) => {
    const profileEnv = approvedRuntimeTransport(root, env, false, 'recharge-pro-menu-7f-20261005');
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env: profileEnv });
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env: profileEnv });
    const operations = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(operations.filter((line) => line.startsWith('build ')).length, 1);
    assert.ok(
      operations
        .find((line) => line.startsWith('build '))
        .includes('auto-recharge/worker/Dockerfile')
    );
    const pushes = operations.filter((line) => line.startsWith('push '));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].endsWith('-auto-recharge'));
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
    assert.deepEqual(readFileSync(profileEnv.TASK_PROFILE_CHECK_LOG, 'utf8').trim().split('\n'), [
      'checked',
      'checked'
    ]);
  });
});

test('fixed 7f prevents Docker work for a different baseline, reuse or failed approval', () => {
  for (const overrides of [
    { EXPECTED_CURRENT: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' },
    { REUSE_IMAGE_COMMIT: 'b'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '99999' },
    { REUSE_IMAGE_RUN_ATTEMPT: '1' },
    { rejectedApproval: true }
  ]) {
    fixture(({ root, env, log }) => {
      const { rejectedApproval, ...fields } = overrides;
      const profileEnv = approvedRuntimeTransport(
        root,
        env,
        rejectedApproval,
        'recharge-pro-menu-7f-20261005'
      );
      for (const file of ['build-images.sh', 'push-images.sh'])
        assert.throws(() =>
          execFileSync('bash', [`scripts/production-release/${file}`], {
            env: { ...profileEnv, ...fields },
            stdio: 'pipe'
          })
        );
      assert.equal(readFileSync(log, 'utf8'), '');
      assert.equal(existsSync(env.GITHUB_ENV), false);
    });
  }
});

test('fixed 7f dispatch selects its exclusive runtime flag and rejects changes before AWS', () => {
  const identity = 'recharge-pro-menu-7f-20261005';
  const current = '7f70688b9bf53a071a0a324ca558aeabc4ced2e3';
  dispatchFixture(identity, current, ({ execute, parametersFile, root, env }) => {
    const transport = approvedRuntimeTransport(root, env, false, identity);
    execute({
      TASK_REAL_PYTHON: transport.TASK_REAL_PYTHON,
      TASK_PROFILE_CHECK_LOG: transport.TASK_PROFILE_CHECK_LOG,
      TASK_EXPECTED_FIXED_PROFILE: transport.TASK_EXPECTED_FIXED_PROFILE
    });
    const command = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1);
    assert.equal(command.split(' ').filter((arg) => arg === '--recharge-pro-menu-7f').length, 1);
    assert.equal(command.includes('--recharge-pro-menu-b8'), false);
    assert.equal(command.includes('--historical-finance-'), false);
  });
  for (const overrides of [
    { EXPECTED_CURRENT: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' },
    { RELEASE_ADMIN_ONLY: 'true' },
    { REUSE_IMAGE_COMMIT: 'b'.repeat(40) },
    { REUSE_IMAGE_RUN_ID: '99999' },
    { REUSE_IMAGE_RUN_ATTEMPT: '1' },
    { rejectedApproval: true },
    { TASK_EXPECTED_FIXED_PROFILE: 'recharge-pro-menu-b8-20261005' }
  ])
    dispatchFixture(identity, current, ({ execute, parametersFile, awsLog, root, env }) => {
      const { rejectedApproval, ...fields } = overrides;
      const transport = approvedRuntimeTransport(root, env, rejectedApproval, identity);
      assert.throws(() =>
        execute({
          TASK_REAL_PYTHON: transport.TASK_REAL_PYTHON,
          TASK_PROFILE_CHECK_LOG: transport.TASK_PROFILE_CHECK_LOG,
          TASK_EXPECTED_FIXED_PROFILE: transport.TASK_EXPECTED_FIXED_PROFILE,
          ...fields
        })
      );
      assert.equal(existsSync(parametersFile), false);
      assert.equal(readFileSync(awsLog, 'utf8'), '');
    });
});

test('fixed 7f approval JSON alone invokes actual profile checks and both profiles skip cache', () => {
  const commands = guardCommands(['deploy/aws/recharge-pro-menu-7f-20261005.json']);
  assert.equal(
    commands.filter(
      (command) => command === 'python3 -B scripts/production-release/remote-deploy.test.py'
    ).length,
    1
  );
  assert.ok(commands.includes('node --test scripts/v2-release-history-policy.test.mjs'));
  assert.ok(commands.includes('node --test scripts/v2-release-maintenance-policy.test.mjs'));
  const workflow = readFileSync('.github/workflows/production-release.yml', 'utf8');
  const cacheStep = workflow
    .split('name: Verify or maintain recoverable unused project image cache')[1]
    .split('env:')[0];
  for (const identity of ['recharge-pro-menu-b8-20261005', 'recharge-pro-menu-7f-20261005'])
    assert.ok(cacheStep.includes(`inputs.historical_exception != '${identity}'`));
  assert.ok(workflow.includes('--fixed-recharge-profile "$FIXED_RECHARGE_PROFILE"'));
});

test('fixed 7f actual independent readback binds its own profile and rejects cross-wired receipts', () => {
  const identity = 'recharge-pro-menu-7f-20261005';
  fixedRechargeReadbackFixture(({ root, execute, receipt, digest, awsLog }) => {
    assert.deepEqual(JSON.parse(execute()), receipt);
    const file = join(root, '.deploy/production-release/fixed-recharge-readback.json');
    const parameters = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Buffer.byteLength(JSON.stringify(parameters)) < 20 * 1024);
    const literals = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          'import ast,json,shlex,sys; p=shlex.split(json.load(open(sys.argv[1]))["commands"][0]); assert p[:2]==["python3","-c"] and len(p)==3; print(json.dumps([n.value for n in ast.walk(ast.parse(p[2])) if isinstance(n,ast.Constant) and isinstance(n.value,str)]))',
          file
        ],
        { encoding: 'utf8' }
      )
    );
    for (const binding of [
      identity,
      '--fixed-recharge-profile',
      '--check-fixed-recharge-deployment',
      digest,
      receipt.currentCommit,
      receipt.sourceTree
    ])
      assert.ok(literals.includes(binding), binding);
    for (const changed of [
      { id: 'recharge-pro-menu-b8-20261005' },
      { previousCommit: 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' },
      { preservedServiceCount: 5 },
      { environmentUnchanged: false },
      { checkCount: true },
      { cacheStatus: 'CLEANED' },
      { unexpected: 'PRIVATE_SYNTHETIC_SENTINEL' }
    ])
      assert.throws(
        () =>
          execute(
            `FIXED_RECHARGE_RELEASE_VERIFIED ${JSON.stringify({ ...receipt, ...changed })}\n`
          ),
        (error) =>
          error.status !== 0 &&
          error.stdout === '' &&
          String(error.stderr).includes('raw output suppressed') &&
          !String(error.stderr).includes('PRIVATE_SYNTHETIC_SENTINEL')
      );
    writeFileSync(awsLog, '');
    for (const profileId of ['recharge-pro-menu-b8-20261005', 'unreviewed']) {
      assert.throws(() => execute(undefined, { FIXED_RECHARGE_PROFILE: profileId }));
      assert.equal(readFileSync(awsLog, 'utf8'), '');
    }
  }, identity);
});

test('Pro business CI prepares the locked Python Chromium before the full Pro module in one worker cache', () => {
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker';
  for (const changed of [`${worker}/plan_selection.py`, `${worker}/test_pro.py`])
    fixture(({ root, env }) => {
      const log = join(root, 'pro-ci-commands.txt');
      writeFileSync(env.TASK_CHANGED_PATHS, changed);
      writeFileSync(
        join(root, 'bin', 'python3'),
        '#!/bin/sh\nprintf "%s\\n" "$*" "$PWD" "$PLAYWRIGHT_BROWSERS_PATH" "$PYTHONDONTWRITEBYTECODE" >> "$TASK_PRO_CI_LOG"\n',
        { mode: 0o755 }
      );
      execFileSync(
        process.execPath,
        ['scripts/ci-recharge-check.mjs', 'connector', 'a'.repeat(40)],
        {
          env: { ...env, TASK_PRO_CI_LOG: log, PLAYWRIGHT_BROWSERS_PATH: 'unrelated-cache' },
          stdio: 'pipe'
        }
      );
      const commands = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(commands.length, 8, changed);
      assert.equal(commands[0], '-m playwright install chromium');
      assert.equal(commands[1], join(process.cwd(), worker));
      assert.equal(commands[2], join(process.cwd(), worker, '.browsers'));
      assert.equal(commands[3], '1');
      const tests = commands[4].split(' ');
      assert.deepEqual(tests.slice(0, 2), ['-m', 'unittest']);
      assert.equal(tests.filter((name) => name === 'test_pro').length, 1);
      assert.equal(tests.includes('test_pro.ProMenuDiagnosticsTests'), false);
      for (const regression of [
        'test_worker_isolation',
        'test_registration_browser',
        'test_server_proxy'
      ])
        assert.ok(tests.includes(regression), regression);
      assert.deepEqual(commands.slice(5), commands.slice(1, 4));
    });
});

test('control-only and other worker CI changes keep the existing Pro subset without installing Chromium', () => {
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker';
  for (const changed of [
    'deploy/aws/recharge-pro-main80-20261006.json',
    `${worker}/pay.py`,
    `${worker}/plan_selection.py.backup`,
    `${worker}/test_pro.py/extra`
  ])
    fixture(({ root, env }) => {
      const log = join(root, 'pro-subset-commands.txt');
      writeFileSync(env.TASK_CHANGED_PATHS, changed);
      writeFileSync(
        join(root, 'bin', 'python3'),
        '#!/bin/sh\nprintf "%s\\n" "$*" "$PLAYWRIGHT_BROWSERS_PATH" >> "$TASK_PRO_CI_LOG"\n',
        { mode: 0o755 }
      );
      execFileSync(
        process.execPath,
        ['scripts/ci-recharge-check.mjs', 'connector', 'a'.repeat(40)],
        {
          env: { ...env, TASK_PRO_CI_LOG: log, PLAYWRIGHT_BROWSERS_PATH: 'existing-cache' },
          stdio: 'pipe'
        }
      );
      const commands = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(commands.length, 2);
      const tests = commands[0].split(' ');
      assert.equal(tests.filter((name) => name === 'test_pro.ProMenuDiagnosticsTests').length, 1);
      assert.equal(tests.includes('test_pro'), false);
      assert.equal(commands[1], 'existing-cache');
    });
});

test('Pro CI Chromium preparation failure prevents the unittest command from running', () => {
  fixture(({ root, env }) => {
    const log = join(root, 'failed-pro-ci-commands.txt');
    writeFileSync(
      env.TASK_CHANGED_PATHS,
      'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py'
    );
    writeFileSync(
      join(root, 'bin', 'python3'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_PRO_CI_LOG"\nexit 29\n',
      { mode: 0o755 }
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['scripts/ci-recharge-check.mjs', 'connector', 'a'.repeat(40)],
        {
          env: { ...env, TASK_PRO_CI_LOG: log },
          stdio: 'pipe'
        }
      )
    );
    assert.equal(readFileSync(log, 'utf8'), '-m playwright install chromium\n');
  });
});

test('fixed main80 approved transport builds and pushes one fresh recharge image only', () => {
  fixture(({ root, env, log }) => {
    const transport = approvedRuntimeTransport(root, env, false, 'recharge-pro-main80-20261006');
    execFileSync('bash', ['scripts/production-release/build-images.sh'], {
      env: transport,
      stdio: 'pipe'
    });
    execFileSync('bash', ['scripts/production-release/push-images.sh'], {
      env: transport,
      stdio: 'pipe'
    });
    const operations = readFileSync(log, 'utf8').trim().split('\n');
    const builds = operations.filter((line) => line.startsWith('build '));
    const pushes = operations.filter((line) => line.startsWith('push '));
    assert.equal(builds.length, 1);
    assert.ok(builds[0].includes('auto-recharge/worker/Dockerfile'));
    assert.ok(builds[0].includes(`${env.RELEASE_COMMIT}-999999-1-auto-recharge`));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].endsWith('-auto-recharge'));
    assert.equal(
      operations.some((line) => /-auto-registration|-api|-admin|-migrate/.test(line)),
      false
    );
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
    assert.deepEqual(readFileSync(transport.TASK_PROFILE_CHECK_LOG, 'utf8').trim().split('\n'), [
      'checked',
      'checked'
    ]);
  });
});

const main80RejectedSelections = [
  { EXPECTED_CURRENT: '4c200c4ae08bb8214ff8e0955f8237ce85069cc6' },
  { EXPECTED_CURRENT: '651f62902fba74ddd189b34932084573b39d245c' },
  { EXPECTED_CURRENT: 'fd3a6da610c505c2b7a51601cf854182991ffd12' },
  { EXPECTED_CURRENT: '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b' },
  { EXPECTED_CURRENT: '3ca300486d0edfadda83c094a48474a63959fce7' },
  { EXPECTED_CURRENT: '7f70688b9bf53a071a0a324ca558aeabc4ced2e3' },
  { RELEASE_ADMIN_ONLY: 'true' },
  { RELEASE_ADMIN_ONLY: 'unexpected' },
  { RELEASE_OPERATION: 'prepare_order_archive_release' },
  { RELEASE_OPERATION: 'prepare_post_cleanup_release' },
  { RELEASE_OPERATION: 'verify_access' },
  { RELEASE_OPERATION: 'cleanup_unused_cache' },
  { REUSE_IMAGE_RUN: '222' },
  { REUSE_IMAGE_COMMIT: 'b'.repeat(40) },
  { REUSE_IMAGE_RUN_ID: '222' },
  { REUSE_IMAGE_RUN_ATTEMPT: '1' },
  { POST_CLEANUP_SEAL_SHA256: 'e'.repeat(64) },
  { ORDER_ARCHIVE_SEAL_SHA256: 'e'.repeat(64) },
  { ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: 'f'.repeat(64) },
  { HISTORICAL_EXCEPTION: 'recharge-pro-menu-b8-20261005' },
  { HISTORICAL_EXCEPTION: 'recharge-pro-menu-7f-20261005' },
  { HISTORICAL_EXCEPTION: 'historical-finance-20261005-order-archive' },
  { HISTORICAL_EXCEPTION: 'recharge-pro-main80-20261007' },
  { HISTORICAL_EXCEPTION: 'recharge-pro-main80-20261006 --admin-only' },
  { rejectedApproval: true },
  { TASK_EXPECTED_FIXED_PROFILE: 'recharge-pro-menu-b8-20261005' }
];

test('fixed main80 build push and dispatch reject cross-wiring reuse external seals and preparation before effects', () => {
  const identity = 'recharge-pro-main80-20261006';
  const baseline = 'b91b626a71ed2c7c2473d080551b3b10b693b0cb';
  for (const override of main80RejectedSelections) {
    const { rejectedApproval, ...fields } = override;
    for (const entry of ['build-images', 'push-images'])
      fixture(({ root, env, log }) => {
        const transport = approvedRuntimeTransport(root, env, rejectedApproval, identity);
        assert.throws(() =>
          execFileSync('bash', [`scripts/production-release/${entry}.sh`], {
            env: { ...transport, ...fields },
            stdio: 'pipe'
          })
        );
        assert.equal(readFileSync(log, 'utf8'), '', `${entry}: external command attempted`);
        assert.equal(existsSync(env.GITHUB_ENV), false);
      });
    dispatchFixture(identity, baseline, ({ execute, parametersFile, awsLog, root, env }) => {
      const transport = approvedRuntimeTransport(root, env, rejectedApproval, identity);
      assert.throws(
        () => execute({ ...transport, EXPECTED_CURRENT: baseline, ...fields }),
        JSON.stringify(fields)
      );
      assert.equal(existsSync(parametersFile), false);
      assert.equal(readFileSync(awsLog, 'utf8'), '');
    });
  }
});

test('fixed main80 dispatch binds one exclusive flag and the fresh candidate image identity', () => {
  const identity = 'recharge-pro-main80-20261006';
  const baseline = 'b91b626a71ed2c7c2473d080551b3b10b693b0cb';
  dispatchFixture(identity, baseline, ({ execute, parametersFile, awsLog, root, env }) => {
    const transport = approvedRuntimeTransport(root, env, false, identity);
    execute({ ...transport, EXPECTED_CURRENT: baseline });
    const args = JSON.parse(readFileSync(parametersFile, 'utf8')).commands.at(-1).split(' ');
    assert.equal(args.filter((arg) => arg === '--recharge-pro-main80').length, 1);
    assert.equal(args[args.indexOf('--expected-current') + 1], baseline);
    assert.equal(args[args.indexOf('--image-commit') + 1], env.RELEASE_COMMIT);
    assert.equal(args[args.indexOf('--image-run-id') + 1], '999999');
    assert.equal(args[args.indexOf('--image-run-attempt') + 1], '1');
    assert.equal(
      args.some((arg) =>
        /^(--historical-finance-|--recharge-pro-menu-|--admin-only|--order-archive-|--post-cleanup-)/.test(
          arg
        )
      ),
      false
    );
    assert.equal(
      readFileSync(awsLog, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('ssm send-command ')).length,
      1
    );
  });
});

test('fixed main80 dispatch rejects malformed candidate bindings before generating parameters or calling AWS', () => {
  const identity = 'recharge-pro-main80-20261006';
  const baseline = 'b91b626a71ed2c7c2473d080551b3b10b693b0cb';
  for (const fields of [
    { RELEASE_COMMIT: 'B'.repeat(40) },
    { RELEASE_COMMIT: 'b'.repeat(40) + ' --admin-only' },
    { SOURCE_TREE: 'c'.repeat(39) },
    { QUALITY_RUN_ID: '0' },
    { QUALITY_RUN_ID: '111 --historical-finance-order-archive' },
    { RELEASE_REPOSITORY: 'unreviewed.example/id-business-v2-release' }
  ])
    dispatchFixture(identity, baseline, ({ execute, parametersFile, awsLog, root, env }) => {
      const transport = approvedRuntimeTransport(root, env, false, identity);
      assert.throws(
        () => execute({ ...transport, EXPECTED_CURRENT: baseline, ...fields }),
        JSON.stringify(fields)
      );
      assert.equal(existsSync(parametersFile), false);
      assert.equal(readFileSync(awsLog, 'utf8'), '');
    });
});

test('main80 disabled real-parser profile refuses all entries before Docker AWS parameters or env changes', () => {
  const identity = 'recharge-pro-main80-20261006';
  for (const entry of ['build-images', 'push-images', 'dispatch'])
    fixture(({ root, env, log }) => {
      const scripts = join(root, 'scripts/production-release');
      mkdirSync(scripts, { recursive: true });
      for (const name of [
        'build-images.sh',
        'push-images.sh',
        'dispatch.sh',
        'validate-release-selection.sh',
        'remote-deploy.py'
      ])
        writeFileSync(join(scripts, name), readFileSync(`scripts/production-release/${name}`));
      mkdirSync(join(root, 'deploy/aws'), { recursive: true });
      const disabledProfile = JSON.parse(readFileSync(`deploy/aws/${identity}.json`, 'utf8'));
      disabledProfile.enabled = false;
      disabledProfile.approvalStatus = 'NOT_APPROVED';
      writeFileSync(join(root, `deploy/aws/${identity}.json`), JSON.stringify(disabledProfile));
      assert.throws(
        () =>
          execFileSync('bash', [join(scripts, `${entry}.sh`)], {
            cwd: root,
            env: {
              ...env,
              HISTORICAL_EXCEPTION: identity,
              EXPECTED_CURRENT: 'b91b626a71ed2c7c2473d080551b3b10b693b0cb',
              RELEASE_ADMIN_ONLY: 'false',
              SOURCE_TREE: 'c'.repeat(40),
              QUALITY_RUN_ID: '111'
            },
            stdio: 'pipe'
          }),
        (error) => error.status !== 0 && String(error.stderr).includes('raw output suppressed')
      );
      assert.equal(readFileSync(log, 'utf8'), '');
      assert.equal(existsSync(env.GITHUB_ENV), false);
      assert.equal(existsSync(join(root, '.deploy/production-release/ssm-999999.json')), false);
    });
});

test('main80 profile guard and workflow choose its approval readback and skipped cache independently', () => {
  const identity = 'recharge-pro-main80-20261006';
  const commands = guardCommands([`deploy/aws/${identity}.json`]);
  assert.equal(
    commands.filter(
      (value) => value === 'python3 -B scripts/production-release/remote-deploy.test.py'
    ).length,
    1
  );
  assert.ok(workflowInputs.historical_exception.options.includes(identity));
  const input = { operation: 'release', historical_exception: identity, reuse_image_run: '' };
  const enabled = workflowSteps
    .filter((step) => !step.if || new Function('inputs', `return (${step.if});`)(input))
    .map((step) => step.name);
  for (const name of [
    'Verify fixed recharge runtime approval',
    'Validate release policy and reviewed seal selection',
    'Build images on the GitHub runner',
    'Verify fixed recharge deployment independently',
    'Record skipped cache maintenance for fixed recharge release'
  ])
    assert.ok(enabled.includes(name), name);
  for (const name of [
    'Verify fixed mailbox release selection',
    'Verify reusable build and unchanged application source',
    'Verify or maintain recoverable unused project image cache'
  ])
    assert.equal(enabled.includes(name), false, name);
  const approval = workflowSteps.find(
    (step) => step.name === 'Verify fixed recharge runtime approval'
  );
  const readback = workflowSteps.find(
    (step) => step.name === 'Verify fixed recharge deployment independently'
  );
  assert.ok(
    approval.run.includes(
      `recharge-pro-main80-20261006) test "$EXPECTED_CURRENT" = b91b626a71ed2c7c2473d080551b3b10b693b0cb`
    )
  );
  assert.equal(
    new Function('inputs', `return (${readback.env.FIXED_RECHARGE_PROFILE.slice(3, -2)});`)(input),
    identity
  );
});

test('main80 actual readback parser accepts the 21-field 49-check proof and rejects old gates and raw extras', () => {
  const identity = 'recharge-pro-main80-20261006';
  fixedRechargeReadbackFixture(
    ({ root, execute, receipt, digest, awsLog, profile, profileFile }) => {
      const inheritedCommit = 'b91b626a71ed2c7c2473d080551b3b10b693b0cb';
      const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/';
      const inheritedBusinessNames = [
        `${worker}registration_browser.py`,
        `${worker}registration_job.py`,
        `${worker}test_registration.py`,
        `${worker}test_registration_browser.py`,
        `${worker}test_registration_auto_code.py`,
        'docs/AUTO_REGISTRATION.md'
      ];
      const inheritedControlNames = [
        'deploy/aws/registration-worker-b8-80-20261006.json',
        'scripts/production-release/registration-only-transport.test.py',
        'deploy/aws/registration-worker-956-20261006.json',
        'deploy/aws/registration-worker-85-20261006.json',
        'deploy/aws/registration-worker-86-20261006.json',
        'deploy/aws/registration-worker-87-20261006.json',
        'deploy/aws/registration-worker-88-20261006.json'
      ];
      const inheritedNames = [...inheritedBusinessNames, ...inheritedControlNames];
      const inherited = Object.fromEntries(
        inheritedNames.map((name) => [
          name,
          createHash('sha256')
            .update(execFileSync('git', ['show', `${inheritedCommit}:${name}`]))
            .digest('hex')
        ])
      );
      assert.equal(profile.enabled, true);
      assert.equal(profile.approvalStatus, 'APPROVED');
      assert.equal(profile.expectedCurrent, inheritedCommit);
      assert.equal(profile.baselineRelease.commit, inheritedCommit);
      assert.equal(profile.baselineRelease.sourceTree, '0108ff3dda67337102d96bef08280ee93d8bcb36');
      assert.equal(
        profile.baselineRelease.previousCommit,
        '4c200c4ae08bb8214ff8e0955f8237ce85069cc6'
      );
      assert.equal(
        profile.financeValidator.sourceCommit,
        '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'
      );
      assert.deepEqual(profile.carriedSourceOnlySha256, inherited);
      assert.equal(Object.keys(profile.sourceModes).length, 30);
      for (const name of inheritedNames) assert.equal(profile.sourceModes[name], 0o644);
      assert.equal(Object.keys(receipt).length, 21);
      assert.equal(receipt.previousCommit, inheritedCommit);
      assert.equal(receipt.violationCount, 0);
      assert.deepEqual(JSON.parse(execute()), receipt);
      const parameters = JSON.parse(
        readFileSync(join(root, '.deploy/production-release/fixed-recharge-readback.json'), 'utf8')
      );
      assert.ok(Buffer.byteLength(JSON.stringify(parameters)) < 20 * 1024);
      assert.ok(parameters.commands[0].includes(identity));
      assert.ok(parameters.commands[0].includes(digest));
      const originalProfile = readFileSync(profileFile, 'utf8');
      const inheritedName = inheritedNames[0];
      const oldSourceHash = createHash('sha256')
        .update(
          execFileSync('git', ['show', `80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b:${inheritedName}`])
        )
        .digest('hex');
      assert.notEqual(oldSourceHash, inherited[inheritedName]);
      const mutations = [
        (value) => {
          value.carriedSourceOnlySha256 = {};
          for (const name of inheritedNames) delete value.sourceModes[name];
        },
        (value) => {
          delete value.carriedSourceOnlySha256[inheritedName];
          delete value.sourceModes[inheritedName];
        },
        (value) => {
          value.carriedSourceOnlySha256['unreviewed/source.py'] = '1'.repeat(64);
          value.sourceModes['unreviewed/source.py'] = 0o644;
        },
        (value) => {
          value.carriedSourceOnlySha256[inheritedName] = '1'.repeat(64);
        },
        (value) => {
          value.carriedSourceOnlySha256[inheritedName] = oldSourceHash;
        },
        (value) => {
          value.sourceModes[inheritedName] = 0o755;
        },
        (value) => {
          value.candidateSourceSha256[inheritedName] = value.carriedSourceOnlySha256[inheritedName];
          delete value.carriedSourceOnlySha256[inheritedName];
        }
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(profile);
        mutate(changed);
        writeFileSync(profileFile, JSON.stringify(changed));
        const previousAws = readFileSync(awsLog, 'utf8');
        const previousParameters = readFileSync(
          join(root, '.deploy/production-release/fixed-recharge-readback.json'),
          'utf8'
        );
        try {
          assert.throws(
            () => execute(),
            (error) => error.status !== 0 && error.stdout === ''
          );
          assert.equal(readFileSync(awsLog, 'utf8'), previousAws);
          assert.equal(
            readFileSync(
              join(root, '.deploy/production-release/fixed-recharge-readback.json'),
              'utf8'
            ),
            previousParameters
          );
        } finally {
          writeFileSync(profileFile, originalProfile);
        }
      }
      for (const changed of [
        { id: 'recharge-pro-menu-7f-20261005' },
        { previousCommit: '3ca300486d0edfadda83c094a48474a63959fce7' },
        { previousCommit: '4c200c4ae08bb8214ff8e0955f8237ce85069cc6' },
        { previousCommit: '651f62902fba74ddd189b34932084573b39d245c' },
        { previousCommit: 'fd3a6da610c505c2b7a51601cf854182991ffd12' },
        { previousCommit: '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b' },
        { checkCount: 48 },
        { executedCheckCount: 48 },
        { violationCount: 5 },
        { violationCount: 6 },
        { checkCount: true },
        { unavailableCheckCount: 1 },
        { servicesUpdated: ['auto-recharge', 'auto-registration'] },
        { migrationStatus: 'APPLIED' },
        { unexpected: 'PRIVATE_SYNTHETIC_SENTINEL' }
      ])
        assert.throws(
          () =>
            execute(
              `FIXED_RECHARGE_RELEASE_VERIFIED ${JSON.stringify({ ...receipt, ...changed })}\n`
            ),
          (error) =>
            error.status !== 0 &&
            error.stdout === '' &&
            String(error.stderr).includes('raw output suppressed') &&
            !String(error.stderr).includes('PRIVATE_SYNTHETIC_SENTINEL')
        );
      writeFileSync(awsLog, '');
      for (const wrongProfile of [
        'recharge-pro-menu-7f-20261005',
        'recharge-pro-main80-20261007'
      ]) {
        assert.throws(() => execute(undefined, { FIXED_RECHARGE_PROFILE: wrongProfile }));
        assert.equal(readFileSync(awsLog, 'utf8'), '');
      }
    },
    identity
  );
});
