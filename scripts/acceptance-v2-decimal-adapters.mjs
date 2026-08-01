import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const containerName = `id-business-v2-decimal-adapter-${process.pid}`;
const databaseName = 'v2_decimal_adapter_test';
const databasePassword = 'v2_decimal_adapter_test';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('无法分配本地 Worker 端口');
  return address.port;
}

async function runCloudflareContract(databaseUrl) {
  const port = await getFreePort();
  const output = [];
  const child = spawn(
    'npx',
    [
      'wrangler@4.114.0',
      'dev',
      '--local',
      '--config',
      'scripts/fixtures/wrangler.v2-decimal-adapter.jsonc',
      '--port',
      String(port),
      '--var',
      `V2_DECIMAL_ADAPTER_DATABASE_URL:${databaseUrl}`,
      '--log-level',
      'error'
    ],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const remember = (chunk) => {
    output.push(String(chunk));
    if (output.length > 40) output.shift();
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);

  try {
    let lastError;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`Cloudflare Worker 提前退出\n${output.join('').trim()}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          const result = await response.json();
          const expected = [
            { id: 1, amount: '12.3457', rate: '5.64351235' },
            { id: 2, amount: '-0.0001', rate: '0.33333334' }
          ];
          if (
            result.runtime !== 'cloudflare' ||
            JSON.stringify(result.items) !== JSON.stringify(expected)
          ) {
            throw new Error(`Cloudflare adapter 返回非规范金额：${JSON.stringify(result)}`);
          }
          return;
        }
        lastError = new Error(
          `Cloudflare Worker HTTP ${response.status}: ${await response.text()}`
        );
      } catch (error) {
        lastError = error;
      }
      await wait(250);
    }
    throw new Error(
      `Cloudflare Worker 在 20 秒内未通过金额契约：${lastError instanceof Error ? lastError.message : String(lastError)}\n${output.join('').trim()}`
    );
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      wait(2_000).then(() => child.kill('SIGKILL'))
    ]);
  }
}

try {
  run('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    containerName,
    '--env',
    `POSTGRES_PASSWORD=${databasePassword}`,
    '--env',
    `POSTGRES_DB=${databaseName}`,
    '--publish',
    '127.0.0.1::5432',
    'postgres:16-alpine'
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', databaseName],
      { encoding: 'utf8' }
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await wait(250);
  }
  if (!ready) throw new Error('隔离 PostgreSQL 在 15 秒内未就绪');

  const portOutput = run('docker', ['port', containerName, '5432/tcp']);
  const portMatch = portOutput.match(/:(\d+)$/m);
  if (!portMatch) throw new Error('无法解析隔离 PostgreSQL 端口');
  const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;

  run(
    'npm',
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      '--run',
      'src/id-business-v2/runtime/id-business-v2-decimal-postgres.integration.spec.ts'
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, V2_DECIMAL_ADAPTER_DATABASE_URL: databaseUrl }
    }
  );

  await runCloudflareContract(databaseUrl);

  console.log('V2 Node/Cloudflare Prisma Decimal PostgreSQL adapter contract passed.');
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}
