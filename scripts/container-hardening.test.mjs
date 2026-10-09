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

function composeService(compose, name) {
  const service = compose.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:|\\nvolumes:)`, 'mu')
  )?.[0];
  assert.ok(service, `${name} service exists`);
  return service;
}

test('production base images and GitHub Actions are immutable', () => {
  const apiDockerfile = readProjectFile('apps/api/Dockerfile.mysql');
  const mediaResolverDockerfile = readProjectFile(
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile'
  );
  const rechargeDockerfile = readProjectFile(
    'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile'
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
  assert.match(
    rechargeDockerfile,
    new RegExp(`^FROM python:3\\.12-slim-bookworm@${sha256DigestPattern}`, 'mu')
  );
  assert.match(adminDockerfile, new RegExp(`^FROM node:24-alpine@${sha256DigestPattern}`, 'mu'));
  assert.match(
    adminDockerfile,
    new RegExp(`^FROM nginx:1\\.27-alpine@${sha256DigestPattern}`, 'mu')
  );
  assert.match(compose, new RegExp(`image: mysql:8\\.4@${sha256DigestPattern}`, 'u'));
  assert.match(compose, new RegExp(`image: caddy:2\\.10-alpine@${sha256DigestPattern}`, 'u'));
  assert.match(restoreScript, new RegExp(`mysql_image="mysql:8\\.4@${sha256DigestPattern}"`, 'u'));
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d+/u);
  assert.match(workflow, /uses:\s+actions\/checkout@[a-f0-9]{40}\s+# v5/u);
  assert.match(workflow, /uses:\s+actions\/setup-node@[a-f0-9]{40}\s+# v5/u);
});

test('auto-recharge worker pins its fingerprint engine and keeps legacy browser compatibility', () => {
  const dockerfile = readProjectFile('apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile');
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const worker = composeService(compose, 'auto-recharge');

  assert.doesNotMatch(dockerfile, /mcr\\.microsoft\\.com\/playwright/u);
  assert.match(dockerfile, /playwright install --with-deps chromium/u);
  assert.match(dockerfile, /playwright install-deps firefox/u);
  assert.match(
    dockerfile,
    /install_fingerprint_browser\.py --destination \/opt\/camoufox --platform lin\.x86_64/u
  );
  assert.match(
    readProjectFile('apps/api/src/id-business-v2/auto-recharge/worker/requirements.lock.txt'),
    /^camoufox==0\.5\.6$/mu
  );
  const installer = readProjectFile(
    'apps/api/src/id-business-v2/auto-recharge/worker/install_fingerprint_browser.py'
  );
  assert.match(installer, /VERSION = '152\.0\.4-beta\.30'/u);
  assert.match(installer, /'lin\.x86_64': '[a-f0-9]{64}'/u);
  assert.match(installer, /digest\.hexdigest\(\) != ASSETS\[platform\]/u);
  assert.match(dockerfile, /^USER recharge$/mu);
  assert.match(worker, /init: true/u);
  assert.match(worker, /read_only: true/u);
  assert.match(worker, /no-new-privileges:true/u);
  assert.match(worker, /cap_drop:\s+- ALL/u);
  assert.match(worker, /\/tmp:rw,noexec,nosuid,nodev,size=512m/u);
  assert.match(worker, /shm_size: 256m/u);
  assert.match(worker, /pids_limit: 512/u);
  assert.match(worker, /mem_limit: 1g/u);
  assert.match(worker, /memswap_limit: 1536m/u);
  assert.match(worker, /networks:\s+- recharge-control\s+- recharge-egress/u);
  assert.doesNotMatch(worker, /ports:/u);
});

test('registration and recharge run in separate bounded workers with one image build', () => {
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const recharge = composeService(compose, 'auto-recharge');
  const registration = composeService(compose, 'auto-registration');
  const api = composeService(compose, 'api');

  assert.match(recharge, /image: &browser-worker-image \$\{AUTO_RECHARGE_WORKER_IMAGE:/u);
  assert.match(recharge, /build:/u);
  assert.match(recharge, /AUTO_RECHARGE_WORKER_ROLE: recharge/u);
  assert.match(registration, /image: \*browser-worker-image/u);
  assert.match(registration, /AUTO_RECHARGE_WORKER_ROLE: registration/u);
  assert.doesNotMatch(registration, /build:/u);
  for (const [worker, network] of [
    [recharge, 'recharge'],
    [registration, 'registration']
  ]) {
    assert.match(worker, /init: true/u);
    assert.match(worker, /read_only: true/u);
    assert.match(worker, /no-new-privileges:true/u);
    assert.match(worker, /cap_drop:\s+- ALL/u);
    assert.match(worker, /\/tmp:rw,noexec,nosuid,nodev,size=512m/u);
    assert.match(worker, /shm_size: 256m/u);
    assert.match(worker, /pids_limit: 512/u);
    assert.match(worker, /mem_limit: 1g/u);
    assert.match(worker, /memswap_limit: 1536m/u);
    assert.match(
      worker,
      new RegExp(`networks:\\s+- ${network}-control\\s+- ${network}-egress`, 'u')
    );
    assert.doesNotMatch(worker, /ports:|volumes:|pid:|ipc:|network_mode:|container_name:/u);
  }
  assert.match(api, /AUTO_RECHARGE_WORKER_URL: http:\/\/auto-recharge:8051/u);
  assert.match(api, /AUTO_REGISTRATION_WORKER_URL: http:\/\/auto-registration:8051/u);
  assert.match(api, /- recharge-control\s+- registration-control/u);
  assert.match(compose, /registration-control:\s+internal: true/u);
  for (const path of ['.env.example', '.env.aws.production.example']) {
    assert.match(readProjectFile(path), /^AUTO_RECHARGE_WORKER_ROLE=recharge$/mu);
    assert.doesNotMatch(readProjectFile(path), /AUTO_REGISTRATION_WORKER_URL/u);
    assert.match(
      readProjectFile(path),
      /^AUTO_RECHARGE_WORKER_IMAGE=id-business-v2-auto-recharge:local$/mu
    );
  }
});

test('CI and production image installs defer vulnerability checks to the explicit audit gate', () => {
  const apiDockerfile = readProjectFile('apps/api/Dockerfile.mysql');
  const adminDockerfile = readProjectFile('apps/admin/Dockerfile');
  const workflow = readProjectFile('.github/workflows/quality.yml');

  assert.match(workflow, /run: npm ci --no-audit/u);
  assert.match(adminDockerfile, /RUN npm ci --no-audit/u);
  assert.match(apiDockerfile, /RUN npm ci --no-audit/u);
  assert.match(apiDockerfile, /npm install --no-audit --package-lock-only/u);
  assert.match(apiDockerfile, /npm ci --no-audit --ignore-scripts/u);
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

test('registration runtime is packaged outside its writable persistent data volume', () => {
  const dockerfile = readProjectFile('apps/api/Dockerfile.mysql');
  const runtime = dockerfile.split(/ AS runtime\s*\n/u).at(-1);
  const compose = readProjectFile('docker-compose.aws-mysql.yml');
  const api = compose.split(/\n {2}api:\n/u)[1].split(/\n {2}admin:\n/u)[0];

  assert.match(runtime, /apt-get install[^\n]*python3/u);
  assert.match(runtime, /COPY --from=registration-dependencies \/opt\/id-registration\/venv/u);
  assert.match(runtime, /\/app\/apps\/api\/src\/id-business-v2\/auto-registration/u);
  assert.match(runtime, /\/app\/apps\/admin\/src\/v2\/styles\/base\.css/u);
  assert.match(runtime, /chown node:node \/app\/\.runtime/u);
  assert.match(api, /read_only: true/u);
  assert.match(api, /auto_registration_data:\/app\/\.runtime\/auto-registration/u);
  assert.match(compose, /^ {2}auto_registration_data:$/mu);
  assert.doesNotMatch(api, /\/opt\/id-registration/u);
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
  assert.match(dockerfile, /python \/opt\/security\/prepare_f2\.py/u);
  assert.match(
    readProjectFile('apps/api/src/id-business-v2/workspace/media-resolver/prepare_f2.py'),
    /COMMIT = "[a-f0-9]{40}"/u
  );
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
