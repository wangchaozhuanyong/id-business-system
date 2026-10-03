import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = process.argv.includes('--built');
const output = resolve(root, '.runtime/bitbrowser-direct-20261002', built ? 'built' : '.');
mkdirSync(output, { recursive: true });
const freePort = () =>
  new Promise((done) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
const port = await freePort();
const debugPort = await freePort();
const bitPort = await freePort();
const localOrigin = `http://127.0.0.1:${port}`;
const origin = 'https://direct-acceptance.example.invalid';
const contentSecurityPolicy = /Content-Security-Policy: (.+)/.exec(
  readFileSync(
    resolve(root, built ? 'apps/admin/dist/_headers' : 'apps/admin/public/_headers'),
    'utf8'
  )
)[1];
const localApiUrl = `http://127.0.0.1:${bitPort}`;
const accountId = '11111111-1111-4111-8111-111111111111';
const proxyId = '22222222-2222-4222-8222-222222222222';
const fixtureEmail = 'direct-fixture@example.com';
const user = {
  id: 'direct-fixture-admin',
  username: 'fixture-admin',
  displayName: '直连验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const settings = {
  proxyId,
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl,
  localApiTokenConfigured: true,
  localApiTokenMask: '已保存 ···验收',
  connectorTokenConfigured: false,
  connectorTokenMask: null,
  groupName: '直连验收分组',
  tagName: '直连验收标签',
  proxyType: 'http',
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: 'https://example.invalid/…（已加密）',
  updatedAt: null
};
const bitSettings = {
  localApiUrl,
  localApiToken: 'fixture-only-api-key',
  groupName: settings.groupName,
  tagName: settings.tagName,
  proxyType: 'http',
  dynamicProxyUrl: 'https://example.invalid/proxy',
  browserOptions: { sessionWaitMinutes: 1 }
};
const results = [];
const errors = [];
let browser, controlled, controlledContext, bitServer;
let authenticated = false;
let identityMismatch = false;
let profileSync = false;
let connectorRequests = 0;
let apiStarts = 0;
let codeRequests = 0;
let settingsSaves = 0;
let endpoint;
let jobs = [];
const vite = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    ...(built ? ['preview'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort'
  ],
  { cwd: resolve(root, 'apps/admin'), stdio: 'ignore' }
);
const waitFor = async (check, limit = 20_000) => {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('验收等待超时');
};
const json = (response, data) => {
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });
  response.end(JSON.stringify({ success: true, data }));
};
const success = (route, data) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const form = (type, next) =>
  `<!doctype html><title>模拟官方登录</title><form onsubmit="event.preventDefault();location.href='${next}'"><input type="${type === 'code' ? 'text' : type}" name="${type === 'code' ? 'code' : type}" ${type === 'code' ? 'autocomplete="one-time-code"' : ''}><button type="submit">继续</button></form>`;

