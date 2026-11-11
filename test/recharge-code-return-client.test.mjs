import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createOrderRechargeClient } from '../server/order-recharge-client.mjs';
import { verifyRechargeAssertion } from '../modules/recharge/assertion.mjs';
test('归还客户端只允许三个专用接口，签名身份固定为受管服务且不外传令牌', async () => {
  const secret = randomBytes(32).toString('hex'), calls = [];
  const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:44575', secret }, async (url, options) => {
    const actor = verifyRechargeAssertion(secret, options.method, url.pathname, options.headers['x-id-recharge-assertion']);
    assert.equal(actor.id, 'order-reconciliation'); assert(actor.admin && actor.sensitive);
    assert.equal(options.redirect, 'error'); calls.push(url.pathname);
    return new Response(JSON.stringify({ success: true, items: [], receipt: { state: 'not-found' } }), { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await client.checkReturns([{ code: 'synthetic', plan: 'plus' }]), []);
  assert.deepEqual(await client.commitReturn({ operationId: 'synthetic' }), { state: 'not-found' });
  assert.deepEqual(await client.returnReceipt({ operationId: 'synthetic' }), { state: 'not-found' });
  assert.deepEqual(calls, ['/api/admin/cdks/returns/check', '/api/admin/cdks/returns/commit', '/api/admin/cdks/returns/receipt']);
  await assert.rejects(client.get('/api/admin/cdks/returns/commit'), /不支持/);
});
