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
  const frozenWorkflow = (commit) =>
    loadYaml(
      execFileSync('git', ['show', `${commit}:${workflowPath}`], {
        cwd: root,
        encoding: 'utf8'
      })
    );
  const baseline = frozenWorkflow('42e8eab5ef696159c7cd6f91204213011c0cb3be');
  const reviewedRecharge = frozenWorkflow('957afa4e7d9c776b0109bf7f217150fd3c545e04');
  const rechargeOnly = structuredClone(reviewedRecharge);
  rechargeOnly.on.workflow_dispatch.inputs.operation.options =
    rechargeOnly.on.workflow_dispatch.inputs.operation.options.filter(
      (operation) => !['verify_recharge_flow', 'release_recharge_flow'].includes(operation)
    );
  const added = new Set([
    'Verify recharge flow predecessor and idle workers before building',
    'Independently read back recharge flow images and preserved services',
    'Save recharge flow build and independent runtime evidence'
  ]);
  rechargeOnly.jobs.release.steps = rechargeOnly.jobs.release.steps.filter(
    (step) => !added.has(step.name)
  );
  for (const step of rechargeOnly.jobs.release.steps)
    if (typeof step.if === 'string')
      step.if = step.if.replace("inputs.operation == 'release_recharge_flow' || ", '');
  assert.deepEqual(rechargeOnly, baseline);

  // Bind reviewed Admin and disk changes to their exact delta; every other field and step stays frozen.
  const expected = structuredClone(reviewedRecharge);
  const steps = expected.jobs.release.steps;
  const diagnosticIndex = steps.findIndex(
    (step) => step.name === 'Read production release diagnostics'
  );
  assert.ok(diagnosticIndex >= 0);
  const adminBaseline = '60e164b75d1eedaab440c17139bf9ba55de08c61';
  assert.equal(steps[diagnosticIndex].if, "inputs.operation == 'verify_access'");
  steps[diagnosticIndex].if += ` && inputs.expected_current != '${adminBaseline}'`;
  steps.splice(
    diagnosticIndex,
    0,
    {
      name: 'Read finite Admin successor baseline facts',
      if: `inputs.operation == 'verify_access' && inputs.expected_current == '${adminBaseline}'`,
      run: 'python3 -B scripts/production-release/admin-successor-diagnostic.py'
    },
    {
      name: 'Save finite Admin successor read-only evidence',
      if: `always() && inputs.operation == 'verify_access' && inputs.expected_current == '${adminBaseline}'`,
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        name: 'admin-successor-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.deploy/production-release/admin-successor-diagnostic-*.json',
        'if-no-files-found': 'warn',
        'include-hidden-files': true,
        'retention-days': 14
      }
    }
  );
  const readback = steps.find(
    (step) => step.name === 'Independently read back Admin publication and preserved services'
  );
  assert.ok(readback);
  const apiOriginSelection = [
    "    expected_api_origin = proof['projection'].get('apiComponentBaseline')",
    "    if expected_api_origin is None and os.environ['EXPECTED_CURRENT'] == '31d2c6885a45817cd40d23fce8d6145bc9f18af2':",
    "        expected_api_origin = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'",
    "    if expected_api_origin != '31d2c6885a45817cd40d23fce8d6145bc9f18af2':",
    "        raise RuntimeError('Admin readback API origin unavailable')",
    ''
  ].join('\n');
  const oldApiOrigin = "receipt['apiComponentBaseline'] != os.environ['EXPECTED_CURRENT']";
  assert.equal(readback.run.split('    staged = ').length, 2);
  assert.equal(readback.run.split(oldApiOrigin).length, 2);
  readback.run = readback.run
    .replace('    staged = ', apiOriginSelection + '    staged = ')
    .replace(oldApiOrigin, "receipt['apiComponentBaseline'] != expected_api_origin");

  const insertAfter = (name, ...addedSteps) => {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index >= 0, name);
    steps.splice(index + 1, 0, ...addedSteps);
  };
  const diskGate =
    "inputs.historical_exception == 'none' && inputs.reuse_image_run == '' && (inputs.operation == 'release' || inputs.operation == 'release_admin' || inputs.operation == 'release_online_recharge' || inputs.operation == 'release_api_workspace' || inputs.operation == 'release_api_admin' || inputs.operation == 'release_api_admin_migration' || inputs.operation == 'release_unpublished_components' || inputs.operation == 'release_recharge_flow')";
  insertAfter(
    'Obtain short-lived AWS credentials through OIDC',
    {
      name: 'Read stable disk maintenance ownership before legacy image operations',
      id: 'disk_owner',
      if: "inputs.operation == 'release' || inputs.operation == 'cleanup_cache' || inputs.operation == 'cleanup_unused_cache' || inputs.operation == 'cleanup_unused_legacy_cache' || inputs.operation == 'cleanup_unused_builder_cache' || inputs.operation == 'cleanup_legacy_cache'",
      run: String.raw`set -Eeuo pipefail
command_id="$(aws ssm send-command --instance-ids "$PRODUCTION_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["if test -e /opt/id-business-v2/maintenance/disk-retention/config.json; then printf true; else printf false; fi"]}' \
  --query 'Command.CommandId' --output text)"
aws ssm wait command-executed --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID"
installed="$(aws ssm get-command-invocation --command-id "$command_id" \
  --instance-id "$PRODUCTION_INSTANCE_ID" --query StandardOutputContent --output text)"
case "$installed" in true|false) ;; *) exit 1 ;; esac
printf 'installed=%s\n' "$installed" >> "$GITHUB_OUTPUT"
`
    },
    {
      name: 'Reject legacy image cleanup after stable disk policy installation',
      if: "steps.disk_owner.outputs.installed == 'true' && (inputs.operation == 'cleanup_cache' || inputs.operation == 'cleanup_unused_cache' || inputs.operation == 'cleanup_unused_legacy_cache' || inputs.operation == 'cleanup_unused_builder_cache' || inputs.operation == 'cleanup_legacy_cache')",
      run: "echo 'The installed disk policy owns image cleanup; legacy cleanup cannot bypass its candidate protections.' >&2\nexit 1\n"
    },
    {
      name: 'Recover reviewed disk headroom before release preflight',
      if: diskGate,
      run: 'python3 -B scripts/production-release/release-storage.py before-build'
    }
  );
  insertAfter('Push immutable images', {
    name: 'Register complete release candidate and reserve pull headroom',
    if: diskGate,
    run: 'python3 -B scripts/production-release/release-storage.py before-pull'
  });
  insertAfter(
    'Independently read back online recharge runtime and preserved services',
    {
      name: 'Confirm published candidate and reclaim superseded local images',
      if: diskGate,
      run: 'python3 -B scripts/production-release/release-storage.py after-publish'
    },
    {
      name: 'Save disk lifecycle safe evidence',
      if: 'always() && ' + diskGate,
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        name: 'disk-lifecycle-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.deploy/production-release/storage/**/*.json',
        'if-no-files-found': 'warn',
        'include-hidden-files': true,
        'retention-days': 14
      }
    }
  );
  for (const name of [
    'Verify or maintain recoverable unused project image cache',
    'Maintain service rollback image cache independently after fixed release'
  ]) {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, name);
    if (name === 'Verify or maintain recoverable unused project image cache') {
      const releaseClause = "(inputs.operation == 'release' && ";
      assert.equal(step.if.split(releaseClause).length, 2);
      step.if = step.if.replace(
        releaseClause,
        releaseClause + "inputs.historical_exception != 'none' && "
      );
    }
    step.if = "steps.disk_owner.outputs.installed != 'true' && (" + step.if + ')';
  }
  // Extend the FULL reviewed 60/disk workflow with only these fixed 43c31870
  // fields. The final equality retains every previous byte, route and gate.
  const confirmBaseline = '43c31870c9497d900491cdb19c5f61c766f3b344';
  const confirmAccess = `inputs.operation == 'verify_access' && inputs.expected_current == '${confirmBaseline}'`;
  const confirmRelease = `inputs.operation == 'release_admin' && inputs.expected_current == '${confirmBaseline}'`;
  const legacyDiagnostic = steps.find(
    (step) => step.name === 'Read production release diagnostics'
  );
  legacyDiagnostic.if += ` && inputs.expected_current != '${confirmBaseline}'`;
  steps.splice(
    steps.indexOf(legacyDiagnostic),
    0,
    {
      name: 'Read sealed 43c31870 Admin confirmation baseline without production changes',
      if: confirmAccess,
      run: 'python3 -B scripts/production-release/admin-pending-online-release.py access-preflight'
    },
    {
      name: 'Save sealed 43c31870 Admin confirmation preflight safe evidence',
      if: 'always() && ' + confirmAccess,
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        name: 'admin-confirm-preflight-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.deploy/production-release/admin-confirm-preflight-*.json',
        'if-no-files-found': 'warn',
        'include-hidden-files': true,
        'retention-days': 14
      }
    }
  );
  insertAfter('Save only independent Admin readback safe evidence', {
    name: 'Save only sealed 43c31870 Admin build source evidence',
    if: 'always() && ' + confirmRelease,
    uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    with: {
      name: 'admin-confirm-build-source-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '.deploy/production-release/admin-pending-online-build-proof.json\n.deploy/production-release/admin-pending-online-build-projection.json\n',
      'if-no-files-found': 'warn',
      'include-hidden-files': true,
      'retention-days': 14
    }
  });
  const replaceOnce = (source, fragment, replacement) => {
    assert.equal(
      source.split(fragment).length,
      2,
      'fixed 43c31870 fragment must occur exactly once'
    );
    return source.replace(fragment, replacement);
  };
  const originalOrigin = [
    "    if expected_api_origin != '31d2c6885a45817cd40d23fce8d6145bc9f18af2':",
    "        raise RuntimeError('Admin readback API origin unavailable')",
    ''
  ].join('\n');
  const confirmOrigin = [
    "    confirm_baseline = '43c31870c9497d900491cdb19c5f61c766f3b344'",
    "    confirm_profile = os.environ['EXPECTED_CURRENT'] == confirm_baseline",
    '    if confirm_profile:',
    "        if (proof['projection'].get('profile') != 'ADMIN_CONFIRM_EXPIRY_20261014'",
    "                or proof['projection'].get('sourceBasisCommit') != confirm_baseline",
    '                or expected_api_origin != confirm_baseline):',
    "            raise RuntimeError('Admin confirmation readback origin unavailable')",
    "    elif expected_api_origin != '31d2c6885a45817cd40d23fce8d6145bc9f18af2':",
    "        raise RuntimeError('Admin readback API origin unavailable')",
    ''
  ].join('\n');
  const originalHelpers =
    "    names = ('remote-deploy.py', 'api-admin-pending-projection.py', 'admin-pending-online-release.py')\n";
  const confirmHelpers =
    originalHelpers +
    [
      '    if confirm_profile:',
      "        names += ('unpublished-component-successor.py', 'api-admin-scope.py')",
      ''
    ].join('\n');
  readback.run = replaceOnce(
    replaceOnce(readback.run, originalOrigin, confirmOrigin),
    originalHelpers,
    confirmHelpers
  );
  const actual = workflow();
  const validate = (candidate) => assert.deepEqual(candidate, expected);
  validate(actual);
  for (const fault of [
    'preflight-gate',
    'ignored-error',
    'proof-export',
    'legacy-gate',
    'origin-seal',
    'helpers',
    'duplicate-step',
    'disk-gate',
    'quality-gate'
  ]) {
    const candidate = structuredClone(actual);
    const candidateSteps = candidate.jobs.release.steps;
    const named = (name) => candidateSteps.find((step) => step.name === name);
    const preflightName =
      'Read sealed 43c31870 Admin confirmation baseline without production changes';
    if (fault === 'preflight-gate') named(preflightName).if = "inputs.operation == 'verify_access'";
    else if (fault === 'ignored-error') named(preflightName)['continue-on-error'] = true;
    else if (fault === 'proof-export')
      named('Save only sealed 43c31870 Admin build source evidence').with.path =
        '.env.aws.production';
    else if (fault === 'legacy-gate')
      named('Read production release diagnostics').if = "inputs.operation == 'verify_access'";
    else if (fault === 'origin-seal')
      named(readback.name).run = readback.run.replace(
        "get('sourceBasisCommit') != confirm_baseline",
        'get("sourceBasisCommit") == confirm_baseline'
      );
    else if (fault === 'helpers')
      named(readback.name).run = readback.run.replace(
        "names += ('unpublished-component-successor.py', 'api-admin-scope.py')",
        "names += ('remote-deploy.py',)"
      );
    else if (fault === 'duplicate-step') candidateSteps.push(structuredClone(named(preflightName)));
    else if (fault === 'disk-gate')
      named('Recover reviewed disk headroom before release preflight').if = 'false';
    else named('Verify exact source and passing Quality Gate')['continue-on-error'] = true;
    assert.throws(() => validate(candidate), undefined, fault);
  }
});
