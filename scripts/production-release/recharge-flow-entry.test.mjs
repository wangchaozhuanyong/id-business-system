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

test('recharge flow uses existing inputs and one production lock, with preflight before build and independent readback', () => {
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
  const context = '.deploy/production-release/recharge-flow-successor-build-context';
  const helper = 'scripts/production-release/recharge-flow-successor';

  function fixture(run) {
    const parent = resolve(root, '.runtime/recharge-flow-fixes-20261013/release/entry-fixtures');
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
      RELEASE_OPERATION: 'release_recharge_flow',
      RELEASE_COMMIT: commit,
      EXPECTED_CURRENT: '60e164b75d1eedaab440c17139bf9ba55de08c61',
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
          RELEASE_OPERATION: 'verify_recharge_flow',
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
        { RELEASE_OPERATION: 'release_recharge_flow_other' },
        { RELEASE_OPERATION: 'verify_recharge_flow_other' }
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
          call.includes('id-business-v2.recharge-flow-successor-projection-sha256=' + projection)
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
          'id-business-v2.recharge-flow-successor-projection-sha256'
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
          RELEASE_OPERATION: 'verify_recharge_flow',
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
  assert.ok(options.includes('verify_recharge_flow'));
  assert.ok(options.includes('release_recharge_flow'));
  const steps = value.jobs.release.steps;
  const named = (name) => steps.find((step) => step.name === name);
  const sequence = [
    'Verify exact source and passing Quality Gate',
    'Verify recharge flow predecessor and idle workers before building',
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance',
    'Independently read back recharge flow images and preserved services'
  ].map((name) => steps.indexOf(named(name)));
  assert.ok(
    sequence.every((index, offset) => index >= 0 && (offset === 0 || index > sequence[offset - 1]))
  );
});

test('read-only recharge operation never builds, pushes or deploys and evidence survives failures', () => {
  const steps = workflow().jobs.release.steps;
  const named = (name) => steps.find((step) => step.name === name);
  for (const name of [
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance'
  ]) {
    assert.ok(named(name).if.includes("inputs.operation == 'release_recharge_flow'"));
    assert.ok(!named(name).if.includes('verify_recharge_flow'));
  }
  assert.equal(
    named('Verify recharge flow predecessor and idle workers before building').run,
    'python3 -B scripts/production-release/recharge-flow-successor-readonly.py preflight'
  );
  assert.equal(
    named('Independently read back recharge flow images and preserved services').run,
    'python3 -B scripts/production-release/recharge-flow-successor-readonly.py readback'
  );
  const artifact = named('Save recharge flow build and independent runtime evidence');
  assert.ok(artifact.if.startsWith('always()'));
  assert.ok(artifact.if.includes('verify_recharge_flow'));
  assert.ok(artifact.if.includes('release_recharge_flow'));
  assert.equal(artifact.with.path, '.deploy/production-release/recharge-flow-successor-*.json');
  assert.equal(artifact.with['include-hidden-files'], true);
});

test('recharge extension preserves all previous workflow inputs, environments and routes', () => {
  const baseline = loadYaml(
    execFileSync('git', ['show', `4f19709a135bfb71fae574affb110051bc7d85ee:${workflowPath}`], {
      cwd: root,
      encoding: 'utf8'
    })
  );
  const current = workflow();
  current.on.workflow_dispatch.inputs.operation.options =
    current.on.workflow_dispatch.inputs.operation.options.filter(
      (operation) => !['verify_recharge_flow', 'release_recharge_flow'].includes(operation)
    );
  const added = new Set([
    'Verify recharge flow predecessor and idle workers before building',
    'Independently read back recharge flow images and preserved services',
    'Save recharge flow build and independent runtime evidence'
  ]);
  current.jobs.release.steps = current.jobs.release.steps.filter((step) => !added.has(step.name));
  for (const step of current.jobs.release.steps)
    if (typeof step.if === 'string')
      step.if = step.if.replace("inputs.operation == 'release_recharge_flow' || ", '');
  assert.deepEqual(current, baseline);
});
