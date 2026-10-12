import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  parseNativeMysqlTestOptions,
  startNativeMysqlTestInstance,
  verifyNativeMysqlTestProject
} from './native-mysql-test-instance.mjs';

const IMAGE = 'mysql:8.4';
const OWNER_LABEL = 'id-business-v2.owned-mysql-test';
const INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},' +
  '"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}},' +
  '"mounts":{{json .Mounts}},"running":{{json .State.Running}}}';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseOwnedMysqlTestOptions(args, { legacyNative = false } = {}) {
  const legacy =
    legacyNative &&
    args.some((arg) => arg.startsWith('--mysql-bin=')) &&
    !args.some((arg) => arg.startsWith('--runtime='));
  return parseNativeMysqlTestOptions(legacy ? ['--runtime=native', ...args] : args);
}

function safeEnvironment(environment, extra = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'])
    if (environment[name]) env[name] = environment[name];
  return { ...env, ...extra };
}

export async function startOwnedMysqlTestInstance(
  { runtime, mysqlBin, database, project },
  {
    execute = spawnSync,
    delay = sleep,
    environment = process.env,
    nativeStarter = startNativeMysqlTestInstance
  } = {}
) {
  if (runtime === 'native') return nativeStarter({ mysqlBin, database, project });
  if (
    runtime !== 'docker' ||
    mysqlBin ||
    !/^(?:id_business_v2_|id_native_)[a-z0-9_]+$/.test(database)
  )
    throw new Error('只允许新建自有空 MySQL 测试实例');
  verifyNativeMysqlTestProject(project);
  // Freeze a local socket endpoint. Never inherit a remote Docker target or database URL.
  if (environment.DOCKER_HOST || environment.DOCKER_CONTEXT || environment.DOCKER_TLS_VERIFY)
    throw new Error('隔离 Docker 验收不能使用外部连接覆盖');
  const env = safeEnvironment(environment);
  const context = execute('docker', ['context', 'inspect'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  let endpoint;
  try {
    const value = JSON.parse(context.stdout);
    if (context.status !== 0 || !Array.isArray(value) || value.length !== 1) throw new Error();
    endpoint = value[0].Endpoints.docker.Host;
    if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^\r\n]+$/.test(endpoint)) throw new Error();
  } catch {
    throw new Error('Docker 验收需要本机 Unix socket 服务');
  }
  const owner = randomUUID();
  const name = 'idv2-owned-mysql-' + randomUUID().replaceAll('-', '');
  const rootPassword = randomBytes(24).toString('hex');
  const docker = (args, extra = {}) =>
    execute('docker', ['--host', endpoint, ...args], {
      env,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      ...extra
    });
  let containerId;
  let started = false;
  let closed = false;
  const readIdentity = (reference) => {
    const result = docker(['inspect', '--format', INSPECT, reference]);
    if (result.status !== 0) throw new Error('自有 Docker 实例身份未确认');
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error('自有 Docker 实例身份回执无效');
    }
    if (
      !/^[a-f0-9]{64}$/.test(value.id) ||
      (containerId && value.id !== containerId) ||
      value.name !== '/' + name ||
      value.labels?.[OWNER_LABEL] !== owner ||
      value.image !== IMAGE ||
      !Array.isArray(value.mounts) ||
      value.mounts.some(
        (mount) =>
          mount.Type !== 'volume' ||
          mount.Destination !== '/var/lib/mysql' ||
          !/^[a-f0-9]{64}$/.test(mount.Name)
      )
    )
      throw new Error('自有 Docker 实例身份已变化，停止清理');
    return value;
  };
  async function cleanup() {
    if (closed || !started) return;
    try {
      const identity = readIdentity(containerId ?? name);
      containerId = identity.id;
      let stopConfirmed = true;
      if (identity.running) {
        const stopped = docker(['stop', '--time', '20', containerId]);
        stopConfirmed = stopped.status === 0;
      } else {
        const removed = docker(['rm', '--volumes', containerId]);
        stopConfirmed = removed.status === 0;
      }
      // --rm can finish removal while the stop client returns an error or before
      // its status query catches up. Verify absence without sending another stop.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const remains = docker([
          'ps',
          '--all',
          '--filter',
          'id=' + containerId,
          '--format',
          '{{.ID}}'
        ]);
        if (remains.status !== 0) throw new Error('自有 Docker 实例清理结果未确认');
        if (!remains.stdout.trim()) {
          closed = true;
          return;
        }
        if (!stopConfirmed) throw new Error('自有 Docker 实例停止未确认');
        await delay(250);
      }
      throw new Error('自有 Docker 实例清理结果未确认');
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
  let stopping = false;
  const stopForSignal = (code) => {
    if (stopping) return;
    stopping = true;
    cleanup().then(
      () => process.exit(code),
      () => process.exit(1)
    );
  };
  const interrupt = () => stopForSignal(130);
  const terminate = () => stopForSignal(143);
  function queryResult(statement, targetDatabase = database) {
    if (
      closed ||
      !containerId ||
      targetDatabase !== database ||
      typeof statement !== 'string' ||
      !statement ||
      Buffer.byteLength(statement) > 8 * 1024 * 1024
    )
      throw new Error('自有 MySQL 查询边界无效');
    const result = docker(
      [
        'exec',
        '-i',
        containerId,
        'sh',
        '-c',
        'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --no-defaults --no-login-paths ' +
          '--protocol=SOCKET --user=root --batch --skip-column-names --raw --binary-mode ' +
          '--local-infile=0 --default-character-set=utf8mb4 --database="$1"',
        'sh',
        database
      ],
      { input: statement }
    );
    const code = /\bERROR (\d{1,5}) \(/.exec(result.stderr ?? '')?.[1];
    return {
      status: Number.isInteger(result.status) ? result.status : 1,
      stdout: result.status === 0 ? result.stdout : '',
      stderr: code ? `ERROR ${code} (` : ''
    };
  }
  const query = (statement, targetDatabase) => {
    const result = queryResult(statement, targetDatabase);
    if (result.status !== 0) throw new Error('自有 Docker MySQL 查询失败；原始输出已隐藏');
    return result.stdout.trim();
  };
  try {
    const launched = docker(
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--label',
        OWNER_LABEL + '=' + owner,
        '--publish',
        '127.0.0.1::3306',
        '--env',
        'MYSQL_ROOT_PASSWORD',
        '--env',
        'MYSQL_ROOT_HOST=%',
        '--env',
        'MYSQL_DATABASE=' + database,
        IMAGE,
        '--mysqlx=OFF',
        '--event-scheduler=OFF',
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_0900_ai_ci',
        '--default-time-zone=+00:00',
        '--log-bin-trust-function-creators=1'
      ],
      { env: safeEnvironment(environment, { MYSQL_ROOT_PASSWORD: rootPassword }), timeout: 300000 }
    );
    started = true;
    if (/^[a-f0-9]{64}$/.test(launched.stdout?.trim() ?? '')) containerId = launched.stdout.trim();
    if (launched.status !== 0 || !containerId)
      throw new Error('新建隔离 Docker MySQL 失败；原始输出已隐藏');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const identity = readIdentity(containerId);
    const bindings = identity.ports?.['3306/tcp'];
    if (
      !Array.isArray(bindings) ||
      bindings.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' ||
      !/^\d{1,5}$/.test(bindings[0].HostPort) ||
      Number(bindings[0].HostPort) < 1 ||
      Number(bindings[0].HostPort) > 65535
    )
      throw new Error('隔离 MySQL 只能发布本机随机端口');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (queryResult('SELECT 1').status === 0) {
        if (!/^8\.4\./.test(query('SELECT VERSION()')))
          throw new Error('隔离 Docker MySQL 版本必须为 8.4');
        return {
          runtime: 'docker',
          port: Number(bindings[0].HostPort),
          rootPassword,
          database,
          query,
          queryResult,
          cleanup
        };
      }
      await delay(250);
    }
    throw new Error('新建隔离 Docker MySQL 未按时就绪');
  } catch (error) {
    await cleanup();
    throw error;
  }
}
