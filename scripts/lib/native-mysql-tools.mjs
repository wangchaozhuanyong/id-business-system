import { spawn } from 'node:child_process';
import { constants, lstat, realpath, open, mkdtemp, mkdir, rm, statfs } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MAX_BYTES = 64 * 1024 * 1024;
export class NativeMysqlError extends Error {
  constructor(code) {
    super('原生 MySQL 检查失败：' + code);
    this.code = code;
  }
}
export const requireValue = (condition, code) => {
  if (!condition) throw new NativeMysqlError(code);
};
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const identifier = (name) => {
  requireValue(
    typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name),
    'DATABASE_NAME_INVALID'
  );
  return String.fromCharCode(96) + name + String.fromCharCode(96);
};
export function safeEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'])
    if (typeof source[key] === 'string') env[key] = source[key];
  return env;
}
export async function existingPath(path, { privateFile = false, directory = false } = {}) {
  requireValue(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_PATH_REQUIRED');
  const exact = resolve(path);
  let current = exact;
  while (current !== dirname(current)) {
    const info = await lstat(current);
    requireValue(!info.isSymbolicLink(), 'SYMLINK_REJECTED');
    current = dirname(current);
  }
  const info = await lstat(exact);
  requireValue(directory ? info.isDirectory() : info.isFile(), 'PATH_TYPE_INVALID');
  if (privateFile)
    requireValue(
      (info.mode & 0o777) === 0o600 &&
        info.nlink === 1 &&
        (info.uid === process.getuid() || info.uid === 0),
      'PRIVATE_FILE_REQUIRED'
    );
  return exact;
}
export async function projectDirectory(path) {
  const exact = await existingPath(path, { directory: true });
  requireValue(
    exact !== PROJECT_ROOT &&
      relative(PROJECT_ROOT, exact) !== '' &&
      !relative(PROJECT_ROOT, exact).startsWith('..') &&
      !isAbsolute(relative(PROJECT_ROOT, exact)),
    'PROJECT_OUTPUT_REQUIRED'
  );
  const info = await lstat(exact);
  requireValue(
    info.uid === process.getuid() && !(info.mode & 0o022),
    'OUTPUT_DIRECTORY_NOT_PRIVATE'
  );
  return exact;
}
export async function privateBytes(path, limit = MAX_BYTES) {
  const exact = await existingPath(path, { privateFile: true });
  const handle = await open(exact, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireValue(before.isFile() && before.size > 0 && before.size <= limit, 'FILE_SIZE_INVALID');
    const raw = await handle.readFile();
    const after = await handle.stat();
    requireValue(
      raw.length === before.size &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      'FILE_CHANGED'
    );
    return raw;
  } finally {
    await handle.close();
  }
}
export async function exclusivePrivateWrite(path, bytes) {
  await projectDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
export function run(
  executable,
  args,
  { cwd, input = '', timeout = 30000, cap = MAX_BYTES, signal, env = safeEnvironment() } = {}
) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let outputSize = 0,
      failure = null,
      killTimer;
    const stop = (code) => {
      failure ??= new NativeMysqlError(code);
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), timeout);
    const abort = () => stop('INTERRUPTED');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (bytes) => {
      outputSize += bytes.length;
      if (outputSize > cap) stop('OUTPUT_LIMIT_EXCEEDED');
      else output.push(bytes);
    });
    // Never retain or expose raw SQL/client errors, configuration, or credentials.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => {
      failure ??= new NativeMysqlError('COMMAND_UNAVAILABLE');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new NativeMysqlError('COMMAND_FAILED'));
      else resolveResult(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}
