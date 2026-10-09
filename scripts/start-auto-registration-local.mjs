import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, '.runtime/auto-registration');
const databaseName = 'id_business_registration_local';
const mysql = resolve(root, '.runtime/mysql/bin/mysql');
const socket = resolve(root, '.runtime/mysql.sock');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
if (!existsSync(mysql) || !existsSync(socket)) throw new Error('请先启动本项目本地 MySQL 实例');
if (!process.env.SEED_ADMIN_USERNAME || !process.env.SEED_ADMIN_PASSWORD)
  throw new Error('请在项目本地配置中设置初始化管理员；不要在聊天中提供密码');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: `mysql://root@127.0.0.1:3306/${databaseName}`,
  V2_RUNTIME_DATABASE_URL: `mysql://root@127.0.0.1:3306/${databaseName}`,
  APP_PORT: '3000',
  CORS_ORIGIN: 'http://localhost:5374,http://127.0.0.1:5374',
  ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'false',
  ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
  ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED: 'false',
  VITE_API_BASE_URL: '/api',
  VITE_DEV_API_PROXY_TARGET: 'http://127.0.0.1:3000'
};
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('独立本地开发环境启动失败');
};
// Only this named development database is initialized; existing databases are untouched.
run(mysql, [
  '--no-defaults',
  '--protocol=socket',
  `--socket=${socket}`,
  '--user=root',
  '-e',
  `CREATE DATABASE IF NOT EXISTS ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
]);
run('npm', ['run', 'prisma:mysql:migrate:deploy']);
run('npm', ['run', 'prisma:seed']);
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const apiLog = openSync(resolve(runtime, 'api.log'), 'a', 0o600);
const adminLog = openSync(resolve(runtime, 'admin.log'), 'a', 0o600);
const api = spawn(process.execPath, [resolve(root, 'apps/api/dist/main.js'), '--host=127.0.0.1'], {
  cwd: root,
  env,
  stdio: ['ignore', apiLog, apiLog]
});
const admin = spawn(
  process.execPath,
  [resolve(root, 'node_modules/vite/bin/vite.js'), '--host=127.0.0.1'],
  {
    cwd: resolve(root, 'apps/admin'),
    env,
    stdio: ['ignore', adminLog, adminLog]
  }
);
closeSync(apiLog);
closeSync(adminLog);
const stop = () => {
  api.kill('SIGTERM');
  admin.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
api.once('exit', stop);
admin.once('exit', stop);
console.log(
  '本地系统启动中：http://localhost:5374/v2/auto-registration（沿用本地配置的管理员登录）'
);
