import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
const releaseTag = 'v2-production-20260907T120000Z';
const region = 'ap-southeast-1';
const registry = `123456789012.dkr.ecr.${region}.amazonaws.com`;
const imageNames = ['api', 'admin', 'migration', 'mediaResolver', 'recharge', 'gate'];

test('source-only ECR release artifact verifies and rejects corruption', () => {
  const directory = createReleaseFixture();
  try {
    const accepted = runVerifier(directory);
    assert.equal(accepted.status, 0, accepted.stderr);
    const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
    assert.equal(JSON.parse(accepted.stdout).artifactSha256, manifest.artifact.sha256);
    assert.equal(manifest.delivery, 'aws-ecr');

    writeFileSync(join(directory, manifest.artifact.file), 'corrupted');
    const rejected = runVerifier(directory);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /源码制品 SHA-256 不一致/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release artifact verifier streams hashes and forbids old nested image archives', () => {
  const source = readFileSync(verifier, 'utf8');
  assert.match(source, /createReadStream\(path\)/u);
  assert.match(source, /for await \(const chunk of stream\)/u);
  assert.doesNotMatch(source, /images\.tar|source\.tar\.gz/u);
});

test('release packager emits a small source archive and ECR digest manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-package-ecr-'));
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot }).trim();
  const digest = `sha256:${'b'.repeat(64)}`;
  const env = {
    ...process.env,
    RELEASE_SOURCE_BRANCH: 'main',
    RELEASE_COMMIT: head,
    RELEASE_TAG: releaseTag,
    RELEASE_CI_RUN_ID: '123',
    RELEASE_CI_RUN_NUMBER: '45',
    RELEASE_OPERATOR: 'github-actions',
    RELEASE_OUTPUT_DIR: directory,
    RELEASE_AWS_REGION: region,
    RELEASE_ECR_REGISTRY: registry
  };
  for (const name of imageNames) {
    const key = name === 'mediaResolver' ? 'MEDIA_RESOLVER' : name.toUpperCase();
    const repository = name === 'mediaResolver' ? 'media-resolver' : name;
    env[`RELEASE_${key}_IMAGE`] = `${registry}/id-business-v2-${repository}:${head}`;
    env[`RELEASE_${key}_DIGEST`] = digest;
  }
  try {
    const result = spawnSync(
      'bash',
      [resolve(projectRoot, 'scripts/package-production-release.sh')],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
    const listing = run('tar', ['-tzf', join(directory, manifest.artifact.file)]);
    assert.doesNotMatch(listing, /images\.tar|source\.tar\.gz/u);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.images.api.reference, `${registry}/id-business-v2-api@${digest}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('EC2 image pull uses an isolated Docker login and exact ECR digests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-ecr-pull-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'docker.log');
  mkdirSync(bin);
  writeExecutable(
    join(bin, 'aws'),
    '#!/usr/bin/env bash\n[[ "$*" == "ecr get-login-password --region ap-southeast-1" ]] || exit 9\nprintf token\n'
  );
  writeExecutable(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
case "$1 $2" in
  'login --username') cat >/dev/null; printf 'login=%s\n' "\${5}" >>"$DOCKER_LOG" ;;
  'pull --platform') printf 'pull=%s\n' "\${4}" >>"$DOCKER_LOG" ;;
  'image inspect')
    if [[ "\${5}" == '{{.Os}}/{{.Architecture}}' ]]; then printf 'linux/amd64\n'; else printf '["%s"]\n' "\${3}"; fi ;;
  *) exit 8 ;;
esac
`
  );
  const digest = `sha256:${'c'.repeat(64)}`;
  const references = ['api', 'admin', 'migration', 'media-resolver', 'recharge', 'gate'].map(
    (name) => `${registry}/id-business-v2-${name}@${digest}`
  );
  try {
    const result = spawnSync(
      'bash',
      [
        resolve(projectRoot, 'scripts/pull-production-release-images.sh'),
        region,
        registry,
        ...references
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_LOG: log,
          TMPDIR: directory
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const operations = readFileSync(log, 'utf8');
    for (const reference of references)
      assert.match(operations, new RegExp(escapeRegExp(reference), 'u'));
    assert.equal(
      readFileSync(
        resolve(projectRoot, 'scripts/pull-production-release-images.sh'),
        'utf8'
      ).includes('export DOCKER_CONFIG="$docker_config"'),
      true
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production scripts are syntactically valid and never build or use SSH tar transfer', () => {
  for (const script of [
    'scripts/package-production-release.sh',
    'scripts/deploy-aws-production-artifact.sh',
    'scripts/bootstrap-aws-production-ecr-release.sh',
    'scripts/read-current-production-release.sh',
    'scripts/install-aws-production-artifact.sh',
    'scripts/pull-production-release-images.sh',
    'scripts/cleanup-aws-production-retention.sh'
  ]) {
    const result = spawnSync('bash', ['-n', resolve(projectRoot, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
  const installer = readProjectFile('scripts/install-aws-production-artifact.sh');
  const deployer = readProjectFile('scripts/deploy-aws-production-artifact.sh');
  assert.doesNotMatch(installer, /docker(?:\s+compose)?\s+build|--build(?:\s|$)/u);
  assert.match(installer, /pull-production-release-images\.sh/u);
  assert.match(installer, /flock -n/u);
  assert.match(deployer, /aws ssm send-command/u);
  assert.match(deployer, /aws s3 cp/u);
  assert.doesNotMatch(deployer, /\b(?:ssh|scp)\b|images\.tar|docker load/u);
});

test('deployment manifest records SSM and S3 transport without secrets', () => {
  const directory = createReleaseFixture();
  const input = join(directory, 'release-manifest.json');
  const output = join(directory, 'deployment-manifest.json');
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(projectRoot, 'scripts/create-production-deployment-manifest.mjs'),
        '--input',
        input,
        '--output',
        output,
        '--deployment-run',
        'github-123-1-aaaaaaaaaaaa',
        '--deployed-at',
        '2026-09-07T12:00:00Z',
        '--operator',
        'github-actions:tester',
        '--previous-commit',
        'd'.repeat(40),
        '--github-artifact-id',
        '123',
        '--github-artifact-name',
        `id-business-v2-${releaseTag}-${commit}`,
        '--github-artifact-digest',
        `sha256:${'e'.repeat(64)}`,
        '--github-run-url',
        'https://github.com/example/repo/actions/runs/123',
        '--aws-region',
        region,
        '--release-bucket',
        'id-business-v2-releases-123456789012-ap-southeast-1',
        '--release-prefix',
        `releases/${releaseTag}/${commit}/deployments/github-123-1-aaaaaaaaaaaa`,
        '--production-base-url',
        'https://example.com',
        '--production-compose-project',
        'id-business-v2-prod'
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(manifest.transport.type, 'aws-ssm-s3');
    assert.equal(manifest.previousCommit, 'd'.repeat(40));
    assert.doesNotMatch(readFileSync(output, 'utf8'), /password|token|private.?key/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production workflow uses OIDC, immutable ECR and a protected manual deployment', () => {
  const quality = readProjectFile('.github/workflows/quality.yml');
  const deploy = readProjectFile('.github/workflows/deploy-production.yml');
  const infrastructure = readProjectFile('deploy/aws/id-business-v2-ecr-release.yaml');
  assert.match(quality, /id-token:\s+write/u);
  assert.match(quality, /aws-actions\/configure-aws-credentials@[a-f0-9]{40}/u);
  assert.match(quality, /aws-actions\/amazon-ecr-login@[a-f0-9]{40}/u);
  assert.match(quality, /docker\/setup-buildx-action@[a-f0-9]{40}/u);
  assert.match(quality, /docker push "\$ecr_reference"/u);
  assert.match(deploy, /environment:\s+production/u);
  assert.match(deploy, /workflow_dispatch/u);
  assert.doesNotMatch(deploy, /SERVER_SSH|PRIVATE_KEY|scp|ssh/u);
  assert.equal((infrastructure.match(/ImageTagMutability: IMMUTABLE/gu) ?? []).length, 6);
  assert.match(infrastructure, /repo:\$\{GitHubRepository\}:environment:production/u);
  assert.doesNotMatch(infrastructure, /AWS-RunShellScript/u);
});

test('current production release reader validates and returns the immutable target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-current-release-test.'));
  const releaseDirectory = join(directory, 'releases', '20260907T120000Z-aaaaaaaaaaaa');
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

function createReleaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'idv2-artifact-ecr-'));
  const source = join(directory, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), '{"private":true}\n');
  writeFileSync(join(source, '.env.aws.production.example'), 'MYSQL_PASSWORD=placeholder\n');
  const artifactFile = `id-business-v2-${releaseTag}-${commit}.tar.gz`;
  const artifactPath = join(directory, artifactFile);
  run('tar', ['-czf', artifactPath, '-C', source, '.']);
  const digest = `sha256:${'b'.repeat(64)}`;
  const images = {};
  for (const name of imageNames) {
    const repository = name === 'mediaResolver' ? 'media-resolver' : name;
    images[name] = {
      taggedReference: `${registry}/id-business-v2-${repository}:${commit}`,
      reference: `${registry}/id-business-v2-${repository}@${digest}`,
      digest,
      platform: 'linux/amd64'
    };
  }
  const manifest = {
    schemaVersion: 2,
    delivery: 'aws-ecr',
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
      githubArtifactName: `id-business-v2-${releaseTag}-${commit}`
    },
    aws: { region, ecrRegistry: registry },
    images,
    environment: 'production',
    builtAt: '2026-09-07T12:00:00Z',
    builtBy: 'github-actions',
    operator: 'github-actions',
    deployedAt: null,
    previousCommit: null
  };
  writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

function runVerifier(directory) {
  return spawnSync(
    process.execPath,
    [verifier, '--directory', directory, '--expected-commit', commit, '--expected-tag', releaseTag],
    { encoding: 'utf8' }
  );
}

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
