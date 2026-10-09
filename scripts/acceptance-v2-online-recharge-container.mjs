// Actual local images and a fresh, labelled MySQL fixture. No payment or external notification.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = resolve(root, '.runtime/online-recharge/container');
const usage =
  'node scripts/acceptance-v2-online-recharge-container.mjs --api-image <local:tag> --migration-image <local:tag> --engine-image <local:tag> [--docker <path>] [--api-recheck]';
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (key === '--api-recheck') {
    if (options[key]) throw new Error('Duplicate fixture option');
    options[key] = true;
    continue;
  }
  if (!['--api-image', '--migration-image', '--engine-image', '--docker'].includes(key))
    throw new Error('Unknown fixture option');
  const value = process.argv[++index];
  if (!value || value.startsWith('--') || options[key]) throw new Error('Invalid fixture option');
  options[key] = value;
}
for (const key of ['--api-image', '--migration-image', '--engine-image']) {
  const value = options[key];
  if (!value || !/^[a-zA-Z0-9./_-]+:[a-zA-Z0-9_.-]+$/.test(value) || /:latest$/.test(value))
    throw new Error(`A fixed local image tag is required: ${key}`);
}
const docker = options['--docker'] || process.env.ONLINE_RECHARGE_CONTAINER_DOCKER || 'docker';
const fixtureId = randomUUID();
const prefix = `online-recharge-container-${fixtureId}`;
const ownerLabel = 'id-business-v2.fixture';
const identityLabel = 'id-business-v2.fixture-id';
const labels = {
  [ownerLabel]: 'online-recharge-container',
  [identityLabel]: fixtureId
};
const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
const resources = [];
const secret = () => randomBytes(32).toString('hex');
const workerKey = secret();
const database = `recharge_fixture_${fixtureId.replaceAll('-', '')}`;
const databaseUser = 'recharge_fixture';
const databasePassword = secret();
const databaseUrl = `mysql://${databaseUser}:${databasePassword}@mysql:3306/${database}`;
const cardId = randomUUID();
const taskId = randomUUID();
const report = {
  scope: 'LOCAL_SYNTHETIC_CONTAINER_ONLY',
  mode: options['--api-recheck'] ? 'API_INTEGRATION_RECHECK' : 'FULL',
  fixtureId,
  realSession: 'NOT_USED',
  realPayment: 'NOT_MEASURED',
  productionDatabase: 'NOT_CONNECTED',
  externalNotification: 'NOT_SENT',
  websocket: 'REUSES_UNCHANGED_GATEWAY_9_CASES',
  cases: [],
  reusedCases: [],
  images: {},
  cleanup: []
};
const reusableCases = new Set([
  'actual_nine_table_schema_information_schema_reflection',
  'credentials_only_engine_ready_without_jobs_or_browser',
  'cvc_extraction_endpoint_absent_and_wrong_key_denied'
]);
let stage = 'preflight';
let api,
  engine,
  mysql,
  dataVolume,
  network,
  engineGeneration = 0;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const unwrap = (value) => (value?.success === true && 'data' in value ? value.data : value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Never print Docker arguments, Env, raw logs, or database output: they may contain fixture keys.
async function command(args, { input, timeout = 60000, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [],
      stderr = [];
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('DOCKER_COMMAND_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim()
      };
      if (expired) reject(new Error('DOCKER_COMMAND_TIMEOUT'));
      else if (code !== 0 && !allowFailure) {
        const error = new Error('DOCKER_COMMAND_FAILED');
        error.dockerDiagnostic = result.stderr
          .replace(/mysql:\/\/[^\s"']+/gi, '[redacted-database-url]')
          .replace(/\b[a-f0-9]{64}\b/gi, '[redacted-secret-or-digest]')
          .replace(/\b731\b/g, '[redacted-synthetic-cvc]')
          .slice(0, 1000);
        reject(error);
      } else done(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function inspect(kind, id) {
  return JSON.parse((await command([kind, 'inspect', id])).stdout)[0];
}
function owned(value) {
  const actual = value.Config?.Labels ?? value.Labels;
  return Object.entries(labels).every(([key, expected]) => actual?.[key] === expected);
}
async function availableSubnet() {
  const ids = (await command(['network', 'ls', '--quiet'])).stdout.split('\n').filter(Boolean);
  const networks = ids.length
    ? JSON.parse((await command(['network', 'inspect', ...ids])).stdout)
    : [];
  const ipv4Range = (cidr) => {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr ?? '');
    if (!match) return undefined;
    const octets = match.slice(1, 5).map(Number),
      bits = Number(match[5]);
    if (bits > 32 || octets.some((value) => value > 255)) return undefined;
    const address = octets.reduce((value, octet) => value * 256 + octet, 0);
    const size = 2 ** (32 - bits),
      start = Math.floor(address / size) * size;
    return [start, start + size - 1];
  };
  const occupied = networks
    .flatMap((value) => value.IPAM?.Config ?? [])
    .map((value) => ipv4Range(value.Subnet))
    .filter(Boolean);
  const offset = parseInt(fixtureId.replaceAll('-', '').slice(0, 2), 16);
  for (const second of [240, 241, 242, 243]) {
    for (let step = 0; step < 256; step++) {
      const subnet = `10.${second}.${(offset + step) % 256}.0/24`;
      const candidate = ipv4Range(subnet);
      if (occupied.every((range) => candidate[1] < range[0] || candidate[0] > range[1]))
        return subnet;
    }
  }
  throw new Error('NO_UNOCCUPIED_FIXTURE_SUBNET');
}
async function createResource(kind, name, args) {
  stage = `create_${kind}`;
  const output = await command(
    kind === 'network'
      ? [kind, 'create', ...labelArgs, ...args, name]
      : [kind, 'create', '--name', name, ...labelArgs, ...args]
  );
  const id = output.stdout;
  const value = await inspect(kind, id);
  assert.ok(owned(value), 'Fixture resource ownership must match');
  const resource = { kind, id: value.Id ?? value.Name, createdAt: value.CreatedAt, removed: false };
  resources.push(resource);
  return resource;
}
async function createVolume(name) {
  stage = 'create_volume';
  // Docker volume create accepts its name as a positional argument.
  const output = await command(['volume', 'create', ...labelArgs, name]);
  const value = await inspect('volume', output.stdout);
  assert.ok(owned(value), 'Fixture volume ownership must match');
  const resource = { kind: 'volume', id: value.Name, createdAt: value.CreatedAt, removed: false };
  resources.push(resource);
  return resource;
}
async function removeOwned(resource) {
  if (resource.removed) return;
  const value = await inspect(resource.kind, resource.id);
  assert.ok(owned(value), 'Cleanup must verify fixture labels');
  assert.equal(value.Id ?? value.Name, resource.id, 'Cleanup must verify immutable identity');
  if (resource.kind === 'volume') assert.equal(value.CreatedAt, resource.createdAt);
  await command([
    resource.kind,
    'rm',
    ...(resource.kind === 'container' ? ['--force'] : []),
    resource.id
  ]);
  resource.removed = true;
  report.cleanup.push({ kind: resource.kind, id: resource.id, status: 'OWNED_RESOURCE_REMOVED' });
}
async function startContainer(name, args, platform = 'linux/amd64') {
  stage = `start_${name}`;
  const resource = await createResource('container', `${prefix}-${name}`, [
    '--platform',
    platform,
    '--pull=never',
    ...args
  ]);
  await command(['container', 'start', resource.id]);
  return resource;
}
async function until(check, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      // Startup failures are retried; raw responses and commands remain private.
    }
    await pause(500);
  }
  throw new Error('FIXTURE_READINESS_TIMEOUT');
}
async function test(name, action) {
  stage = name;
  if (options['--api-recheck'] && reusableCases.has(name)) {
    assert.ok(report.reusedEvidence, 'Unchanged-image evidence must be validated before reuse');
    report.reusedCases.push({ name, status: 'REUSED_PRIOR_PASS' });
    console.log(`REUSE ${name}`);
    return;
  }
  await action();
  report.cases.push({ name, status: 'PASS' });
  console.log(`PASS ${name}`);
}
const envArgs = (values) =>
  Object.entries(values).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
const hardening = [
  '--init',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '512',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=384m,mode=1777'
];
async function execNode(container, source) {
  const output = await command(['container', 'exec', '-i', container.id, 'node'], {
    input: source
  });
  return JSON.parse(output.stdout);
}
async function request(path, { method = 'GET', body, key } = {}) {
  const response = await execNode(
    api,
    `
    (async () => {
      const response = await fetch('http://127.0.0.1:3000' + ${JSON.stringify(path)}, {
        method: ${JSON.stringify(method)},
        headers: {
          ${body ? "'content-type': 'application/json'," : ''}
          ${key ? `'x-online-recharge-worker': ${key === workerKey ? 'process.env.ONLINE_RECHARGE_WORKER_KEY' : JSON.stringify(key)}` : ''}
        },
        ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
        signal: AbortSignal.timeout(8000)
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json(), headers: { 'cache-control': response.headers.get('cache-control') } }));
    })().catch(() => process.exit(1));
  `
  );
  return {
    status: response.status,
    body: unwrap(response.body),
    headers: new Headers(response.headers)
  };
}
async function rpc(method, args = {}, key = workerKey) {
  return request('/api/id-business-v2/online-recharge/worker/rpc', {
    method: 'POST',
    body: { method, args },
    key
  });
}
async function credentials(path, body = {}, wrongKey = false) {
  return execNode(
    api,
    `
    (async () => {
      const response = await fetch('http://127.0.0.1:8053${path}', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-online-recharge-worker': ${wrongKey ? "'synthetic-wrong-key'" : 'process.env.ONLINE_RECHARGE_WORKER_KEY'} },
        body: ${JSON.stringify(JSON.stringify(body))}, signal: AbortSignal.timeout(4000)
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    })().catch(() => process.exit(1));
  `
  );
}
async function credentialsClient() {
  return execNode(
    api,
    `
    require('reflect-metadata');
    const { ConfigService } = require('@nestjs/config');
    const { OnlineRechargeEphemeralCredentials } = require('/app/apps/api/dist/id-business-v2/online-recharge/ephemeral-credentials.service.js');
    (async () => {
      const client = new OnlineRechargeEphemeralCredentials(new ConfigService(process.env));
      let stored = false, status;
      try { await client.putCvc(${JSON.stringify(cardId)}, '731'); stored = true; }
      catch(error) { status = error.getStatus?.(); }
      console.log(JSON.stringify({ stored, status, availableIds: await client.available([${JSON.stringify(cardId)}]) }));
    })().catch(() => process.exit(1));
  `
  );
}
async function sql(query) {
  const output = await command(
    [
      'container',
      'exec',
      '-i',
      '--env',
      `MYSQL_PWD=${databasePassword}`,
      mysql.id,
      'mysql',
      '--host=127.0.0.1',
      `--user=${databaseUser}`,
      '--batch',
      '--skip-column-names',
      database
    ],
    { input: query }
  );
  return output.stdout;
}
async function startEngine(key = workerKey) {
  engineGeneration++;
  engine = await startContainer(`engine-${engineGeneration}`, [
    ...hardening,
    '--network',
    `container:${api.id}`,
    '--shm-size',
    '256m',
    '--mount',
    `type=volume,src=${dataVolume.id},dst=/workspace/engine/runtime`,
    ...envArgs({
      NODE_ENV: 'production',
      ONLINE_RECHARGE_ENGINE_ENABLED: '0',
      ONLINE_RECHARGE_WORKER_KEY: key,
      ONLINE_RECHARGE_RPC_URL:
        'http://127.0.0.1:3000/api/id-business-v2/online-recharge/worker/rpc',
      ONLINE_RECHARGE_CREDENTIALS_URL: 'http://127.0.0.1:8053',
      ONLINE_RECHARGE_RUNTIME_DIR: '/workspace/engine/runtime',
      ONLINE_RECHARGE_MEDIA_DIR: '/workspace/engine/runtime/media',
      ONLINE_RECHARGE_FFMPEG_PATH: '/usr/bin/ffmpeg'
    }),
    report.images.engine.id
  ]);
  await until(async () => {
    const value = await inspect('container', engine.id);
    return value.State.Running && value.State.Health?.Status === 'healthy';
  });
}
async function artifactFile(filename) {
  return execNode(
    api,
    `
    const fs = require('node:fs'), crypto = require('node:crypto');
    const path = '/app/.runtime/online-recharge/artifacts/' + ${JSON.stringify(filename)};
    const stat = fs.statSync(path);
    console.log(JSON.stringify({ uid: stat.uid, mode: stat.mode & 0o777, sha256: crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex') }));
  `
  );
}

try {
  await mkdir(evidence, { recursive: true });
  const compose = await readFile(resolve(root, 'docker-compose.aws-mysql.yml'), 'utf8');
  const mysqlImage = compose.match(/image:\s*(mysql:8\.4@sha256:[a-f0-9]{64})/)?.[1];
  assert.ok(mysqlImage, 'Use the project Compose pinned MySQL image');
  const migrationsRoot = resolve(root, 'apps/api/prisma-mysql/migrations');
  const migrations = [];
  for (const directory of (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    migrations.push({
      name: directory.name,
      checksum: digest(await readFile(resolve(migrationsRoot, directory.name, 'migration.sql')))
    });
  }
  report.migrations = migrations;
  report.source = {
    composeSha256: digest(compose),
    scriptSha256: digest(await readFile(fileURLToPath(import.meta.url)))
  };
  await test('fixed_local_images_no_pull', async () => {
    for (const [name, tag] of Object.entries({
      api: options['--api-image'],
      migration: options['--migration-image'],
      engine: options['--engine-image'],
      mysql: mysqlImage
    })) {
      stage = `fixed_local_image_${name}`;
      const value = await inspect('image', tag);
      assert.match(value.Id, /^sha256:[a-f0-9]{64}$/);
      assert.equal(value.Os, 'linux');
      if (name === 'mysql') assert.ok(['amd64', 'arm64'].includes(value.Architecture));
      else assert.equal(value.Architecture, 'amd64');
      report.images[name] = {
        tag,
        id: value.Id,
        platform: `${value.Os}/${value.Architecture}`
      };
    }
  });
  if (options['--api-recheck']) {
    const proofPath = resolve(evidence, 'full-result.json');
    const bytes = await readFile(proofPath);
    const prior = JSON.parse(bytes);
    assert.equal(prior.status, 'PASS');
    assert.equal(prior.images.engine.id, report.images.engine.id);
    assert.equal(prior.images.mysql.id, report.images.mysql.id);
    assert.equal(prior.images.mysql.platform, report.images.mysql.platform);
    assert.deepEqual(prior.migrations, migrations);
    for (const name of reusableCases)
      assert.ok(prior.cases.some((item) => item.name === name && item.status === 'PASS'));
    report.reusedEvidence = { path: proofPath, sha256: digest(bytes), cases: [...reusableCases] };
    report.schemaReflection = prior.schemaReflection;
    report.schemaReflectionEvidence = 'REUSED_UNCHANGED_MIGRATION_SQL_AND_MYSQL_IMAGE';
  }
  const subnet = await availableSubnet();
  network = await createResource('network', `${prefix}-network`, [
    '--internal',
    '--subnet',
    subnet
  ]);
  report.network = { internal: true, subnet };
  await test('exclusive_internal_network', async () =>
    assert.equal((await inspect('network', network.id)).Internal, true));
  const mysqlVolume = await createVolume(`${prefix}-mysql`);
  dataVolume = await createVolume(`${prefix}-data`);
  const registrationVolume = await createVolume(`${prefix}-auto-registration`);
  mysql = await startContainer(
    'mysql',
    [
      '--network',
      network.id,
      '--network-alias',
      'mysql',
      '--mount',
      `type=volume,src=${mysqlVolume.id},dst=/var/lib/mysql`,
      ...envArgs({
        MYSQL_DATABASE: database,
        MYSQL_USER: databaseUser,
        MYSQL_PASSWORD: databasePassword,
        MYSQL_ROOT_PASSWORD: secret(),
        TZ: 'UTC'
      }),
      report.images.mysql.id,
      '--character-set-server=utf8mb4',
      '--collation-server=utf8mb4_0900_ai_ci',
      '--default-time-zone=+00:00',
      '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
      '--log-bin-trust-function-creators=1'
    ],
    report.images.mysql.platform
  );
  stage = 'mysql_ready';
  await until(async () => (await sql('SELECT 1;')) === '1');
  const migration = await startContainer('migration', [
    ...hardening,
    '--network',
    network.id,
    ...envArgs({ NODE_ENV: 'production', DATABASE_URL: databaseUrl }),
    report.images.migration.id,
    'npx',
    'prisma',
    'migrate',
    'deploy',
    '--schema',
    'apps/api/prisma-mysql/schema.prisma'
  ]);
  await test('all_current_migrations_deployed_and_checksums_match', async () => {
    const exit = await command(['container', 'wait', migration.id], { timeout: 180000 });
    assert.equal(exit.stdout, '0', 'Migration image must exit successfully');
    const rows = (
      await sql(
        'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;'
      )
    )
      .split('\n')
      .map((line) => {
        const [name, checksum] = line.split('\t');
        return { name, checksum };
      });
    assert.deepEqual(rows, migrations);
  });
  await test('actual_nine_table_schema_information_schema_reflection', async () => {
    const tables = [
      'config',
      'cards',
      'proxies',
      'addresses',
      'codes',
      'tasks',
      'events',
      'bills',
      'webhook_receipts'
    ].map((name) => `online_recharge_${name}`);
    const names = tables.map((name) => `'${name}'`).join(',');
    const reflected = JSON.parse(
      await sql(`
      SELECT JSON_OBJECT(
        'rows', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', migration_name, 'checksum', checksum,
          'finished', finished_at IS NOT NULL, 'rolledBack', rolled_back_at IS NOT NULL)) FROM _prisma_migrations),
        'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', TABLE_NAME, 'engine', ENGINE, 'collation', TABLE_COLLATION))
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names})),
        'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('table', TABLE_NAME, 'column', COLUMN_NAME, 'type', DATA_TYPE,
          'columnType', COLUMN_TYPE, 'nullable', IS_NULLABLE, 'default', COLUMN_DEFAULT, 'extra', EXTRA))
          FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names})),
        'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('table', TABLE_NAME, 'index', INDEX_NAME, 'column', COLUMN_NAME,
          'sequence', SEQ_IN_INDEX, 'nonUnique', NON_UNIQUE, 'type', INDEX_TYPE, 'prefix', SUB_PART))
          FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names}))
      );
    `)
    );
    for (const field of ['rows', 'tables', 'columns', 'indexes'])
      assert.ok(Array.isArray(reflected[field]));
    assert.deepEqual(reflected.tables.map((item) => item.name).sort(), tables.sort());
    assert.ok(
      reflected.tables.every(
        (item) => item.engine === 'InnoDB' && item.collation === 'utf8mb4_unicode_ci'
      )
    );
    const column = (table, name) =>
      reflected.columns.find((item) => item.table === table && item.column === name);
    const created = column('online_recharge_addresses', 'created_at');
    assert.equal(created.columnType, 'datetime(6)');
    assert.equal(created.default.toLowerCase(), 'current_timestamp(6)');
    assert.equal(created.extra, 'DEFAULT_GENERATED');
    assert.equal(column('online_recharge_addresses', 'active').columnType, 'tinyint(1)');
    assert.equal(column('online_recharge_bills', 'amount').columnType, 'decimal(18,4)');
    reflected.rows.sort((a, b) => a.name.localeCompare(b.name));
    reflected.tables.sort((a, b) => a.name.localeCompare(b.name));
    reflected.columns.sort(
      (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column)
    );
    reflected.indexes.sort(
      (a, b) =>
        a.table.localeCompare(b.table) || a.index.localeCompare(b.index) || a.sequence - b.sequence
    );
    report.schemaReflection = reflected;
    await writeFile(resolve(evidence, 'schema.json'), JSON.stringify(reflected, null, 2) + '\n');
  });
  api = await startContainer('api', [
    ...hardening,
    '--network',
    network.id,
    '--mount',
    `type=volume,src=${dataVolume.id},dst=/app/.runtime/online-recharge`,
    '--mount',
    `type=volume,src=${registrationVolume.id},dst=/app/.runtime/auto-registration`,
    ...envArgs({
      NODE_ENV: 'production',
      APP_PORT: '3000',
      AUTH_PROVIDER: 'local',
      DATABASE_URL: databaseUrl,
      APP_PUBLIC_URL: 'https://synthetic-fixture.internal',
      CORS_ORIGIN: 'https://synthetic-fixture.internal',
      FIELD_ENCRYPTION_KEY: secret(),
      HASH_SECRET: secret(),
      JWT_SECRET: secret(),
      JWT_EXPIRES_IN: '1h',
      MICROSOFT_MAIL_OAUTH_CLIENT_ID: randomUUID(),
      MICROSOFT_MAIL_OAUTH_CLIENT_SECRET: secret(),
      MICROSOFT_MAIL_OAUTH_REDIRECT_URI:
        'https://synthetic-fixture.internal/api/mail/oauth/callback',
      ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'false',
      ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
      ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED: 'false',
      ID_BUSINESS_V2_MEDIA_RESOLVER_URL: 'http://media-resolver:8787',
      AUTO_RECHARGE_WORKER_TOKEN: secret(),
      AUTO_RECHARGE_WORKER_URL: 'http://127.0.0.1:1',
      AUTO_REGISTRATION_WORKER_URL: 'http://127.0.0.1:1',
      VENDURE_MAILBOX_ADMIN_API_URL: 'https://synthetic-fixture.internal/admin-api',
      VENDURE_MAILBOX_SHOP_API_URL: 'https://synthetic-fixture.internal/shop-api',
      VENDURE_MAILBOX_API_KEY: secret(),
      ONLINE_RECHARGE_WORKER_KEY: workerKey,
      ONLINE_RECHARGE_CREDENTIALS_URL: 'http://127.0.0.1:8053',
      ONLINE_RECHARGE_ARTIFACT_DIR: '/app/.runtime/online-recharge/artifacts'
    }),
    report.images.api.id
  ]);
  report.apiTransport = 'ACTUAL_NEST_PRIVATE_LOOPBACK_NO_HOST_PORT';
  await test('actual_nest_database_ready', async () => {
    await until(async () => {
      const response = await request('/api/health/ready');
      return (
        response.status === 200 &&
        response.body.status === 'ready' &&
        response.body.database === 'ok'
      );
    });
  });
  await test('public_config_has_only_customer_parameters', async () => {
    const response = await request('/api/id-business-v2/online-recharge/public/config');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(
      Object.keys(response.body).sort(),
      [
        'active',
        'maintenance',
        'maintenanceDrain',
        'maxConcurrent',
        'paymentRegion',
        'plans'
      ].sort()
    );
    assert.deepEqual(
      response.body.plans.map((item) => item.key),
      ['plus', 'pro_5x', 'pro_20x']
    );
    assert.equal(response.body.active, 0);
  });
  await test('anonymous_admin_denied', async () =>
    assert.equal(
      (await request('/api/id-business-v2/online-recharge/admin/overview')).status,
      401
    ));
  await test('worker_rpc_missing_or_wrong_key_denied', async () => {
    assert.equal((await rpc('getRuntimeConfig', {}, '')).status, 401);
    assert.equal((await rpc('getRuntimeConfig', {}, secret())).status, 401);
  });
  await test('worker_rpc_valid_key_reads_safe_config', async () => {
    const response = await rpc('getRuntimeConfig');
    assert.equal(response.status, 201);
    assert.ok(response.body.browserPool);
    assert.equal(JSON.stringify(response.body).includes(workerKey), false);
  });
  await startEngine();
  await test('api_and_engine_nonroot_readonly_and_no_private_ports_published', async () => {
    for (const resource of [api, engine]) {
      const value = await inspect('container', resource.id);
      assert.equal(value.HostConfig.ReadonlyRootfs, true);
      assert.ok(value.HostConfig.CapDrop.includes('ALL'));
      assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
      assert.notEqual(
        Number((await command(['container', 'exec', resource.id, 'id', '-u'])).stdout),
        0
      );
      assert.ok(
        value.Mounts.some(
          (mount) => mount.Type === 'volume' && mount.Name === dataVolume.id && mount.RW
        )
      );
      const ports = value.HostConfig.PortBindings ?? {};
      assert.deepEqual(ports, {});
      for (const port of ['8053/tcp', '9222/tcp', '9223/tcp']) assert.equal(ports[port], undefined);
    }
    assert.equal(
      (await inspect('container', engine.id)).HostConfig.NetworkMode,
      `container:${api.id}`
    );
    for (const resource of [mysql, migration])
      assert.deepEqual((await inspect('container', resource.id)).HostConfig.PortBindings ?? {}, {});
  });
  await test('credentials_only_engine_ready_without_jobs_or_browser', async () => {
    const response = await credentials('/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.ready, true);
    assert.equal(response.body.mode, 'credentials-only');
    assert.equal(response.body.activeTasks, 0);
    assert.equal(response.body.rpcConnected, false);
  });
  await test('real_cvc_memory_write_status_never_returns_secret', async () => {
    assert.deepEqual(await credentialsClient(), { stored: true, availableIds: [cardId] });
    const status = await credentials('/credentials/status', { ids: [cardId] });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { availableIds: [cardId] });
    assert.equal(JSON.stringify(status.body).includes('cvc'), false);
  });
  await test('cvc_extraction_endpoint_absent_and_wrong_key_denied', async () => {
    assert.equal((await credentials('/credentials/take', { ids: [cardId] })).status, 404);
    assert.equal((await credentials('/credentials/status', { ids: [cardId] }, true)).status, 401);
  });
  await test('cvc_not_saved_to_database_volume_or_logs', async () => {
    assert.equal(
      await sql(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND (column_name LIKE '%cvc%' OR column_name LIKE '%cvv%');"
      ),
      '0'
    );
    const state = await execNode(
      api,
      `
      const fs = require('node:fs'), path = require('node:path');
      function scan(directory) { return fs.readdirSync(directory, { withFileTypes: true }).some(entry => { const file = path.join(directory, entry.name); return entry.isDirectory() ? scan(file) : entry.isFile() && fs.readFileSync(file).includes(${JSON.stringify(cardId)}); }); }
      console.log(JSON.stringify({ found: scan('/app/.runtime/online-recharge') }));
    `
    );
    assert.equal(state.found, false);
    for (const resource of [api, engine]) {
      const logs = await command(['container', 'logs', resource.id]);
      assert.equal((logs.stdout + logs.stderr).includes(cardId), false);
      assert.equal(/\bcvc\s*[=:]\s*["']?731\b/i.test(logs.stdout + logs.stderr), false);
    }
  });
  await test('readonly_root_rejects_api_and_engine_writes', async () => {
    for (const resource of [api, engine]) {
      const output = await execNode(
        resource,
        `
        const fs = require('node:fs'); let code;
        try { fs.writeFileSync('/container-acceptance-write', 'synthetic'); } catch(error) { code = error.code; }
        console.log(JSON.stringify({ code }));
      `
      );
      assert.ok(['EROFS', 'EACCES'].includes(output.code));
    }
  });
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xoAAAAASUVORK5CYII=',
    'base64'
  );
  let artifact;
  await test('real_task_lease_and_api_artifact_write', async () => {
    await sql(
      `INSERT INTO online_recharge_tasks (id, operation, message, updated_at) VALUES ('${taskId}', 'config_test', 'Synthetic container storage acceptance', NOW(6));`
    );
    const claimed = await rpc('claimJob', { workerId: 'synthetic-container-storage' });
    assert.equal(claimed.status, 201);
    assert.equal(claimed.body.id, taskId);
    assert.equal(claimed.body.operation, 'config_test');
    assert.equal(claimed.body.session, null);
    const scope = {
      taskId,
      workerId: claimed.body.workerId,
      leaseId: claimed.body.leaseId,
      leaseVersion: claimed.body.leaseVersion
    };
    const uploaded = await rpc('evidenceUpload', {
      ...scope,
      redacted: true,
      kind: 'screenshot',
      mimeType: 'image/png',
      name: 'synthetic-container.png',
      dataBase64: imageBytes.toString('base64')
    });
    assert.equal(uploaded.status, 201);
    artifact = uploaded.body;
    assert.match(artifact.filename, /^[a-f0-9-]{36}\.png$/);
    assert.equal(artifact.size, imageBytes.length);
    const completed = await rpc('completeJob', {
      ...scope,
      status: 'succeeded',
      result: { message: 'Synthetic storage diagnostic complete' }
    });
    assert.deepEqual(completed.body, { ok: true, status: 'succeeded' });
  });
  await test('artifact_is_private_and_saved_with_restricted_permissions', async () => {
    const file = await artifactFile(artifact.filename);
    assert.equal(file.sha256, digest(imageBytes));
    assert.equal(file.mode, 0o600);
    assert.notEqual(file.uid, 0);
    assert.equal((await request(`/api${artifact.downloadPath}`)).status, 401);
    report.artifact = { id: artifact.id, sha256: file.sha256, size: imageBytes.length };
  });
  await test('shared_volume_visible_to_engine', async () => {
    const state = await execNode(
      engine,
      `
      const fs = require('node:fs'), crypto = require('node:crypto');
      const bytes = fs.readFileSync('/workspace/engine/runtime/artifacts/' + ${JSON.stringify(artifact.filename)});
      fs.writeFileSync('/workspace/engine/runtime/container-storage-marker', 'synthetic durable fixture', { mode: 0o600 });
      console.log(JSON.stringify({ sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
    `
    );
    assert.equal(state.sha256, digest(imageBytes));
  });
  await removeOwned(engine);
  await startEngine(secret());
  await test('wrong_engine_key_is_rejected_by_api_credentials_client', async () => {
    assert.equal((await credentials('/health')).status, 401);
    assert.equal((await credentials('/credentials/status', { ids: [cardId] })).status, 401);
    assert.deepEqual(await credentialsClient(), {
      stored: false,
      status: 503,
      availableIds: []
    });
    assert.equal((await request('/api/health/ready')).status, 200);
  });
  await removeOwned(engine);
  await startEngine();
  await test('engine_recreation_loses_cvc_but_preserves_artifact_volume', async () => {
    assert.deepEqual((await credentials('/credentials/status', { ids: [cardId] })).body, {
      availableIds: []
    });
    assert.equal((await artifactFile(artifact.filename)).sha256, digest(imageBytes));
  });
  await removeOwned(engine);
  await command(['container', 'restart', '--time', '20', api.id]);
  await test('api_restart_keeps_database_and_artifact_metadata_and_bytes', async () => {
    await until(async () => (await request('/api/health/ready')).status === 200);
    assert.equal((await artifactFile(artifact.filename)).sha256, digest(imageBytes));
    assert.equal(
      await sql(
        `SELECT COUNT(*) FROM online_recharge_events WHERE id = '${artifact.id}' AND stage = 'artifact';`
      ),
      '1'
    );
    assert.equal(
      await sql(`SELECT status FROM online_recharge_tasks WHERE id = '${taskId}';`),
      'succeeded'
    );
    assert.deepEqual(
      await execNode(
        api,
        "const fs = require('node:fs'); console.log(JSON.stringify({ marker: fs.readFileSync('/app/.runtime/online-recharge/container-storage-marker', 'utf8') }));"
      ),
      { marker: 'synthetic durable fixture' }
    );
  });
  await startEngine();
  await test('shared_network_reattachment_ready_cvc_still_absent', async () => {
    assert.equal((await credentials('/health')).body.mode, 'credentials-only');
    assert.deepEqual((await credentials('/credentials/status', { ids: [cardId] })).body, {
      availableIds: []
    });
  });
  await test('no_payment_no_billing_no_recharge_tasks', async () => {
    assert.equal(
      await sql(
        "SELECT COUNT(*) FROM online_recharge_tasks WHERE operation <> 'config_test' OR payment_started = 1 OR confirmed_paid = 1;"
      ),
      '0'
    );
    assert.equal(await sql('SELECT COUNT(*) FROM online_recharge_bills;'), '0');
    assert.equal((await credentials('/health')).body.activeTasks, 0);
    const config = await request('/api/id-business-v2/online-recharge/public/config');
    assert.equal(config.body.active, 0);
  });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  // Intentionally omit raw error messages/stacks: an assertion may contain a response secret.
  report.failure = {
    stage,
    type: error?.name ?? 'Error',
    ...(error?.dockerDiagnostic ? { dockerDiagnostic: error.dockerDiagnostic } : {})
  };
  process.exitCode = 1;
} finally {
  for (const resource of [...resources].reverse()) {
    try {
      await removeOwned(resource);
    } catch {
      report.cleanup.push({
        kind: resource.kind,
        id: resource.id,
        status: 'CLEANUP_FAILED_OWNERSHIP_OR_DOCKER_ERROR'
      });
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    resolve(evidence, `attempt-${fixtureId}.json`),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.cases.length,
      failure: report.failure,
      evidence: resolve(evidence, 'result.json')
    })
  );
}
