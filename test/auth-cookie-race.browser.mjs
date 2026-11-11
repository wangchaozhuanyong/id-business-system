import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';

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
      const request = Readable.from(req.postData() ? [Buffer.from(req.postData())] : []);
      request.url = url.pathname; request.method = req.method(); request.headers = { ...req.headers(), host: url.host };
      const headers = {}; let status, body;
      await auth.handle(request, { setHeader(k, v) { headers[k] = v; }, writeHead(code, extra) { status = code; Object.assign(headers, extra); }, end(value) { body = value; } });
      if (url.pathname.endsWith('/login') && firstLogin) {
        if (legacy) headers['Set-Cookie'] = headers['Set-Cookie'].replace('__Host-id_session_v2=', '__Host-id_session=').replace('Max-Age=7776000', 'Max-Age=2592000');
        firstLogin = false;
      }
      if (url.pathname.endsWith('/activity')) { markStarted(); await gate; }
      for (const name of Object.keys(headers)) if (Array.isArray(headers[name])) headers[name] = headers[name].join('\n');
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
