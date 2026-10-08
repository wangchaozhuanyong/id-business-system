import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  finiteMysqlResult,
  fixtureMysqlCommand,
  fixtureOptions,
  fixtureRequest
} from './native-mysql-fixture-bridge.mjs';

test('only the two isolated fixture schemas and explicit absolute installation are accepted', () => {
  assert.equal(
    fixtureOptions([
      '--database=recharge_fixture',
      '--mysql-bin=/installed/mysql/bin',
      '--work-directory=/project/.runtime/fixtures'
    ]).database,
    'recharge_fixture'
  );
  for (const args of [
    ['--database=business', '--mysql-bin=/bin', '--work-directory=/project/.runtime'],
    ['--database=recharge_fixture', '--mysql-bin=relative', '--work-directory=/project/.runtime'],
    ['--database=recharge_fixture', '--mysql-bin=/bin'],
    ['--database=recharge_fixture', '--mysql-bin=/bin', '--mysql-bin=/other']
  ])
    assert.throws(() => fixtureOptions(args));
});

test('unknown users, credential placement and cross-fixture user access are rejected', () => {
  for (const request of [
    { op: 'query', sql: 'SELECT 1', user: 'production' },
    { op: 'query', sql: 'SELECT 1', user: 'root', password: 'f'.repeat(48) },
    { op: 'query', sql: 'SELECT 1', user: 'retention_readonly', password: 'invalid' },
    { op: 'close', sql: 'SELECT 1' }
  ])
    assert.throws(() => fixtureRequest(request, 'storage_retention_test'));
  assert.throws(() =>
    fixtureRequest(
      { op: 'query', sql: 'SELECT 1', user: 'retention_readonly', password: 'f'.repeat(48) },
      'recharge_fixture'
    )
  );
});

test('original private socket parameters and cwd are reused, credentials and SQL stay off argv', () => {
  const password = 'c'.repeat(48),
    statement = 'SELECT 1;';
  const command = fixtureMysqlCommand(
    {
      tools: { mysql: '/installed/mysql/bin/mysql' },
      connection: {
        cwd: '/project/.runtime/owned/data',
        args: [
          '--no-defaults',
          '--no-login-paths',
          '--protocol=SOCKET',
          '--socket=mysql.sock',
          '--user=root'
        ]
      }
    },
    'storage_retention_test',
    { op: 'query', sql: statement, user: 'retention_readonly', password }
  );
  assert.equal(command.cwd, '/project/.runtime/owned/data');
  assert(command.args.includes('--protocol=SOCKET') && command.args.includes('--no-login-paths'));
  assert(
    command.args.includes('--user=retention_readonly') && !command.args.includes('--user=root')
  );
  assert(!command.args.join(' ').includes(password) && !command.args.join(' ').includes(statement));
  assert.equal(command.input, statement);
  assert.equal(command.env.MYSQL_PWD, password);
  assert.equal(command.env.DATABASE_URL, undefined);
  assert(
    Object.keys(command.env).every((key) =>
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'MYSQL_PWD'].includes(key)
    )
  );
});

test('all expected policy rejection codes survive without SQL or diagnostic disclosure', () => {
  for (const code of [1644, 1451, 1142]) {
    assert.deepEqual(
      finiteMysqlResult(
        1,
        'private partial value',
        `ERROR ${code} (45000): secret SQL and connection details`
      ),
      { returncode: 1, mysqlCode: code, stdout: '' }
    );
  }
  assert.deepEqual(finiteMysqlResult(null, '', 'sensitive configuration failure'), {
    returncode: 1,
    mysqlCode: null,
    stdout: ''
  });
  assert.deepEqual(finiteMysqlResult(0, '1\n', ''), {
    returncode: 0,
    mysqlCode: null,
    stdout: '1'
  });
});

test('a real bridge process never confirms cleanup for an attempted but unreturned instance', () => {
  const bridgeUrl = new URL('./native-mysql-fixture-bridge.mjs', import.meta.url).href;
  for (const preflight of [false, true]) {
    const stub = `
      export const identifier = name => name;
      export const safeEnvironment = () => ({});
      export const mysqlTools = async () => {
        ${preflight ? "throw new Error('private-fixture-diagnostic')" : "return {version:'8.4.11'}"};
      };
      export const startIsolatedMysql = async () => { throw new Error('private-fixture-diagnostic'); };
      export const ownedInstance = () => { throw new Error('unexpected instance'); };
      export const sql = async () => { throw new Error('unexpected SQL'); };
    `;
    const source = `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === './native-mysql-tools.mjs' && context.parentURL === ${JSON.stringify(bridgeUrl)})
            return {url:'fixture:mock-tools',shortCircuit:true};
          return nextResolve(specifier,context);
        },
        load(url, context, nextLoad) {
          if (url === 'fixture:mock-tools')
            return {format:'module',source:${JSON.stringify(stub)},shortCircuit:true};
          return nextLoad(url,context);
        }
      });
      process.argv=[process.execPath,${JSON.stringify(fileURLToPath(bridgeUrl))},
        '--database=recharge_fixture','--mysql-bin=/mock/bin','--work-directory=/mock/project'];
      await import(${JSON.stringify(bridgeUrl)});
    `;
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    );
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: source,
      encoding: 'utf8',
      timeout: 10000,
      env
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert(!result.stdout.includes('private-fixture-diagnostic'));
    assert.deepEqual(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        { ready: false, returncode: 1, mysqlCode: null },
        { closed: true, cleanup: preflight }
      ]
    );
  }
});