try {
  await waitFor(async () => (await fetch(localOrigin).catch(() => null))?.ok);
  controlled = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${debugPort}`, `--remote-allow-origins=${origin}`]
  });
  endpoint = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json())
    .webSocketDebuggerUrl;
  controlledContext = await controlled.newContext();
  // Every official URL is fulfilled locally. No login, proxy or payment network is contacted.
  await controlledContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'chatgpt.com' && url.pathname === '/api/auth/session') {
      const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } };
      return route.fulfill({
        json: authenticated
          ? {
              user: {
                id: 'user-fixture',
                email: identityMismatch ? 'other@example.com' : fixtureEmail
              },
              accessToken: `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
            }
          : {}
      });
    }
    if (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/backend-api/accounts/check/'))
      return route.fulfill({
        json: {
          accounts: {
            'account-fixture': { account: { account_id: 'account-fixture', plan_type: 'free' } }
          }
        }
      });
    if (url.hostname === 'chatgpt.com' && url.pathname === '/auth/login')
      return route.fulfill({
        contentType: 'text/html',
        body: form('email', 'https://auth.openai.com/password')
      });
    if (url.hostname === 'auth.openai.com' && url.pathname === '/password')
      return route.fulfill({
        contentType: 'text/html',
        body: form('password', 'https://auth.openai.com/code')
      });
    if (url.hostname === 'auth.openai.com' && url.pathname === '/code')
      return route.fulfill({
        contentType: 'text/html',
        body: form('code', 'https://chatgpt.com/fixture-success')
      });
    if (url.hostname === 'chatgpt.com' && url.pathname === '/fixture-success') authenticated = true;
    if (url.hostname === 'chatgpt.com')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>模拟 ChatGPT</title><p>模拟登录窗口</p>'
      });
    return route.abort();
  });
  bitServer = http.createServer(async (request, response) => {
    if (request.method === 'OPTIONS') return json(response, {});
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    if (request.headers['x-api-key'] !== 'fixture-only-api-key') {
      response.writeHead(401, { 'Access-Control-Allow-Origin': '*' });
      return response.end('{}');
    }
    if (request.url === '/health') return json(response, {});
    if (request.url === '/group/list')
      return json(response, { list: [{ id: 'group-fixture', groupName: settings.groupName }] });
    if (request.url === '/browserTag/list')
      return json(response, [{ id: 'b'.repeat(32), tagName: settings.tagName }]);
    if (request.url === '/browser/update') {
      assert.equal(body.password, '');
      assert.equal(body.cookie, '');
      for (const key of [
        'syncTabs',
        'syncCookies',
        'syncLocalStorage',
        'syncIndexedDb',
        'syncAuthorization'
      ])
        assert.equal(body[key], false);
      return json(response, { id: 'c'.repeat(32) });
    }
    if (request.url === '/browserTag/updateRelation') return json(response, {});
    if (request.url === '/browser/detail')
      return json(response, {
        id: 'c'.repeat(32),
        syncTabs: false,
        syncCookies: profileSync,
        syncLocalStorage: false,
        syncIndexedDb: false,
        syncAuthorization: false
      });
    if (request.url === '/browser/open') {
      assert.deepEqual(body.args, [`--remote-allow-origins=${origin}`]);
      await controlledContext.newPage();
      return json(response, { ws: endpoint });
    }
    throw new Error('未预期的模拟比特接口');
  });
  await new Promise((done) => bitServer.listen(bitPort, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true });
  const install = async (context, mockApi = true) => {
    await context.grantPermissions(['local-network-access'], { origin });
    await context.addInitScript((fixtureUser) => {
      localStorage.setItem('apple_business_access_token', 'fixture-only-session');
      localStorage.setItem('apple_business_current_user', JSON.stringify(fixtureUser));
    }, user);
    await context.route('http://127.0.0.1:55321/**', (route) => {
      connectorRequests++;
      return route.abort();
    });
    await context.route(origin + '/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path === '/protocol-fixture')
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': contentSecurityPolicy },
          body: '<!doctype html><title>网页直连协议验收</title>'
        });
      if (mockApi && path.startsWith('/api/')) {
        if (path === '/api/auth/me') return success(route, user);
        if (path === '/api/auth/session')
          return route.fulfill({ status: 401, json: { success: false, message: '请登录' } });
        if (path.endsWith('/auto-recharge/bitbrowser-settings')) {
          if (request.method() === 'PUT') {
            assert.equal(request.postDataJSON().directMode, true);
            assert.equal(request.postDataJSON().proxyId, proxyId);
            assert.equal(request.postDataJSON().dynamicProxyUrl, undefined);
            assert.equal(request.postDataJSON().staticProxyCredentials, undefined);
            settingsSaves++;
          }
          return success(route, settings);
        }
        if (path.endsWith('/auto-recharge/bitbrowser-catalog-access')) {
          assert.equal(request.postDataJSON().directMode, true);
          return success(route, {
            connectorUrl: '',
            connectorToken: '',
            localApiUrl,
            localApiToken: 'fixture-only-api-key'
          });
        }
        const proxy = {
          id: proxyId,
          countryCode: 'US',
          kind: 'dynamic_residential',
          connectionMode: 'extraction',
          protocol: 'http',
          status: 'active',
          remark1: '直连验收代理',
          remark2: null,
          linkMask: 'https://example.invalid/…（已加密）',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        if (path.endsWith('/auto-recharge/proxies/countries'))
          return success(route, { items: ['US'] });
        if (path.endsWith('/auto-recharge/proxies'))
          return success(route, { items: [proxy], total: 1, page: 1, pageSize: 100 });
        if (path.endsWith('/auto-recharge/server-proxy-settings'))
          return success(route, { proxyId, proxy, legacyConfigured: false });
        if (path.endsWith('/auto-recharge/jobs') && request.method() === 'GET')
          return success(route, { items: jobs, configured: true });
        if (path.endsWith('/bank-recharge/accounts') && request.method() === 'GET')
          return success(route, {
            items: [
              {
                id: accountId,
                emailMasked: fixtureEmail,
                status: 'active',
                subscriptionState: 'never_subscribed',
                hasPassword: true,
                hasTotp: true
              }
            ],
            total: 1
          });
        if (path.endsWith('/identity'))
          return success(route, { id: accountId, email: fixtureEmail });
        if (path.endsWith('/login-credential'))
          return success(route, { email: fixtureEmail, password: 'fixture-only-password' });
        if (path.endsWith('/totp-code')) {
          codeRequests++;
          return success(route, {
            token: '123456',
            expiresAt: new Date(Date.now() + 30_000).toISOString()
          });
        }
        if (path.endsWith('/auto-recharge/addresses'))
          return success(route, {
            items: [],
            total: 0,
            page: 1,
            pageSize: 2000,
            totals: { unused: 0, used: 0, disabled: 0 }
          });
        if (path.endsWith('/auto-recharge/jobs/bitbrowser-open')) {
          const input = request.postDataJSON();
          assert.equal(input.directMode, true);
          assert.deepEqual(Object.keys(input).sort(), ['directMode', 'id', 'windowName']);
          apiStarts++;
          jobs = [
            {
              id: input.id,
              action: 'bitbrowser',
              plan: 'plus',
              state: 'running',
              result: { mode: 'open_browser', status: 'waiting_local_connector' },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ];
          return success(route, {
            id: input.id,
            mode: 'open_browser',
            connectorUrl: '',
            connectorToken: '',
            agentToken: 'fixture-only-agent',
            bitBrowser: { ...bitSettings }
          });
        }
        if (/\/auto-recharge\/local\//.test(path)) {
          assert.equal(request.headers()['x-recharge-local'], 'fixture-only-agent');
          const input = request.postDataJSON();
          const job = jobs[0];
          assert.equal(input.result.payment_requests_sent, 0);
          assert.ok(!JSON.stringify(input).includes('fixture-only-password'));
          job.result = { ...job.result, ...input.result };
          job.state =
            input.type === 'finished'
              ? 'finished'
              : ['login_code_required', 'verification_required'].includes(input.result.stage)
                ? 'awaiting_human_verification'
                : 'running';
          return success(route, { ok: true });
        }
        return success(route, { items: [], total: 0, configured: true });
      }
      const response = await fetch(localOrigin + path + url.search);
      return route.fulfill({
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'text/plain',
        headers: request.isNavigationRequest()
          ? { 'Content-Security-Policy': contentSecurityPolicy }
          : {},
        body: Buffer.from(await response.arrayBuffer())
      });
    });
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await install(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/v2/auto-recharge');
  await page.getByText('仅登录窗口', { exact: true }).click();
  await page.getByText('已保存账号', { exact: true }).click();
  const select = page.getByRole('combobox', { name: '选择已保存的 ChatGPT 账号' });
  await select.click();
  await page.getByRole('option', { name: fixtureEmail, exact: true }).click();
  await page.getByRole('button', { name: '打开比特浏览器并登录', exact: true }).click();
  await waitFor(() => jobs[0]?.state === 'finished', 35_000).catch(async (error) => {
    const diagnostic = {
      apiStarts,
      codeRequests,
      connectorRequests,
      errors,
      jobs: jobs.map((job) => ({
        state: job.state,
        status: job.result.status,
        stage: job.result.stage,
        reason: job.result.reason
      })),
      windows: controlledContext
        .pages()
        .map((page) => new URL(page.url()).origin + new URL(page.url()).pathname)
    };
    writeFileSync(resolve(output, 'failure.json'), JSON.stringify(diagnostic, null, 2));
    await page.screenshot({ path: resolve(output, 'failure.png') });
    console.log(JSON.stringify(diagnostic));
    throw error;
  });
  assert.equal(jobs[0].result.status, 'session_ready');
  assert.equal(jobs[0].result.account_matched, true);
  assert.equal(codeRequests, 1);
  assert.equal(apiStarts, 1);
  assert.equal(connectorRequests, 0);
  results.push({
    scenario: '真实浏览器协议与页面自动取码',
    ok: true,
    connectorRequests,
    codeRequests,
    paymentRequests: 0
  });
  await page.getByRole('button', { name: '比特浏览器直连设置', exact: true }).click();
  await page.getByText('网页直连', { exact: true }).waitFor();
  assert.equal(await page.getByText('本机连接密钥', { exact: true }).count(), 0);
  assert.equal(await page.getByText('本机连接器地址', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '检测完整连接', exact: true }).click();
  await page
    .getByRole('dialog', { name: '比特浏览器直连设置' })
    .getByText('比特浏览器直连、分组／标签检测通过', { exact: true })
    .waitFor();
  await page.screenshot({ path: resolve(output, 'settings-direct.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitFor(async () => settingsSaves === 1);
  assert.equal(settingsSaves, 1);
  await page.getByRole('dialog', { name: '比特浏览器直连设置' }).waitFor({ state: 'hidden' });
  for (const width of [1440, 1024, 901, 900, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.getByTitle(theme === 'light' ? '切换为浅色主题' : '切换为深色主题').click();
      await page.getByRole('button', { name: '连接说明', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '比特浏览器直连说明' });
      await dialog.waitFor();
      await dialog.getByText('开启本地接口：', { exact: true }).waitFor();
      await dialog.getByText('填写网站设置：', { exact: true }).waitFor();
      await dialog.evaluate(async (element) => {
        const animations = [];
        for (let current = element; current; current = current.parentElement)
          animations.push(...current.getAnimations());
        await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
      });
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      const overflow = await dialog.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1
      );
      assert.equal(overflow, false);
      await page.screenshot({
        path: resolve(output, `${width}-${theme}-help.png`),
        animations: 'disabled'
      });
      await dialog.getByRole('button', { name: '知道了', exact: true }).click();
      results.push({ scenario: '连接说明弹窗', width, theme, ok: true });
    }
  }
  await context.close();
  if (!built) {
    const protocolContext = await browser.newContext();
    await install(protocolContext, false);
    const protocolPage = await protocolContext.newPage();
    await protocolPage.goto(origin + '/protocol-fixture');
    const run = async (scenario) =>
      protocolPage.evaluate(
        async ({ scenario, settings, email }) => {
          const { runDirectLogin } =
            await import('/src/v2/features/auto-recharge/bitbrowser-direct-login.ts');
          const controller = new AbortController();
          const stages = [];
          try {
            const credential =
              scenario === 'json'
                ? {
                    sessionJson: JSON.stringify({
                      sessionToken: 'fixture-only-session-cookie',
                      user: { id: 'user-fixture', email },
                      account: { id: 'account-fixture' }
                    })
                  }
                : { login: { email, password: 'fixture-only-password' } };
            const result = await runDirectLogin(
              settings,
              credential,
              '模拟直连窗口',
              controller.signal,
              {
                progress: async (stage) => {
                  stages.push(stage);
                  if (scenario === 'cancel' && stage === 'bitbrowser_profile_opened')
                    controller.abort();
                },
                code: async () => '123456'
              }
            );
            return { ok: true, result, stages };
          } catch (error) {
            return { ok: false, reason: error.reason, stages };
          }
        },
        { scenario, settings: bitSettings, email: fixtureEmail }
      );
    identityMismatch = true;
    authenticated = true;
    let result = await run('mismatch');
    assert.equal(result.reason, 'official_login_email_mismatch');
    results.push({ scenario: '账号不匹配停止', ok: true });
    identityMismatch = false;
    profileSync = true;
    result = await run('sync');
    assert.equal(result.reason, 'bitbrowser_profile_sync_unverified');
    assert.ok(!result.stages.includes('bitbrowser_profile_opened'));
    results.push({ scenario: '无法核实关闭登录态同步时停止', ok: true });
    profileSync = false;
    result = await run('cancel');
    assert.equal(result.ok, false);
    assert.ok(!result.stages.includes('login_password'));
    results.push({ scenario: '取消后不再填写凭据', ok: true });
    authenticated = true;
    result = await run('json');
    assert.equal(result.result.status, 'session_ready');
    assert.equal(result.result.account_matched, true);
    assert.ok(!result.stages.includes('login_password'));
    results.push({ scenario: '授权 JSON 完整身份核实', ok: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        ok: true,
        mode: built ? 'production-build' : 'source',
        results,
        runtimeErrors: errors.length,
        realAccountLogins: 0,
        realPaymentRequests: 0
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: results.length,
      output,
      runtimeErrors: 0,
      realAccountLogins: 0,
      realPaymentRequests: 0
    })
  );
} finally {
  await browser?.close();
  await controlled?.close();
  await new Promise((done) => (bitServer ? bitServer.close(done) : done()));
  vite.kill('SIGTERM');
}
