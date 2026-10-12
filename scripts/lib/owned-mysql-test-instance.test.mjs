import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOwnedMysqlTestOptions,
  startOwnedMysqlTestInstance
} from './owned-mysql-test-instance.mjs';

const parent = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.runtime/owned-mysql-adapter-tests'
);
mkdirSync(parent, { recursive: true, mode: 0o700 });
const project = mkdtempSync(resolve(parent, 'fixture-'));
mkdirSync(resolve(project, 'apps/api/prisma-mysql'), { recursive: true });
writeFileSync(resolve(project, 'apps/api/prisma-mysql/schema.prisma'), 'synthetic fixture schema');
after(() => rmSync(project, { recursive: true }));
const database = 'id_business_v2_owned_adapter_fixture';
const containerId = 'a'.repeat(64);

function harness(patch = {}) {
  const state = { calls: [], stopped: false, removed: false, queries: 0, ...patch };
  const execute = (_command, args, options) => {
    const values = args[0] === '--host' ? args.slice(2) : args;
    state.calls.push({ args, envKeys: Object.keys(options.env), hasInput: Boolean(options.input) });
    if (values[0] === 'context')
      return {
        status: 0,
        stdout: JSON.stringify([
          { Endpoints: { docker: { Host: state.host ?? 'unix:///fixture/docker.sock' } } }
        ]),
        stderr: ''
      };
    if (values[0] === 'run') {
      state.name = values[values.indexOf('--name') + 1];
      state.owner = values[values.indexOf('--label') + 1].split('=')[1];
      state.passwordLength = options.env.MYSQL_ROOT_PASSWORD.length;
      return { status: state.runStatus ?? 0, stdout: containerId, stderr: 'private raw error' };
    }
    if (values[0] === 'inspect')
      return {
        status: 0,
        stdout: JSON.stringify({
          id: containerId,
          name: '/' + state.name,
          labels: {
            'id-business-v2.owned-mysql-test': state.changedOwner ? 'foreign' : state.owner
          },
          image: 'mysql:8.4',
          ports: { '3306/tcp': [{ HostIp: state.binding ?? '127.0.0.1', HostPort: '33061' }] },
          mounts: [{ Type: 'volume', Destination: '/var/lib/mysql', Name: 'b'.repeat(64) }],
          running: state.running ?? true
        }),
        stderr: ''
      };
    if (values[0] === 'exec') {
      state.queries++;
      if (state.neverReady || options.input === 'BAD SQL')
        return {
          status: 1,
          stdout: 'private query output',
          stderr: 'ERROR 1064 (42000): private raw error'
        };
      return {
        status: 0,
        stdout: options.input === 'SELECT VERSION()' ? (state.version ?? '8.4.9\n') : '1\n',
        stderr: ''
      };
    }
    if (values[0] === 'stop') {
      state.stopped = true;
      return { status: state.stopStatus ?? 0, stdout: containerId, stderr: '' };
    }
    if (values[0] === 'rm') {
      state.removed = true;
      return { status: 0, stdout: containerId, stderr: '' };
    }
    if (values[0] === 'ps') {
      state.psReads = (state.psReads ?? 0) + 1;
      return {
        status: state.psStatus ?? 0,
        stdout:
          state.remains || state.psReads <= (state.pendingRemovalReads ?? 0) ? containerId : '',
        stderr: ''
      };
    }
    throw new Error('unexpected fixture command');
  };
  return {
    state,
    dependencies: {
      execute,
      delay: async () => {},
      environment: {
        PATH: '/synthetic',
        HOME: '/synthetic',
        DATABASE_URL: 'mysql://external.invalid/live',
        JWT_SECRET: 'private',
        MYSQL_HOST: 'external.invalid'
      }
    }
  };
}
const start = (h) =>
  startOwnedMysqlTestInstance({ runtime: 'docker', database, project }, h.dependencies);

test('Docker CI and existing native command interfaces reject mixed/external arguments', () => {
  assert.equal(parseOwnedMysqlTestOptions(['--runtime=docker']).runtime, 'docker');
  assert.equal(
    parseOwnedMysqlTestOptions(['--mysql-bin=/installed/bin'], { legacyNative: true }).runtime,
    'native'
  );
  assert.equal(
    parseOwnedMysqlTestOptions(['--runtime=native', '--mysql-bin=/installed/bin']).runtime,
    'native'
  );
  for (const args of [
    ['--runtime=docker', '--mysql-bin=/installed/bin'],
    ['--database=production'],
    ['--url=mysql://external.invalid/live'],
    ['--runtime=native'],
    ['--runtime=docker', '--runtime=native'],
    ['--evidence-dir=/outside']
  ])
    assert.throws(() => parseOwnedMysqlTestOptions(args));
});

test('native runtime still delegates unchanged to the existing owned launcher', async () => {
  const input = { runtime: 'native', mysqlBin: '/installed/bin', database, project };
  let observed;
  const result = await startOwnedMysqlTestInstance(input, {
    nativeStarter: async (value) => {
      observed = value;
      return { runtime: 'native' };
    },
    execute: () => {
      throw new Error('Docker must not run');
    }
  });
  assert.deepEqual(observed, { mysqlBin: input.mysqlBin, database, project });
  assert.equal(result.runtime, 'native');
});

