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
import { gzipSync } from 'node:zlib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(projectRoot, 'scripts/verify-production-release-artifact.mjs');
const deploymentManifestCreator = resolve(
  projectRoot,
  'scripts/create-production-deployment-manifest.mjs'
);
const commit = 'a'.repeat(40);
const releaseTag = 'v2-production-20260829T120000Z';

test('packager creates split schema v2 artifacts from the exact checked-out commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-package-v2-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'output');
  mkdirSync(bin);
  mkdirSync(output);
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const tag = 'v2-production-20260907T235959Z';
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1 $2" == 'image inspect' ]]; then
  if [[ "$5" == '{{.Id}}' ]]; then printf 'sha256:%s\\n' "${'e'.repeat(64)}"; else printf '4096\\n'; fi
elif [[ "$1" == save ]]; then
  printf 'immutable-image:%s' "$2"
else
  exit 90
fi
`
  );
  chmodSync(join(bin, 'docker'), 0o700);
  const imageEnvironment = Object.fromEntries(
    ['API', 'ADMIN', 'MIGRATION', 'MEDIA_RESOLVER', 'RECHARGE', 'GATE'].map((name) => [
      `RELEASE_${name}_IMAGE`,
      `id-business-v2-release-${name.toLowerCase().replace('_', '-')}:${head}`
    ])
  );

  try {
    const packaged = spawnSync(
      'bash',
      [resolve(projectRoot, 'scripts/package-production-release.sh')],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...imageEnvironment,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_SOURCE_BRANCH: 'main',
          RELEASE_COMMIT: head,
          RELEASE_TAG: tag,
          RELEASE_CI_RUN_ID: '987',
          RELEASE_CI_RUN_NUMBER: '65',
          RELEASE_OPERATOR: 'test',
          RELEASE_OUTPUT_DIR: output,
          RELEASE_IMAGE_NAMES: 'api,admin,migration,mediaResolver,recharge,gate',
          RELEASE_PREVIOUS_COMMIT: 'c'.repeat(40),
          RELEASE_BACKUP_POLICY: 'recent',
          RELEASE_MIGRATION_REQUIRED: 'false',
          RELEASE_ACCEPTANCE_SCOPES: 'base'
        }
      }
    );
    assert.equal(packaged.status, 0, packaged.stderr);
    const verified = spawnSync(
      process.execPath,
      [verifier, '--directory', output, '--expected-commit', head, '--expected-tag', tag],
      { encoding: 'utf8' }
    );
    assert.equal(verified.status, 0, verified.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.changedImages, [
      'api',
      'admin',
      'migration',
      'mediaResolver',
      'recharge',
      'gate'
    ]);
    assert.deepEqual(
      readdirSync(output)
        .filter((name) => name.startsWith('image-'))
        .sort(),
      [
        `image-admin-${head}.tar.gz`,
        `image-api-${head}.tar.gz`,
        `image-gate-${head}.tar.gz`,
        `image-mediaResolver-${head}.tar.gz`,
        `image-migration-${head}.tar.gz`,
        `image-recharge-${head}.tar.gz`
      ]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test('schema v2 verifier accepts one changed image and inherited immutable images', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-incremental-artifact-test-'));
  const payloadDirectory = join(directory, 'payload');
  const sourceDirectory = join(directory, 'source');
  mkdirSync(payloadDirectory);
  mkdirSync(sourceDirectory);
  writeFileSync(join(sourceDirectory, 'package.json'), '{"private":true}\n');
  run('tar', ['-czf', join(payloadDirectory, 'source.tar.gz'), '-C', sourceDirectory, '.']);

  const artifactFile = `id-business-v2-${releaseTag}-${commit}-source.tar.gz`;
  const artifactPath = join(directory, artifactFile);
  run('tar', ['-czf', artifactPath, '-C', payloadDirectory, 'source.tar.gz']);
  const previousCommit = 'c'.repeat(40);
  const previousTag = 'v2-production-20260828T120000Z';
  const imageNames = ['api', 'admin', 'migration', 'mediaResolver', 'recharge', 'gate'];
  const images = Object.fromEntries(
    imageNames.map((name) => {
      const changed = name === 'admin';
      const sourceCommit = changed ? commit : previousCommit;
      const sourceTag = changed ? releaseTag : previousTag;
      const fileName = `image-${name}-${sourceCommit}.tar.gz`;
      const archiveBytes = Buffer.from(`${name}-immutable-image`);
      if (changed) writeFileSync(join(directory, fileName), archiveBytes);
      const referenceName = name === 'mediaResolver' ? 'media-resolver' : name;
      return [
        name,
        {
          reference: `id-business-v2-release-${referenceName}:${sourceCommit}`,
          digest: `sha256:${(changed ? 'd' : 'b').repeat(64)}`,
          sizeBytes: 1024,
          inherited: !changed,
          archive: {
            file: fileName,
            sha256: sha256Bytes(archiveBytes),
            githubArtifactName: `id-business-v2-${sourceTag}-${sourceCommit}-image-${name}`,
            ciWorkflowRunId: changed ? '456' : '123',
            sourceCommit,
            sourceReleaseTag: sourceTag
          }
        }
      ];
    })
  );
  const manifest = {
    schemaVersion: 2,
    sourceBranch: 'main',
    commit,
    releaseTag,
    ciWorkflow: 'Production Release Artifact',
    ciWorkflowRunId: '456',
    ciWorkflowRunNumber: '78',
    deploymentRun: null,
    artifact: {
      file: artifactFile,
      sha256: sha256File(artifactPath),
      sourceArchiveSha256: sha256File(join(payloadDirectory, 'source.tar.gz')),
      githubArtifactName: `id-business-v2-${releaseTag}-${commit}-control`
    },
    images,
    changedImages: ['admin'],
    risk: { backupPolicy: 'recent', migrationRequired: false },
    acceptanceScopes: ['admin', 'base'],
    environment: 'production',
    builtAt: '2026-08-29T12:00:00.000Z',
    operator: 'github-actions',
    deployedAt: null,
    previousCommit
  };
  writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest)}\n`);

  try {
    const accepted = runVerifier(directory);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).changedImages, ['admin']);

    const deploymentManifest = join(directory, 'deployment-manifest.json');
    const created = spawnSync(
      process.execPath,
      [
        deploymentManifestCreator,
        '--input',
        join(directory, 'release-manifest.json'),
        '--output',
        deploymentManifest,
        '--deployment-run',
        'aws-fixture',
        '--deployed-at',
        '2026-08-29T12:30:00Z',
        '--operator',
        'test',
        '--previous-commit',
        previousCommit,
        '--github-artifact-id',
        '789',
        '--github-artifact-name',
        manifest.artifact.githubArtifactName,
        '--github-artifact-digest',
        `sha256:${'f'.repeat(64)}`,
        '--github-run-url',
        'https://github.com/example/repo/actions/runs/456'
      ],
      { encoding: 'utf8' }
    );
    assert.equal(created.status, 0, created.stderr);
    assert.equal(
      JSON.parse(readFileSync(deploymentManifest, 'utf8')).previousCommit,
      previousCommit
    );

    rmSync(join(directory, `image-admin-${commit}.tar.gz`));
    const missing = runVerifier(directory);
    assert.notEqual(missing.status, 0);
    const metadataOnly = spawnSync(
      process.execPath,
      [
        verifier,
        '--directory',
        directory,
        '--expected-commit',
        commit,
        '--expected-tag',
        releaseTag,
        '--metadata-only',
        'true'
      ],
      { encoding: 'utf8' }
    );
    assert.equal(metadataOnly.status, 0, metadataOnly.stderr);
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
    'scripts/deploy-aws-incremental-release.sh',
    'scripts/release-production.sh',
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

