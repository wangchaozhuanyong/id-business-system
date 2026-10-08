import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDoctorReport, parseDoctorOptions, runDoctor } from './doctor.mjs';

function doctorFixture({ args = [], outputs = {}, env, spawnError } = {}) {
  const calls = [];
  const versions = {
    'node --version': 'v22.21.1',
    'npm --version': '10.9.4',
    'mysql --version': 'mysql  Ver 8.4.6 for macos on arm64 (Homebrew)',
    'mysqld --version': 'mysqld  Ver 8.4.6 for macos on arm64 (Homebrew)',
    'docker --version': 'Docker version 28.4.0, build fixture',
    'docker compose version': 'Docker Compose version v2.39.4',
    'docker info': 'daemon metadata',
    'npm run prisma:validate --silent': 'schema valid'
  };
  const result = runDoctor({
    args,
    cwd: '/project',
    exists: () => true,
    lstat: () => ({ isSymbolicLink: () => true }),
    readFile: () => env ?? 'DATABASE_URL=mysql://fixture.invalid/test\nJWT_SECRET=fixture',
    spawn(command, commandArgs, options) {
      calls.push({ command, args: commandArgs, options });
      if (spawnError) throw new Error(spawnError);
      const key = [command, ...commandArgs].join(' ');
      const output = Object.hasOwn(outputs, key) ? outputs[key] : versions[key];
      if (typeof output === 'object') return output;
      return { status: output === undefined ? 1 : 0, stdout: output ?? '', stderr: '' };
    }
  });
  return { result, calls, report: formatDoctorReport(result) };
}

test('native doctor is the default and never invokes Docker or a database connection', () => {
  const { result, calls, report } = doctorFixture();
  assert.equal(result.failed, 0);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ['node', '--version'],
      ['npm', '--version'],
      ['mysql', '--version'],
      ['mysqld', '--version'],
      ['npm', 'run', 'prisma:validate', '--silent']
    ]
  );
  assert.ok(calls.every(({ options }) => options.shell === false && options.cwd === '/project'));
  assert.match(report, /database connection not checked/);
});

test('explicit installed executable paths are passed as a single argument without a shell', () => {
  const client = '/installed/mysql tools/bin/mysql';
  const server = '/installed/mysql tools/bin/mysqld';
  const { result, calls } = doctorFixture({
    args: ['--runtime', 'native', `--mysql-client=${client}`, '--mysql-server', server],
    outputs: {
      [`${client} --version`]: `${client} Ver 8.4.6 for macos`,
      [`${server} --version`]: `${server} Ver 8.4.6 for macos`
    }
  });
  assert.equal(result.failed, 0);
  assert.equal(calls[2].command, client);
  assert.equal(calls[3].command, server);
  assert.deepEqual(calls[2].args, ['--version']);
});

test('native prerequisites require both MySQL 8.4 binaries and reject MariaDB or MySQL 8.0', () => {
  const missingServer = doctorFixture({ outputs: { 'mysqld --version': undefined } });
  assert.equal(missingServer.result.failed, 1);
  assert.ok(
    missingServer.result.checks.find(({ name }) => name === 'MySQL 8.4 client installed').ok
  );
  assert.equal(
    doctorFixture({ outputs: { 'mysql --version': 'mysql Ver 8.0.43 for macos' } }).result.failed,
    1
  );
  assert.equal(
    doctorFixture({ outputs: { 'mysqld --version': 'mysqld Ver 8.4.6-MariaDB' } }).result.failed,
    1
  );
});

test('explicit Docker mode retains CLI, Compose and daemon checks without requiring MySQL binaries', () => {
  const { result, calls } = doctorFixture({ args: ['--runtime=docker'] });
  assert.equal(result.failed, 0);
  assert.deepEqual(
    calls.slice(2, 5).map(({ command, args }) => [command, ...args]),
    [
      ['docker', '--version'],
      ['docker', 'compose', 'version'],
      ['docker', 'info']
    ]
  );
  const stopped = doctorFixture({
    args: ['--runtime=docker'],
    outputs: { 'docker info': { status: 1, stdout: '', stderr: 'private daemon failure' } }
  });
  assert.equal(stopped.result.failed, 1);
  assert.doesNotMatch(stopped.report, /private daemon failure/);
});

test('invalid or duplicate arguments fail before reading files or executing commands', () => {
  for (const args of [
    ['--runtime=remote'],
    ['--runtime'],
    ['--mysql-client='],
    ['--runtime=native', '--runtime=docker'],
    ['--password=fixture-secret'],
    ['--mysql-server=mysqld\nfixture-secret']
  ]) {
    assert.throws(() => parseDoctorOptions(args));
    const { result, calls, report } = doctorFixture({ args });
    assert.equal(result.failed, 1);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(report, /fixture-secret/);
  }
});

test('reports suppress raw command errors, Prisma output, environment values and unexpected versions', () => {
  const secret = 'fixture-private-value';
  const { result, report } = doctorFixture({
    env: `DATABASE_URL=mysql://fixture:${secret}@fixture.invalid/test\nJWT_SECRET=change_me`,
    outputs: {
      'node --version': secret,
      'mysql --version': { status: 1, stdout: secret, stderr: secret },
      'npm run prisma:validate --silent': { status: 1, stdout: secret, stderr: secret }
    }
  });
  assert.ok(result.failed > 0);
  assert.doesNotMatch(report, new RegExp(secret));
  assert.doesNotMatch(report, /JWT_SECRET=change_me/);
  assert.match(report, /validation failed; details suppressed/);
  assert.doesNotMatch(doctorFixture({ spawnError: secret }).report, new RegExp(secret));
});
