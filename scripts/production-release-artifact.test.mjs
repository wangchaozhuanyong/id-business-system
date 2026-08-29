import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      ['api', 'admin', 'migration', 'gate'].map((name) => [
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

test('release scripts pass shell syntax and production installation never builds images', () => {
  for (const script of [
    'scripts/package-production-release.sh',
    'scripts/deploy-aws-production-artifact.sh',
    'scripts/install-aws-production-artifact.sh'
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
});

test('tag workflow uploads one SHA-pinned immutable artifact', () => {
  const workflow = readFileSync(resolve(projectRoot, '.github/workflows/quality.yml'), 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- 'v2-production-\*'/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@[a-f0-9]{40}\s+# v4/u);
  assert.match(workflow, /scripts\/package-production-release\.sh/u);
  assert.match(workflow, /scripts\/verify-production-release-artifact\.mjs/u);
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