export async function mysqlTools(binDirectory) {
  const directory = await existingPath(binDirectory, { directory: true });
  const result = {};
  for (const name of ['mysql', 'mysqldump', 'mysqld', 'mysqladmin']) {
    const executable = await existingPath(join(directory, name));
    requireValue((await lstat(executable)).mode & 0o111, 'MYSQL_TOOL_NOT_EXECUTABLE');
    const args = ['--no-defaults', ...(name === 'mysqld' ? [] : ['--no-login-paths']), '--version'];
    const output = (await run(executable, args, { cap: 4096 })).toString();
    const match = /\b(?:Ver\s+)?(8\.4\.\d+)\b/.exec(output);
    requireValue(match, 'MYSQL_84_REQUIRED');
    requireValue(!result.version || result.version === match[1], 'MYSQL_TOOL_VERSION_MISMATCH');
    result.version = match[1];
    result[name] = executable;
  }
  return Object.freeze(result);
}
export async function configuredConnection(defaultsFile) {
  const raw = await privateBytes(defaultsFile, 16384);
  const value = raw.toString('utf8');
  requireValue(!value.includes('\0'), 'DEFAULTS_FILE_INVALID');
  const allowed = new Set([
    'user',
    'password',
    'host',
    'port',
    'socket',
    'protocol',
    'ssl-mode',
    'ssl-ca',
    'ssl-cert',
    'ssl-key'
  ]);
  const options = new Map();
  let group = false;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    if (trimmed === '[client]') {
      requireValue(!group, 'DEFAULTS_FILE_INVALID');
      group = true;
      continue;
    }
    const match = /^([a-z-]+)\s*=\s*(.*)$/.exec(trimmed);
    requireValue(
      group && match && allowed.has(match[1]) && !options.has(match[1]),
      'DEFAULTS_FILE_INVALID'
    );
    options.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  requireValue(options.has('user'), 'DEFAULTS_USER_REQUIRED');
  if (options.has('socket')) {
    requireValue(
      isAbsolute(options.get('socket')) &&
        (!options.has('protocol') || options.get('protocol').toUpperCase() === 'SOCKET'),
      'SOURCE_ENDPOINT_INVALID'
    );
    requireValue((await lstat(options.get('socket'))).isSocket(), 'SOURCE_SOCKET_REQUIRED');
  } else {
    requireValue(
      ['127.0.0.1', 'localhost', '::1'].includes(options.get('host')) &&
        options.get('protocol')?.toUpperCase() === 'TCP' &&
        /^[1-9][0-9]{0,4}$/.test(options.get('port') || '') &&
        Number(options.get('port')) <= 65535,
      'SOURCE_ENDPOINT_INVALID'
    );
  }
  raw.fill(0);
  return Object.freeze({
    args: ['--defaults-file=' + resolve(defaultsFile), '--no-login-paths'],
    cwd: PROJECT_ROOT
  });
}
export async function sql(tools, connection, database, statement, options = {}) {
  if (database) identifier(database);
  const args = [
    ...connection.args,
    '--connect-timeout=5',
    '--default-character-set=utf8mb4',
    '--batch',
    '--skip-column-names',
    '--raw',
    '--binary-mode',
    '--local-infile=0'
  ];
  if (database) args.push(database);
  return (await run(tools.mysql, args, { cwd: connection.cwd, input: statement, ...options }))
    .toString('utf8')
    .trim();
}
const OWNED = new WeakMap();
export function ownedInstance(instance) {
  const details = OWNED.get(instance);
  requireValue(details, 'OWNED_ISOLATED_INSTANCE_REQUIRED');
  return details;
}
export async function startIsolatedMysql(tools, workDirectory, { signal } = {}) {
  const area = await projectDirectory(workDirectory);
  const space = await statfs(area);
  requireValue(space.bavail * space.bsize > 256 * 1024 * 1024, 'INSUFFICIENT_ISOLATED_SPACE');
  const directory = await mkdtemp(join(area, 'owned-mysql-'));
  const dataDirectory = join(directory, 'data');
  const initialIdentity = await lstat(directory);
  const base = [
    '--no-defaults',
    '--basedir=' + dirname(dirname(tools.mysqld)),
    '--datadir=' + join(directory, 'data'),
    '--lower-case-table-names=' + (process.platform === 'darwin' ? '2' : '0')
  ];
  let child;
  const cleanup = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => child.once('close', done)),
        new Promise((done) => setTimeout(done, 5000))
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((done) => child.once('close', done));
      }
    }
    const identity = await lstat(directory).catch(() => null);
    requireValue(
      identity &&
        identity.dev === initialIdentity.dev &&
        identity.ino === initialIdentity.ino &&
        !identity.isSymbolicLink(),
      'CLEANUP_OWNERSHIP_CHANGED'
    );
    await rm(directory, { recursive: true });
  };
  try {
    await mkdir(dataDirectory, { mode: 0o700 });
    await mkdir(join(directory, 'plugins'), { mode: 0o700 });
    await run(tools.mysqld, [...base, '--initialize-insecure'], {
      cwd: dataDirectory,
      timeout: 60000,
      signal,
      cap: 4096
    });
    child = spawn(
      tools.mysqld,
      [
        ...base,
        '--socket=mysql.sock',
        '--pid-file=mysql.pid',
        '--log-error=mysql-error.log',
        '--skip-networking=ON',
        '--mysqlx=OFF',
        '--event-scheduler=OFF',
        '--skip-log-bin',
        '--secure-file-priv=NULL',
        '--plugin-dir=' + join(directory, 'plugins'),
        '--symbolic-links=0',
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_0900_ai_ci',
        '--default-time-zone=+00:00',
        '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
      ],
      { cwd: dataDirectory, env: safeEnvironment(), stdio: 'ignore' }
    );
    let failed = false;
    child.on('error', () => {
      failed = true;
    });
    const connection = Object.freeze({
      args: [
        '--no-defaults',
        '--no-login-paths',
        '--protocol=SOCKET',
        '--socket=mysql.sock',
        '--user=root'
      ],
      cwd: dataDirectory
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      requireValue(!signal?.aborted, 'INTERRUPTED');
      requireValue(
        !failed && child.exitCode === null && child.signalCode === null,
        'ISOLATED_SERVER_FAILED'
      );
      try {
        const health = JSON.parse(
          await sql(
            tools,
            connection,
            null,
            "SELECT JSON_OBJECT('network',@@skip_networking,'events',@@event_scheduler," +
              "'fileAccess',@@secure_file_priv,'datadir',@@datadir);",
            { cap: 4096, signal }
          )
        );
        const checks = {
          networkDisabled: Number(health.network) === 1,
          eventsDisabled: health.events === 'OFF',
          fileAccessDisabled: health.fileAccess === null || health.fileAccess === 'NULL',
          dataDirectoryMatched: (await realpath(health.datadir)) === (await realpath(dataDirectory))
        };
        if (!Object.values(checks).every(Boolean)) {
          const error = new NativeMysqlError('ISOLATION_NOT_VERIFIED');
          error.isolationChecks = checks;
          throw error;
        }
        ready = true;
        break;
      } catch (error) {
        if (!(error instanceof NativeMysqlError) || error.code === 'ISOLATION_NOT_VERIFIED')
          throw error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    requireValue(ready, 'ISOLATED_SERVER_TIMEOUT');
    const instance = Object.freeze({ directory, cleanup });
    OWNED.set(instance, { tools, connection, databasePrefix: 'idv2_native_fixture_' });
    return instance;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export function definitionQueries() {
  const original = readFileSync(join(PROJECT_ROOT, 'scripts/verify-aws-mysql-backup.sh'), 'utf8');
  const match = /definition_queries\(\) \{\s+cat <<'SQL'\n([\s\S]*?)\nSQL\n\}/.exec(original);
  requireValue(
    match && match[1].startsWith('SET TRANSACTION READ ONLY;') && match[1].endsWith('ROLLBACK;'),
    'ORIGINAL_DEFINITION_QUERY_UNAVAILABLE'
  );
  const events =
    "SELECT 'E',EVENT_NAME,SHA2(CAST(JSON_ARRAY(EVENT_DEFINITION,EVENT_TYPE,EXECUTE_AT," +
    'INTERVAL_VALUE,INTERVAL_FIELD,STARTS,ENDS,STATUS,ON_COMPLETION,DEFINER,SQL_MODE,' +
    'CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,TIME_ZONE) AS CHAR),256) ' +
    'FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() ORDER BY EVENT_NAME;\n';
  const views =
    "SELECT 'V',TABLE_NAME,SHA2(CAST(JSON_ARRAY(VIEW_DEFINITION,CHECK_OPTION,IS_UPDATABLE," +
    'DEFINER,SECURITY_TYPE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION) AS CHAR),256) ' +
    'FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME;\n';
  return match[1].replace('ROLLBACK;', events + views + 'ROLLBACK;');
}
export async function definitionSnapshot(tools, connection, database, options = {}) {
  const result = await sql(tools, connection, database, definitionQueries(), options);
  const rows = result ? result.split('\n').map((line) => line.split('\t')) : [];
  const seen = new Set();
  for (const row of rows) {
    requireValue(
      row.length === 3 &&
        /^[STFEV]$/.test(row[0]) &&
        /^[A-Za-z0-9_]{1,64}$/.test(row[1]) &&
        /^[a-f0-9]{64}$/.test(row[2]) &&
        !seen.has(row[0] + ':' + row[1]),
      'DEFINITION_METADATA_INVALID'
    );
    seen.add(row[0] + ':' + row[1]);
  }
  return {
    rows,
    sha256: sha256(JSON.stringify(rows)),
    counts: Object.fromEntries(
      ['S', 'T', 'F', 'E', 'V'].map((kind) => [kind, rows.filter((row) => row[0] === kind).length])
    )
  };
}
export function requireCoreSnapshot(snapshot) {
  const names = new Set(snapshot.rows.filter((row) => row[0] === 'S').map((row) => row[1]));
  requireValue(
    snapshot.counts.S >= 6 &&
      snapshot.counts.T === 49 &&
      snapshot.counts.F === 1 &&
      snapshot.rows.some((row) => row[0] === 'F' && row[1] === 'idv2_integrity_trigger_exists') &&
      [
        '_prisma_migrations',
        'users',
        'audit_logs',
        'id_business_v2_orders',
        'id_business_v2_finance_journals',
        'id_business_v2_balance_ledger'
      ].every((name) => names.has(name)),
    'CURRENT_ID_PROTECTION_REQUIRED'
  );
}
export function normalizeDump(bytes) {
  const input = bytes.toString('utf8');
  let block = false;
  return Buffer.from(
    input
      .split('\n')
      .map((line) => {
        if (line === 'DELIMITER ;;') block = true;
        if (block) line = line.replace(/;\s+\*\/;;$/, ' */;;');
        if (line === 'DELIMITER ;') block = false;
        return line;
      })
      .join('\n')
  );
}
export async function checkTables(tools, connection, database, snapshot, options) {
  for (const row of snapshot.rows.filter((row) => row[0] === 'S')) {
    const output = await sql(
      tools,
      connection,
      database,
      'CHECK TABLE ' + identifier(row[1]) + ';',
      options
    );
    const results = output.split('\n').map((line) => line.split('\t'));
    requireValue(
      results.length > 0 &&
        results.some((line) => line[1] === 'check' && line[2] === 'status' && line[3] === 'OK') &&
        results.every((line) => line[2] !== 'error' && line[2] !== 'warning'),
      'CHECK_TABLE_FAILED'
    );
  }
}
export async function coreRestoreProtection(tools, connection, database, options) {
  const original = readFileSync(join(PROJECT_ROOT, 'scripts/verify-aws-mysql-backup.sh'), 'utf8');
  const match =
    /read -r trigger_count routine_count bad_definers[\s\S]*?run_restore_sql <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(
      original
    );
  requireValue(match, 'ORIGINAL_GUARD_QUERY_UNAVAILABLE');
  requireValue(
    (await sql(tools, connection, database, match[1], options)) === '49\t1\t0\t0\t1\t0\t1\t7',
    'RESTORED_CORE_GUARD_INVALID'
  );
  const migration = await sql(
    tools,
    connection,
    database,
    'SELECT COUNT(*) FROM ' +
      identifier('_prisma_migrations') +
      ' WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
    options
  );
  requireValue(/^[1-9][0-9]*$/.test(migration), 'RESTORED_MIGRATIONS_MISSING');
  const functionProbe = await sql(
    tools,
    connection,
    database,
    "SELECT idv2_integrity_trigger_exists('idv2_audit_log_no_update','audit_logs')," +
      "idv2_integrity_trigger_exists('idv2_balance_ledger_no_delete','id_business_v2_balance_ledger')," +
      "idv2_integrity_trigger_exists('idv2_finance_line_no_delete','id_business_v2_finance_journal_lines')," +
      "idv2_integrity_trigger_exists('restore_probe_missing_trigger','audit_logs');",
    options
  );
  requireValue(functionProbe === '1\t1\t1\t0', 'RESTORED_FUNCTION_PROBE_FAILED');
  const probes = [
    ['audit_logs', 'UPDATE', 'Audit logs are immutable'],
    ['audit_logs', 'DELETE', 'Audit logs are immutable'],
    ['id_business_v2_balance_ledger', 'UPDATE', 'V2 balance ledger is immutable'],
    ['id_business_v2_balance_ledger', 'DELETE', 'V2 balance ledger is immutable'],
    ['id_business_v2_finance_journals', 'DELETE', 'Posted finance journals cannot be deleted'],
    [
      'id_business_v2_finance_journal_lines',
      'UPDATE',
      'Posted finance journal lines are immutable'
    ],
    ['id_business_v2_finance_journal_lines', 'DELETE', 'Posted finance journal lines are immutable']
  ];
  for (const [table, operation, message] of probes) {
    const count = await sql(
      tools,
      connection,
      database,
      'SELECT COUNT(*) FROM ' + identifier(table) + ';',
      options
    );
    requireValue(/^[1-9][0-9]*$/.test(count), 'RESTORED_GUARD_PROBE_ROW_MISSING');
    // Catch the expected SIGNAL inside the isolated server and always ROLLBACK in the same session.
    const procedure = 'native_restore_probe_' + randomBytes(6).toString('hex');
    const statement =
      operation === 'UPDATE'
        ? 'UPDATE ' + identifier(table) + ' SET id=id LIMIT 1;'
        : 'DELETE FROM ' + identifier(table) + ' LIMIT 1;';
    const script =
      'DELIMITER ;;\nCREATE PROCEDURE ' +
      identifier(procedure) +
      '()\nBEGIN\n' +
      'DECLARE hit INT DEFAULT 0; DECLARE state CHAR(5); DECLARE msg TEXT;\n' +
      'DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN GET DIAGNOSTICS CONDITION 1 ' +
      'state = RETURNED_SQLSTATE, msg = MESSAGE_TEXT; SET hit=hit+1; END;\n' +
      'START TRANSACTION; SET @idv2_routine_audit_cleanup_scope=NULL;\n' +
      statement +
      "\nROLLBACK; SELECT JSON_OBJECT('hits',hit,'state',state,'expected',msg=" +
      "'" +
      message.replaceAll("'", "''") +
      "');\nEND;;\nDELIMITER ;\nCALL " +
      identifier(procedure) +
      '();\nDROP PROCEDURE ' +
      identifier(procedure) +
      ';\n';
    const probe = JSON.parse(await sql(tools, connection, database, script, options));
    requireValue(
      probe.hits === 1 &&
        probe.state === '45000' &&
        Number(probe.expected) === 1 &&
        (await sql(
          tools,
          connection,
          database,
          'SELECT COUNT(*) FROM ' + identifier(table) + ';',
          options
        )) === count,
      'RESTORED_GUARD_PROBE_FAILED'
    );
  }
  return { rollbackProbes: 7, originalDefinerLocked: true };
}
