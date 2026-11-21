import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';

async function browserRequest(req) {
  const url = new URL(req.url());
  const request = Readable.from(req.postData() ? [Buffer.from(req.postData())] : []);
  request.url = url.pathname;
  request.method = req.method();
  request.headers = { ...await req.allHeaders(), host: url.host };
  return request;
}

async function authResponse(auth, request) {
  const headers = {};
  let status, body;
  await auth.handle(request, {
    setHeader(key, value) { headers[key] = value; },
    getHeader(key) { return headers[key]; },
    writeHead(code, extra) { status = code; Object.assign(headers, extra); },
    end(value) { body = value; }
  });
  for (const name of Object.keys(headers)) if (Array.isArray(headers[name])) headers[name] = headers[name].join('\n');
  return { status, headers, body };
}

test('delayed new and legacy activity responses cannot replace a later login in another tab', { timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true });
  for (const legacy of [false, true]) await t.test(legacy ? 'previous cookie generation' : 'new cookie generation', async t => {
    const directory = await mkdtemp(new URL('../.runtime/auth-race-', import.meta.url));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const origin = 'https://auth-race.example.test';
    const credentials = { email: 'review@example.test', name: '隔离测试', password: 'fixture-only-browser-password' };
    const path = join(directory, 'accounts.json');
    await initializeLocalAdmin(path, credentials);
    const auth = createLocalAuth(path, { publicUrl: new URL(origin) });
    let releaseActivity, markStarted, firstLogin = true;
    const gate = new Promise(resolve => { releaseActivity = resolve; });
    t.after(() => releaseActivity());
    const activityStarted = new Promise(resolve => { markStarted = resolve; });
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route(origin + '/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>隔离审查</title><p>虚构账号会话回归</p>' });
      const { headers, status, body } = await authResponse(auth, await browserRequest(req));
      if (url.pathname.endsWith('/login') && firstLogin) {
        if (legacy) headers['Set-Cookie'] = headers['Set-Cookie'].replace('__Host-id_session_v2=', '__Host-id_session=').replace('Max-Age=7776000', 'Max-Age=2592000');
        firstLogin = false;
      }
      if (url.pathname.endsWith('/activity')) { markStarted(); await gate; }
      await route.fulfill({ status, headers, body });
    });
    const a = await context.newPage(), b = await context.newPage();
    await a.goto(origin + '/'); await b.goto(origin + '/');
    const post = (page, path, body = {}) => page.evaluate(async ({ path, body }) => {
      const response = await fetch('/api/local/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }, { path, body });
    const session = page => page.evaluate(async () => (await fetch('/api/local/auth/session')).json());
    assert.equal((await post(a, 'login', { ...credentials, remember: true })).status, 200);
    const pending = post(a, 'activity');
    await activityStarted;
    assert.equal((await post(b, 'logout')).status, 200);
    assert.equal((await context.cookies()).length, 0, 'logout clears both generations in the isolated context');
    assert.equal((await post(b, 'login', { ...credentials, remember: true })).status, 200);
    assert((await session(b)).actor);
    releaseActivity(); await pending;
    assert((await session(b)).actor, 'a late activity response must not replace the later login');
    assert.equal((await post(b, 'logout')).status, 200);
    assert.equal((await context.cookies()).length, 0);
    assert.equal((await session(b)).actor, null);
  });
});

