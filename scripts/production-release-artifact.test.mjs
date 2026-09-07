import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
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
      ['api', 'admin', 'migration', 'mediaResolver', 'recharge', 'gate'].map((name) => [
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
    'scripts/load-production-release-images.sh',
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
  assert.match(installer, /load-production-release-images\.sh/u);
  assert.match(installer, /flock -n/u);
  assert.doesNotMatch(installer, /rm -f -- "\$RELEASE_ARTIFACT_ARCHIVE"/u);
  const deployer = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-production-artifact.sh'),
    'utf8'
  );
  assert.match(deployer, /mv -- "\$artifact_path" "\$artifact_directory\/\$artifact_file"/u);
  assert.match(deployer, /tar -xzf "\$artifact_path" -C "\$extraction_directory" source\.tar\.gz/u);
  assert.doesNotMatch(deployer, /extraction_directory\}\/images\.tar/u);
  assert.match(installer, /artifacts\/\$\{RELEASE_TAG\}-\$\{RELEASE_COMMIT\}/u);
});

test('streamed image import validates before Docker and preserves the immutable bundle', () => {
  withImageLoaderFixture(({ directory, artifact, imageBytes, runLoader, input, runtime }) => {
    const originalHash = sha256File(artifact);
    const result = runLoader();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(input), imageBytes);
    assert.equal(sha256File(artifact), originalHash);
    assert.deepEqual(readdirSync(runtime), [], '导入不能留下解压归档或临时文件');
    assert.ok(existsSync(directory));
  });
});

test('production installer declares every referenced release parameter', () => {
  const installer = readFileSync(
    resolve(projectRoot, 'scripts/install-aws-production-artifact.sh'),
    'utf8'
  );
  const parameters = installer.match(/for variable in ([\s\S]*?); do/u)?.[1];
  assert.ok(parameters);
  const required = new Set(parameters.match(/\bRELEASE_[A-Z0-9_]+\b/gu));
  for (const [, name] of installer.matchAll(/\$\{?(RELEASE_[A-Z0-9_]+)/gu)) {
    assert.ok(required.has(name), `安装器仍引用未声明的发布参数：${name}`);
  }
  assert.match(
    installer,
    /"\$RELEASE_ARTIFACT_ARCHIVE" "\$RELEASE_ARTIFACT_SHA256" "\$RELEASE_IMAGE_ARCHIVE_SHA256"/u,
    '导入器必须同时取得正式包和镜像归档的校验值'
  );
});

for (const failure of ['artifact-hash', 'image-hash', 'archive-content', 'symlink', 'space']) {
  test(`streamed image import rejects ${failure} before starting Docker`, () => {
    withImageLoaderFixture(({ artifact, runLoader, input, payload, directory }) => {
      const options = {};
      if (failure === 'artifact-hash') options.artifactHash = '0'.repeat(64);
      if (failure === 'image-hash') options.imageHash = '0'.repeat(64);
      if (failure === 'archive-content') {
        writeFileSync(join(payload, 'extra'), 'unexpected');
        run('tar', ['-czf', artifact, '-C', payload, 'images.tar', 'source.tar.gz', 'extra']);
      }
      if (failure === 'symlink') {
        options.artifact = join(directory, 'linked.tar.gz');
        symlinkSync(artifact, options.artifact);
      }
      if (failure === 'space') options.env = { AVAILABLE_KIB: '1024' };
      const result = runLoader(options);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(input), false, '校验或空间不足时不得启动 Docker');
    });
  });
}

test('streamed import propagates both Docker and late decompression failures', () => {
  for (const env of [{ DOCKER_STATUS: '23' }, { FAIL_TAR_INVOCATION: '4' }]) {
    withImageLoaderFixture(({ artifact, runLoader, input }) => {
      const result = runLoader({ env });
      assert.notEqual(result.status, 0, '管道任一端失败均必须阻断安装');
      assert.equal(existsSync(input), true, '该用例验证已启动导入之后的失败');
      assert.equal(existsSync(artifact), true, '失败后仍保留正式制品');
    });
  }
});

function withImageLoaderFixture(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-stream-load-'));
  const payload = join(directory, 'payload');
  const bin = join(directory, 'bin');
  const runtime = join(directory, 'runtime');
  for (const path of [payload, bin, runtime]) mkdirSync(path);
  const imageBytes = Buffer.alloc(65536, 'immutable-layer');
  const artifact = join(directory, 'release.tar.gz');
  const input = join(directory, 'docker-input');
  writeFileSync(join(payload, 'images.tar'), imageBytes);
  writeFileSync(join(payload, 'source.tar.gz'), 'source-fixture');
  run('tar', ['-czf', artifact, '-C', payload, 'images.tar', 'source.tar.gz']);
  const realTar = spawnSync('which', ['tar'], { encoding: 'utf8' }).stdout.trim();
  const scripts = {
    docker: `#!/usr/bin/env bash
set -eu
[[ "$*" == load ]] || exit 91
cat >"$IMAGE_INPUT"
exit "\u0024{DOCKER_STATUS:-0}"
`,
    df: `#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf 'fixture 99999999 0 %s 0%% /\\n' "\u0024{AVAILABLE_KIB:-99999999}"
`,
    tar: `#!/usr/bin/env bash
set -eu
count=0
if [[ -f "$TAR_COUNTER" ]]; then read -r count <"$TAR_COUNTER"; fi
count=$((count + 1))
printf '%s\\n' "$count" >"$TAR_COUNTER"
if [[ "$count" == "\u0024{FAIL_TAR_INVOCATION:-0}" ]]; then
  printf 'partial-image-stream'
  exit 17
fi
exec "$REAL_TAR" "$@"
`
  };
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o700);
  }
  const runLoader = (options = {}) =>
    spawnSync(
      'bash',
      [
        resolve(projectRoot, 'scripts/load-production-release-images.sh'),
        options.artifact ?? artifact,
        options.artifactHash ?? sha256File(artifact),
        options.imageHash ?? sha256File(join(payload, 'images.tar'))
      ],
      {
        cwd: runtime,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: runtime,
          IMAGE_INPUT: input,
          REAL_TAR: realTar,
          TAR_COUNTER: join(directory, 'tar-count'),
          ...options.env
        }
      }
    );
  try {
    callback({ directory, artifact, imageBytes, runLoader, input, runtime, payload });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

test('AWS deploy forwards all six immutable image references to the remote installer', () => {
  const deployer = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-production-artifact.sh'),
    'utf8'
  );
  assert.match(
    deployer,
    /"\$migration_digest" \\\n\s+"\$media_resolver_reference" \\\n\s+"\$media_resolver_digest" \\\n\s+"\$recharge_reference" \\\n\s+"\$recharge_digest" \\\n\s+"\$gate_reference" \\\n\s+"\$gate_digest" \\\n\s+"\$PRODUCTION_BASE_URL" \\\n\s+"\$PRODUCTION_COMPOSE_PROJECT" <<'REMOTE_DEPLOY'/u
  );
  assert.match(
    deployer,
    /migration_digest="\$6"\nmedia_resolver_reference="\$7"\nmedia_resolver_digest="\$8"\nrecharge_reference="\$9"\nrecharge_digest="\$\{10\}"\ngate_reference="\$\{11\}"\ngate_digest="\$\{12\}"\nproduction_base_url="\$\{13\}"\nproduction_compose_project="\$\{14\}"/u
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
