function withFirstRechargeWorkflow(value) {
  const result = structuredClone(value);
  const options = result.on.workflow_dispatch.inputs.operation.options;
  const index = options.indexOf('release_recharge_flow');
  assert.ok(index >= 0 && !options.includes('release_first_recharge'));
  options.splice(index + 1, 0, 'verify_first_recharge', 'release_first_recharge');
  const steps = result.jobs.release.steps;
  const find = (name) => {
    const matches = steps.filter((step) => step.name === name);
    assert.equal(matches.length, 1, name);
    return matches[0];
  };
  for (const name of [
    'Recover reviewed disk headroom before release preflight',
    'Build images on the GitHub runner',
    'Push immutable images',
    'Register complete release candidate and reserve pull headroom',
    'Deploy through the production instance',
    'Confirm published candidate and reclaim superseded local images',
    'Save disk lifecycle safe evidence'
  ]) {
    const step = find(name);
    const clause = "inputs.operation == 'release_recharge_flow'";
    assert.equal(step.if.split(clause).length, 2, name);
    step.if = step.if.replace(clause, clause + " || inputs.operation == 'release_first_recharge'");
  }
  const anchor = find('Verify recharge flow predecessor and idle workers before building');
  steps.splice(steps.indexOf(anchor) + 1, 0, {
    name: 'Verify first recharge predecessor and idle workers before building',
    if: "inputs.operation == 'verify_first_recharge' || inputs.operation == 'release_first_recharge'",
    run: 'python3 -B scripts/production-release/first-recharge-successor-readonly.py preflight'
  });
  const save = find('Save recharge flow build and independent runtime evidence');
  steps.splice(
    steps.indexOf(save) + 1,
    0,
    {
      name: 'Independently read back first recharge images and preserved services',
      if: "inputs.operation == 'release_first_recharge'",
      run: 'python3 -B scripts/production-release/first-recharge-successor-readonly.py readback'
    },
    {
      name: 'Save first recharge build and independent runtime evidence',
      if: "always() && (inputs.operation == 'verify_first_recharge' || inputs.operation == 'release_first_recharge')",
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        name: 'first-recharge-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.deploy/production-release/first-recharge-successor-*.json',
        'if-no-files-found': 'warn',
        'include-hidden-files': true,
        'retention-days': 14
      }
    }
  );
  return result;
}
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = '.github/workflows/production-release.yml';
const workflow = () =>
  loadYaml(readFileSync(new URL('../../' + workflowPath, import.meta.url), 'utf8'));

test('first recharge uses existing inputs and one production lock, with preflight before build and independent readback', () => {
  const value = workflow();
  assert.equal(value.concurrency.group, 'id-business-v2-production-release');
  assert.equal(value.concurrency['cancel-in-progress'], false);
  assert.equal(value.jobs.release.if, "github.ref == 'refs/heads/main'");
  assert.equal(
    value.jobs.release.env.API_FAULT_RESTORE_APPROVED,
    '${{ inputs.api_fault_restore_approved }}'
  );

  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const projection = 'c'.repeat(64);
  const context = '.deploy/production-release/first-recharge-successor-build-context';
  const helper = 'scripts/production-release/first-recharge-successor';

  function fixture(run) {
    const parent = resolve(root, '.runtime/first-recharge-release-20261014/entry-fixtures');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'owned-'));
    const bin = join(directory, 'bin');
    const log = join(directory, 'commands.jsonl');
    mkdirSync(bin);
    writeFileSync(log, '');
    const stub = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const file = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ENTRY_TEST_LOG, JSON.stringify([file, ...args]) + '\\n');
