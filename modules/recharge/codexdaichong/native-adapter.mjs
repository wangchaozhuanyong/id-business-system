import { createServer, request as httpRequest } from 'node:http';
import { verifyRechargeAssertion } from '../assertion.mjs';
import { validateRuntimeOrigin } from './runtime-health.mjs';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const publicPaths = [
  /^\/api\/public\/(payment-region|runtime|subscription\/check)$/,
  /^\/api\/(verify-cdk|run-process)$/,
  /^\/api\/cdk\/(query|query-batch|download)$/,
  /^\/api\/task-(status|captcha)\/[^/]+$/
];
// Match the original sensitive operations; product browsing keeps its existing staff permission.
const sensitivePaths = /^\/api\/admin\/(?:sessions|cards|cdks)(?:\/|$)|^\/api\/admin\/orbitcard\/(?:usage|sync|cards\/[^/]+\/(?:restore|plan))(?:\/|$)/;
const identityPaths = /^\/api\/(?:admin\/(?:login|2fa|security|secondary|verify-secondary|change-password|change-secondary-password)(?:\/|$)|public\/admin-paths$)/;
const requestHeaders = ['accept', 'content-type', 'content-length', 'user-agent', 'range', 'x-real-ip'];
const responseHeaders = ['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'retry-after'];
const pick = (headers, names) => Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));

function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ success: false, message }));
}

function checkedPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') ||
      /[\\\x00-\x20#]/.test(raw) || /%(?:00|25|2e|2f|5c)/i.test(raw.split('?')[0])) return null;
  const url = new URL(raw, 'http://127.0.0.1');
  if (url.pathname.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw.split('?')[0]) ||
      [...url.searchParams.keys()].some((key) => key.toLowerCase() === 'token')) return null;
  return url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
}

/** Use the pinned module's own signing function; the native token never leaves the server. */
export function createNativeAdminTokenIssuer({ issueSignedToken, readPasswordVersion, secret }) {
  if (typeof issueSignedToken !== 'function' || typeof readPasswordVersion !== 'function' ||
      typeof secret !== 'string' || secret.trim().length < 32)
    throw new TypeError('原版管理接口需要已有的独立签名配置');
  return async (actor) => {
    if (!actor?.admin) throw new Error('没有充值管理权限');
    const version = await readPasswordVersion();
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('无法核对原版管理版本');
    return issueSignedToken({ sub: 'admin', permissions: ['admin'], pv: version, email: actor.email },
      15_000, secret.trim()).token;
  };
}

/** Separate transport only. Never patches, imports or wraps the native payment implementation. */
export function createNativeRechargeAdapter({ nativeUrl, secret, getNativeAdminToken }) {
  const native = new URL(validateRuntimeOrigin(nativeUrl));
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || typeof getNativeAdminToken !== 'function')
    throw new TypeError('原版外围接入需要服务签名和原生鉴权');
  function principal(req) {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.cookie || req.headers.origin) return null;
    return verifyRechargeAssertion(secret, req.method, req.url, req.headers['x-id-recharge-assertion']);
  }
  async function handle(req, res) {
    const actor = principal(req);
    if (!actor) return reply(res, 401, '服务认证无效');
    const path = checkedPath(req.url);
    if (!path || !methods.has(req.method) || identityPaths.test(path)) return reply(res, 404, '接口不存在');
    const admin = path.startsWith('/api/admin/');
    const external = path === '/api/external/cards/push';
    if (!admin && !external && !publicPaths.some((pattern) => pattern.test(path)))
      return reply(res, 404, '接口不存在');
    if ((admin || external) && !actor.admin) return reply(res, 403, '没有充值管理权限');
    if (sensitivePaths.test(path) && !actor.sensitive) return reply(res, 403, '没有敏感资料权限');
    if (path === '/api/admin/session') {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, '不支持此操作');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ success: true, refreshed: false,
        token: null, expiresAt: null, issuedAt: null, permissions: ['admin'], email: actor.email }));
    }
    const headers = pick(req.headers, requestHeaders);
    if (actor.clientIp) headers['x-real-ip'] = actor.clientIp;
    if (admin) headers.authorization = 'Bearer ' + await getNativeAdminToken(actor);
    if (external && req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
    const upstream = httpRequest({ hostname: native.hostname, port: native.port, method: req.method,
      path: req.url, headers }, (response) => {
      const permittedRedirect = path.startsWith('/api/task-captcha/') && response.statusCode === 302;
      const location = permittedRedirect && URL.parse(response.headers.location || '');
      if (response.statusCode >= 300 && response.statusCode < 400 &&
          (!location || location.protocol !== 'https:' || location.username || location.password)) {
        response.resume();
        return reply(res, 502, '原版服务返回无效跳转');
      }
      res.writeHead(response.statusCode, { ...pick(response.headers, responseHeaders),
        ...(location ? { Location: location.href, 'Referrer-Policy': 'no-referrer' } : {}),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(180_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) reply(res, 502, '充值服务暂不可用');
      else res.destroy();
    });
    // A transport disconnect does not cancel or resubmit a native recharge task.
    req.on('aborted', () => upstream.destroy());
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }
  function upgrade(req, socket, head) {
    const actor = principal(req);
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if (!actor?.admin || req.method !== 'GET' || req.url !== '/') return reject();
    const upstream = httpRequest({ hostname: native.hostname, port: native.port, method: 'GET', path: '/',
      headers: { ...pick(req.headers, ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']),
        connection: 'Upgrade', upgrade: 'websocket' } });
    let connected = false;
    upstream.once('upgrade', (response, remote, remoteHead) => {
      connected = true;
      if (!response.headers['sec-websocket-accept'] || socket.destroyed) { remote.destroy(); return reject(); }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        response.headers['sec-websocket-accept'] + '\r\n\r\n');
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      remote.once('close', () => socket.destroy());
      socket.once('close', () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.once('response', (response) => { response.resume(); reject(); });
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.once('error', reject);
    socket.once('close', () => { if (!connected) upstream.destroy(); });
    upstream.end();
  }
  return { handle: (req, res) => handle(req, res).catch(() => {
    if (!res.headersSent) reply(res, 503, '充值服务暂不可用');
    else res.destroy();
  }), upgrade };
}

export async function startNativeRechargeAdapter(options, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('外围接入端口无效');
  if (new URL(validateRuntimeOrigin(options.nativeUrl)).port === String(port))
    throw new TypeError('外围接入与原版服务必须使用不同端口');
  const adapter = createNativeRechargeAdapter(options);
  const server = createServer(adapter.handle);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', adapter.upgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let closing;
  return {
    server,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        // closeAllConnections deliberately excludes upgraded sockets.
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    }
  };
}
