import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, root } from './helpers/offline-design.mjs';
const actor = { id: 'fixture-owner', name: '测试管理员', email: 'owner@example.test', role: 'super', nicknameSet: false };
test('remember login, own-device controls and reconnect states work without local server or business writes', { timeout: 90000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await interceptDesign(context, { localFixtures: {}, actor });
  let signedIn = false, fail = false, expired = false, activityCount = 0, submitted;
  let devices = [{ id: '11111111-1111-1111-1111-111111111111', current: true, remembered: true, device: 'Chrome · macOS', createdAt: Date.now(), lastUsedAt: Date.now(), expiresAt: Date.now() + 2592000000 },
    { id: '22222222-2222-2222-2222-222222222222', current: false, remembered: false, device: 'Safari · iOS', createdAt: Date.now(), lastUsedAt: Date.now(), expiresAt: Date.now() + 28800000 }];
  await context.route('**/api/local/auth/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/login')) { submitted = req.postDataJSON(); signedIn = true; return route.fulfill({ json: { actor } }); }
    if (path.endsWith('/session')) return fail ? route.fulfill({ status: 503, json: { error: '暂不可用' } }) : route.fulfill({ json: { configured: true, actor: expired ? null : actor, reason: expired ? 'expired' : undefined } });
    if (path.endsWith('/activity')) { activityCount++; return fail ? route.abort() : route.fulfill({ json: { remembered: true } }); }
    if (req.method() === 'DELETE') { devices = devices.filter(row => !path.endsWith(row.id)); return route.fulfill({ json: { current: false } }); }
    if (path.endsWith('/devices')) return route.fulfill({ json: { items: devices } });
    return route.fulfill({ json: {} });
  });
  await context.route(url => url.origin === origin && url.pathname === '/', async route => {
    let html = await readFile(root + '/frontend/index.html', 'utf8');
    html = html.replace('<head>', `<head><meta name="id-local-auth" content="required">${signedIn ? `<meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify(actor))}">` : ''}<link rel="stylesheet" href="/local-auth.css">`).replace('    <script src="./prototype.js', '    <script src="/local-data.js" defer></script><script src="/local-auth.js" defer></script><script src="./prototype.js');
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => { if (errors.length) console.error('browser errors:', errors); });
  await page.goto(origin + '/');
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert(await page.locator('#local-auth-remember').isVisible());
    const before = await page.locator('#local-auth-password').boundingBox();
    const help = page.getByLabel('查看在此设备保持登录说明');
    await help.click();
    await page.getByText('保持登录后，实际操作时自动续期；', { exact: false }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('#local-auth-password').boundingBox(), before);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.locator('#local-auth-email').fill(actor.email);
  await page.locator('#local-auth-password').fill('fixture-only-password');
  await page.locator('#local-auth-remember').check();
  await page.locator('.local-auth-form button[type=submit]').click();
  await page.waitForFunction(() => window.IDDesignAPI && window.IDLocalAuth?.getState().status === 'signed-in');
  await page.locator('#profile-button').waitFor({ state: 'visible' });
  assert.equal(submitted.remember, true);
  assert.equal(new URL(page.url()).searchParams.has('auth_reason'), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#profile-button').click();
  await page.locator('.local-auth-device').last().waitFor();
  assert.equal(await page.locator('.local-auth-device').count(), 2);
  await page.locator('[data-device-id="22222222-2222-2222-2222-222222222222"]').click();
  await page.locator('[data-action=confirm-accept]').click();
  await page.waitForFunction(() => document.querySelectorAll('.local-auth-device').length === 1);
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const button = await page.locator('[data-device-id]').boundingBox();
    assert(button.x >= 0 && button.x + button.width <= width);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.locator('#drawer .drawer-header [data-action=drawer-close]').click();
  assert(activityCount > 0, 'real user interaction must report activity');
  const count = activityCount;
  await page.evaluate(() => window.IDLocalAuth.refresh());
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
  assert.equal(activityCount, count, 'background refresh and synthetic events must not renew sessions');
  fail = true;
  await page.evaluate(() => { const originalNow = Date.now; Date.now = () => originalNow() + 120001; });
  await page.locator('#profile-button').click();
  await page.locator('#local-auth-connection').waitFor();
  await page.locator('#self-nickname').fill('隔离的未保存昵称');
  await page.locator('#drawer > #local-auth-connection button').waitFor();
  await page.evaluate(() => window.IDLocalAuth.refresh().catch(() => {}));
  assert(await page.locator('#profile-button').isVisible(), '503 must preserve current page and login');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('#local-auth-connection').waitFor();
  // A new confirmation must inherit the retry control; closing it restores the drawer host.
  await page.locator('[data-device-id]').click();
  await page.locator('#confirm-dialog > #local-auth-connection button').waitFor();
  await page.locator('#local-auth-connection button').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#local-auth-connection button').disabled);
  await page.locator('[data-action=confirm-cancel]').click();
  await page.locator('#drawer > #local-auth-connection button').waitFor();
  assert.equal(await page.locator('#self-nickname').inputValue(), '隔离的未保存昵称');
  fail = false;
  await page.locator('#local-auth-connection button').click();
  await page.locator('#local-auth-connection').waitFor({ state: 'detached' });
  assert(await page.locator('#drawer').evaluate(node => node.open));
  assert.equal(await page.locator('#self-nickname').inputValue(), '隔离的未保存昵称');
  expired = true; signedIn = false;
  await page.evaluate(() => window.IDLocalAuth.refresh());
  await page.locator('#local-auth-gate').waitFor();
  assert.equal(await page.locator('.local-auth-reason').textContent(), '登录已到期，请重新登录。');
  assert.deepEqual(errors, []);
  if (process.env.ID_AUTH_QA_OUTPUT) {
    await mkdir(process.env.ID_AUTH_QA_OUTPUT, { recursive: true });
    await page.screenshot({ path: process.env.ID_AUTH_QA_OUTPUT + '/login-mobile.png', fullPage: true });
  }
});
