import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const retentionScript = resolve(projectRoot, 'scripts/cleanup-aws-production-retention.sh');

test('production retention keeps current and previous releases without pruning volumes', () => {
  const source = readFileSync(retentionScript, 'utf8');

  assert.match(source, /release_keep_count=5/u);
  assert.match(source, /artifact_keep_count=3/u);
  assert.match(source, /minimum_free_bytes=8589934592/u);
  assert.match(source, /DEPLOY_LOCK_HELD/u);
  assert.match(source, /current_commit/u);
  assert.match(source, /previous_commit/u);
  assert.match(source, /docker image prune --force/u);
  assert.doesNotMatch(source, /docker (?:volume|system) prune/u);
  assert.doesNotMatch(source, /docker image prune[^\n]*-a/u);
  assert.doesNotMatch(source, /ID_BUSINESS_RETENTION/u);
});

test('production retention removes only stale controlled fixtures', () => {
  const temporaryDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'idv2-retention-test-')));
  const deploymentRoot = join(temporaryDirectory, 'id-business-v2');
  const releasesRoot = join(deploymentRoot, 'releases');
  const artifactsRoot = join(deploymentRoot, 'artifacts');
  const fakeBin = join(temporaryDirectory, 'bin');
  const dockerLog = join(temporaryDirectory, 'docker.log');
  const fixtureScript = join(temporaryDirectory, 'cleanup-production-retention.sh');
  const currentCommit = 'c'.repeat(40);
  const previousCommit = 'b'.repeat(40);
  const staleCommit = 'a'.repeat(40);
  const releaseNames = [
    `20260830T050000Z-${currentCommit.slice(0, 12)}`,
    `20260830T040000Z-${previousCommit.slice(0, 12)}`,
    '20260830T030000Z-dddddddddddd',
    '20260830T020000Z-eeeeeeeeeeee',
    '20260830T010000Z-ffffffffffff',
    '20260829T230000Z-111111111111',
    '20260829T220000Z-222222222222',
    '20260829T210000Z-333333333333'
  ];
  const artifactNames = [
    `v2-production-20260830T050000Z-${currentCommit}`,
    `v2-production-20260830T040000Z-${previousCommit}`,
    `v2-production-20260830T030000Z-${staleCommit}`,
    `v2-production-20260830T020000Z-${'d'.repeat(40)}`,
    `v2-production-20260830T010000Z-${'e'.repeat(40)}`
  ];

  mkdirSync(releasesRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(fakeBin);
  for (const releaseName of releaseNames) mkdirSync(join(releasesRoot, releaseName));
  for (const artifactName of artifactNames) mkdirSync(join(artifactsRoot, artifactName));
  writeFileSync(
    join(releasesRoot, releaseNames[0], 'release-manifest.json'),
    `${JSON.stringify({ commit: currentCommit, previousCommit }, null, 2)}\n`
  );
  symlinkSync(join(releasesRoot, releaseNames[0]), join(deploymentRoot, 'current'));
  const fixtureSource = readFileSync(retentionScript, 'utf8')
    .replace("deployment_root='/opt/id-business-v2'", `deployment_root='${deploymentRoot}'`)
    .replace('minimum_free_bytes=8589934592', 'minimum_free_bytes=1')
    .replace('if [[ "$(id -u)" != 0 ]]; then', 'if false; then');
  writeExecutable(fixtureScript, fixtureSource);
  writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/sh\nexit 3\n`);
  writeExecutable(join(fakeBin, 'flock'), `#!/bin/sh\nexit 0\n`);
  writeExecutable(
    join(fakeBin, 'docker'),
    `#!/bin/sh
set -eu
if [ "$1" = image ] && [ "$2" = ls ]; then
  printf '%s\n' \
    'id-business-v2-release-api:${currentCommit}' \
    'id-business-v2-release-api:${previousCommit}' \
    'id-business-v2-release-api:${staleCommit}' \
    'id-business-v2-rollback-api:legacy' \
    'mysql:8.4'
elif [ "$1" = image ] && [ "$2" = rm ]; then
  printf 'remove=%s\n' "$3" >>"$DOCKER_LOG"
elif [ "$1" = image ] && [ "$2" = prune ]; then
  printf 'prune=dangling-only\n' >>"$DOCKER_LOG"
else
  exit 2
fi
`
  );

  try {
    const result = spawnSync('bash', [fixtureScript, '--scheduled'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCKER_LOG: dockerLog,
        PATH: `${fakeBin}:${process.env.PATH}`
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.removedReleases, 3);
    assert.equal(summary.removedArtifacts, 2);
    assert.equal(summary.removedImageReferences, 2);
    assert.deepEqual(readdirSync(releasesRoot).sort(), releaseNames.slice(0, 5).sort());
    assert.deepEqual(readdirSync(artifactsRoot).sort(), artifactNames.slice(0, 3).sort());
    const dockerOperations = readFileSync(dockerLog, 'utf8');
    assert.match(
      dockerOperations,
      new RegExp(`remove=id-business-v2-release-api:${staleCommit}`, 'u')
    );
    assert.match(dockerOperations, /remove=id-business-v2-rollback-api:legacy/u);
    assert.match(dockerOperations, /prune=dangling-only/u);
    assert.doesNotMatch(dockerOperations, new RegExp(currentCommit, 'u'));
    assert.doesNotMatch(dockerOperations, new RegExp(previousCommit, 'u'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('deployment installs and verifies the daily retention timer', () => {
  const installer = readFileSync(
    resolve(projectRoot, 'scripts/install-aws-production-artifact.sh'),
    'utf8'
  );
  const deployer = readFileSync(
    resolve(projectRoot, 'scripts/deploy-aws-production-artifact.sh'),
    'utf8'
  );
  const service = readFileSync(
    resolve(projectRoot, 'deploy/systemd/id-business-v2-production-retention.service'),
    'utf8'
  );
  const timer = readFileSync(
    resolve(projectRoot, 'deploy/systemd/id-business-v2-production-retention.timer'),
    'utf8'
  );

  assert.match(deployer, /cleanup-aws-production-retention\.sh/u);
  assert.match(deployer, /--preflight/u);
  assert.match(deployer, /available_kib < 8388608/u);
  assert.match(installer, /install_retention_timer/u);
  assert.match(installer, /--post-deploy/u);
  assert.match(installer, /systemctl enable --now id-business-v2-production-retention\.timer/u);
  assert.match(installer, /retention_timer_changed/u);
  assert.match(installer, /systemctl disable --now id-business-v2-production-retention\.timer/u);
  assert.match(service, /cleanup-aws-production-retention\.sh --scheduled/u);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:15:00 UTC/u);
  assert.match(timer, /Persistent=true/u);
});

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
