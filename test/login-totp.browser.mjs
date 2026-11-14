import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateTotp } from '../modules/tools/totp.mjs';
import { interceptDesign, origin, root } from './helpers/offline-design.mjs';

// Public RFC 6238 test vector, never a business credential.
const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('signed-out 2FA queries stay local, expire correctly and clear on close or late completion', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 960 } });
  const requests = await interceptDesign(context, { skipRechargeAssets: true });
  await context.route(url => url.origin === origin && url.pathname === '/', async route => {
    const html = (await readFile(join(root, 'frontend/index.html'), 'utf8'))
      .replace('    <script src="./prototype.js', '    <script src="/local-auth.js" defer></script>\n    <script src="./prototype.js')
      .replace(/^ *<script (?:type="module" )?src="\.\/[^"\n]+"(?: defer)?><\/script>\n/gm, '')
      .replace('<head>', '<head><meta name="id-local-auth" content="required"><link rel="stylesheet" href="/local-auth.css">')
      .replace('<div class="app-shell">', '<div class="app-shell" hidden>');
    await route.fulfill({ body: html, contentType: 'text/html' });
  });
  await context.addInitScript(() => {
    window.fixtureClipboard = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) {
      if (window.fixtureClipboardFailure) throw new Error('fixture denial');
      window.fixtureClipboard.push(value);
    } } });
  });
  let moduleMode = 'fail', moduleCalls = 0, requested, release;
  await context.route('**/assets/tools/totp.mjs*', async route => {
    moduleCalls++;
    if (moduleMode === 'fail') return route.fulfill({ status: 503, body: '' });
    if (moduleMode === 'hold') { requested.resolve(); await release.promise; }
    await route.fallback();
  });
  const page = await context.newPage(), errors = [], apiCalls = [], measurements = [];
  let leaked = false;
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiCalls.push({ path: url.pathname, method: request.method() });
    if (request.url().includes(key) || request.postData()?.includes(key)) leaked = true;
  });
  await page.goto(origin + '/');
  await page.clock.setFixedTime(new Date(59_000));
  const opener = page.locator('#local-auth-totp-open');
  const dialog = page.getByRole('dialog', { name: '2FA 验证码查询' });
  const input = page.locator('#local-auth-totp-secret');
  const form = page.locator('.local-auth-totp-form');
  const submit = form.getByRole('button', { name: '获取验证码' });
  const code = page.locator('.local-auth-totp-code');
  const result = page.locator('.local-auth-totp-result');
  const notice = page.locator('#local-auth-totp-error');
  const copy = page.getByRole('button', { name: '复制验证码' });
  const waitForCode = expected => page.waitForFunction(value => document.querySelector('.local-auth-totp-code')?.textContent === value, expected);
  const storageBefore = await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]);

  await opener.press('Enter');
  assert(await dialog.isVisible());
  assert(await input.evaluate(node => node === document.activeElement));
  await submit.click();
  assert.match(await notice.textContent(), /请输入/);
  assert.equal(moduleCalls, 0, 'empty input does not load or request anything');
  await input.fill(key);
  await submit.click();
  await notice.waitFor({ state: 'visible' });
  assert.match(await notice.textContent(), /加载失败/);
  assert.equal(await input.inputValue(), key, 'failed module load preserves the temporary input for retry');
  assert.equal(moduleCalls, 1);

  moduleMode = 'hold'; requested = Promise.withResolvers(); release = Promise.withResolvers();
  await submit.click();
  await requested.promise;
  assert(await form.getByRole('button').isDisabled());
  await form.dispatchEvent('submit');
  assert.equal(moduleCalls, 2, 'pending duplicate submits do not reload the component');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#local-auth-totp-secret').value === '');
  const response = page.waitForResponse(url => new URL(url.url()).pathname === '/assets/tools/totp.mjs');
  moduleMode = 'ready'; release.resolve(); await response;
  assert.equal(await code.textContent(), '—');
  assert(await result.isHidden());
  assert(await opener.evaluate(node => node === document.activeElement), 'close restores focus to the entry');

  await opener.click();
  await input.fill(key);
  await submit.click();
  await waitForCode('287082');
  assert.equal(await page.locator('[data-totp-countdown]').textContent(), '1');
  await copy.click();
  assert.equal(await page.evaluate(() => window.fixtureClipboard.at(-1)), '287082');
  assert.match(await page.locator('.local-auth-totp-status').textContent(), /已复制/);
  await page.clock.setFixedTime(new Date(60_000));
  await waitForCode((await calculateTotp(key, 60_000)).code);
  assert.equal(await page.locator('[data-totp-countdown]').textContent(), '30');
  // A click must not copy the expired display when the next timer has not fired yet.
  await page.clock.setFixedTime(new Date(90_000));
  await copy.click();
  assert.equal(await page.evaluate(() => window.fixtureClipboard.at(-1)), (await calculateTotp(key, 90_000)).code);
  await page.evaluate(() => { window.fixtureClipboardFailure = true; });
  await copy.click();
  assert.match(await page.locator('.local-auth-totp-status').textContent(), /手动复制/);
  await page.evaluate(() => { window.fixtureClipboardFailure = false; });
  await input.fill('INVALID!');
  assert(await result.isHidden(), 'editing invalidates the previous result immediately');
  await submit.click();
  await notice.waitFor({ state: 'visible' });
  assert.match(await notice.textContent(), /Base32/);
  assert.doesNotMatch(await notice.textContent(), /INVALID/);
  await dialog.getByLabel('关闭验证码查询').click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#local-auth-totp-secret').value === '');

  const output = process.env.ID_AUTH_QA_OUTPUT;
  if (output) {
    const rel = relative(root, output);
    assert(!rel.startsWith('..') && !isAbsolute(rel), '验收输出必须位于本项目内');
    await mkdir(output, { recursive: true });
  }
  for (const [width, height] of [[1440, 960], [390, 844], [320, 640], [844, 390]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await opener.click();
    assert.equal(await input.inputValue(), '');
    assert(await result.isHidden());
    const help = dialog.getByLabel('查看2FA 验证码查询说明');
    const before = await input.boundingBox();
    assert.equal(await dialog.locator('.title-help').getAttribute('open'), null);
    await help.press('Enter');
    await dialog.locator('.title-description:visible').waitFor();
    assert.deepEqual(await input.boundingBox(), before, 'help does not move the form');
    await page.keyboard.press('Escape');
    assert(await dialog.isVisible(), 'first Escape closes the help only');
    assert.equal(await dialog.locator('.title-help').getAttribute('open'), null);
    await input.focus();
    if (output && height > 390) await page.screenshot({ path: join(output, `totp-${width}-${theme}.png`), fullPage: true });
    const uri = `otpauth://totp/RFC?secret=${key}&digits=8&period=60`;
    await input.fill(uri);
    await submit.click();
    await waitForCode((await calculateTotp(uri, 90_000)).code);
    await copy.scrollIntoViewIfNeeded();
    const bounds = await dialog.evaluate(node => {
      const box = node.getBoundingClientRect();
      const code = node.querySelector('.local-auth-totp-code').getBoundingClientRect();
      const copy = node.querySelector('[data-totp-copy]').getBoundingClientRect();
      return { dialog: box.toJSON(), code: code.toJSON(), copy: copy.toJSON(), overflow: node.scrollWidth > node.clientWidth };
    });
    assert(!bounds.overflow, 'dialog does not overflow horizontally');
    assert(bounds.dialog.left >= 0 && bounds.dialog.right <= width && bounds.dialog.top >= 0 && bounds.dialog.bottom <= height);
    assert(bounds.code.left >= bounds.dialog.left && bounds.code.right <= bounds.dialog.right, 'eight digits remain visible');
    assert(bounds.copy.width >= 44 && bounds.copy.height >= 44 && bounds.copy.right <= bounds.dialog.right);
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate(node => node.contains(document.activeElement)), 'keyboard focus stays in the dialog');
    measurements.push({ width, height, theme, ...bounds });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#local-auth-totp-secret').value === '');
    assert.equal(await code.textContent(), '—');
  }
  await opener.click();
  await input.fill(key);
  await page.mouse.click(2, 2);
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#local-auth-totp-secret').value === '');
  await opener.click();
  await input.fill(key);
  await submit.click();
  await waitForCode((await calculateTotp(key, 90_000)).code);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), '');
  assert.equal(await code.textContent(), '—');
  assert.deepEqual(await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]), storageBefore);
  assert.deepEqual(apiCalls, [], 'anonymous calculator must never read saved-account or other business APIs');
  assert.equal(leaked, false, 'test key is never sent in a request');
  assert.deepEqual(requests.external, []);
  assert.deepEqual(requests.unavailable, []);
  assert.deepEqual(errors, []);
  if (output) await writeFile(join(output, 'totp-result.json'), JSON.stringify({ passed: true, apiCalls, leaked, errors, measurements }, null, 2));
});