test('Docker launches one random owned MySQL 8.4 and exposes only its loopback port', async () => {
  const h = harness();
  const instance = await start(h);
  assert.equal(instance.runtime, 'docker');
  assert.equal(instance.database, database);
  assert.equal(instance.port, 33061);
  assert.equal(h.state.passwordLength, 48);
  const run = h.state.calls.find((call) => call.args.includes('run'));
  assert.ok(/^idv2-owned-mysql-[a-f0-9]{32}$/.test(h.state.name));
  assert.ok(run.args.includes('mysql:8.4'));
  assert.ok(run.args.includes('127.0.0.1::3306'));
  assert.ok(run.args.includes('MYSQL_ROOT_PASSWORD'));
  assert.equal(
    run.args.some((arg) => arg.startsWith('MYSQL_ROOT_PASSWORD=')),
    false
  );
  assert.equal(
    h.state.calls.some(
      (call) =>
        call.envKeys.includes('DATABASE_URL') ||
        call.envKeys.includes('JWT_SECRET') ||
        call.envKeys.includes('MYSQL_HOST')
    ),
    false
  );
  assert.equal(
    run.args.some((arg) => ['--volume', '--mount', '--privileged', '--network=host'].includes(arg)),
    false
  );
  assert.equal(instance.query('SELECT 1'), '1');
  assert.throws(() => instance.query('SELECT 1', 'production'));
  assert.throws(() => instance.query('x'.repeat(8 * 1024 * 1024 + 1)));
  const result = instance.queryResult('BAD SQL');
  assert.deepEqual(result, { status: 1, stdout: '', stderr: 'ERROR 1064 (' });
  await instance.cleanup();
  await instance.cleanup();
  assert.equal(h.state.stopped, true);
  assert.equal(h.state.calls.filter((call) => call.args.includes('stop')).length, 1);
  assert.equal(
    h.state.calls.some((call) => call.args.includes('--force') || call.args.includes('prune')),
    false
  );
  assert.equal(
    h.state.calls
      .filter((call) => call.args.includes('stop'))
      .every((call) => call.args.at(-1) === containerId),
    true
  );
});

test('remote daemon overrides and non-owned database names reject before creation', async () => {
  for (const flag of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY']) {
    const h = harness();
    h.dependencies.environment[flag] = 'external';
    await assert.rejects(start(h));
    assert.equal(h.state.calls.length, 0);
  }
  for (const host of [
    'tcp://external.invalid:2375',
    'ssh://external.invalid',
    'http://external.invalid'
  ]) {
    const h = harness({ host });
    await assert.rejects(start(h));
    assert.equal(
      h.state.calls.some((call) => call.args.includes('run')),
      false
    );
  }
  for (const rejected of ['production', 'mysql', 'id_business_v2'])
    await assert.rejects(
      startOwnedMysqlTestInstance({ runtime: 'docker', database: rejected, project })
    );
});

test('invalid binding/version/readiness clean only the newly created fixture', async () => {
  for (const options of [
    { binding: '0.0.0.0' },
    { version: '8.0.99' },
    { neverReady: true },
    { runStatus: 1 }
  ]) {
    const h = harness(options);
    await assert.rejects(start(h));
    assert.equal(h.state.stopped, true);
    assert.equal(
      h.state.calls
        .filter((call) => call.args.includes('stop'))
        .every((call) => call.args.at(-1) === containerId),
      true
    );
    if (options.neverReady) assert.equal(h.state.queries, 120);
  }
});

test('changed owner identity prevents cleanup and absence requires a successful readback', async () => {
  const changed = harness();
  const first = await start(changed);
  changed.state.changedOwner = true;
  await assert.rejects(first.cleanup());
  assert.equal(changed.state.stopped, false);
  const unknown = harness();
  const second = await start(unknown);
  unknown.state.psStatus = 1;
  await assert.rejects(second.cleanup());
  assert.equal(unknown.state.stopped, true);
  const remains = harness();
  const third = await start(remains);
  remains.state.remains = true;
  await assert.rejects(third.cleanup());
});

test('an already stopped owned fixture removes only its anonymous test volume without force', async () => {
  const h = harness();
  const instance = await start(h);
  h.state.running = false;
  await instance.cleanup();
  const command = h.state.calls.find((call) => call.args.includes('rm'));
  assert.ok(command.args.includes('--volumes'));
  assert.equal(command.args.at(-1), containerId);
  assert.equal(command.args.includes('--force'), false);
});

test('auto-removal races require confirmed absence and never repeat the stop request', async () => {
  const removed = harness({ stopStatus: 1 });
  const first = await start(removed);
  await first.cleanup();
  assert.equal(removed.state.calls.filter((call) => call.args.includes('stop')).length, 1);
  assert.equal(removed.state.psReads, 1);
  const pending = harness({ pendingRemovalReads: 2 });
  const second = await start(pending);
  await second.cleanup();
  assert.equal(pending.state.calls.filter((call) => call.args.includes('stop')).length, 1);
  assert.equal(pending.state.psReads, 3);
  const unknown = harness({ stopStatus: 1, remains: true });
  const third = await start(unknown);
  await assert.rejects(third.cleanup());
  assert.equal(unknown.state.calls.filter((call) => call.args.includes('stop')).length, 1);
});