test('incremental image import validates and streams one compressed image archive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-single-image-load-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const imageBytes = Buffer.alloc(32768, 'one-image-layer');
  const archive = join(directory, `image-api-${commit}.tar.gz`);
  const input = join(directory, 'docker-input');
  writeFileSync(archive, gzipSync(imageBytes));
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
[[ "$*" == load ]] || exit 91
cat >"$IMAGE_INPUT"
`
  );
  writeFileSync(
    join(bin, 'df'),
    `#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf 'fixture 99999999 0 99999999 0%% /\\n'
`
  );
  chmodSync(join(bin, 'docker'), 0o700);
  chmodSync(join(bin, 'df'), 0o700);

  try {
    const result = spawnSync(
      'bash',
      [
        resolve(projectRoot, 'scripts/load-production-release-images.sh'),
        '--image',
        archive,
        sha256File(archive),
        String(imageBytes.length)
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMAGE_INPUT: input }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(input), imageBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('installer preflight reaches all image checks using only the immutable bundle', () => {
  withImageLoaderFixture(({ directory, artifact, imageBytes, input, bin, fixtureEnv }) => {
    const root = join(directory, 'deployment');
    const current = join(root, 'releases', 'current-fixture');
    const previous = join(root, 'releases', 'previous-fixture');
    const cache = join(root, 'artifacts', `${releaseTag}-${commit}`);
    const bundle = join(cache, `id-business-v2-${releaseTag}-${commit}.tar.gz`);
    for (const path of [join(current, 'scripts'), previous, cache])
      mkdirSync(path, { recursive: true });
    cpSync(artifact, bundle);
    cpSync(
      resolve(projectRoot, 'scripts/load-production-release-images.sh'),
      join(current, 'scripts/load-production-release-images.sh')
    );
    for (const path of [current, previous])
      writeFileSync(join(path, 'docker-compose.aws-mysql.yml'), 'services: {}\n');
    writeFileSync(
      join(previous, '.env.aws.production'),
      'COMPOSE_PROJECT_NAME=fixture\nV2_RUNTIME_DATABASE_URL=mysql://id_business_app:fixture@127.0.0.1:3306/fixture\nAUTO_RECHARGE_WORKER_TOKEN=fixture-only\n'
    );
    const digest = `sha256:${'b'.repeat(64)}`;
    const commands = {
      docker: `#!/usr/bin/env bash
set -eu
case "$1" in
  compose|ps) exit 0 ;;
  image) printf '%s\\n' "$3" >>"$INSPECTED_IMAGES"; printf '%s\\n' "$FIXTURE_DIGEST" ;;
  load) cat >"$IMAGE_INPUT" ;;
  *) exit 99 ;;
