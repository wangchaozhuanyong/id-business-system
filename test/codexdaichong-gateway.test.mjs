import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';
import { createCodexdaichongGateway } from '../modules/recharge/codexdaichong/gateway.mjs';

const prefix = '/integrations/codexdaichong';
const member = { id: 'u-1', email: 'member@example.test', admin: false, sensitive: false };
const admin = { ...member, id: 'u-2', admin: true, sensitive: true };

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('gateway accepts the unified session only and preserves upstream JSON and CAPTCHA semantics', async (t) => {
  const secret = randomBytes(48).toString('base64url');
  const upstreamRequests = [];
  const engine = await listen(t, async (req, res) => {
    const [payload, signature] = req.headers['x-id-recharge-assertion'].split('.');
    assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
    const claim = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claim.path, req.url);
    assert.equal(claim.method, req.method);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      claim,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString()
    });
    if (req.url === '/api/task-captcha/fixture') {
      res
        .writeHead(302, {
          Location: 'https://validation.example.test/challenge',
          'Set-Cookie': 'upstream=fixture'
        })
        .end();
    } else {
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=fixture' })
        .end(
          JSON.stringify(
            req.url === '/api/public/runtime'
              ? { success: true, runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 } }
              : { success: true }
          )
        );
    }
  });
  let gateway;
  const origin = await listen(t, (req, res) => gateway.handle(req, res));
  gateway = createCodexdaichongGateway({
    upstreamUrl: engine,
    publicOrigin: origin,
    secret,
    getUnifiedPrincipal: (req) => ({ 'id=member': member, 'id=admin': admin })[req.headers.cookie]
  });
  const makeRequest = (path, init) => fetch(origin + prefix + path, init);
  const memberHeaders = { Cookie: 'id=member', Authorization: 'Bearer forged' };
  const adminHeaders = { Cookie: 'id=admin', Origin: origin };

  assert.equal((await makeRequest('/status')).status, 401);
  assert.deepEqual(await (await makeRequest('/status', { headers: memberHeaders })).json(), {
    ready: true,
    admin: false
  });
  assert.equal(
    (await makeRequest('/admin?view=dashboard', { headers: memberHeaders })).status,
    403
  );
  assert.equal((await makeRequest('/api/admin/cards', { headers: memberHeaders })).status, 403);
  assert.equal(
    (await makeRequest('/api/admin/change-password/', { headers: adminHeaders, method: 'POST' }))
      .status,
    404
  );
  assert.equal(
    (await makeRequest('/api/admin/login', { headers: adminHeaders, method: 'POST' })).status,
    404
  );
  assert.equal(
    (await makeRequest('/api/external/cards/push', { headers: adminHeaders, method: 'POST' }))
      .status,
    404
  );
  assert.equal(
    (await makeRequest('/api/cdk/query-batch', { headers: memberHeaders, method: 'POST' })).status,
    403
  );
  const success = await makeRequest('/api/cdk/query-batch', {
    method: 'POST',
    headers: {
      ...memberHeaders,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-ID-Recharge-Assertion': 'forged'
    },
    body: '{"cdks":["fixture"]}'
  });
  assert.deepEqual(await success.json(), { success: true });
  assert.equal(success.headers.get('set-cookie'), null);
  assert.deepEqual(upstreamRequests.at(-1).claim.actor, member);
  assert.equal(upstreamRequests.at(-1).cookie, undefined);
  assert.equal(upstreamRequests.at(-1).authorization, undefined);
  assert.equal(upstreamRequests.at(-1).body, '{"cdks":["fixture"]}');
  assert.equal((await makeRequest('/api/admin/cards', { headers: adminHeaders })).status, 200);
  assert.deepEqual(upstreamRequests.at(-1).claim.actor, admin);

  const captcha = await makeRequest('/api/task-captcha/fixture', {
    headers: memberHeaders,
    redirect: 'manual'
  });
  assert.equal(captcha.status, 302);
  assert.equal(captcha.headers.get('location'), 'https://validation.example.test/challenge');
  assert.equal(captcha.headers.get('set-cookie'), null);
});

test('upstream pages retain the signed-in operations without their own login or external runtime assets', async () => {
  const assets = await loadCodexdaichongAssets();
  assert.equal(assets.has('/admin-login.html'), false);
  for (const path of ['/redeem', '/subscription', '/admin']) {
    const page = assets.get(path);
    assert.match(page.csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(page.body, /(?:src|href)="https:\/\/(?:unpkg|fonts\.)/);
    for (const [, script] of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Script(script));
    }
  }
  assert.match(assets.get('/redeem').body, /\/integrations\/codexdaichong\/api\/run-process/);
  assert.match(assets.get('/redeem').body, /\/integrations\/codexdaichong\/socket/);
  assert.doesNotMatch(assets.get('/admin').body, /修改后台密码|绑定 Google Authenticator/);
  assert.match(assets.get('/admin').body, /Session 管理|CDK 管理/);
  const script = assets.get('/admin.js').body;
  assert.doesNotMatch(script, /plus_admin_token|localStorage\./);
  assert.doesNotThrow(() => new Script(script));
});
