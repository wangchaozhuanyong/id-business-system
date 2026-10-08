import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';

export function parseNativeMysqlTestOptions(args, allowedFlags = []) {
  const result = { runtime: 'docker', extraFlags: [] };
  for (const arg of args) {
    if (allowedFlags.includes(arg)) {
      result.extraFlags.push(arg);
      continue;
    }
    const match = /^--(runtime|mysql-bin)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(result, match[1] === 'mysql-bin' ? 'mysqlBin' : 'explicitRuntime'))
      throw new Error('MySQL 验收参数无效');
    if (match[1] === 'runtime') {
      if (!['native', 'docker'].includes(match[2])) throw new Error('MySQL 验收运行方式无效');
      result.runtime = match[2];
      result.explicitRuntime = true;
    } else result.mysqlBin = match[2];
  }
  if (result.runtime === 'native' && (!result.mysqlBin || !isAbsolute(result.mysqlBin)))
    throw new Error('原生 MySQL 验收必须指定已安装的 --mysql-bin 绝对目录');
  if (result.runtime === 'docker' && result.mysqlBin)
    throw new Error('Docker 验收不能混入原生安装目录');
  return result;
}

function cleanEnvironment(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

async function availablePort() {
  const socket = createServer();
  await new Promise((ready, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', ready);
  });
  const port = socket.address().port;
  await new Promise((ready) => socket.close(ready));
  return port;
}

const delay = (ms) => new Promise((ready) => setTimeout(ready, ms));

export function verifyNativeMysqlTestProject(project) {
  const schema = resolve(project, 'apps/api/prisma-mysql/schema.prisma');
  if (
    !isAbsolute(project) ||
    realpathSync(project) !== resolve(project) ||
    realpathSync(schema) !== schema ||
    !lstatSync(schema).isFile()
  )
    throw new Error('必须在已确认的项目测试副本中执行');
  const parent = resolve(project, '.runtime/native-mysql-tests');
  let ancestor = parent;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory())
    throw new Error('测试目录祖先不能为软链接');
  return parent;
}

export function verifyNativeMysqlTestDirectory(project, directory) {
  const parent = verifyNativeMysqlTestProject(project);
  if (
    realpathSync(parent) !== parent ||
    dirname(directory) !== parent ||
    !/^owned-[a-zA-Z0-9]+$/.test(directory.slice(parent.length + 1)) ||
    realpathSync(directory) !== directory ||
    !lstatSync(directory).isDirectory()
  )
    throw new Error('自有测试目录身份已改变，停止清理并保留目录');
}