esac
`,
      flock: '#!/usr/bin/env bash\nexit 0\n',
      ps: '#!/usr/bin/env bash\nexit 0\n',
      systemctl: '#!/usr/bin/env bash\nexit 3\n',
      // 隔离测试不变更文件归属，但仍验证生产安装参数并复制相同输入。
      install: `#!/usr/bin/env bash
set -eu
[[ "$#" == 8 && "$1 $2 $3 $4 $5 $6" == '-m 600 -o root -g root' ]] || exit 98
cp "$7" "$8"
chmod 600 "$8"
`
    };
    for (const [name, script] of Object.entries(commands)) {
      writeFileSync(join(bin, name), script);
      chmodSync(join(bin, name), 0o700);
    }
    const installer = readFileSync(
      resolve(projectRoot, 'scripts/install-aws-production-artifact.sh'),
      'utf8'
    );
    const boundary = installer.indexOf('\ntimers_stopped=0');
    assert.ok(boundary > 0);
    // 只替换隔离根目录；实际执行安装器的入口到镜像校验，维护和数据库阶段不进入。
    const preflight = installer
      .slice(0, boundary)
      .replace(
        "deployment_root='/opt/id-business-v2'",
        `deployment_root='${root.replaceAll("'", "'\\''")}'`
      );
    assert.ok(!preflight.includes("deployment_root='/opt/id-business-v2'"));
    const env = {
      ...fixtureEnv,
      RELEASE_DIRECTORY: current,
      PREVIOUS_RELEASE_DIRECTORY: previous,
      RELEASE_MANIFEST_SCHEMA: '1',
      RELEASE_ARTIFACT_ARCHIVE: bundle,
      RELEASE_ARTIFACT_SHA256: sha256File(bundle),
      RELEASE_IMAGE_ARCHIVE_SHA256: createHash('sha256').update(imageBytes).digest('hex'),
      RELEASE_COMMIT: commit,
      RELEASE_TAG: releaseTag,
      RELEASE_DEPLOYMENT_RUN: 'fixture',
      RELEASE_BACKUP_POLICY: 'fresh',
      RELEASE_MIGRATION_REQUIRED: 'true',
      RELEASE_ACCEPTANCE_SCOPES: 'base',
      RELEASE_CHANGED_IMAGES: 'api,admin,migration,mediaResolver,recharge,gate',
      PRODUCTION_BASE_URL: 'https://example.invalid',
      PRODUCTION_COMPOSE_PROJECT: 'fixture',
      FIXTURE_DIGEST: digest,
      INSPECTED_IMAGES: join(directory, 'inspected-images')
    };
    const images = ['API', 'ADMIN', 'MIGRATION', 'MEDIA_RESOLVER', 'RECHARGE', 'GATE'];
    for (const name of images) {
      env[`RELEASE_${name}_IMAGE`] = `fixture-${name.toLowerCase()}:${commit}`;
      env[`RELEASE_${name}_DIGEST`] = digest;
      env[`RELEASE_${name}_ARCHIVE`] = '-';
      env[`RELEASE_${name}_ARCHIVE_SHA256`] = '-';
      env[`RELEASE_${name}_SIZE_BYTES`] = '-';
    }
    delete env.RELEASE_IMAGE_ARCHIVE;
    const result = spawnSync('bash', ['-s'], {
      input: preflight,
      encoding: 'utf8',
      timeout: 10000,
      env
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(input), imageBytes);
    const checked = readFileSync(env.INSPECTED_IMAGES, 'utf8').trim().split('\n');
    assert.deepEqual(
      checked.slice(-6),
      images.map((name) => env[`RELEASE_${name}_IMAGE`])
    );
    assert.equal(existsSync(bundle), true);
  });
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
  const fixtureEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: runtime,
    IMAGE_INPUT: input,
    REAL_TAR: realTar,
    TAR_COUNTER: join(directory, 'tar-count')
  };
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
          ...fixtureEnv,
          ...options.env
        }
      }
    );
  try {
    callback({
      directory,
      artifact,
      imageBytes,
      runLoader,
      input,
      runtime,
      payload,
      bin,
      fixtureEnv
    });
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

test('current production release reader exposes safe artifact inheritance metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-current-release-json-test.'));
  const releaseDirectory = join(directory, 'releases', '20260904T120000Z-aaaaaaaaaaaa');
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(
    join(releaseDirectory, 'release-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        commit,
        releaseTag,
        ciWorkflowRunId: '456',
        artifact: { githubArtifactName: `id-business-v2-${releaseTag}-${commit}-control` }
      },
      null,
      2
    )}\n`
  );
  symlinkSync(releaseDirectory, join(directory, 'current'));

  try {
    const result = spawnSync(
      'bash',
      [resolve(projectRoot, 'scripts/read-current-production-release.sh'), directory, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      directory: realpathSync(releaseDirectory),
      commit,
      releaseTag,
      schemaVersion: 2,
      ciWorkflowRunId: '456',
      controlArtifactName: `id-business-v2-${releaseTag}-${commit}-control`
    });
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

test('fixed production entry reuses successful work and permits only one failed-job rerun', () => {
  const entry = readFileSync(resolve(projectRoot, 'scripts/release-production.sh'), 'utf8');
  const incremental = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-incremental-release.sh'),
    'utf8'
  );
  assert.match(entry, /gh run rerun "\$release_run_id" --failed/u);
  assert.equal(entry.match(/gh run rerun/gu)?.length, 1);
  assert.match(entry, /release_run_attempt[\s\S]*"\$release_run_attempt" -ge 2/u);
  assert.match(entry, /请通过修复 PR 产生新 SHA 后重新验证，禁止循环重跑/u);
  assert.match(entry, /复用已成功验证的制品运行/u);
  assert.match(incremental, /复用同一版本的服务端候选发布目录/u);
  assert.match(incremental, /仅下载缺失镜像制品/u);
  assert.match(incremental, /remote_payload_state/u);
  assert.doesNotMatch(incremental, /docker(?:\s+compose)?\s+build/u);
});

