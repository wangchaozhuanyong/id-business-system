import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(projectRoot, 'scripts/verify-production-release-artifact.mjs');
const commit = 'a'.repeat(40);
const releaseTag = 'v2-production-20260829T120000Z';

test('release artifact verifier accepts a complete immutable bundle and rejects corruption', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-artifact-test-'));
  const payloadDirectory = join(directory, 'payload');
  const sourceDirectory = join(directory, 'source');
  mkdirSync(payloadDirectory);
  mkdirSync(sourceDirectory);
  writeFileSync(join(sourceDirectory, 'package.json'), '{"private":true}\n');
  writeFileSync(
    join(sourceDirectory, '.env.aws.production.example'),
    'MYSQL_PASSWORD=replace_with_placeholder\n'
  );
  writeFileSync(join(payloadDirectory, 'images.tar'), 'immutable-image-archive');
  run('tar', ['-czf', join(payloadDirectory, 'source.tar.gz'), '-C', sourceDirectory, '.']);

  const artifactFile = `id-business-v2-${releaseTag}-${commit}.tar.gz`;
  const artifactPath = join(directory, artifactFile);
  run('tar', ['-czf', artifactPath, '-C', payloadDirectory, 'images.tar', 'source.tar.gz']);
  const manifest = {
    schemaVersion: 1,
    sourceBranch: 'main',
    commit,
    releaseTag,
    ciWorkflow: 'Quality Gate',
    ciWorkflowRunId: '123',
    ciWorkflowRunNumber: '45',
    deploymentRun: null,
    artifact: {
      file: artifactFile,
      sha256: sha256File(artifactPath),
      imageArchiveSha256: sha256File(join(payloadDirectory, 'images.tar')),
      sourceArchiveSha256: sha256File(join(payloadDirectory, 'source.tar.gz'))
    },
    images: Object.fromEntries(
      ['api', 'admin', 'migration', 'mediaResolver', 'gate'].map((name) => [
        name,
        { reference: `id-business-v2-${name}:${commit}`, digest: `sha256:${'b'.repeat(64)}` }
      ])
    ),
    environment: 'production',
    builtAt: '2026-08-29T12:00:00.000Z',
    operator: 'github-actions',
    deployedAt: null,
    previousCommit: null
  };
  writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest)}\n`);

  try {
    const accepted = runVerifier(directory);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).artifactSha256, manifest.artifact.sha256);

    cpSync(artifactPath, `${artifactPath}.valid`);
    writeFileSync(artifactPath, 'corrupted');
    const rejected = runVerifier(directory);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /制品 SHA-256 不一致/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release artifact verifier uses streaming IO for release file hashes', () => {
  const source = readFileSync(verifier, 'utf8');
  assert.match(source, /createReadStream\(path\)/u);
  assert.match(source, /for await \(const chunk of stream\)/u);
  assert.doesNotMatch(source, /createHash\('sha256'\)\.update\(readFileSync\(path\)\)/u);
});

test('release scripts pass shell syntax and production installation never builds images', () => {
  for (const script of [
    'scripts/package-production-release.sh',
    'scripts/deploy-aws-production-artifact.sh',
    'scripts/read-current-production-release.sh',
    'scripts/install-aws-production-artifact.sh',
    'scripts/cleanup-aws-production-retention.sh'
  ]) {
    const result = spawnSync('bash', ['-n', resolve(projectRoot, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
  const installer = readFileSync(
    resolve(projectRoot, 'scripts/install-aws-production-artifact.sh'),
    'utf8'
  );
  assert.doesNotMatch(installer, /docker(?:\s+compose)?\s+build/u);
  assert.doesNotMatch(installer, /--build(?:\s|$)/u);
  assert.match(installer, /docker load/u);
  assert.match(installer, /flock -n/u);
  assert.match(
    installer,
    /"\$\{deployment_root\}\/incoming\/"\*\/extracted\/images\.tar/u,
    '临时镜像归档只能从受控 incoming 路径删除'
  );
  const discardArchiveIndex = installer.indexOf('rm -f -- "$RELEASE_IMAGE_ARCHIVE"');
  const postDeployRetentionIndex = installer.indexOf(
    'cleanup-aws-production-retention.sh" --post-deploy'
  );
  assert.ok(discardArchiveIndex > installer.indexOf('docker load'));
  assert.ok(discardArchiveIndex < postDeployRetentionIndex);
});

test('current production release reader validates and returns the immutable target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-current-release-test.'));
  const releaseDirectory = join(directory, 'releases', '20260904T120000Z-aaaaaaaaaaaa');
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(
    join(releaseDirectory, 'release-manifest.json'),
    `${JSON.stringify({ commit, releaseTag }, null, 2)}\n`
  );
  symlinkSync(releaseDirectory, join(directory, 'current'));

  try {
    const result = spawnSync(
      'bash',
      [resolve(projectRoot, 'scripts/read-current-production-release.sh'), directory],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `${realpathSync(releaseDirectory)}\t${commit}\t${releaseTag}`
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production installer isolates the scheduled performance audit from deployment', () => {
  const installer = readFileSync(
    resolve(projectRoot, 'scripts/install-aws-production-artifact.sh'),
    'utf8'
  );
  assert.match(
    installer,
    /id-business-v2-production-retention\.service \\\n\s+id-business-v2-mysql-performance\.service; do/u,
    '部署开始前必须拒绝仍在运行的性能巡检'
  );
  assert.match(
    installer,
    /systemctl stop \\\n\s+id-business-v2-mysql-backup\.timer \\\n\s+id-business-v2-mysql-backup-verify\.timer \\\n\s+id-business-v2-mysql-performance\.timer \\\n\s+id-business-v2-mysql-performance\.service/u,
    '部署窗口必须同时停止性能定时器和服务'
  );

  const backupRestore = installer.match(/restore_backup_timers\(\) \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(backupRestore);
  assert.doesNotMatch(backupRestore, /mysql-performance/u);

  const failureRestore = installer.match(/restore_timers\(\) \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(failureRestore);
  assert.match(failureRestore, /restore_backup_timers/u);
  assert.match(failureRestore, /systemctl start id-business-v2-mysql-performance\.timer/u);

  const postDeployRestoreIndex = installer.indexOf(
    'restore_backup_timers\nif ! systemctl is-enabled'
  );
  const performanceInstall = installer.match(
    /install_performance_timer\(\) \{([\s\S]*?)\n\}/u
  )?.[1];
  assert.ok(performanceInstall);
  const performanceBaselineIndex = performanceInstall.indexOf(
    'MYSQL_PERFORMANCE_BASELINE_ONLY=true'
  );
  const performanceEnableIndex = performanceInstall.indexOf(
    'systemctl enable id-business-v2-mysql-performance.timer'
  );
  const performanceCheckIndex = performanceInstall.indexOf(
    'systemctl start id-business-v2-mysql-performance.service'
  );
  const performanceTimerStartIndex = performanceInstall.indexOf(
    'systemctl start id-business-v2-mysql-performance.timer'
  );
  const installPerformanceCallIndex = installer.lastIndexOf('\ninstall_performance_timer\n');
  assert.ok(postDeployRestoreIndex > 0);
  assert.ok(performanceEnableIndex > performanceBaselineIndex);
  assert.ok(performanceCheckIndex > performanceEnableIndex);
  assert.ok(performanceTimerStartIndex > performanceCheckIndex);
  assert.ok(installPerformanceCallIndex > postDeployRestoreIndex);
});

test('AWS deploy forwards all five immutable image references to the remote installer', () => {
  const deployer = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-production-artifact.sh'),
    'utf8'
  );
  assert.match(
    deployer,
    /"\$migration_digest" \\\n\s+"\$media_resolver_reference" \\\n\s+"\$media_resolver_digest" \\\n\s+"\$gate_reference" \\\n\s+"\$gate_digest" \\\n\s+"\$PRODUCTION_BASE_URL" \\\n\s+"\$PRODUCTION_COMPOSE_PROJECT" <<'REMOTE_DEPLOY'/u
  );
  assert.match(
    deployer,
    /migration_digest="\$6"\nmedia_resolver_reference="\$7"\nmedia_resolver_digest="\$8"\ngate_reference="\$9"\ngate_digest="\$\{10\}"\nproduction_base_url="\$\{11\}"\nproduction_compose_project="\$\{12\}"/u
  );
});

test('AWS deploy returns early when the exact production commit is already current', () => {
  const deployer = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-production-artifact.sh'),
    'utf8'
  );
  const currentCommitCheckIndex = deployer.indexOf(
    'if [[ "$previous_commit" == "$release_commit" ]]'
  );
  const artifactLookupIndex = deployer.indexOf('gh run list', currentCommitCheckIndex);
  const artifactDownloadIndex = deployer.indexOf('gh run download "$ci_run_id"');
  const retentionPreflightIndex = deployer.indexOf(
    'sudo bash -s -- --preflight <"$retention_script"'
  );

  assert.ok(currentCommitCheckIndex > 0);
  assert.match(deployer, /BASE_URL="\$PRODUCTION_BASE_URL" bash scripts\/deploy-smoke\.sh/u);
  assert.match(deployer, /deployment_status=already_deployed/u);
  assert.match(deployer, /<"\$current_release_reader"/u);
  assert.doesNotMatch(deployer, /<<'REMOTE_CURRENT'/u);
  assert.ok(artifactLookupIndex > currentCommitCheckIndex);
  assert.ok(artifactDownloadIndex > currentCommitCheckIndex);
  assert.ok(retentionPreflightIndex > currentCommitCheckIndex);
});

test('tag workflow uploads one SHA-pinned immutable artifact', () => {
  const workflow = readFileSync(resolve(projectRoot, '.github/workflows/quality.yml'), 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- 'v2-production-\*'/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
  assert.match(workflow, /headBranch == \\"main\\" and \.headSha == \\"\$\{GITHUB_SHA\}\\"/u);
  assert.match(workflow, /该 commit 已由成功运行/u);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@[a-f0-9]{40}\s+# v4/u);
  assert.match(workflow, /scripts\/package-production-release\.sh/u);
  assert.match(workflow, /scripts\/verify-production-release-artifact\.mjs/u);
});

test('quality workflow avoids duplicate branch pushes and scopes expensive jobs', () => {
  const workflow = readFileSync(resolve(projectRoot, '.github/workflows/quality.yml'), 'utf8');
  const scheduledAudit = readFileSync(
    resolve(projectRoot, '.github/workflows/dependency-audit.yml'),
    'utf8'
  );

  assert.doesNotMatch(workflow, /codex\/\*\*-release-\*/u);
  assert.match(workflow, /concurrency:\s*\n\s+group:/u);
  assert.match(workflow, /cancel-in-progress:/u);
  assert.match(
    workflow,
    /quality:\s*\n\s+needs: change-scope\s*\n\s+if: \$\{\{ github\.event_name != 'push' \|\| !startsWith\(github\.ref, 'refs\/tags\/v2-production-'\) \}\}/u
  );
  assert.match(
    workflow,
    /Skip unchanged production image boundary[\s\S]*needs\.change-scope\.outputs\.production_images != 'true'/u
  );
  assert.match(
    workflow,
    /Build AWS MySQL production images[\s\S]*needs\.change-scope\.outputs\.production_images == 'true'/u
  );
  assert.match(workflow, /needs\.change-scope\.outputs\.dependency_audit == 'true'/u);
  assert.match(
    workflow,
    /NPM_AUDIT_INFRASTRUCTURE_POLICY: \$\{\{ github\.event_name == 'pull_request' && 'warn' \|\| 'fail' \}\}/u
  );
  assert.match(
    workflow,
    /Package immutable production artifact\s*\n\s+if: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v2-production-'\) \}\}/u
  );
  assert.match(scheduledAudit, /schedule:\s*\n\s+- cron:/u);
  assert.match(scheduledAudit, /npm run audit:high/u);
  assert.doesNotMatch(scheduledAudit, /NPM_AUDIT_INFRASTRUCTURE_POLICY/u);
});

function runVerifier(directory) {
  return spawnSync(
    process.execPath,
    [verifier, '--directory', directory, '--expected-commit', commit, '--expected-tag', releaseTag],
    { encoding: 'utf8' }
  );
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