export async function startNativeMysqlTestInstance({
  mysqlBin,
  database,
  project = process.cwd()
}) {
  if (!isAbsolute(mysqlBin) || !/^(?:id_business_v2_|id_native_)[a-z0-9_]+$/.test(database))
    throw new Error('只允许隔离 MySQL 测试配置');
  const parent = verifyNativeMysqlTestProject(project);
  const commands = {};
  for (const name of ['mysqld', 'mysql', 'mysqladmin']) {
    const file = resolve(mysqlBin, name);
    accessSync(file, constants.X_OK);
    const version = spawnSync(
      file,
      ['--no-defaults', ...(name === 'mysqld' ? [] : ['--no-login-paths']), '--version'],
      { encoding: 'utf8', env: cleanEnvironment(), timeout: 10000 }
    );
    if (version.status !== 0 || !/\b8\.4\./.test(version.stdout))
      throw new Error('原生 MySQL 验收需要 8.4 客户端和服务端');
    commands[name] = file;
  }
  // Every directory below is newly owned by this invocation; no existing datadir/config is accepted.
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (verifyNativeMysqlTestProject(project) !== parent || realpathSync(parent) !== parent)
    throw new Error('测试目录不能为软链接');
  const port = await availablePort();
  const directory = mkdtempSync(resolve(parent, 'owned-'));
  verifyNativeMysqlTestDirectory(project, directory);
  const rootPassword = randomBytes(24).toString('hex');
  let child;
  let childEnded = true;
  let passwordEnabled = false;
  function queryResult(sql, targetDatabase) {
    return spawnSync(
      commands.mysql,
      [
        '--no-defaults',
        '--no-login-paths',
        '--protocol=SOCKET',
        '--socket=mysql.sock',
        '--user=root',
        '--batch',
        '--skip-column-names',
        ...(targetDatabase ? [targetDatabase] : [])
      ],
      {
        cwd: directory,
        input: sql,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
        env: cleanEnvironment(passwordEnabled ? { MYSQL_PWD: rootPassword } : {})
      }
    );
  }
  function query(sql, targetDatabase) {
    const result = queryResult(sql, targetDatabase);
    if (result.status !== 0) throw new Error('自有原生 MySQL 查询失败；SQL、凭据和原始输出已隐藏');
    return result.stdout.trim();
  }
  async function stopDaemon() {
    if (!child || childEnded) return;
    if (existsSync(resolve(directory, 'mysql.pid'))) {
      const pidText = readFileSync(resolve(directory, 'mysql.pid'), 'utf8').trim();
      if (Number(pidText) !== child.pid) throw new Error('自有 MySQL PID 身份不匹配，停止清理');
    }
    child.kill('SIGTERM');
    for (let index = 0; index < 100 && !childEnded; index += 1) await delay(100);
    if (!childEnded) {
      child.kill('SIGKILL');
      for (let index = 0; index < 30 && !childEnded; index += 1) await delay(100);
    }
    if (!childEnded) throw new Error('自有 MySQL 未退出，保留测试目录');
  }
  async function cleanup() {
    verifyNativeMysqlTestDirectory(project, directory);
    await stopDaemon();
    verifyNativeMysqlTestDirectory(project, directory);
    rmSync(directory, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  let stopping = false;
  function stopForSignal(code) {
    if (stopping) return;
    stopping = true;
    cleanup().then(
      () => process.exit(code),
      () => process.exit(1)
    );
  }
  const interrupt = () => stopForSignal(130);
  const terminate = () => stopForSignal(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  async function launch(network) {
    childEnded = false;
    child = spawn(
      commands.mysqld,
      [
        '--no-defaults',
        `--datadir=${directory}`,
        '--socket=mysql.sock',
        '--pid-file=mysql.pid',
        '--log-error=mysql.log',
        '--mysqlx=OFF',
        '--event-scheduler=OFF',
        '--innodb-buffer-pool-size=64M',
        '--performance-schema=OFF',
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_0900_ai_ci',
        '--default-time-zone=+00:00',
        '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
        '--log-bin-trust-function-creators=1',
        ...(network ? ['--bind-address=127.0.0.1', `--port=${port}`] : ['--skip-networking'])
      ],
      { cwd: directory, stdio: 'ignore', env: cleanEnvironment() }
    );
    child.once('exit', () => {
      childEnded = true;
    });
    child.once('error', () => {
      childEnded = true;
    });
    for (let index = 0; index < 120; index += 1) {
      if (childEnded) throw new Error('自有 MySQL 启动失败；原始日志已隐藏');
      const result = queryResult('SELECT 1');
      if (result.status === 0) return;
      await delay(250);
    }
    throw new Error('自有 MySQL 未按时就绪');
  }
  try {
    const initialized = spawnSync(
      commands.mysqld,
      [
        '--no-defaults',
        '--initialize-insecure',
        `--datadir=${directory}`,
        '--mysqlx=OFF',
        '--log-error=mysql.log'
      ],
      { cwd: directory, stdio: 'ignore', env: cleanEnvironment(), timeout: 60000 }
    );
    if (initialized.status !== 0) throw new Error('自有空 MySQL 初始化失败');
    await launch(false);
    query(
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}'; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`
    );
    passwordEnabled = true;
    await stopDaemon();
    await launch(true);
    return { runtime: 'native', port, rootPassword, database, query, queryResult, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