test('dedicated release workflow creates split SHA-pinned immutable artifacts', () => {
  const quality = readFileSync(resolve(projectRoot, '.github/workflows/quality.yml'), 'utf8');
  const workflow = readFileSync(
    resolve(projectRoot, '.github/workflows/production-release.yml'),
    'utf8'
  );
  assert.doesNotMatch(quality, /tags:\s*\n\s*- 'v2-production-\*'/u);
  assert.match(workflow, /name: Production Release Artifact/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$PREVIOUS_COMMIT" "\$RELEASE_COMMIT"/u);
  assert.match(workflow, /assert\.equal\(run\.head_sha, process\.env\.RELEASE_COMMIT\)/u);
  assert.match(workflow, /同一 commit 已有成功不可变制品运行/u);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@[a-f0-9]{40}\s+# v4/u);
  assert.match(workflow, /scripts\/package-production-release\.sh/u);
  assert.match(workflow, /scripts\/verify-production-release-artifact\.mjs/u);
  assert.match(workflow, /Upload API image artifact/u);
  assert.match(workflow, /steps\.package\.outputs\.api_archive_path != ''/u);
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
  assert.match(workflow, /quality:\s*\n\s+needs: change-scope\s*\n\s+runs-on:/u);
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
  assert.doesNotMatch(workflow, /Package immutable production artifact/u);
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

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
