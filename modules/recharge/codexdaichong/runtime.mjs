import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEXDAICHONG_REVISION, PRODUCTION_GUARD_REVISION } from './prepare.mjs';
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
const productionDatabase = 'id_redesign_codexdaichong_prod';
const productionAccount = 'id_redesign_recharge';
const productionLock = 'id_redesign_codexdaichong_prod.runtime';

export function isolatedCodexdaichongEnv(env = process.env) {
  const checked = checkedRuntimeEnv(env);
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
  return checked;
}

function checkedRuntimeEnv(env) {
  const missing = required.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) throw new Error('缺少隔离运行配置：' + missing.join('、'));
  if (!portValid(env.PORT) || !portValid(env.DB_PORT) || +env.PORT === +env.DB_PORT)
    throw new Error('服务和 MySQL 必须使用不同的有效端口');
  return Object.fromEntries(
    [...required, 'PATH', 'LANG', 'TZ']
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name]])
  );
}

function productionRuntimeEnv(env) {
  const checked = checkedRuntimeEnv(env);
  if (checked.DB_HOST !== '127.0.0.1' || checked.DB_NAME !== productionDatabase ||
      checked.DB_USER !== productionAccount || Buffer.byteLength(checked.ID_RECHARGE_BRIDGE_SECRET) < 32)
    throw new Error('正式预检只接受独立新版专用回环 MySQL、专用账号和桥接密钥');
  return checked;
}

function connectProduction(checked, createConnection) {
  return createConnection({
    host: checked.DB_HOST, port: Number(checked.DB_PORT), database: checked.DB_NAME,
    user: checked.DB_USER, password: checked.DB_PASSWORD, connectTimeout: 3000
  });
}

async function readProductionState(db) {
  let state;
  try {
    await db.query({ sql: 'START TRANSACTION READ ONLY', timeout: 3000 });
    const [[row]] = await db.query({ sql: `
      SELECT DATABASE() AS databaseName, CURRENT_USER() AS account,
        (EXISTS(SELECT 1 FROM task_logs WHERE status NOT IN ('success', 'failed', 'card_invalid')) OR
          EXISTS(SELECT 1 FROM activation_manual_holds WHERE resolved_at IS NULL) OR
          EXISTS(SELECT 1 FROM cdk_codes AS code WHERE code.used_at IS NOT NULL AND code.type = '自助'
            AND NOT EXISTS (SELECT 1 FROM task_logs AS task WHERE task.cdk_code = code.cdk_code))) AS pending,
        (EXISTS(SELECT 1 FROM phone_assets WHERE in_use = 1) OR
          EXISTS(SELECT 1 FROM card_assets WHERE in_use = 1) OR
          EXISTS(SELECT 1 FROM pool_emails WHERE registered = 0 AND in_use = 1) OR
          EXISTS(SELECT 1 FROM orbitcard_card_usage WHERE in_use = 1)) AS assetsLocked
    `, timeout: 5000 });
    state = row;
  } catch {
    throw new Error('正式代充只读预检失败，请核对专用库结构和账号权限');
  }
  if (state?.databaseName !== productionDatabase || typeof state.account !== 'string' ||
      state.account.split('@')[0] !== productionAccount)
    throw new Error('正式代充数据库实际身份不符合配置');
  if (state.pending !== 0 || state.assetsLocked !== 0)
    throw new Error('存在未确认的代充任务或资产锁，须先核对原任务');
}

export async function checkProductionDatabase(env, createConnection) {
  const checked = productionRuntimeEnv(env);
  let db;
  try {
    db = await connectProduction(checked, createConnection);
  } catch {
    throw new Error('正式代充只读预检无法连接专用库');
  }
  try {
    await readProductionState(db);
  } finally {
    try {
      await db.end();
    } catch {
      db.destroy();
      throw new Error('正式代充只读预检无法确认连接已关闭');
    }
  }
}

async function holdProductionRuntime(directory) {
  const checked = productionRuntimeEnv(process.env);
  const marker = await readFile(join(directory, '.id-business-production-guard'), 'utf8').catch(() => '');
  if (marker.trim() !== PRODUCTION_GUARD_REVISION)
    throw new Error('正式启动需要按当前版本重新准备运行副本');
  const requireFromCopy = createRequire(join(directory, 'package.json'));
  const db = await connectProduction(checked, requireFromCopy('mysql2/promise').createConnection);
  try {
    const [[{ acquired }]] = await db.execute({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', timeout: 3000 }, [productionLock]);
    if (acquired !== 1) throw new Error('独立正式代充库已有运行实例');
    await readProductionState(db);
    await db.query({ sql: 'ROLLBACK', timeout: 3000 });
  } catch (error) {
    db.destroy();
    throw error;
  }
  globalThis[Symbol.for('id-business.recharge.production-lock')] = true;
  const stopOnLostLock = () => {
    console.error('正式代充失去运行锁，停止服务并保留任务待核对。');
    process.exit(1);
  };
  db.on('error', stopOnLostLock);
  const verifyOwnership = async () => {
    try {
      const [[{ owned }]] = await db.execute({
        sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', timeout: 3000
      }, [productionLock]);
      if (owned === 1) {
        setTimeout(verifyOwnership, 5000).unref();
        return;
      }
    } catch {
      // Losing the dedicated connection also loses the advisory lock.
    }
    stopOnLostLock();
  };
  setTimeout(verifyOwnership, 5000).unref();
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

if (process.env.ID_RECHARGE_RUNTIME_MODE === 'production' && basename(process.argv[1] || '') === 'server.js') {
  try {
    await holdProductionRuntime(dirname(process.argv[1]));
  } catch (error) {
    const message = error.code ? '正式代充无法取得独立数据库运行锁。' : error.message;
    console.error(message);
    process.exit(1);
  }
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
    } else if (action === 'preflight-production') {
      const directory = await checkCodexdaichongRuntime(target);
      const requireFromCopy = createRequire(join(directory, 'package.json'));
      await checkProductionDatabase(process.env, requireFromCopy('mysql2/promise').createConnection);
      console.log('正式专用库只读预检通过。执行器未启动。');
    } else if (action === 'preflight' || action === 'start' || action === 'start-production') {
      const production = action === 'start-production';
      const env = production ? productionRuntimeEnv(process.env) : isolatedCodexdaichongEnv();
      const directory = await checkCodexdaichongRuntime(target);
      if (action === 'preflight')
        console.log('通过：锁定运行副本、依赖和隔离环境参数。MySQL 连通性待启动验证。');
      else {
        if (production) env.ID_RECHARGE_RUNTIME_MODE = 'production';
        const preload = production ? ['--import', import.meta.url] : [];
        const child = spawn(process.execPath, [...preload, join(directory, 'server.js')], {
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
        '用法：runtime.mjs preflight | preflight-production | start | start-production [副本目录]，或 health <回环地址>'
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
