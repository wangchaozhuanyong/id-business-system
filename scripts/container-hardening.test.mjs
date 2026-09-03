import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256DigestPattern = 'sha256:[a-f0-9]{64}';

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

test('production base images and GitHub Actions are immutable', () => {
  const apiDockerfile = readProjectFile('apps/api/Dockerfile.mysql');
  const mediaResolverDockerfile = readProjectFile(
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile'
  );
  const adminDockerfile = readProjectFile('apps/admin/Dockerfile');
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const workflow = readProjectFile('.github/workflows/quality.yml');
  const restoreScript = readProjectFile('scripts/verify-aws-mysql-backup.sh');

  assert.doesNotMatch(apiDockerfile, /^FROM node:24-bookworm-slim AS /mu);
  assert.match(
    apiDockerfile,
    new RegExp(`^FROM node:24-bookworm-slim@${sha256DigestPattern}`, 'mu')
  );
  assert.match(
    mediaResolverDockerfile,
    new RegExp(`^FROM python:3\\.11-slim-bookworm@${sha256DigestPattern}`, 'mu')
  );
  assert.match(adminDockerfile, new RegExp(`^FROM node:24-alpine@${sha256DigestPattern}`, 'mu'));
  assert.match(
    adminDockerfile,
    new RegExp(`^FROM nginx:1\\.27-alpine@${sha256DigestPattern}`, 'mu')
  );
  assert.match(compose, new RegExp(`image: mysql:8\\.4@${sha256DigestPattern}`, 'u'));
  assert.match(compose, new RegExp(`image: caddy:2\\.10-alpine@${sha256DigestPattern}`, 'u'));
  assert.match(restoreScript, new RegExp(`mysql_image="mysql:8\\.4@${sha256DigestPattern}"`, 'u'));
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|upload-artifact)@v\d+/u);
  assert.match(workflow, /uses:\s+actions\/checkout@[a-f0-9]{40}\s+# v5/u);
  assert.match(workflow, /uses:\s+actions\/setup-node@[a-f0-9]{40}\s+# v5/u);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@[a-f0-9]{40}\s+# v4/u);
});

test('API runtime image excludes build workspace and runs as node', () => {
  const dockerfile = readProjectFile('apps/api/Dockerfile.mysql');
  const runtime = dockerfile.split(/ AS runtime\s*\n/u).at(-1);
  const migration = dockerfile
    .split(/ AS migration\s*\n/u)
    .at(-1)
    .split(/\nFROM /u)[0];

  assert.ok(runtime);
  assert.ok(migration);
  assert.doesNotMatch(runtime, /COPY --from=build \/app \/app/u);
  assert.match(runtime, /COPY --from=production-dependencies .*\/app\/node_modules/u);
  assert.match(runtime, /\/app\/apps\/api\/dist/u);
  assert.match(runtime, /\/app\/packages\/shared\/dist/u);
  assert.doesNotMatch(runtime, /prisma-mysql/u);
  assert.match(runtime, /\nUSER node\n/u);
  assert.match(migration, /\/app\/apps\/api\/prisma-mysql/u);
  assert.match(migration, /\nUSER node\n/u);
});

test('production Compose enforces the API and migration container boundaries', () => {
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const migrate = compose.split(/\n {2}migrate:\n/u)[1].split(/\n {2}api:\n/u)[0];
  const api = compose.split(/\n {2}api:\n/u)[1].split(/\n {2}admin:\n/u)[0];

  for (const [name, service, target] of [
    ['migrate', migrate, 'migration'],
    ['api', api, 'runtime']
  ]) {
    assert.match(service, new RegExp(`target: ${target}`, 'u'), `${name} build target`);
    assert.match(service, /read_only: true/u, `${name} read-only root filesystem`);
    assert.match(service, /no-new-privileges:true/u, `${name} no-new-privileges`);
    assert.match(service, /cap_drop:\s+- ALL/u, `${name} drops all capabilities`);
    assert.match(service, /\/tmp:rw,noexec,nosuid,nodev,size=64m/u, `${name} bounded tmpfs`);
  }
});

test('media resolver is an isolated, bounded and non-root sidecar', () => {
  const dockerfile = readProjectFile(
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile'
  );
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const resolver = compose.split(/\n {2}media-resolver:\n/u)[1].split(/\n {2}api:\n/u)[0];
  const api = compose.split(/\n {2}api:\n/u)[1].split(/\n {2}admin:\n/u)[0];

  assert.match(dockerfile, /\nUSER resolver\n/u);
  assert.match(dockerfile, /YT_DLP_VERSION=2026\.08\.19/u);
  assert.match(dockerfile, /YT_DLP_COMMIT=[a-f0-9]{40}/u);
  assert.match(dockerfile, /F2_COMMIT=[a-f0-9]{40}/u);
  assert.match(dockerfile, /curl-cffi,pin-curl-cffi/u);
  assert.match(dockerfile, /deno,pin-deno/u);
  const worker = readProjectFile('apps/api/src/id-business-v2/workspace/media-resolver/server.py');
  assert.match(worker, /WORKER_TICKET_TTL_SECONDS = 10 \* 60/u);
  assert.match(worker, /MAX_WORKER_TICKETS = 128/u);
  assert.match(worker, /MAX_WORKER_TICKET_BYTES = 2 \* 1024 \* 1024/u);
  const cachedDownload = worker
    .split(/def download_with_ytdlp\(/u)[1]
    .split(/\ndef ytdlp_options\(/u)[0];
  assert.match(cachedDownload, /ydl\.process_ie_result\(info, download=True\)/u);
  assert.doesNotMatch(cachedDownload, /extract_info/u);
  assert.match(resolver, /read_only: true/u);
  assert.match(resolver, /no-new-privileges:true/u);
  assert.match(resolver, /cap_drop:\s+- ALL/u);
  assert.match(resolver, /\/tmp:rw,noexec,nosuid,nodev,size=640m/u);
  assert.match(resolver, /pids_limit: 128/u);
  assert.match(resolver, /mem_limit: 768m/u);
  assert.match(resolver, /networks:\s+- media-egress/u);
  assert.doesNotMatch(resolver, /ports:/u);
  assert.match(api, /ID_BUSINESS_V2_MEDIA_RESOLVER_URL: http:\/\/media-resolver:8787/u);
});
