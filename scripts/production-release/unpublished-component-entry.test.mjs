import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const projection = 'c'.repeat(64);
const context = '.deploy/production-release/unpublished-component-successor-build-context';
const helper = 'scripts/production-release/unpublished-component-successor';

function fixture(run) {
  const parent = resolve(root, '.runtime/unpublished-release-20261013/checks');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'entry-owned-'));
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
  console.log(format.includes('source-tree') ? process.env.SOURCE_TREE : format.includes('projection-sha256') ? process.env.ENTRY_TEST_BAD_LABEL || process.env.ENTRY_TEST_PROJECTION : process.env.RELEASE_COMMIT);
}
if (file === 'aws' && args.includes('describe-images')) console.log('sha256:' + 'd'.repeat(64));
`;
  for (const name of ['git', 'python3', 'docker', 'aws'])
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  const env = {
    PATH: bin + ':' + process.env.PATH,
    RELEASE_OPERATION: 'release_unpublished_components',
    RELEASE_COMMIT: commit,
    EXPECTED_CURRENT: 'e'.repeat(40),
    SOURCE_TREE: tree,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    QUALITY_RUN_ID: '456',
    HISTORICAL_EXCEPTION: 'none',
    RELEASE_REPOSITORY: '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
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

test('component selector denies unapproved restoration, reuse, foreign policies and invalid source', () => {
  fixture((execute) => {
    assert.equal(execute('validate-release-selection.sh').status, 0);
    assert.equal(
      execute('validate-release-selection.sh', {
        RELEASE_OPERATION: 'verify_unpublished_components',
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
      { EXPECTED_CURRENT: 'invalid' },
      { SOURCE_TREE: 'invalid' },
      {
        RELEASE_OPERATION: 'release_unpublished_components_other',
        API_FAULT_RESTORE_APPROVED: 'false'
      },
      {
        RELEASE_OPERATION: 'verify_unpublished_components_other',
        API_FAULT_RESTORE_APPROVED: 'false'
      }
    ]) {
      const result = execute('validate-release-selection.sh', patch);
      assert.notEqual(result.status, 0, JSON.stringify(patch));
      assert.deepEqual(result.calls, []);
    }
  });
});

test('component build prepares one projection and produces only three fresh labeled images', () => {
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
    for (const call of builds) {
      assert.ok(call.includes('org.opencontainers.image.revision=' + commit));
      assert.ok(call.includes('id-business-v2.source-tree=' + tree));
      assert.ok(
        call.includes(
          'id-business-v2.unpublished-component-successor-projection-sha256=' + projection
        )
      );
      assert.equal(call.at(-1), context);
      assert.ok(call[call.indexOf('-f') + 1].startsWith(context + '/apps/'));
      assert.ok(!call.includes('--cache-from'));
    }
    assert.ok(builds[1].includes('V2_BUILD_ID=v2-' + commit));
    const failed = execute('build-images.sh', { ENTRY_TEST_FAIL_PYTHON: 'prepare' });
    assert.notEqual(failed.status, 0);
    assert.ok(failed.calls.every((call) => call[0] !== 'docker'));
  });
});

test('component push verifies producer labels before publishing only current-run image tags', () => {
  fixture((execute, env) => {
    const result = execute('push-images.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.calls
        .filter((call) => call[0] === 'docker' && call[1] === 'push')
        .map((call) => call[2]),
      ['api', 'admin', 'migrate'].map(
        (service) => `${env.RELEASE_REPOSITORY}:${commit}-123-1-${service}`
      )
    );
    assert.equal(
      result.calls.filter((call) =>
        call.some((arg) => arg.includes('unpublished-component-successor-projection-sha256'))
      ).length,
      3
    );
    const failed = execute('push-images.sh', { ENTRY_TEST_BAD_LABEL: 'f'.repeat(64) });
    assert.notEqual(failed.status, 0);
    assert.ok(failed.calls.every((call) => !(call[0] === 'docker' && call[1] === 'push')));
  });
});

test('read-only component verification cannot build, push or dispatch, and stale main cannot dispatch', () => {
  fixture((execute) => {
    for (const script of ['build-images.sh', 'push-images.sh', 'dispatch.sh']) {
      const result = execute(script, {
        RELEASE_OPERATION: 'verify_unpublished_components',
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

test('component workflow stays under one lock and orders qualified source, preflight, build and independent readback', () => {
  const workflow = loadYaml(
    readFileSync(resolve(root, '.github/workflows/production-release.yml'), 'utf8')
  );
  const input = workflow.on.workflow_dispatch.inputs.api_fault_restore_approved;
  assert.deepEqual(input, {
    description: 'Separately approved API fault restoration protection for the component successor',
    required: false,
    default: false,
    type: 'boolean'
  });
  assert.equal(workflow.concurrency.group, 'id-business-v2-production-release');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.release.if, "github.ref == 'refs/heads/main'");
  assert.equal(
    workflow.jobs.release.env.API_FAULT_RESTORE_APPROVED,
    '${{ inputs.api_fault_restore_approved }}'
  );
  const steps = workflow.jobs.release.steps;
  const named = (name) => steps.find((step) => step.name === name);
  const sequence = [
    'Verify exact source and passing Quality Gate',
    'Verify unpublished component predecessor and idle workers before building',
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance',
    'Independently read back unpublished component images and preserved services'
  ].map((name) => steps.indexOf(named(name)));
  assert.ok(
    sequence.every((value, index) => value >= 0 && (index === 0 || value > sequence[index - 1]))
  );
  for (const name of [
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance'
  ]) {
    assert.ok(named(name).if.includes("inputs.operation == 'release_unpublished_components'"));
    assert.ok(!named(name).if.includes('verify_unpublished_components'));
  }
  const artifact = named('Save unpublished component build and independent runtime evidence');
  assert.ok(artifact.if.startsWith('always()'));
  assert.equal(
    artifact.with.path,
    '.deploy/production-release/unpublished-component-successor-*.json'
  );
});
