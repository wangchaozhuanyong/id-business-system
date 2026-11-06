import { createServer } from 'node:http';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readToolConfig } from './tools/read-tool-config.mjs';
import {
  createLoopbackVendureRechargeBridge, rechargeWorkerPrefix, vendureRechargePrefix
} from '../modules/recharge/vendure/loopback-bridge.mjs';
import {
  isolatedRechargeFilename, openIsolatedRechargeStore
} from '../modules/recharge/vendure/isolated-task-store.mjs';

const runtimeRoot = fileURLToPath(new URL('../.runtime/', import.meta.url));

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export async function startVendureTaskService({
  directory, vendurePort, workerPort, storageKey, vendureKey, workerSecret, codes,
  acceptSubmissions = false, legacyReceipts
}) {
  const validPort = (value) => Number.isInteger(value) && value >= 0 && value <= 65535;
  if (!validPort(vendurePort) || !validPort(workerPort) || (vendurePort !== 0 && vendurePort === workerPort) ||
      typeof directory !== 'string' || !isAbsolute(directory) || typeof storageKey !== 'string' ||
      !directory.startsWith(runtimeRoot) || !/^[a-f0-9]{64}$/.test(storageKey) ||
      !Array.isArray(codes) || !codes.length || typeof acceptSubmissions !== 'boolean')
    throw new Error('商城任务服务需要独立端口、私有目录、存储密钥和兑换码配置');
  const state = await lstat(directory);
  if (!state.isDirectory() || (state.mode & 0o777) !== 0o700 || state.uid !== process.getuid() ||
      await realpath(directory) !== directory)
    throw new Error('商城任务目录须由服务账号持有且权限为 0700');
  const lock = join(directory, 'vendure-task-service.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('商城任务目录已被占用，异常退出后须先核对原任务');
    throw error;
  }
  const key = Buffer.from(storageKey, 'hex');
  let store;
  try {
    store = openIsolatedRechargeStore({ file: join(directory, isolatedRechargeFilename), storageKey: key });
  } catch (error) {
    await rmdir(lock);
    throw error;
  } finally {
    key.fill(0);
  }
  let bridge;
  const servers = [];
  let closing;
  function close() {
    closing ??= (async () => {
      bridge?.close();
      await Promise.all(servers.map(closeServer));
      store.close();
      await rmdir(lock);
    })();
    return closing;
  }
  async function startListener(prefix, port) {
    const server = createServer({ requestTimeout: 15000, headersTimeout: 5000 }, (request, response) => {
      if (!(request.url || '').startsWith(prefix + '/'))
        return response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return void bridge.handle(request, response);
    });
    servers.push(server);
    return listen(server, port);
  }
  try {
    bridge = createLoopbackVendureRechargeBridge({
      codes, vendureKey, workerSecret, store, acceptSubmissions, legacyReceipts
    });
    const vendureUrl = await startListener(vendureRechargePrefix, vendurePort);
    const workerUrl = await startListener(rechargeWorkerPrefix, workerPort);
    return { vendureUrl, workerUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error();
    process.umask(0o077);
    const config = await readToolConfig(process.argv[2], 'vendure-task-service');
    if (!config?.vendurePort || !config?.workerPort) throw new Error();
    const service = await startVendureTaskService(config);
    console.log(JSON.stringify({ vendureUrl: service.vendureUrl, workerUrl: service.workerUrl }));
    const stop = () => void service.close().catch(() => { process.exitCode = 1; });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    console.error('商城代充任务服务启动失败，请核对专用端口、配置和私有目录。');
    process.exitCode = 1;
  }
}
