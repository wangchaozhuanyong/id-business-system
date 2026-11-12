import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSnapshot, restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';
import { createLegacyToolRoutes, legacyWebsiteVisitIngest } from '../server/tools/legacy-public-routes.mjs';
import { createManagedMailboxQuery, MailboxAuthorizationError } from '../server/tools/mailbox-pool.mjs';
import { createMicrosoftMailbox, legacyMicrosoftMailboxCallback, microsoftMailboxPrefix } from '../server/tools/mailbox-microsoft.mjs';
import { createMediaResolver } from '../server/tools/media-resolver.mjs';
import { createWebsiteMonitor } from '../server/tools/website-monitor.mjs';
import { createWebsiteVisits, websiteVisitSignaturePayload } from '../server/tools/website-visits.mjs';

async function testDirectory(t) {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(runtime, 'online-tools-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the normal preview routes isolate saved 2FA, website analytics and signed visits, and mailbox management', async (t) => {
  const dir = await testDirectory(t);
  const authPath = join(dir, 'auth.json');
  const databasePath = join(dir, 'fixture.sqlite');
  const password = 'test-only-online-tools-password';
  await initializeLocalAdmin(authPath, { email: 'tools-admin@example.test', name: '工具测试', password });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const visitSecret = 'test-only-website-visits-signed-fixture';
  const gaMetricHeaders = ['screenPageViews', 'totalUsers', 'sessions'].map((name) => ({ name }));
  const gaMetrics = ['9', '5', '7'].map((value) => ({ value }));
  const date = new Date().toISOString().slice(0, 10);
  const rawDay = date.replaceAll('-', '');
  const rawReports = [{
    metadata: { timeZone: 'UTC' }, metricHeaders: gaMetricHeaders,
    rows: [{ metricValues: gaMetrics }], rowCount: 1
  }, {
    metadata: { timeZone: 'UTC' }, metricHeaders: gaMetricHeaders, dimensionHeaders: [{ name: 'date' }],
    rows: [{ dimensionValues: [{ value: rawDay }], metricValues: gaMetrics }], rowCount: 1
  }];
  let analyticsCalls = 0;
  let cloudflareCalls = 0;
  let mailboxCalls = 0;
  let rejectExistingMailbox = false;
  const { server, url } = await startPreview(0, {
    databasePath, authPath, websiteVisitsSecret: visitSecret,
    websiteAnalyticsConfig: {
      propertyId: '100', streamId: '200', hosts: ['example.test'],
      serviceAccount: {
        type: 'service_account', client_email: 'test@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
      }
    },
    websiteCloudflareConfig: {
      accountId: 'a'.repeat(32),
      apiToken: 'synthetic-cloudflare-analytics-token',
      sites: { 'shop.flashcast.com.my': 'b'.repeat(32) }
    },
    websiteAnalyticsFetch: async (target, options) => {
      if (target === 'https://api.cloudflare.com/client/v4/graphql') {
        cloudflareCalls++;
        const { variables } = JSON.parse(options.body);
        assert(variables.filter.AND.some(filter => filter.requestHost === 'shop.flashcast.com.my'));
        const totals = { count: 14, sum: { visits: 4 } };
        return Response.json({ data: { viewer: { accounts: [{
          total: [totals], daily: [{ dimensions: { date }, ...totals }]
        }] } } });
      }
      analyticsCalls++;
      if (target.includes('oauth2.googleapis.com')) {
        const claims = JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1], 'base64url'));
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/analytics.readonly');
        return Response.json({ access_token: 'synthetic-analytics-token', expires_in: 3600 });
      }
      assert.match(target, /properties\/100:batchRunReports$/);
      assert.match(options.body, /"value":"200"/);
      return Response.json({ reports: rawReports });
    },
    readManagedMailbox: async (mailbox) => {
      if (mailbox.limit === undefined) {
        if (mailbox.email === 'invalid@example.test' || mailbox.appPassword === 'rejected-credential') throw new Error('fixture failure');
        return [];
      }
      mailboxCalls++;
      assert.equal(mailbox.email, 'pool@example.test');
      if (rejectExistingMailbox) throw new MailboxAuthorizationError();
      return [{ subject: '<script>synthetic</script>', receivedAt: '2026-11-05T05:00:00Z', body: '验证码 472081' }];
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  const call = (path, { method = 'GET', cookie, body, headers = {} } = {}) => fetch(url + 'api/local/' + path, {
    method, headers: {
      ...(cookie && { Cookie: cookie }),
      ...(body !== undefined && { Origin: origin, 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body !== undefined && JSON.stringify(body) || undefined
  });
  const login = async (email) => {
    const response = await call('auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';', 1)[0];
  };
  const admin = await login('tools-admin@example.test');
  assert.equal((await call('auth/employees', { method: 'POST', cookie: admin,
    body: { email: 'tools-employee@example.test', name: '员工', password, role: 'employee' }
  })).status, 201);
  const employee = await login('tools-employee@example.test');

  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const saved = await call('saved-totp', { method: 'PUT', cookie: employee,
    body: { action: 'create', version: 0, name: '合成 2FA', secret } });
  assert.equal(saved.status, 200);
  const account = (await saved.json()).items[0];
  assert.ok(account.id);
  assert.equal(account.secret, undefined);
  assert.deepEqual((await (await call('saved-totp', { cookie: admin })).json()).items, []);
  assert.equal((await call('saved-totp/code', { method: 'POST', cookie: admin, body: { id: account.id } })).status, 404);
  const code = await (await call('saved-totp/code', { method: 'POST', cookie: employee, body: { id: account.id } })).json();
  assert.match(code.code, /^\d{6}$/);
  assert.ok(code.expiresAt > code.serverNow);

  const analytics = 'tools/website-analytics?days=7';
  assert.equal((await call(analytics, { cookie: employee })).status, 403);
  const report = await (await call(analytics, { cookie: admin })).json();
  assert.deepEqual(report.summary, { pageViews: 9, visitors: 5, sessions: 7 });
  assert.equal(report.timeZone, 'UTC');
  assert.equal(report.daily.length, 7);
  assert.equal((await call(analytics, { cookie: admin })).status, 200);
  assert.equal(analyticsCalls, 2);
  const storefrontAnalytics = analytics + '&site=shop.flashcast.com.my';
  assert.equal((await call(storefrontAnalytics, { cookie: employee })).status, 403);
  const storefront = await (await call(storefrontAnalytics, { cookie: admin })).json();
  assert.deepEqual(storefront.summary, { pageViews: 14, visits: 4 });
  const waiting = await (await call(analytics + '&site=moyaoai.com', { cookie: admin })).json();
  assert.equal(waiting.status, 'unconfigured');
  assert.equal(cloudflareCalls, 1);

  const event = { eventId: randomUUID(), host: 'flashcast.com.my', path: '/zh/gallery',
    ip: '203.0.113.12', occurredAt: new Date().toISOString() };
  const ingest = 'tools/website-visits/ingest';
  assert.equal((await call(ingest, { method: 'POST', body: event })).status, 401);
  const signature = createHmac('sha256', visitSecret).update(websiteVisitSignaturePayload(event)).digest('hex');
  for (let i = 0; i < 2; i++)
    assert.equal((await call(ingest, { method: 'POST', body: event,
      headers: { 'x-website-visit-signature': signature } })).status, 200);
  const filters = { days: 7, page: 1, pageSize: 20, sort: 'newest', ip: '' };
  const search = 'tools/website-visits/search';
  assert.equal((await call(search, { method: 'POST', body: filters, cookie: employee })).status, 403);
  const visits = await (await call(search, { method: 'POST', body: filters, cookie: admin })).json();
  assert.equal(visits.total, 1);
  assert.equal(visits.items[0].ipMasked, '203.0.*.*');
  assert.equal(visits.items[0].ip, undefined);
  const revealed = await call('tools/website-visits/reveal', { method: 'POST', cookie: admin,
    body: { id: event.eventId } });
  assert.deepEqual(await revealed.json(), { ip: event.ip });

  const pool = 'tools/mailbox-pool';
  const appPassword = 'synthetic-mail-app-password';
  const mailbox = { action: 'create', version: 0, provider: 'google', email: 'pool@example.test',
    validDays: 7, appPassword };
  assert.equal((await call(pool, { method: 'PUT', cookie: employee, body: mailbox })).status, 403);
  const rejected = await call(pool, { method: 'PUT', cookie: admin, body: { ...mailbox, email: 'invalid@example.test' } });
  assert.equal(rejected.status, 422);
  assert.deepEqual((await (await call(pool, { cookie: admin })).json()).items, []);
  const created = await call(pool, { method: 'PUT', cookie: admin, body: mailbox });
  assert.equal(created.status, 200);
  const snapshot = await created.json();
  assert.match(snapshot.issuedCode, /^MBX-/);
  assert.equal(snapshot.items[0].appPassword, undefined);
  const id = snapshot.items[0].id;
  assert.equal((await call(pool, { method: 'POST', cookie: employee, body: { id } })).status, 403);
  assert.deepEqual(await (await call(pool, { method: 'POST', cookie: admin, body: { id } })).json(), { code: snapshot.issuedCode });
  assert.equal((await call(pool, { method: 'PUT', cookie: admin,
    body: { action: 'credential', id, version: 1, appPassword: 'rejected-credential' } })).status, 422);
  const codeSearch = 'tools/mailbox-query';
  const queried = await call(codeSearch, { method: 'POST', body: { queryCode: snapshot.issuedCode } });
  assert.equal(queried.status, 200);
  assert.equal((await queried.json()).items[0].extractedCode, '472081');
  assert.equal(mailboxCalls, 1);
  const rotated = await (await call(pool, { method: 'PUT', cookie: admin,
    body: { action: 'rotate', version: 1, id: snapshot.items[0].id, validDays: 7 }
  })).json();
  assert.notEqual(rotated.issuedCode, snapshot.issuedCode);
  assert.equal((await call(codeSearch, { method: 'POST', body: { queryCode: snapshot.issuedCode } })).status, 404);
  assert.equal(mailboxCalls, 1);
  const settings = await (await call(pool, { method: 'PUT', cookie: admin,
    body: { action: 'settings', version: 2, validDays: 12, applyExisting: true }
  })).json();
  assert.equal(settings.defaultValidDays, 12);
  assert.equal(settings.updatedExistingCount, undefined);
  assert.equal(settings.items[0].expiresAt, rotated.items[0].expiresAt);
  assert.deepEqual(await (await call(pool, { method: 'POST', cookie: admin, body: { id } })).json(), { code: rotated.issuedCode });
  assert(settings.items[0].lastQueriedAt);
  const batch = await (await call(pool, { method: 'PUT', cookie: admin,
    body: { action: 'batch', version: 3, items: [
      { provider: 'google', email: 'pool@example.test', appPassword },
      { provider: 'apple', email: 'another@example.test', appPassword },
      { provider: 'apple', email: 'invalid@example.test', appPassword }
    ] }
  })).json();
  assert.deepEqual(batch.batch.map((row) => row.success), [false, true, false]);
  assert.match(batch.batch[1].issuedCode, /^MBX-/);
  assert.equal(batch.defaultValidDays, 12);
  rejectExistingMailbox = true;
  assert.equal((await call(codeSearch, { method: 'POST', body: { queryCode: rotated.issuedCode } })).status, 503);
  const invalid = await (await call(pool, { cookie: admin })).json();
  assert.equal(invalid.items.find((row) => row.id === id).authFailed, true);
  assert.equal((await call(codeSearch, { method: 'POST', body: { queryCode: rotated.issuedCode } })).status, 404);
  const repaired = await (await call(pool, { method: 'PUT', cookie: admin,
    body: { action: 'credential', id, version: invalid.version, appPassword } })).json();
  assert.equal(repaired.items.find((row) => row.id === id).authFailed, false);
  const audit = await (await call('audit', { cookie: admin })).text();
  const bytes = await readFile(databasePath);
  for (const raw of [appPassword, secret, snapshot.issuedCode, event.ip, code.code]) {
    assert.ok(!audit.includes(raw));
    assert.ok(!bytes.includes(Buffer.from(raw)));
  }
  const snapshotDir = join(dir, 'snapshot');
  const restored = join(dir, 'restored');
  await createSnapshot({ source: databasePath, output: snapshotDir });
  const recovery = await restoreSnapshot({ input: snapshotDir, key: databasePath + '.key', output: restored });
  assert.equal(recovery.documents, 3);
  const recoveredStore = createLocalBusinessStore(join(restored, 'local-business.sqlite'));
  try {
    assert.equal(recoveredStore.loadManagedMailboxPool().items.length, 2);
    assert.equal(recoveredStore.searchWebsiteVisits(filters, Date.now()).total, 1);
  } finally {
    recoveredStore.close();
  }
});

test('Microsoft callback uses PKCE and stores a verified mailbox only for the initiating administrator', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  let oauth;
  const owner = { id: 'fixture-owner', role: 'admin', name: '测试' };
  const server = createServer((req, res) => {
    const op = req.url.split('?')[0].slice(microsoftMailboxPrefix.length);
    void oauth.handle(req, res, op, req.headers['x-test-owner'] === 'yes' ? owner : { ...owner, id: 'other' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const prefix = origin + microsoftMailboxPrefix;
  let verifier;
  oauth = createMicrosoftMailbox({ store, config: {
    clientId: randomUUID(), clientSecret: 'synthetic-client-secret', redirectUri: prefix + 'callback'
  }, fetchImpl: async (target, options) => {
    assert.match(target, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/);
    verifier = options.body.get('code_verifier');
    return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token' });
  }, readImap: async (input) => {
    assert.equal(input.email, 'microsoft@example.test');
    assert.equal(input.accessToken, 'synthetic-access-token');
    return [];
  } });
  const post = (op, body, same = true) => fetch(prefix + op, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'x-test-owner': same ? 'yes' : 'no' },
    body: JSON.stringify(body)
  });
  const start = await post('start', { email: 'microsoft@example.test', version: 0, validDays: 7 });
  assert.equal(start.status, 200);
  const { authorizationId, authorizationUrl } = await start.json();
  assert.equal(new URL(authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await post('finish', { authorizationId })).status, 202);
  assert.equal((await fetch(prefix + 'callback?state=' + authorizationId + '&code=synthetic-code')).status, 200);
  assert.match(verifier, /^[\w-]{43}$/);
  assert.equal((await post('finish', { authorizationId }, false)).status, 404);
  const finish = await post('finish', { authorizationId });
  assert.equal(finish.status, 200);
  const saved = await finish.json();
  assert.equal(saved.items[0].provider, 'microsoft');
  assert.equal(saved.items[0].refreshToken, undefined);
  assert.equal((await post('finish', { authorizationId })).status, 404);
});

test('HTTPS tools require the configured host and keep the deployed Microsoft callback path', async (t) => {
  const publicOrigin = 'https://admin.example.test';
  const host = 'admin.example.test';
  const actor = { id: 'fixture-owner', role: 'admin', name: '测试' };
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const config = {
    clientId: randomUUID(), clientSecret: 'synthetic-client-secret',
    redirectUri: publicOrigin + legacyMicrosoftMailboxCallback
  };
  let tokenCalls = 0;
  const oauth = createMicrosoftMailbox({
    publicOrigin, config, store,
    fetchImpl: async (_target, { body }) => {
      tokenCalls++;
      assert.equal(body.get('redirect_uri'), config.redirectUri);
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    },
    readImap: async () => []
  });
  const secret = 'test-only-website-visit-signing-secret';
  const visits = createWebsiteVisits({ store, publicOrigin, secret });
  const publicRoutes = createLegacyToolRoutes({ publicOrigin, microsoftMailbox: oauth, handleWebsiteVisits: visits });
  const server = createServer(async (req, res) => {
    if (!await publicRoutes(req, res)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  function callPublic(path, { method = 'GET', headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { host, 'content-type': 'application/json', ...headers },
        signal: AbortSignal.timeout(2000)
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function call(handler, path, { headers, method = 'POST', body = {} } = {}) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method, url: path, headers: { host, origin: publicOrigin, 'content-type': 'application/json', ...headers }
    });
    const result = {};
    await handler(req, {
      writeHead(status) { result.status = status; },
      end(value) { result.body = value; }
    });
    return result;
  }

  const start = (req, res) => oauth.handle(req, res, 'start', actor);
  const callback = (req, res) => oauth.handle(req, res, 'callback');
  const started = await call(start, microsoftMailboxPrefix + 'start', {
    body: { email: 'microsoft@example.test', version: 0, validDays: 7 }
  });
  assert.equal(started.status, 200);
  const { authorizationId, authorizationUrl } = JSON.parse(started.body);
  assert.equal(new URL(authorizationUrl).searchParams.get('redirect_uri'), config.redirectUri);
  const query = '?state=' + authorizationId + '&code=synthetic-code';
  const wrongHost = { host: 'other.example.test', 'x-forwarded-host': host, 'x-forwarded-proto': 'https' };
  assert.equal((await callPublic(legacyMicrosoftMailboxCallback + query, { headers: wrongHost })).status, 403);
  assert.equal((await call(callback, microsoftMailboxPrefix + 'callback' + query, { method: 'GET' })).status, 400);
  assert.deepEqual(await callPublic(legacyMicrosoftMailboxCallback + query, { method: 'POST' }), { status: 405, allow: 'GET' });
  assert.equal((await callPublic(microsoftMailboxPrefix + 'callback' + query)).status, 404);
  assert.equal(tokenCalls, 0);
  assert.equal((await callPublic(legacyMicrosoftMailboxCallback + query)).status, 200);
  assert.equal((await call((req, res) => oauth.handle(req, res, 'finish', actor), microsoftMailboxPrefix + 'finish', {
    body: { authorizationId }
  })).status, 200);
  assert.equal(tokenCalls, 1);

  const event = { eventId: randomUUID(), host: 'flashcast.com.my', path: '/zh/gallery',
    ip: '203.0.113.12', occurredAt: new Date().toISOString() };
  const signed = createHmac('sha256', secret).update(websiteVisitSignaturePayload(event)).digest('hex');
  assert.deepEqual(await callPublic(legacyWebsiteVisitIngest), { status: 405, allow: 'POST' });
  assert.equal((await callPublic(legacyWebsiteVisitIngest, { method: 'POST', body: event })).status, 401);
  assert.equal((await callPublic(legacyWebsiteVisitIngest, {
    method: 'POST', body: event, headers: { 'x-website-visit-signature': signed }
  })).status, 200);
  const mailbox = createManagedMailboxQuery({ store, publicOrigin });
  const media = createMediaResolver({ publicOrigin });
  const monitor = createWebsiteMonitor({ publicOrigin });
  for (const [handler, path, expected] of [
    [(req, res) => visits(req, res, 'search', actor), '/api/local/tools/website-visits/search', 400],
    [mailbox, '/api/local/tools/mailbox-query', 404],
    [(req, res) => media(req, res, actor), '/api/local/tools/media/resolve', 503],
    [(req, res) => monitor(req, res, actor), '/api/local/tools/website-monitor', 400]
  ]) {
    assert.equal((await call(handler, path, { headers: wrongHost })).status, 403);
    assert.equal((await call(handler, path, { headers: { origin: 'http://' + host } })).status, 403);
    assert.equal((await call(handler, path)).status, expected, path);
  }
});
