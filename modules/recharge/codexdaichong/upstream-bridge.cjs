'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const secret = process.env.ID_RECHARGE_BRIDGE_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) {
  throw new Error('线上代充服务需要配置独立的内部认证密钥');
}

const assertionHeader = 'x-id-recharge-assertion';
const maximumAssertionTtlMs = 30_000;
const base64url = /^[A-Za-z0-9_-]+$/;
const identityApi =
  /^\/api\/(?:admin\/(?:login(?:\/|$)|change-password$|change-secondary-password$|verify-secondary$|secondary(?:\/|$)|2fa(?:\/|$)|security\/(?:paths|status|2fa-mode)$)|public\/admin-paths$)/;
const identityPage = /^\/admin(?:-login(?:\.html)?|\.html)?$/;

function requestPath(request) {
  return request.originalUrl ?? request.url;
}

function actorFromRequest(request) {
  const assertion = request.headers[assertionHeader];
  if (typeof assertion !== 'string' || assertion.length > 4096) return null;
  const [payload, signature, extra] = assertion.split('.');
  if (extra !== undefined || !base64url.test(payload ?? '') || !base64url.test(signature ?? '')) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (
    actual.length !== expected.length ||
    actual.toString('base64url') !== signature ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Date.now();
    const actor = claims?.actor;
    if (
      claims.method !== request.method ||
      claims.path !== requestPath(request) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now ||
      claims.exp > now + maximumAssertionTtlMs ||
      typeof actor?.id !== 'string' ||
      !actor.id.trim() ||
      actor.id.length > 256 ||
      typeof actor.email !== 'string' ||
      actor.email.length > 320 ||
      typeof actor.admin !== 'boolean' ||
      typeof actor.sensitive !== 'boolean' ||
      (actor.sensitive && !actor.admin)
    ) {
      return null;
    }
    return Object.freeze({
      id: actor.id,
      email: actor.email,
      admin: actor.admin,
      sensitive: actor.sensitive
    });
  } catch {
    return null;
  }
}

function requireGateway(request, response, next) {
  const actor = actorFromRequest(request);
  if (!actor) return response.status(401).json({ success: false, message: '统一登录已失效' });

  let pathname;
  try {
    pathname = decodeURIComponent(request.path).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return response.status(400).json({ success: false, message: '请求地址无效' });
  }
  if (identityApi.test(pathname) || identityPage.test(pathname)) {
    return response.status(404).json({ success: false, message: '此入口由统一账号系统管理' });
  }
  if (
    (pathname === '/api/admin' ||
      pathname.startsWith('/api/admin/') ||
      pathname.startsWith('/api/external/')) &&
    !actor.admin
  ) {
    return response.status(403).json({ success: false, message: '需要线上代充管理权限' });
  }
  Object.defineProperty(request, 'idRechargeActor', { value: actor });
  return next();
}

function authenticateAdmin(request, response, next) {
  const actor = request.idRechargeActor;
  if (!actor?.admin) {
    return response.status(403).json({ success: false, message: '需要线上代充管理权限' });
  }
  request.admin = actor;
  return next();
}

function requireSensitive(request, response, next) {
  if (!request.idRechargeActor?.admin || !request.idRechargeActor.sensitive) {
    return response.status(403).json({ success: false, message: '需要线上代充敏感操作权限' });
  }
  return next();
}

function verifyWebSocket({ req }) {
  return req.method === 'GET' && req.url === '/' && Boolean(actorFromRequest(req));
}

function requireDedicatedRuntime() {
  const env = process.env;
  const isPort = (port) => /^\d+$/.test(port || '') && Number(port) > 0 && Number(port) <= 65535;
  if (
    !env.DB_HOST?.trim() ||
    !isPort(env.DB_PORT) ||
    !isPort(env.PORT) ||
    !/^id_redesign_codexdaichong(?:_[a-z0-9]+)*$/.test(env.DB_NAME || '') ||
    !env.DB_USER?.trim() ||
    env.DB_USER.toLowerCase() === 'root' ||
    !env.DB_PASSWORD
  ) {
    throw new Error('线上代充需要明确配置独立新版专用数据库及运行端口');
  }
  if ((env.DB_NAME === 'id_redesign_codexdaichong_prod' || env.ID_RECHARGE_RUNTIME_MODE === 'production') &&
      (env.DB_NAME !== 'id_redesign_codexdaichong_prod' || env.ID_RECHARGE_RUNTIME_MODE !== 'production' ||
       globalThis[Symbol.for('id-business.recharge.production-lock')] !== true)) {
    throw new Error('正式代充需要由持有独立数据库运行锁的启动入口运行');
  }
}

module.exports = {
  requireGateway,
  authenticateAdmin,
  requireSensitive,
  verifyWebSocket,
  requireDedicatedRuntime
};
