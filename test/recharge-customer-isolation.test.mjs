import assert from 'node:assert/strict';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { signRechargeAssertion } from '../modules/recharge/assertion.mjs';
import { createNativeRechargeAdapter } from '../modules/recharge/codexdaichong/native-adapter.mjs';

test('customer route restrictions reject private cards, credentials, diagnostics and media before native transport', async t => {
  let nativeRequests = 0;
  let tokenRequests = 0;
  const transport = t.mock.method(http, 'request', () => {
    nativeRequests++;
    throw new Error('synthetic-private-native-diagnostic');
  });
  syncBuiltinESMExports();
  t.after(() => { transport.mock.restore(); syncBuiltinESMExports(); });
  const secret = 'synthetic-bridge-secret-for-offline-test-only';
  const customer = { id: 'synthetic-customer', email: 'customer@example.test', admin: false, sensitive: false };
  const adapter = createNativeRechargeAdapter({ nativeUrl: 'http://127.0.0.1:31993', secret,
    async getNativeAdminToken() { tokenRequests++; throw new Error('synthetic-private-token'); }
  });
  async function request(path, actor = customer, extraHeaders = {}) {
    const result = {};
    await adapter.handle({
      url: path, method: 'GET', socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', path, actor), ...extraHeaders }
    }, {
      headersSent: false,
      writeHead(status) { this.headersSent = true; result.status = status; },
      end(raw) { result.body = JSON.parse(raw); }
    });
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
    return result;
  }
  for (const path of ['/api/admin/cards', '/API/ADMIN/CARDS/', '/api/admin/sessions', '/api/admin/cdks',
    '/api/admin/task-logs/original-job', '/api/admin/proxies', '/api/admin/addresses',
    '/api/admin/checkout/generate', '/api/admin/orbitcard/usage',
    '/api/admin/screenshots?path=checkout_debug%2Ffixture.png', '/api/admin/video?path=fixture.webm'])
    assert.equal((await request(path)).status, 403);
  for (const path of ['/debug_screenshots/fixture.png', '/media/fixture.webm', '/admin.js',
    '/api/admin/cards%2F1', '/api/admin/cards?token=synthetic'])
    assert.equal((await request(path)).status, 404);
  const administrator = { ...customer, admin: true };
  for (const path of ['/api/admin/cards', '/api/admin/sessions', '/api/admin/cdks', '/api/admin/orbitcard/usage'])
    assert.equal((await request(path, administrator)).status, 403);
  assert.equal((await request('/api/admin/cards', customer, { cookie: 'synthetic=private' })).status, 401);
  assert.equal((await request('/api/admin/cards', customer, { origin: 'https://example.test' })).status, 401);
  let upgradeReply;
  adapter.upgrade({ method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {
    'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', '/', customer)
  } }, { end(value) { upgradeReply = value; } }, Buffer.alloc(0));
  assert.match(upgradeReply, /^HTTP\/1\.1 403/);
  assert.equal(nativeRequests, 0);
  assert.equal(tokenRequests, 0);
});
