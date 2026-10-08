import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(project, 'scripts/acceptance-v2-data-governance.mjs'), 'utf8');
const parserUrl = pathToFileURL(
  resolve(project, 'scripts/lib/native-mysql-test-instance.mjs')
).href;

function harness(args, fail = '') {
  const parent = resolve(project, '.runtime/docker-independence-20261008/native-data-governance');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(resolve(parent, 'unit-'));
  const callsFile = resolve(directory, 'calls.jsonl');
  try {
    mkdirSync(resolve(directory, 'apps/api/prisma-mysql/migrations/owned-fixture'), {
      recursive: true
    });
    const transformed = source
      .replace("from 'node:child_process'", "from './transport.mock.mjs'")
      .replace("from './lib/native-mysql-test-instance.mjs'", "from './transport.mock.mjs'");
    assert.notEqual(transformed, source);
    writeFileSync(resolve(directory, 'entry.mjs'), transformed);
    writeFileSync(
      resolve(directory, 'transport.mock.mjs'),
      `
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync as realSpawnSync } from 'node:child_process';
export { parseNativeMysqlTestOptions } from ${JSON.stringify(parserUrl)};
const record = (call) => appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(call)+'\\n');
const state = { migrations:1, failedMigrations:0, users:2, customers:1, jobs:3,
  items:3, approvals:2, checkpoints:2, auditLogs:10, orderSnapshots:1 };
export function spawnSync(command, args, options = {}) {
  record({ tool:command, action:args[0],
    ...(['npm','npx'].includes(command) ? { stdio:options.stdio } : {}) });
  if (process.env.TEST_FAIL === 'real-child' && command === 'npm')
    return realSpawnSync(process.execPath, ['-e',
      'process.stdout.write("SYNTHETIC_PRIVATE_OUTPUT");process.stderr.write("SYNTHETIC_PRIVATE_OUTPUT");process.exit(1)'], options);
  if (process.env.TEST_FAIL === 'child' && command === 'npm')
    return { status:1, stdout:'SYNTHETIC_PRIVATE_OUTPUT', stderr:'SYNTHETIC_PRIVATE_OUTPUT' };
  let stdout='';
  if (command === 'docker' && args[0] === 'run') stdout='a'.repeat(64);
  if (command === 'docker' && args[0] === 'port') stdout='127.0.0.1:33111';
  if (command === 'docker' && args[0] === 'exec' && args[2] === 'mysql') stdout=JSON.stringify(state);
  if (command === 'npm' && args[1] === 'test') stdout=String.fromCharCode(27)+'[32mTest Files 1 passed (1)'+
    String.fromCharCode(27)+'[0m\\nTests 3 passed (3)\\n';
  return { status:0, stdout, stderr:'' };
}
export async function startNativeMysqlTestInstance(options) {
  record({ tool:'native', action:'start', validBin:options.mysqlBin === '/installed/mysql/bin',
    ownedDatabase:/^id_business_v2_governance_drill_\\d+$/.test(options.database) });
  return { port:33111, rootPassword:randomBytes(24).toString('hex'),
    query(sql,database) {
      record({ tool:'native', action:'query', sameOwnedDatabase:database===options.database,
        terminalStateSql:sql.includes("'orderSnapshots'") && sql.includes("'migrations'") });
      if (process.env.TEST_FAIL === 'query') throw new Error('Mock isolated query failure');
      return JSON.stringify(state);
    },
    async cleanup() { record({ tool:'native', action:'cleanup' }); }
  };
}
`
    );
    const result = spawnSync(process.execPath, ['entry.mjs', ...args], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_FAIL: fail }
    });
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse)
      : [];
    return { result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('data governance native transport uses only owned native query and cleanup with unchanged workflow', () => {
  const { result, calls } = harness(['--runtime=native', '--mysql-bin=/installed/mysql/bin']);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.runtime, 'native');
  assert.equal(summary.workflow.length, 12);
  assert.equal(summary.verifiedState.auditLogs, 10);
  assert.deepEqual(summary.testCounts, [
    { kind: 'Test Files', passed: 1, total: 1 },
    { kind: 'Tests', passed: 3, total: 3 }
  ]);
  assert.ok(
    calls
      .filter((call) => ['npm', 'npx'].includes(call.tool))
      .every((call) => call.stdio === 'pipe')
  );
  assert.ok(!calls.some((call) => call.tool === 'docker'));
  assert.deepEqual(
    calls.filter((call) => call.tool === 'native'),
    [
      { tool: 'native', action: 'start', validBin: true, ownedDatabase: true },
      { tool: 'native', action: 'query', sameOwnedDatabase: true, terminalStateSql: true },
      { tool: 'native', action: 'cleanup' }
    ]
  );
});

test('legacy data governance default still uses disposable Docker transport', () => {
  const { result, calls } = harness([]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout.trim()).runtime, 'docker');
  assert.ok(!calls.some((call) => call.tool === 'native'));
  assert.ok(
    calls
      .filter((call) => ['npm', 'npx'].includes(call.tool))
      .every((call) => call.stdio === 'inherit')
  );
  assert.deepEqual(
    calls.filter((call) => call.tool === 'docker').map((call) => call.action),
    ['run', 'exec', 'port', 'exec', 'rm']
  );
});

test('invalid native configuration and existing business targets reject before any transport', () => {
  for (const args of [
    ['--runtime=native'],
    ['--runtime=native', '--mysql-bin=relative'],
    ['--runtime=native', '--mysql-bin=/installed/mysql/bin', '--database=production'],
    ['--runtime=native', '--mysql-bin=/installed/mysql/bin', '--socket=/existing/mysql.sock'],
    ['--runtime=native', '--runtime=docker', '--mysql-bin=/installed/mysql/bin'],
    ['--mysql-bin=/installed/mysql/bin']
  ]) {
    const { result, calls } = harness(args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, []);
  }
});

test('native child/query failures retain owned cleanup and hide private child output', () => {
  for (const fail of ['query', 'child', 'real-child']) {
    const { result, calls } = harness(
      ['--runtime=native', '--mysql-bin=/installed/mysql/bin'],
      fail
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls.at(-1), { tool: 'native', action: 'cleanup' });
    assert.ok(!calls.some((call) => call.tool === 'docker'));
    assert.ok(!result.stderr.includes('SYNTHETIC_PRIVATE_OUTPUT'));
    assert.ok(!result.stdout.includes('SYNTHETIC_PRIVATE_OUTPUT'));
  }
});
