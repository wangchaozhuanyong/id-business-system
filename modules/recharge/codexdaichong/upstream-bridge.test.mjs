import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const secret = randomBytes(48).toString('base64url');
const source = await readFile(new URL('./upstream-bridge.cjs', import.meta.url), 'utf8');
const customer = { id: 'u1', email: 'u1@example.test', admin: false, sensitive: false };
const admin = { ...customer, admin: true };

function loadBridge(value = secret) {
  const module = { exports: {} };
  runInNewContext(source, {
    require: createRequire(import.meta.url),
    process: { env: { ID_RECHARGE_BRIDGE_SECRET: value } },
    module,
    Buffer
  });
  return module.exports;
}

function signedRequest(method, path, actor, overrides = {}) {
  const claims = { method, path, exp: Date.now() + 10_000, actor, ...overrides };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    method,
    path: path.split('?')[0],
    originalUrl: path,
    headers: { 'x-id-recharge-assertion': payload + '.' + signature }
  };
}

function statusAfter(middleware, request) {
  const response = { statusCode: 200 };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = () => response;
  middleware(request, response, () => {});
  return response.statusCode;
}

test('sidecar requires a strong internal secret and rejects unsigned and mismatched HTTP requests', () => {
  assert.throws(() => loadBridge(''), /内部认证密钥/);
  const { requireGateway } = loadBridge();
  assert.equal(statusAfter(requireGateway, { headers: {} }), 401);
  const path = '/api/cdk/query?cdk=fixture';
  const request = signedRequest('GET', path, customer);
  assert.equal(statusAfter(requireGateway, request), 200);
  assert.equal(request.idRechargeActor.id, customer.id);
  assert.equal(statusAfter(requireGateway, { ...request, originalUrl: '/api/cdk/query?cdk=other' }), 401);
  assert.equal(statusAfter(requireGateway, { ...request, method: 'POST' }), 401);
  assert.equal(statusAfter(requireGateway, signedRequest('GET', path, customer, { exp: Date.now() - 1 })), 401);
  assert.equal(statusAfter(requireGateway, signedRequest('GET', path, customer, { exp: Date.now() + 120_000 })), 401);
});

test('sidecar rejects separate accounts and requires the unified administrator and sensitive permission', () => {
  const { requireGateway, authenticateAdmin, requireSensitive } = loadBridge();
  assert.equal(statusAfter(requireGateway, signedRequest('POST', '/API/ADMIN/LOGIN/', admin)), 404);
  assert.equal(statusAfter(requireGateway, signedRequest('POST', '/api/admin/2fa/setup', admin)), 404);
  assert.equal(statusAfter(requireGateway, signedRequest('GET', '/api/public/admin-paths', admin)), 404);
  assert.equal(statusAfter(requireGateway, signedRequest('GET', '/api/admin/cards', customer)), 403);
  const request = signedRequest('GET', '/api/admin/cards', admin);
  assert.equal(statusAfter(requireGateway, request), 200);
  assert.equal(statusAfter(authenticateAdmin, request), 200);
  assert.equal(statusAfter(requireSensitive, request), 403);
  const elevated = signedRequest('GET', '/api/admin/cards', { ...admin, sensitive: true });
  assert.equal(statusAfter(requireGateway, elevated), 200);
  assert.equal(statusAfter(requireSensitive, elevated), 200);
});

test('sidecar rejects unsigned socket upgrades and accepts only the signed original socket path', () => {
  const { verifyWebSocket } = loadBridge();
  assert.equal(verifyWebSocket({ req: { method: 'GET', url: '/', headers: {} } }), false);
  const { headers } = signedRequest('GET', '/', customer);
  assert.equal(verifyWebSocket({ req: { method: 'GET', url: '/', headers } }), true);
  assert.equal(verifyWebSocket({ req: { method: 'GET', url: '/other', headers } }), false);
});
