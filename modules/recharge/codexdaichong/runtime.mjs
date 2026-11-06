import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEXDAICHONG_REVISION } from './prepare.mjs';
import { probeCodexdaichongRuntime } from './runtime-health.mjs';

const runtimeRoot = fileURLToPath(new URL('../../../.runtime/', import.meta.url));
const required = [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'ID_RECHARGE_BRIDGE_SECRET'
];
const portValid = (value) => /^\d{1,5}$/.test(value ?? '') && +value > 0 && +value <= 65535;

export function isolatedCodexdaichongEnv(env = process.env) {
  const missing = required.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) throw new Error('缺少隔离运行配置：' + missing.join('、'));
  if (!portValid(env.PORT) || !portValid(env.DB_PORT) || +env.PORT === +env.DB_PORT)
    throw new Error('服务和 MySQL 必须使用不同的有效端口');
  if (
    env.DB_HOST !== '127.0.0.1' ||
    !/^id_redesign_codexdaichong_test(?:_[a-z0-9]+)*$/.test(env.DB_NAME)
  )
    throw new Error('隔离启动只接受回环 MySQL 和专用测试库名');
  if (
    env.DB_USER.trim().toLowerCase() === 'root' ||
    Buffer.byteLength(env.ID_RECHARGE_BRIDGE_SECRET) < 32
  )
    throw new Error('隔离启动需要专用非 root 数据库账号及至少 32 字节的桥接密钥');
  return Object.fromEntries(
    [...required, 'PATH', 'LANG', 'TZ']
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name]])
  );
}

export async function checkCodexdaichongRuntime(directory = join(runtimeRoot, 'codexdaichong')) {
  const projectRuntime = await realpath(runtimeRoot);
  const location = await realpath(directory);
  const inside = relative(projectRuntime, location);
  if (
    !inside ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    projectRuntime !== runtimeRoot.replace(/\/$/, '')
  )
    throw new Error('运行副本须位于本项目 .runtime 专用目录');
  const revision = await readFile(join(location, '.id-business-integrated-runtime'), 'utf8');
  if (revision.trim() !== CODEXDAICHONG_REVISION) throw new Error('运行副本与固定版本不一致');
  const packagePath = join(location, 'package.json');
  const { dependencies } = JSON.parse(await readFile(packagePath, 'utf8'));
  const requireFromCopy = createRequire(packagePath);
  const missing = Object.keys(dependencies).filter((name) => {
    try {
      const resolved = requireFromCopy.resolve(name);
      if (!isAbsolute(resolved)) return false; // Node built-in module.
      const dependencyPath = relative(join(location, 'node_modules'), resolved);
      return dependencyPath.startsWith('..') || isAbsolute(dependencyPath);
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error('运行副本尚缺锁定依赖：' + missing.join('、'));
  for (const file of ['server.js', 'upstream-bridge.cjs', 'package-lock.json'])
    await readFile(join(location, file));
  return location;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [action, target] = process.argv.slice(2);
  try {
    if (action === 'health') {
      const result = await probeCodexdaichongRuntime({
        upstreamUrl: target,
        secret: process.env.ID_RECHARGE_BRIDGE_SECRET
      });
      console.log(JSON.stringify(result));
      if (!result.ready) process.exitCode = 1;
    } else if (action === 'preflight' || action === 'start') {
      const env = isolatedCodexdaichongEnv();
      const directory = await checkCodexdaichongRuntime(target);
      if (action === 'preflight')
        console.log('通过：锁定运行副本、依赖和隔离环境参数。MySQL 连通性待启动验证。');
      else {
        const child = spawn(process.execPath, [join(directory, 'server.js')], {
          cwd: directory,
          env,
          stdio: 'inherit'
        });
        const interrupt = () => child.kill('SIGINT');
        const terminate = () => child.kill('SIGTERM');
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', terminate);
        try {
          const [code] = await once(child, 'exit');
          process.exitCode = code ?? 1;
        } finally {
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', terminate);
        }
      }
    } else {
      throw new Error(
        '用法：runtime.mjs preflight [副本目录] | start [副本目录] | health <回环地址>'
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
