import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerEntry = resolve(
  projectDir,
  'apps/api/src/id-business-v2/auto-recharge/worker/server.py'
);
const loopbackHosts = new Set(['127.0.0.1']);
const callbackPath = '/api/id-business-v2/auto-recharge/internal';
const pythonCheck = `import importlib.util, sys
raise SystemExit(0 if sys.version_info >= (3, 11) and all(importlib.util.find_spec(name) for name in ('playwright', 'camoufox')) else 1)`;

export function parseNativeWorkerOptions(argv) {
  const values = {};
  const names = new Set(['role', 'python', 'engine-path', 'host', 'port']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check' || argument === '--help') {
      const name = argument.slice(2);
      if (values[name]) throw new Error('启动参数重复');
      values[name] = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !names.has(match[1]) || match[1] in values) {
      throw new Error('原生执行器启动参数无效');
    }
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error('原生执行器启动参数缺少值');
    values[match[1]] = value;
  }
  if (values.help) return { help: true };
  const role = values.role ?? 'recharge';
  const host = values.host ?? '127.0.0.1';
  const rawPort = values.port ?? '8051';
  if (role !== 'recharge') throw new Error('执行器类型无效');
  if (!loopbackHosts.has(host)) throw new Error('本机执行器只能监听回环地址');
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('执行器端口无效');
  }
  if (!values.python || !values['engine-path'] || !isAbsolute(values['engine-path'])) {
    throw new Error('请明确指定已安装的 Python 环境和浏览器内核绝对路径');
  }
  return {
    role,
    host,
    port: Number(rawPort),
    python: values.python,
    enginePath: values['engine-path'],
    check: Boolean(values.check)
  };
}

export function nativeWorkerLaunch(options, environment = process.env) {
  if (options.role !== 'recharge') throw new Error('执行器类型无效');
  const token = environment.AUTO_RECHARGE_WORKER_TOKEN ?? '';
  if (token.length < 32) throw new Error('执行器凭据未配置，须通过现有环境变量传入');
  let callback;
  try {
    callback = new URL(
      environment.AUTO_RECHARGE_CALLBACK_URL ?? `http://127.0.0.1:3000${callbackPath}`
    );
  } catch {
    throw new Error('本机 API 回调地址无效');
  }
  if (
    !['http:', 'https:'].includes(callback.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(callback.hostname) ||
    callback.pathname !== callbackPath ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  ) {
    throw new Error('本机执行器须使用本机 API 回调地址');
  }
  const cwd = resolve(projectDir, '.runtime/native-workers', options.role);
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'SYSTEMROOT']) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  return {
    command: options.python,
    args: [
      '-B',
      workerEntry,
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--engine-path',
      options.enginePath
    ],
    cwd,
    env: {
      ...env,
      TMPDIR: cwd,
      PYTHONDONTWRITEBYTECODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: resolve(projectDir, '.runtime/native-workers/browser-cache'),
      AUTO_RECHARGE_WORKER_ROLE: options.role,
      AUTO_RECHARGE_WORKER_TOKEN: token,
      AUTO_RECHARGE_CALLBACK_URL: callback.href
    }
  };
}

function runWorker(launch) {
  return new Promise((resolveExit) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: 'inherit',
      shell: false
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    function finish(code) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      resolveExit(code);
    }
    child.once('error', () => finish(1));
    child.once('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

export async function startNativeWorker(argv, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const run = dependencies.run ?? spawnSync;
  const launchWorker = dependencies.launchWorker ?? runWorker;
  const checkEngine =
    dependencies.checkEngine ??
    ((path) => {
      if (!statSync(path).isFile()) throw new Error();
      accessSync(path, constants.X_OK);
    });
  let options;
  let launch;
  try {
    options = parseNativeWorkerOptions(argv);
    if (options.help) {
      log(
        '用法：npm run auto-recharge:native -- --role=recharge --python=已安装环境 --engine-path=内核绝对路径 [--port=8051] [--check]'
      );
      return 0;
    }
    launch = nativeWorkerLaunch(options, dependencies.environment ?? process.env);
  } catch (error) {
    log(error instanceof Error && error.message ? error.message : '浏览器内核不可用');
    return 1;
  }
  try {
    checkEngine(options.enginePath);
  } catch {
    log('浏览器内核不可用：须指定已有的可执行文件');
    return 1;
  }
  try {
    const result = run(options.python, ['-B', '-c', pythonCheck], {
      cwd: projectDir,
      env: launch.env,
      encoding: 'utf8',
      timeout: 15000,
      shell: false
    });
    if (result.error || result.status !== 0) throw new Error();
    const packages = run(options.python, ['-B', '-m', 'pip', 'check'], {
      cwd: projectDir,
      env: launch.env,
      encoding: 'utf8',
      timeout: 30000,
      shell: false
    });
    if (packages.error || packages.status !== 0) throw new Error();
  } catch {
    log('Python 环境检查失败：需要 Python 3.11 及以上和已安装且依赖完整的 Playwright／Camoufox');
    return 1;
  }
  if (options.check) {
    log('原生执行器前置检查通过；尚未启动服务或验证 API／数据库连接');
    return 0;
  }
  try {
    (dependencies.makeRuntimeDir ?? mkdirSync)(launch.cwd, { recursive: true, mode: 0o700 });
  } catch {
    log('无法创建本项目执行器运行目录');
    return 1;
  }
  log(`启动本机充值执行器：${options.host}:${options.port}`);
  return launchWorker(launch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await startNativeWorker(process.argv.slice(2));
}
