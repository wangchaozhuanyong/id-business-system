import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { interceptDesign, origin, root } from './helpers/offline-design.mjs';

test('paper login keeps fields, setup, errors and pending submits usable across viewport sizes', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: {}, skipRechargeAssets: true });
  let setup = false, loginCalls = 0, pending;
  const errors = [], rows = [];
  const output = process.env.ID_AUTH_QA_OUTPUT;
  if (output) {
    const path = relative(root, output);
    assert(!path.startsWith('..') && !isAbsolute(path), '验收输出必须位于本项目内');
    await mkdir(output, { recursive: true });
    await writeFile(join(output,'layout-result.json'),JSON.stringify({passed:false,status:'running'}));
  }
  await context.route(url => url.origin === origin && url.pathname === '/', async route => {
    let html = await readFile(join(root, 'frontend/index.html'), 'utf8');
    html = html.replace('<head>', '<head><meta name="id-local-auth" content="required">' +
      (setup ? '<meta name="id-local-admin-setup" content="setup@example.test">' : '') +
      '<link rel="stylesheet" href="/local-auth.css">')
      .replace('    <script src="./prototype.js', '    <script src="/local-auth.js" defer></script>\n    <script src="./prototype.js');
    await route.fulfill({ body: html, contentType: 'text/html' });
  });
  await context.route('**/api/local/auth/login', async route => {
    loginCalls++;
    if (pending) await pending.promise;
    await route.fulfill({ status: 401, json: { error: '邮箱或密码不正确，请核对后重试。' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  const geometry = () => page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const input = document.querySelector('#local-auth-email');
    return { overflow: document.documentElement.scrollWidth > innerWidth,
      header: box('.local-auth-header'), brand: box('.local-auth-brand'), badge: box('.local-auth-badge'),
      form: box('.local-auth-card'), footer: box('.local-auth-footer'), submit: box('.local-auth-form button[type="submit"]'),
      inputs: [...document.querySelectorAll('.local-auth-form input:not([type="checkbox"])')]
        .map(input => ({ id: input.id, ...input.getBoundingClientRect().toJSON() })),
      palette: { background: getComputedStyle(document.querySelector('#local-auth-gate')).backgroundColor,
        surface: getComputedStyle(input).backgroundColor,
        text: getComputedStyle(input).color, placeholder: getComputedStyle(input, '::placeholder').color,
        footer: getComputedStyle(document.querySelector('.local-auth-footer')).color,
        borders: [...document.querySelectorAll('.local-auth-form input:not([type="checkbox"])')]
          .map(input => getComputedStyle(input).borderBottomColor) } };
  });
  const contrast = (a, b) => {
    const luminance = value => {
      const values = value.match(/[\d.]+/g).slice(0,3).map(Number).map(value => value / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const x = luminance(a), y = luminance(b);
    return (Math.max(x,y) + 0.05) / (Math.min(x,y) + 0.05);
  };
  const check = async label => {
    const bounds = await geometry();
    assert.equal(bounds.overflow, false, label);
    assert(bounds.brand.right + 8 <= bounds.badge.left, label + ': header overlap');
    assert(bounds.form.top >= bounds.header.bottom + 20, label + ': form overlaps header');
    assert(bounds.footer.top >= bounds.form.bottom + 20, label + ': footer overlaps form');
    assert(bounds.submit.left >= 0 && bounds.submit.right <= page.viewportSize().width, label + ': clipped submit');
    assert(bounds.inputs.every(input => input.width >= 180 && input.height >= 44), label + ': field size');
    assert(contrast(bounds.palette.text, bounds.palette.surface) >= 4.5, label + ': input text contrast');
    assert(contrast(bounds.palette.placeholder, bounds.palette.surface) >= 4.5, label + ': placeholder contrast');
    assert(contrast(bounds.palette.footer, bounds.palette.background) >= 4.5, label + ': footer contrast');
    assert(bounds.palette.borders.every(color => contrast(color, bounds.palette.surface) >= 3), label + ': input border contrast ' + JSON.stringify(bounds.palette));
    assert.equal(await page.locator('.local-auth-brand-name').textContent(), 'AI订阅管理系统');
    assert.equal(await page.getByRole('button', { name: setup ? '设置密码并登录' : '登录', exact: true }).count(), 1);
    for (const button of await page.locator('.local-auth-password-toggle').all()) {
      const box = await button.boundingBox();
      assert(box.width >= 44 && box.height >= 44, label + ': password toggle target');
    }
    return bounds;
  };
  for (const mode of ['login', 'setup']) {
    setup = mode === 'setup';
    for (const width of [1440,1024,901,900,768,390,320]) for (const theme of ['light','dark']) {
      const height = width <= 900 ? 844 : 960;
      await page.setViewportSize({ width, height });
      await page.goto(origin + '/');
      await page.locator('#local-auth-email').waitFor();
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.evaluate(async () => { await document.fonts.ready; await document.querySelector('.local-auth-mark').decode(); });
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation =>
        animation.effect.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => {}))));
      // Scroll separately when required; geometry checks measure the same document position.
      await page.evaluate(() => scrollTo(0,0));
      const bounds = await check(`${mode} ${width} ${theme}`);
      assert.equal(await page.locator('.local-auth-story').isVisible(), width > 900);
      if (setup) {
        assert.equal(await page.locator('#local-auth-email').inputValue(), 'setup@example.test');
        assert(await page.locator('#local-auth-email').evaluate(input => input.readOnly));
        assert.equal(await page.locator('#local-auth-confirmation').count(), 1);
      } else assert.equal(await page.locator('#local-auth-confirmation').count(), 0);
      const help = page.getByLabel('查看' + (setup ? '设置本机管理员密码' : '登录工作台') + '说明');
      await help.scrollIntoViewIfNeeded();
      const before = await page.locator('#local-auth-email').boundingBox();
      assert.equal(await page.locator('.local-auth-card .title-help').getAttribute('open'), null);
      await help.click();
      assert.notEqual(await page.locator('.local-auth-card .title-help').getAttribute('open'), null);
      assert.deepEqual(await page.locator('#local-auth-email').boundingBox(), before);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.local-auth-card .title-help').getAttribute('open'), null);
      await page.locator('#local-auth-password').fill('layout-fixture-only');
      await page.locator('.local-auth-password-toggle').first().press('Enter');
      assert.equal(await page.locator('#local-auth-password').getAttribute('type'), 'text');
      await page.locator('.local-auth-password-toggle').first().press('Enter');
      assert.equal(await page.locator('#local-auth-password').getAttribute('type'), 'password');
      await page.locator('#local-auth-password').fill('');
      await page.locator('.local-auth-header').click({ position: { x: 3, y: 3 } });
      await page.evaluate(() => scrollTo(0,0));
      if (output && (width === 1440 || width === 390))
        await page.screenshot({ path: join(output, `${mode}-${width}-${theme}.png`), fullPage: true });
      rows.push({ mode,width,theme,...bounds });
    }
  }
  setup = false;
  for (const width of [1440,390,320]) for (const theme of ['light','dark']) {
    await page.setViewportSize({ width, height: width > 900 ? 960 : 844 });
    await page.goto(origin + '/?auth_reason=expired');
    await page.locator('#local-auth-password').waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.locator('.local-auth-reason').textContent(), '登录已到期，请重新登录。');
    await page.locator('#local-auth-email').fill('layout@example.test');
    await page.locator('#local-auth-password').fill('layout-fixture-only');
    pending = Promise.withResolvers();
    const previous = loginCalls;
    const submit = page.locator('.local-auth-form button[type="submit"]');
    await submit.click();
    await page.waitForFunction(() => document.querySelector('.local-auth-form').getAttribute('aria-busy') === 'true');
    assert(await submit.isDisabled());
    assert.equal(await submit.textContent(), '正在登录…');
    await page.locator('.local-auth-form').dispatchEvent('submit');
    pending.resolve();
    await page.locator('.local-auth-error:not([hidden])').waitFor();
    pending = undefined;
    assert.equal(loginCalls, previous + 1, 'pending submit must not duplicate login');
    assert.equal(await page.locator('#local-auth-password').inputValue(), '');
    assert.equal(await page.locator('#local-auth-email').inputValue(), 'layout@example.test');
    assert.equal(await submit.isDisabled(), false);
    assert.equal(await submit.textContent(), '登录');
    const bounds = await check(`error ${width} ${theme}`);
    if (output && width === 390)
      await page.screenshot({path:join(output,`error-${width}-${theme}.png`),fullPage:true});
    rows.push({mode:'error',width,theme,...bounds});
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests.external,[]);
  assert.deepEqual(requests.unavailable,[]);
  if(output) await writeFile(join(output,'layout-result.json'),JSON.stringify({passed:true,cases:rows.length,errors,rows},null,2));
});
