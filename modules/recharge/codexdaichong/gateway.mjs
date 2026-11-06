import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { signRechargeAssertion } from '../assertion.mjs';
import { loadCodexdaichongAssets } from './assets.mjs';
import { probeCodexdaichongRuntime } from './runtime-health.mjs';

export const CODEXDAICHONG_PREFIX = '/integrations/codexdaichong';
const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const readMethods = new Set(['GET', 'HEAD']);
const externalCardPush = '/api/external/cards/push';
const publicRoutes = [
  /^\/api\/public\/(payment-region|runtime|subscription\/check)$/,
  /^\/api\/(verify-cdk|run-process)$/,
  /^\/api\/cdk\/(query|query-batch|download)$/,
  /^\/api\/task-(status|captcha)\/[^/]+$/
];
const separateIdentity =
  /^\/api\/admin\/(?:login(?:\/|$)|2fa(?:\/|$)|security(?:\/|$)|secondary(?:\/|$)|verify-secondary$|change-(?:secondary-)?password$)/i;
const requestHeaders = ['accept', 'content-type', 'content-length', 'user-agent', 'range'];
const responseHeaders = [
  'content-type',
  'content-disposition',
  'content-length',
  'content-range',
  'accept-ranges',
  'retry-after'
];

function respond(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({ ready: false, success: false, message }));
}

function classify(path) {
  if (!path.startsWith('/api/')) return 'asset';
  if (separateIdentity.test(path.replace(/\/+$/, ''))) return 'blocked';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (path === externalCardPush) return 'external-card-push';
  if (publicRoutes.some((pattern) => pattern.test(path))) return 'public';
  return 'blocked';
}

function parsePath(url = '') {
  const raw = url.slice(CODEXDAICHONG_PREFIX.length);
  const pathname = raw.split('?', 1)[0];
  // Express decodes individual parameters. Reject separators and dot segments before policy matching.
  if (
    !pathname.startsWith('/') ||
    /%(?:00|25|2e|2f|5c)/i.test(pathname) ||
    pathname.includes('//') ||
    pathname.includes('\\') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)
  )
    return null;
  return { raw, pathname };
}

function safePrincipal(principal) {
  if (
    !principal ||
    typeof principal.id !== 'string' ||
    principal.id.length < 1 ||
    principal.id.length > 128 ||
    typeof principal.email !== 'string' ||
    principal.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/.test(principal.email)
  )
    return null;
  if (!principal.id.trim()) return null;
  return {
    id: principal.id,
    email: principal.email,
    admin: principal.admin === true,
    sensitive: principal.admin === true && principal.sensitive === true
  };
}

function filterHeaders(source, names) {
  return Object.fromEntries(
    names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]]))
  );
}

/**
 * The independent host supplies the verified session and permission mapping.
 * This factory does not authenticate users, start the upstream, or open a database.
 */
