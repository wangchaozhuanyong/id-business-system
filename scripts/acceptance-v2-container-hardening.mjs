import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tagSuffix = `${process.pid}-${Date.now()}`;
const providedRuntimeImage = process.env.V2_RUNTIME_IMAGE?.trim();
const providedMigrationImage = process.env.V2_MIGRATION_IMAGE?.trim();
const providedMediaResolverImage = process.env.V2_MEDIA_RESOLVER_IMAGE?.trim();
const runtimeImage = providedRuntimeImage || `id-business-v2-api-runtime-acceptance:${tagSuffix}`;
const migrationImage =
  providedMigrationImage || `id-business-v2-api-migration-acceptance:${tagSuffix}`;
const mediaResolverImage =
  providedMediaResolverImage || `id-business-v2-media-resolver-acceptance:${tagSuffix}`;
const removeImagesAfterAcceptance = !providedRuntimeImage && !providedMigrationImage;

assert.equal(
  Boolean(providedRuntimeImage),
  Boolean(providedMigrationImage) && Boolean(providedMediaResolverImage),
  '复用制品验收时必须同时提供 API、migration 与媒体解析镜像'
);

const runtimeProbe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.notEqual(process.getuid(), 0, 'runtime must not run as root');
assert.equal(fs.existsSync('/app/apps/api/src'), false, 'API source must not be present');
assert.equal(fs.existsSync('/app/apps/api/prisma-mysql'), false, 'migrations must not be present');
assert.equal(fs.existsSync('/app/node_modules/.bin/prisma'), false, 'Prisma CLI must not be present');
assert.equal(fs.existsSync('/app/node_modules/typescript'), false, 'TypeScript must not be present');
assert.ok(require.resolve('@prisma/client'));
assert.ok(require.resolve('@apple-business/shared'));
assert.throws(() => fs.writeFileSync('/app/runtime-write-probe', 'blocked'), /EROFS|EACCES/);
fs.writeFileSync('/tmp/runtime-write-probe', 'allowed');
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m, 'effective capabilities must be empty');
assert.match(status, /^NoNewPrivs:\s+1$/m, 'no-new-privileges must be active');
console.log('runtime-boundary-ok');
`;

const migrationProbe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.notEqual(process.getuid(), 0, 'migration must not run as root');
assert.ok(fs.existsSync('/app/apps/api/prisma-mysql/schema.prisma'));
assert.ok(fs.existsSync('/app/node_modules/.bin/prisma'));
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
console.log('migration-boundary-ok');
`;

try {
  run('docker', ['info'], { stdio: 'ignore' });
  if (!providedRuntimeImage) buildImage('runtime', runtimeImage);
  if (!providedMigrationImage) buildImage('migration', migrationImage);
  if (!providedMediaResolverImage) buildMediaResolverImage(mediaResolverImage);

  const runtimeInspect = inspectImage(runtimeImage);
  const migrationInspect = inspectImage(migrationImage);
  const mediaResolverInspect = inspectImage(mediaResolverImage);
  assert.equal(runtimeInspect.Config.User, 'node');
  assert.equal(migrationInspect.Config.User, 'node');
  assert.equal(mediaResolverInspect.Config.User, 'resolver');
  assert.ok(
    runtimeInspect.Size < migrationInspect.Size,
    `runtime image (${runtimeInspect.Size}) must be smaller than migration image (${migrationInspect.Size})`
  );

  runHardened(runtimeImage, ['node', '-e', runtimeProbe]);
  runHardened(migrationImage, ['node', '-e', migrationProbe]);
  runHardened(migrationImage, ['/app/node_modules/.bin/prisma', '--version']);
  runHardened(mediaResolverImage, ['python', '/app/server.py', '--self-test'], '640m');
  runHardened(
    mediaResolverImage,
    [
      'python',
      '-c',
      "import os, pathlib, yt_dlp; assert os.getuid() != 0; assert pathlib.Path('/app/server.py').is_file(); " +
        "assert pathlib.Path('/app/f2_bridge.py').is_file(); " +
        "pathlib.Path('/tmp/resolver-write-probe').write_text('allowed'); " +
        "status=pathlib.Path('/proc/self/status').read_text(); assert 'NoNewPrivs:\\t1' in status; " +
        "print('media-runtime-ok')"
    ],
    '640m'
  );
  runHardened(
    mediaResolverImage,
    ['/opt/f2/bin/python', '-c', "import f2; print('f2-runtime-ok')"],
    '640m'
  );

  console.log(
    JSON.stringify({
      status: 'passed',
      runtimeImageBytes: runtimeInspect.Size,
      migrationImageBytes: migrationInspect.Size,
      mediaResolverImageBytes: mediaResolverInspect.Size,
      runtimeUser: runtimeInspect.Config.User,
      migrationUser: migrationInspect.Config.User,
      mediaResolverUser: mediaResolverInspect.Config.User
    })
  );
} finally {
  if (removeImagesAfterAcceptance) {
    spawnSync(
      'docker',
      ['image', 'rm', '--force', runtimeImage, migrationImage, mediaResolverImage],
      {
        cwd: projectRoot,
        stdio: 'ignore'
      }
    );
  }
}

function buildImage(target, tag) {
  run('docker', [
    'build',
    '--file',
    'apps/api/Dockerfile.mysql',
    '--target',
    target,
    '--tag',
    tag,
    '.'
  ]);
}

function buildMediaResolverImage(tag) {
  run('docker', [
    'build',
    '--file',
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile',
    '--tag',
    tag,
    '.'
  ]);
}

function inspectImage(tag) {
  return JSON.parse(run('docker', ['image', 'inspect', tag], { capture: true }))[0];
}

function runHardened(image, command, tmpfsSize = '64m') {
  run('docker', [
    'run',
    '--rm',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsSize}`,
    image,
    ...command
  ]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? (options.capture ? 'pipe' : 'inherit')
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`
    );
  }
  return result.stdout ?? '';
}
