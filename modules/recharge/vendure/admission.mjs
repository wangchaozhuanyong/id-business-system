import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { generatedCdkPattern } from '../codexdaichong/native-code-returns.mjs';

export const moyaoRechargeChannel = 'moyao-ai';
export const storefrontAdmissionSocketName = 'lookup.sock';
export const rechargeManualReviewReason = 'manual_review_required';
const route = '/lookup';
const supportedPlans = new Map([
  ['plus', 'plus'], ['pro100', 'pro_5x'], ['pro_5x', 'pro_5x'], ['pro200', 'pro_20x'], ['pro_20x', 'pro_20x']
]);

export function storefrontRechargePlan(plan) {
  return supportedPlans.get(plan);
}

export function storefrontRechargeCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return generatedCdkPattern.test(code) ? code : '';
}

function validResult(result) {
  return result && typeof result.plan === 'string' && storefrontRechargePlan(result.plan) === result.plan &&
    ['available', 'reserved', 'used', 'disabled'].includes(result.status) &&
    (result.reason === undefined ||
      (result.status === 'reserved' && result.reason === rechargeManualReviewReason));
}

export function createStorefrontAdmissionClient(socketPath) {
  if (!isAbsolute(socketPath)) throw new TypeError('商城准入套接字路径无效');
  return (code, clientIp) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ code, clientIp });
    const outgoing = request({
      socketPath, path: route, method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, async response => {
      try {
        if (response.statusCode === 404) {
          response.resume();
          return resolve(null);
        }
        if (response.statusCode !== 200) throw new Error('商城准入暂不可用');
        let text = '';
        for await (const chunk of response.setEncoding('utf8')) {
          text += chunk;
          if (text.length > 1024) throw new Error('商城准入响应无效');
        }
        const result = JSON.parse(text);
        if (!validResult(result)) throw new Error('商城准入响应无效');
        resolve(result);
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function clearStaleSocket(path) {
  const before = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!before) return;
  if (!before.isSocket() || before.uid !== process.getuid()) throw new Error('商城准入套接字不安全');
  const live = await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () => socket.destroy(new Error('商城准入套接字核对超时')));
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
  if (live) throw new Error('商城准入套接字正在使用');
  const current = await lstat(path);
  if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('商城准入套接字已变化');
  await unlink(path);
}

export async function listenStorefrontAdmission(directory, lookup) {
  if (!isAbsolute(directory) || typeof lookup !== 'function') throw new TypeError('商城准入监听配置无效');
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const state = await lstat(directory);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700 ||
      await realpath(directory) !== directory) throw new Error('商城准入目录须为服务账号持有的私有目录');
  const path = join(directory, storefrontAdmissionSocketName);
  await clearStaleSocket(path);
  const server = createServer({ requestTimeout: 9000, headersTimeout: 2000 }, async (incoming, response) => {
    const send = (status, value) => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (incoming.url !== route || incoming.method !== 'POST' || incoming.headers.origin || incoming.headers.cookie)
      return send(404, {});
    try {
      let raw = '';
      for await (const chunk of incoming.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
        raw += chunk;
        if (raw.length > 512) {
          incoming.resume();
          return send(400, {});
        }
      }
      const body = JSON.parse(raw);
      const code = storefrontRechargeCode(body?.code);
      if (!code || !isIP(body?.clientIp ?? '')) return send(404, {});
      const result = await lookup(code, body.clientIp);
      if (result === null) return send(404, {});
      if (!validResult(result)) return send(503, {});
      return send(200, { plan: result.plan, status: result.status, reason: result.reason });
    } catch {
      return send(503, {});
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o600);
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}