export function createCodexdaichongGateway({
  upstreamUrl,
  secret,
  getUnifiedPrincipal,
  getExternalCardPrincipal,
  publicOrigin,
  assets = loadCodexdaichongAssets
}) {
  const upstream = new URL(upstreamUrl);
  const origin = new URL(publicOrigin);
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    !upstream.port ||
    upstream.pathname !== '/' ||
    upstream.search ||
    upstream.hash ||
    upstream.username ||
    upstream.password ||
    !['https:', 'http:'].includes(origin.protocol) ||
    typeof secret !== 'string' ||
    Buffer.byteLength(secret) < 32 ||
    typeof getUnifiedPrincipal !== 'function'
  )
    throw new TypeError('充值模块需要独立回环服务、桥接密钥和统一会话验证');

  let assetsPromise;
  const target = (req, method, path, actor, extraHeaders = {}) => {
    const clientIp = req.socket.remoteAddress;
    return {
      hostname: upstream.hostname,
      port: upstream.port,
      method,
      path,
      headers: {
        ...filterHeaders(req.headers, requestHeaders),
        ...extraHeaders,
        ...(isIP(clientIp) ? { 'x-real-ip': clientIp } : {}),
        'x-id-recharge-assertion': signRechargeAssertion(secret, method, path, actor)
      }
    };
  };

  function canMutate(req) {
    return req.headers.origin === origin.origin && req.headers['sec-fetch-site'] !== 'cross-site';
  }

  async function handle(req, res) {
    const path = parsePath(req.url);
    if (!path || !allowedMethods.has(req.method)) return respond(res, 404, '页面不存在');
    const scope = classify(path.pathname);
    if (scope === 'blocked') return respond(res, 404, '页面不存在');
    const external = scope === 'external-card-push';
    if (external && (typeof getExternalCardPrincipal !== 'function' || req.method !== 'POST')) {
      return respond(res, 404, '页面不存在');
    }
    // Machine access requires the host service identity and the original upstream API key.
    if (external && (req.headers.origin || req.headers.cookie)) {
      return respond(res, 403, '此入口用于服务间调用');
    }
    const resolvePrincipal = external ? getExternalCardPrincipal : getUnifiedPrincipal;
    const actor = safePrincipal(await resolvePrincipal(req));
    if (!actor) return respond(res, 401, '请通过统一账号登录');
    if ((scope === 'admin' || external || path.pathname === '/admin') && !actor.admin) {
      return respond(res, 403, '当前账号没有充值管理权限');
    }
    if (!external && !readMethods.has(req.method) && !canMutate(req))
      return respond(res, 403, '请求来源未通过校验');
    if (path.pathname === '/status' && readMethods.has(req.method)) {
      const result = await probeCodexdaichongRuntime({
        upstreamUrl: upstream.origin,
        secret,
        actor,
        clientIp: req.socket.remoteAddress
      });
      if (!result.ready) return respond(res, 503, 'ChatGPT 充值服务未就绪');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(
        req.method === 'HEAD' ? undefined : JSON.stringify({ ready: true, admin: actor.admin })
      );
    }
    if (scope === 'asset') {
      if (!readMethods.has(req.method)) return respond(res, 404, '页面不存在');
      assetsPromise ??= Promise.resolve()
        .then(assets)
        .catch((error) => {
          assetsPromise = undefined;
          throw error;
        });
      const asset = (await assetsPromise).get(path.pathname);
      if (!asset) return respond(res, 404, '页面不存在');
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'no-referrer',
        ...(asset.csp ? { 'Content-Security-Policy': asset.csp } : {})
      });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    const extraHeaders = external ? filterHeaders(req.headers, ['x-api-key']) : {};
    const upstreamRequest = httpRequest(
      target(req, req.method, path.raw, actor, extraHeaders),
      (reply) => {
        if (reply.statusCode >= 300 && reply.statusCode < 400) {
          reply.resume();
          const location = URL.parse(reply.headers.location || '');
          if (
            reply.statusCode === 302 &&
            req.method === 'GET' &&
            path.pathname.startsWith('/api/task-captcha/') &&
            location?.protocol === 'https:' &&
            !location.username &&
            !location.password
          ) {
            return res
              .writeHead(302, {
                Location: location.href,
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer'
              })
              .end();
          }
          respond(res, 502, '充值服务返回了无效跳转');
          return;
        }
        res.writeHead(reply.statusCode, {
          ...filterHeaders(reply.headers, responseHeaders),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        reply.on('error', () => res.destroy());
        reply.pipe(res);
      }
    );
    upstreamRequest.setTimeout(180_000, () => upstreamRequest.destroy());
    upstreamRequest.on('error', () => {
      if (!res.headersSent) respond(res, 502, '无法连接 ChatGPT 充值服务');
      else res.destroy();
    });
    res.once('close', () => {
      if (!res.writableFinished) upstreamRequest.destroy();
    });
    req.pipe(upstreamRequest);
  }

  async function upgrade(req, socket, head) {
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if (parsePath(req.url)?.raw !== '/socket' || !canMutate(req)) return reject();
    const actor = safePrincipal(await getUnifiedPrincipal(req));
    if (!actor || socket.destroyed) return reject();
    const proxy = httpRequest(
      target(req, 'GET', '/', actor, {
        ...filterHeaders(req.headers, [
          'sec-websocket-key',
          'sec-websocket-version',
          'sec-websocket-protocol'
        ]),
        upgrade: 'websocket',
        connection: 'Upgrade'
      })
    );
    let upgraded = false;
    proxy.once('upgrade', (res, engineSocket, engineHead) => {
      upgraded = true;
      const accept = res.headers['sec-websocket-accept'];
      if (!accept || socket.destroyed) {
        engineSocket.destroy();
        return reject();
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n'
      );
      async function sessionIsCurrent() {
        try {
          const current = safePrincipal(await getUnifiedPrincipal(req));
          return (
            current?.id === actor.id &&
            current.admin === actor.admin &&
            current.sensitive === actor.sensitive
          );
        } catch {
          return false;
        }
      }
      // Revalidate before forwarding task traffic, even between idle checks.
      function guardedPipe(source, destination, initial) {
        const guard = new Transform({
          transform(chunk, _encoding, done) {
            sessionIsCurrent().then((valid) => {
              if (valid && !source.destroyed && !destination.destroyed) return done(null, chunk);
              source.destroy();
              destination.destroy();
              done();
            });
          }
        });
        source.once('close', () => guard.destroy());
        destination.once('close', () => guard.destroy());
        if (initial.length) guard.write(initial);
        source.pipe(guard).pipe(destination);
      }
      socket.on('error', () => engineSocket.destroy());
      engineSocket.on('error', () => socket.destroy());
      socket.once('close', () => engineSocket.destroy());
      engineSocket.once('close', () => socket.destroy());
      let checkingSession = false;
      const sessionCheck = setInterval(async () => {
        if (checkingSession || socket.destroyed) return;
        checkingSession = true;
        if (!(await sessionIsCurrent())) socket.destroy();
        checkingSession = false;
      }, 15_000);
      sessionCheck.unref();
      socket.once('close', () => clearInterval(sessionCheck));
      guardedPipe(socket, engineSocket, head);
      guardedPipe(engineSocket, socket, engineHead);
    });
    proxy.once('response', (res) => {
      res.resume();
      reject();
    });
    proxy.setTimeout(5000, () => proxy.destroy());
    proxy.once('error', reject);
    socket.once('close', () => {
      if (!upgraded) proxy.destroy();
    });
    proxy.end();
  }

  return {
    handle: (req, res) =>
      handle(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else respond(res, 503, 'ChatGPT 充值模块暂不可用');
      }),
    upgrade: (req, socket, head) => upgrade(req, socket, head).catch(() => socket.destroy())
  };
}
