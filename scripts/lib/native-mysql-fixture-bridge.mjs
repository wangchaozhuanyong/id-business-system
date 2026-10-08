import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  identifier,
  mysqlTools,
  ownedInstance,
  safeEnvironment,
  sql,
  startIsolatedMysql
} from './native-mysql-tools.mjs';

const databases = new Set(['recharge_fixture', 'storage_retention_test']);
const users = new Set(['root', 'retention_runtime', 'retention_readonly']);
const requireValue = (value) => {
  if (!value) throw new Error('FIXTURE_PROTOCOL_REJECTED');
};

export function fixtureOptions(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(database|mysql-bin|work-directory)=(.+)$/.exec(arg);
    requireValue(match && !Object.hasOwn(values, match[1]));
    values[match[1]] = match[2];
  }
  requireValue(
    databases.has(values.database) &&
      isAbsolute(values['mysql-bin'] || '') &&
      isAbsolute(values['work-directory'] || '')
  );
  return values;
}

export function fixtureRequest(value, database) {
  requireValue(
    databases.has(database) && value && typeof value === 'object' && !Array.isArray(value)
  );
  if (value.op === 'close') {
    requireValue(Object.keys(value).length === 1);
    return value;
  }
  requireValue(
    value.op === 'query' &&
      Object.keys(value).every((key) => ['op', 'sql', 'user', 'password'].includes(key)) &&
      typeof value.sql === 'string' &&
      value.sql.length > 0 &&
      Buffer.byteLength(value.sql) <= 8 * 1024 * 1024 &&
      users.has(value.user) &&
      (database !== 'recharge_fixture' || value.user === 'root') &&
      (value.user === 'root'
        ? value.password === undefined
        : typeof value.password === 'string' && /^[a-f0-9]{48}$/.test(value.password))
  );
  return value;
}

export function fixtureMysqlCommand(details, database, request) {
  fixtureRequest(request, database);
  requireValue(databases.has(database) && request.op === 'query');
  return {
    executable: details.tools.mysql,
    args: [
      ...details.connection.args.filter((arg) => !arg.startsWith('--user=')),
      '--user=' + request.user,
      '--connect-timeout=5',
      '--default-character-set=utf8mb4',
      '--batch',
      '--skip-column-names',
      '--raw',
      '--binary-mode',
      '--local-infile=0',
      '--database=' + database
    ],
    cwd: details.connection.cwd,
    env: {
      ...safeEnvironment(),
      ...(request.password === undefined ? {} : { MYSQL_PWD: request.password })
    },
    input: request.sql
  };
}

export function finiteMysqlResult(returncode, stdout, stderr) {
  const match = /\bERROR (\d{1,5}) \(/.exec(stderr);
  return {
    returncode: Number.isInteger(returncode) ? returncode : 1,
    mysqlCode: returncode === 0 || !match ? null : Number(match[1]),
    stdout: returncode === 0 ? stdout.trim() : ''
  };
}

async function execute(details, database, request, signal) {
  const command = fixtureMysqlCommand(details, database, request);
  return new Promise((done) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '',
      errors = '',
      tooLarge = false,
      timer;
    const stop = () => {
      child.kill('SIGTERM');
      timer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
      timer.unref();
    };
    const deadline = setTimeout(stop, 120000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (bytes) => {
      if (Buffer.byteLength(output) + bytes.length > 1024 * 1024) {
        tooLarge = true;
        stop();
      } else output += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      // Retain only enough in memory to extract a numerical client error code.
      if (errors.length < 8192) errors += bytes.toString().slice(0, 8192 - errors.length);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.once('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      done(finiteMysqlResult(tooLarge ? 1 : code, output, errors));
    });
    child.stdin.end(command.input);
  });
}

async function main() {
  const abort = new AbortController();
  let instance,
    lines,
    startAttempted = false,
    signalled = false;
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const interrupt = () => {
    signalled = true;
    abort.abort();
    lines?.close();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  // A disconnected Python parent must still allow finally to reclaim the new fixture.
  process.stdout.on('error', interrupt);
  try {
    const options = fixtureOptions(process.argv.slice(2));
    const tools = await mysqlTools(options['mysql-bin']);
    startAttempted = true;
    instance = await startIsolatedMysql(tools, options['work-directory'], { signal: abort.signal });
    const details = ownedInstance(instance);
    await sql(tools, details.connection, null, 'CREATE DATABASE ' + identifier(options.database), {
      signal: abort.signal,
      cap: 4096
    });
    send({ ready: true, runtime: 'native', tcpDisabled: true, mysqlVersion: tools.version });
    lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      requireValue(Buffer.byteLength(line) <= 9 * 1024 * 1024);
      const request = fixtureRequest(JSON.parse(line), options.database);
      if (request.op === 'close' || abort.signal.aborted) break;
      send(await execute(details, options.database, request, abort.signal));
    }
  } catch {
    send({ ready: false, returncode: 1, mysqlCode: null });
    process.exitCode = 1;
  } finally {
    lines?.close();
    try {
      if (instance) await instance.cleanup();
      // The starter owns cleanup on failure, but an unreturned instance cannot be
      // independently confirmed by this bridge. Never emit a success acknowledgment.
      send({ closed: true, cleanup: !startAttempted || Boolean(instance) });
    } catch {
      send({ closed: true, cleanup: false });
      process.exitCode = 1;
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (signalled) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