if (file === 'git') console.log((process.env.ENTRY_TEST_REMOTE || process.env.RELEASE_COMMIT) + '\\trefs/heads/main');
if (file === 'python3') {
  if (args.includes('-')) console.log(process.env.ENTRY_TEST_PROJECTION);
  if (process.env.ENTRY_TEST_FAIL_PYTHON && args.includes(process.env.ENTRY_TEST_FAIL_PYTHON)) process.exit(2);
}
if (file === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  const value = format.includes('source-tree') ? process.env.ENTRY_TEST_BAD_TREE || process.env.SOURCE_TREE : format.includes('projection-sha256') ? process.env.ENTRY_TEST_BAD_LABEL || process.env.ENTRY_TEST_PROJECTION : process.env.ENTRY_TEST_BAD_REVISION || process.env.RELEASE_COMMIT;
  console.log(value);
}
if (file === 'aws' && args.includes('describe-images')) console.log('sha256:' + 'd'.repeat(64));
`;
    for (const name of ['git', 'python3', 'docker', 'aws'])
      writeFileSync(join(bin, name), stub, { mode: 0o755 });
    const env = {
      PATH: bin + ':' + process.env.PATH,
      RELEASE_OPERATION: 'release_first_recharge',
      RELEASE_COMMIT: commit,
      EXPECTED_CURRENT: '568e9390a304a36edba86823d5d5b31e5506763b',
      SOURCE_TREE: tree,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      QUALITY_RUN_ID: '456',
      HISTORICAL_EXCEPTION: 'none',
      RELEASE_REPOSITORY:
        '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
      AWS_REGION: 'ap-northeast-1',
      PRODUCTION_INSTANCE_ID: 'i-05836da38606e633c',
      API_FAULT_RESTORE_APPROVED: 'true',
      GITHUB_ENV: join(directory, 'github-env'),
      ENTRY_TEST_LOG: log,
      ENTRY_TEST_PROJECTION: projection
    };
    const execute = (script, patch = {}) => {
      writeFileSync(log, '');
      const result = spawnSync('bash', [resolve(root, 'scripts/production-release', script)], {
        cwd: directory,
        env: { ...env, ...patch },
        encoding: 'utf8'
      });
      return {
        ...result,
        calls: readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      };
    };
    try {
      return run(execute, env);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }

  test('recharge selection rejects aliases, stale baseline, unapproved restoration and foreign controls before side effects', () => {
    fixture((execute) => {
      assert.equal(execute('validate-release-selection.sh').status, 0);
      assert.equal(
        execute('validate-release-selection.sh', {
          RELEASE_OPERATION: 'verify_first_recharge',
          API_FAULT_RESTORE_APPROVED: 'false'
        }).status,
        0
      );
      for (const patch of [
        { API_FAULT_RESTORE_APPROVED: '' },
        { API_FAULT_RESTORE_APPROVED: 'false' },
        { API_FAULT_RESTORE_APPROVED: 'TRUE' },
        { REUSE_IMAGE_RUN: '1' },
        { REUSE_IMAGE_COMMIT: commit },
        { REUSE_IMAGE_RUN_ID: '1' },
        { REUSE_IMAGE_RUN_ATTEMPT: '1' },
        { RELEASE_BROWSER_CACHE_IMAGE: 'old-build' },
        { RELEASE_BROWSER_CACHE_IMAGE_ID: 'sha256:' + projection },
        { POST_CLEANUP_SEAL_SHA256: projection },
        { ORDER_ARCHIVE_SEAL_SHA256: projection },
        { ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: projection },
        { CACHE_PLAN_SHA256: projection },
        { DIAGNOSTIC_COMMAND_ID: 'old-command' },
        { HISTORICAL_EXCEPTION: 'historical-finance-20261005' },
        { RELEASE_ADMIN_ONLY: 'true' },
        { GITHUB_REF: 'refs/heads/other' },
        { RELEASE_COMMIT: 'invalid' },
        { EXPECTED_CURRENT: 'e'.repeat(40) },
        { SOURCE_TREE: 'invalid' },
        { RELEASE_OPERATION: 'release_first_recharge_other' },
        { RELEASE_OPERATION: 'verify_first_recharge_other' }
      ]) {
        const result = execute('validate-release-selection.sh', patch);
        assert.notEqual(result.status, 0, JSON.stringify(patch));
        assert.deepEqual(result.calls, []);
      }
    });
  });

  test('recharge build uses separate API/Admin contexts, three fresh images, correct build ID and producer proof', () => {
    fixture((execute) => {
      const result = execute('build-images.sh');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.calls.filter((call) => call[0] === 'python3' && call[2]?.startsWith(helper)),
        [
          ['python3', '-B', helper + '.py', 'prepare'],
          ['python3', '-B', helper + '.py', 'proof']
        ]
      );
      const builds = result.calls.filter((call) => call[0] === 'docker' && call[1] === 'build');
      assert.equal(builds.length, 3);
      assert.deepEqual(
        builds.map((call) => call[call.indexOf('-t') + 1].split('-').at(-1)),
        ['api', 'admin', 'migrate']
      );
      assert.deepEqual(
        builds.map((call) => call.at(-1)),
        [context + '/api', context + '/admin', context + '/api']
      );
      assert.deepEqual(
        builds.map((call) => call[call.indexOf('-f') + 1]),
        [
          context + '/api/apps/api/Dockerfile.mysql',
          context + '/admin/apps/admin/Dockerfile',
          context + '/api/apps/api/Dockerfile.mysql'
        ]
      );
      for (const call of builds) {
        assert.ok(call.includes('org.opencontainers.image.revision=' + commit));
        assert.ok(call.includes('id-business-v2.source-tree=' + tree));
        assert.ok(
          call.includes('id-business-v2.first-recharge-successor-projection-sha256=' + projection)
        );
        assert.ok(!call.includes('--cache-from'));
      }
      assert.ok(builds[1].includes('V2_BUILD_ID=v2-' + commit));
      const failed = execute('build-images.sh', { ENTRY_TEST_FAIL_PYTHON: 'prepare' });
      assert.notEqual(failed.status, 0);
      assert.ok(failed.calls.every((call) => call[0] !== 'docker'));
    });
  });

  test('recharge push checks all revision/tree/projection labels before pushing exact three image tags', () => {
    fixture((execute, env) => {
      const result = execute('push-images.sh');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.calls
          .filter((call) => call[0] === 'docker' && call[1] === 'push')
          .map((call) => call[2]),
        ['api', 'admin', 'migrate'].map(
          (name) => `${env.RELEASE_REPOSITORY}:${commit}-123-1-${name}`
        )
      );
      const firstPush = result.calls.findIndex(
        (call) => call[0] === 'docker' && call[1] === 'push'
      );
      const labels = result.calls
        .slice(0, firstPush)
        .filter((call) => call[0] === 'docker' && call[1] === 'image' && call[2] === 'inspect');
      assert.equal(labels.length, 10);
      const expectedLabels = ['api', 'admin', 'migrate'].flatMap((name) => {
        const reference = `${env.RELEASE_REPOSITORY}:${commit}-123-1-${name}`;
        return [
          'org.opencontainers.image.revision',
          'id-business-v2.source-tree',
          'id-business-v2.first-recharge-successor-projection-sha256'
        ].map((label) => [
          'docker',
          'image',
          'inspect',
          reference,
          '--format',
          `{{ index .Config.Labels "${label}" }}`
        ]);
      });
      assert.deepEqual(labels.slice(0, 9), expectedLabels);
      // The existing common push loop independently rechecks the first API revision.
      assert.deepEqual(labels[9], expectedLabels[0]);
      for (const patch of [
        { ENTRY_TEST_BAD_LABEL: 'f'.repeat(64) },
        { ENTRY_TEST_BAD_TREE: 'f'.repeat(40) },
        { ENTRY_TEST_BAD_REVISION: 'f'.repeat(40) }
      ]) {
        const failed = execute('push-images.sh', patch);
        assert.notEqual(failed.status, 0);
        assert.ok(failed.calls.every((call) => !(call[0] === 'docker' && call[1] === 'push')));
      }
    });
  });

  test('verify recharge cannot build/push/deploy and stale main cannot dispatch the release', () => {
    fixture((execute) => {
      for (const script of ['build-images.sh', 'push-images.sh', 'dispatch.sh']) {
        const result = execute(script, {
          RELEASE_OPERATION: 'verify_first_recharge',
          API_FAULT_RESTORE_APPROVED: 'false'
        });
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.calls, []);
      }
      const stale = execute('dispatch.sh', { ENTRY_TEST_REMOTE: 'f'.repeat(40) });
      assert.notEqual(stale.status, 0);
      assert.deepEqual(
        stale.calls.map((call) => call[0]),
        ['git']
      );
      const result = execute('dispatch.sh');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls, [
        ['git', 'ls-remote', 'origin', 'refs/heads/main'],
        ['python3', '-B', helper + '-readonly.py', 'release']
      ]);
    });
  });
  const options = value.on.workflow_dispatch.inputs.operation.options;
  assert.ok(options.includes('verify_first_recharge'));
  assert.ok(options.includes('release_first_recharge'));
  const steps = value.jobs.release.steps;
  const named = (name) => steps.find((step) => step.name === name);
  const sequence = [
    'Verify exact source and passing Quality Gate',
    'Verify first recharge predecessor and idle workers before building',
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance',
    'Independently read back first recharge images and preserved services'
  ].map((name) => steps.indexOf(named(name)));
  assert.ok(
    sequence.every((index, offset) => index >= 0 && (offset === 0 || index > sequence[offset - 1]))
  );
});

test('first recharge preserves the complete latest workflow and admits only its finite new lane', () => {
  const baseRaw = execFileSync(
    'git',
    ['show', 'b9f2e2b75a753b86a5057dd798d651c57496554e:' + workflowPath],
    { cwd: root, encoding: 'utf8' }
  );
  const expected = withFirstRechargeWorkflow(loadYaml(baseRaw));
  const actual = workflow();
  const validate = (value) => assert.deepEqual(value, expected);
  validate(actual);
  const steps = actual.jobs.release.steps;
  const preflight = steps.findIndex(
    (step) => step.name === 'Verify first recharge predecessor and idle workers before building'
  );
  const build = steps.findIndex((step) => step.name === 'Build images on the GitHub runner');
  const deploy = steps.findIndex((step) => step.name === 'Deploy through the production instance');
  const readback = steps.findIndex(
    (step) => step.name === 'Independently read back first recharge images and preserved services'
  );
  const cleanup = steps.findIndex(
    (step) => step.name === 'Confirm published candidate and reclaim superseded local images'
  );
  assert.ok(
    preflight >= 0 && preflight < build && build < deploy && deploy < readback && readback < cleanup
  );
  for (const fault of [
    'first-preflight',
    'first-readback',
    'first-artifact',
    'restore-input',
    'quality',
    'disk',
    'legacy',
    'duplicate'
  ]) {
    const changed = structuredClone(actual);
    const find = (name) => changed.jobs.release.steps.find((step) => step.name === name);
    if (fault === 'first-preflight')
      find('Verify first recharge predecessor and idle workers before building')[
        'continue-on-error'
      ] = true;
    else if (fault === 'first-readback')
      find('Independently read back first recharge images and preserved services').if = 'false';
    else if (fault === 'first-artifact')
      find('Save first recharge build and independent runtime evidence').with.path =
        '.env.aws.production';
    else if (fault === 'restore-input')
      changed.jobs.release.env.API_FAULT_RESTORE_APPROVED = 'true';
    else if (fault === 'quality') find('Verify exact source and passing Quality Gate').if = 'false';
    else if (fault === 'disk')
      find('Register complete release candidate and reserve pull headroom').if = 'false';
    else if (fault === 'legacy')
      find('Read sealed 43c31870 Admin confirmation baseline without production changes').run =
        'true';
    else
      changed.jobs.release.steps.splice(
        preflight,
        0,
        structuredClone(changed.jobs.release.steps[preflight])
      );
    assert.throws(() => validate(changed), undefined, fault);
  }
});
