import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEXDAICHONG_REVISION, verifyCodexdaichongSource } from './prepare.mjs';
import { probeCodexdaichongRuntime } from './runtime-health.mjs';
import { createNativeAdminTokenIssuer, createNativeCardStop, startNativeRechargeAdapter } from './native-adapter.mjs';
import { verifyNativeNetworkIsolation } from './native-network.mjs';
import { resolveNativeAdminTokenSecret } from './native-secret.mjs';

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
// Keep the pinned engine's startup options. Job credentials, plan/region
// overrides and worker-mode flags must still be assigned by its own scheduler.
const upstreamRuntimeSettings = [
  'BROWSER_POOL', 'BROWSER_POOL_SIZE', 'BROWSER_POOL_MAX_SIZE',
  'BROWSER_POOL_BASE_PORT', 'BROWSER_POOL_ACQUIRE_TIMEOUT_MS',
  'HEADFUL', 'CHROMIUM_CHANNEL', 'PLAYWRIGHT_BROWSERS_PATH', 'PROXY',
  'MAX_CONCURRENT_ACTIVATIONS', 'PROCESS_IDLE_TIMEOUT_MS',
  'PAYMENT_MAX_CARD_ATTEMPTS', 'GPT_API_MAX_POLLS', 'GPT_API_POLL_INTERVAL_MS',
  'CHECKOUT_UI_MODE', 'CHECKOUT_READY_WAIT_MS', 'RECORD_VIDEO', 'JSON_BODY_LIMIT'
];
const portValid = (value) => /^\d{1,5}$/.test(value ?? '') && +value > 0 && +value <= 65535;
const productionDatabase = 'id_redesign_codexdaichong_prod';
const productionAccount = 'id_redesign_recharge';

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
    [...required, ...upstreamRuntimeSettings,
      'PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR', 'DISPLAY', 'XDG_CACHE_HOME']
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name]])
  );
}

export function productionRuntimeEnv(env) {
  const checked = checkedRuntimeEnv(env);
  if (checked.DB_HOST !== '127.0.0.1' || checked.DB_NAME !== productionDatabase ||
      checked.DB_USER !== productionAccount || Buffer.byteLength(checked.ID_RECHARGE_BRIDGE_SECRET) < 32)
    throw new Error('正式预检只接受独立新版专用回环 MySQL、专用账号和桥接密钥');
  return checked;
}

export function nativeProductionRuntimeEnv(env) {
  const checked = checkedRuntimeEnv(env);
  const address = checked.DB_HOST;
  const octets = isIP(address) === 4 ? address.split('.').map(Number) : [];
  const privateAddress = octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if ((!privateAddress && address !== '127.0.0.1') || checked.DB_NAME !== productionDatabase ||
      checked.DB_USER !== productionAccount || Buffer.byteLength(checked.ID_RECHARGE_BRIDGE_SECRET) < 32)
    throw new Error('原版正式进程只接受明确的私网 IPv4 或回环 MySQL、专用库、专用账号和桥接密钥');
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

async function checkDedicatedProductionDatabase(checked, createConnection) {
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

export async function checkProductionDatabase(env, createConnection) {
  return checkDedicatedProductionDatabase(productionRuntimeEnv(env), createConnection);
}

export async function checkNativeProductionDatabase(env, createConnection) {
  return checkDedicatedProductionDatabase(nativeProductionRuntimeEnv(env), createConnection);
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
  await verifyCodexdaichongSource(location);
  return location;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [action, target] = process.argv.slice(2);
  try {
    if (action === 'preflight-native-production') {
      const directory = await checkCodexdaichongRuntime(target);
      const requireFromCopy = createRequire(join(directory, 'package.json'));
      await checkNativeProductionDatabase(process.env, requireFromCopy('mysql2/promise').createConnection);
      console.log('原版启动前只读预检通过。');
    } else if (action === 'health') {
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
        // The pristine engine is a separate private service. Never start its
        // wildcard listener on the public host as an implicit side effect.
        const nativeUrl = process.env.ID_RECHARGE_NATIVE_URL;
        await verifyNativeNetworkIsolation({ nativeUrl, container: process.env.ID_RECHARGE_NATIVE_CONTAINER,
          proof: process.env.ID_RECHARGE_NATIVE_NETWORK_PROOF, secret: env.ID_RECHARGE_BRIDGE_SECRET });
        const requireFromCopy = createRequire(join(directory, 'package.json'));
        const nativeAuth = requireFromCopy('./admin-auth.js');
        const nativeSecret = resolveNativeAdminTokenSecret(process.env);
        const pool = requireFromCopy('mysql2/promise').createPool({
          host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
          user: env.DB_USER, password: env.DB_PASSWORD, connectionLimit: 1, connectTimeout: 3000
        });
        try {
          const getNativeAdminToken = createNativeAdminTokenIssuer({
            issueSignedToken: nativeAuth.issueSignedToken, secret: nativeSecret,
            async readPasswordVersion() {
              const [rows] = await pool.execute({ sql: 'SELECT config_value FROM app_config WHERE config_key = ?', timeout: 3000 },
                ['admin_password_version']);
              return rows.length === 1 ? Number(rows[0].config_value) : NaN;
            }
          });
          const adapter = await startNativeRechargeAdapter({ nativeUrl, secret: env.ID_RECHARGE_BRIDGE_SECRET,
            getNativeAdminToken, stopCardUse: createNativeCardStop(pool) }, Number(env.PORT));
          let closing;
          const stop = () => {
            closing ??= adapter.close().finally(() => pool.end()).catch(() => { process.exitCode = 1; });
            return closing;
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        } catch (error) { await pool.end(); throw error; }
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