test('reopened profile restores the original route after a cross-site entry with a valid Strict cookie', { timeout: 45_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true });
  const directory = await mkdtemp(new URL('../.runtime/auth-reopen-', import.meta.url));
  const origin = 'https://auth-reopen.example.test', external = 'https://links.example.org';
  const target = origin + '/?entry=shortcut#/workspace/order/gpt';
  const credentials = { email: 'reopen@example.test', name: '隔离测试', password: randomUUID() };
  const accounts = join(directory, 'accounts.json');
  let context;
  t.after(async () => { await context?.close(); await rm(directory, { recursive: true, force: true }); });
  await initializeLocalAdmin(accounts, credentials);
  let now = Date.now();
  const auth = createLocalAuth(accounts, { publicUrl: new URL(origin), now: () => now });
  const script = await readFile(new URL('../frontend/local-auth.js', import.meta.url));
  const documents = [], validSessions = [], writes = [];
  let delayedProbe, failProbe = false, serveAnonymous = false;
  async function openProfile() {
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL, serviceWorkers: 'block'
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === external)
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="' + target + '">打开订单</a>' });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/local-auth.js') return route.fulfill({ contentType: 'application/javascript', body: script });
      const request = await browserRequest(route.request());
      if (url.pathname === '/') {
        const actor = serveAnonymous ? null : auth.getActor(request);
        documents.push(Boolean(actor));
        const marker = actor ? '<meta name="id-local-actor" content="' + encodeURIComponent(JSON.stringify(actor)) + '">' : '';
        return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' },
          body: '<!doctype html><head><meta name="id-local-auth" content="required">' + marker +
            '<script defer src="/local-auth.js"></script></head><body></body>' });
      }
      if (!url.pathname.startsWith('/api/local/auth/')) return route.fulfill({ status: 404, body: '' });
      if (request.method !== 'GET') writes.push(url.pathname);
      if (url.pathname.endsWith('/session') && failProbe) return route.fulfill({ status: 503, json: {} });
      const reply = await authResponse(auth, request);
      if (url.pathname.endsWith('/session')) {
        validSessions.push(Boolean(JSON.parse(reply.body).actor));
        if (delayedProbe) await delayedProbe.promise;
      }
      return route.fulfill(reply);
    });
    const page = context.pages()[0];
    page.setDefaultTimeout(5000);
    return page;
  }
  const signedIn = page => page.waitForFunction(() => window.IDLocalAuth?.getState().status === 'signed-in', null, { timeout: 5000 });
  async function login(page) {
    await page.locator('#local-auth-email').fill(credentials.email);
    await page.locator('#local-auth-password').fill(credentials.password);
    await page.locator('.local-auth-form button[type=submit]').click();
    await signedIn(page);
  }
  let page = await openProfile();
  await page.goto(target);
  await login(page);
  const persisted = (await context.cookies(origin)).find(cookie => cookie.name === '__Host-id_session_v2');
  assert(persisted && persisted.sameSite === 'Strict' && persisted.expires > Date.now() / 1000);
  await context.close();
  documents.length = validSessions.length = writes.length = 0;
  page = await openProfile();
  await page.goto(target);
  await signedIn(page);
  assert.deepEqual(documents, [true], 'direct reopen uses the existing authenticated document');
  documents.length = validSessions.length = 0;
  await page.goto(external + '/');
  delayedProbe = Promise.withResolvers();
  try {
    await Promise.all([
      page.waitForRequest(origin + '/api/local/auth/session'),
      page.getByRole('link', { name: '打开订单' }).click()
    ]);
    assert.equal(await page.locator('.local-auth-form:visible').count(), 0, 'no credential prompt while checking the existing session');
  } finally {
    delayedProbe.resolve();
    delayedProbe = undefined;
  }
  await signedIn(page);
  assert.deepEqual(documents, [false, true], 'cross-site document is anonymous, then reloaded with the existing identity');
  assert.deepEqual(validSessions, [true]);
  assert.deepEqual(writes, [], 'restoring the session uses only reads');
  assert.equal(page.url(), target);
  documents.length = validSessions.length = 0;
  await page.goto(external + '/');
  failProbe = true;
  await page.getByRole('link', { name: '打开订单' }).click();
  const retry = page.getByRole('button', { name: '重新检查' });
  await retry.waitFor();
  assert.equal(await page.locator('.local-auth-form').count(), 0);
  assert.deepEqual(documents, [false], 'a failed read waits for an explicit retry');
  failProbe = false;
  serveAnonymous = true;
  await retry.click();
  await page.getByText('当前设备已登录，工作台暂未打开。请重试。').waitFor();
  assert.deepEqual(documents, [false, false], 'a second anonymous document stops automatic reloads');
  assert.deepEqual(validSessions, [true, true]);
  serveAnonymous = false;
  await retry.click();
  await signedIn(page);
  assert.deepEqual(documents, [false, false, true]);
  assert.deepEqual(writes, []);
  assert.equal(page.url(), target);
  await page.evaluate(() => window.IDLocalAuth.logout());
  await page.locator('.local-auth-form').waitFor();
  documents.length = validSessions.length = 0;
  await page.goto(external + '/');
  await page.getByRole('link', { name: '打开订单' }).click();
  await page.locator('.local-auth-form').waitFor();
  assert.deepEqual(documents, [false]);
  assert.deepEqual(validSessions, [false], 'a logged-out browser stays on the login page');
  await login(page);
  now = persisted.expires * 1000 + 1000;
  documents.length = validSessions.length = writes.length = 0;
  await page.reload();
  await page.locator('.local-auth-form').waitFor();
  await page.getByText('登录已到期，请重新登录。').waitFor();
  assert.deepEqual(documents, [false]);
  assert.deepEqual(validSessions, [false], 'a browser with an expired session must authenticate again');
  assert.deepEqual(writes, []);
});
