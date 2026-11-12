import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';
import { fixtures } from './helpers/visual-redesign-fixtures.mjs';

const output = root + '/.runtime/visual-redesign-20261110';

test('全站视觉：截图、图表、音效、对比度、键盘与窄屏', { timeout: 90_000 }, async t => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: fixtures });
  await context.addInitScript(() => {
    window.audioAudit = { contexts: 0, tones: 0 };
    window.AudioContext = class {
      constructor() { window.audioAudit.contexts++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
      async resume() { if (window.rejectAudio) throw Error('unavailable'); this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {}, start() { window.audioAudit.tones++; }, stop() { this.onended?.(); } }; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {} }; }
    };
  });
  const page = await context.newPage(), errors = [], securityErrors = [];
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|inline style/i.test(message.text())) securityErrors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/overview');
  page.setDefaultTimeout(6000);
  await page.waitForFunction(() => document.querySelector('.overview-metric-value strong')?.textContent === '28');
  await page.screenshot({ path: output + '/after-overview-desktop.png', fullPage: true });
  const routes = await page.evaluate(() => window.IDDesignAPI.navigation.flatMap(([group, , rows]) =>
    rows.map(([title, route, placeholder]) => ({ group, title, route, placeholder: Boolean(placeholder) }))));
  await writeFile(output + '/route-inventory.json', JSON.stringify(routes, null, 2));

  await t.test('图表可通过键盘逐项读取，提示浮层不改变布局', async () => {
    const point = page.locator('.overview-chart-data [data-chart-point]').first();
    const before = await page.locator('.overview-columns').first().boundingBox();
    await point.focus();
    await page.keyboard.press('ArrowRight');
    assert(await page.locator('.overview-chart-data [data-chart-point]').nth(1).evaluate(n => n === document.activeElement));
    assert(await page.locator('.overview-chart-data [role=tooltip]').isVisible());
    assert.deepEqual(await page.locator('.overview-columns').first().boundingBox(), before);
    await page.keyboard.press('Escape');
    assert(await page.locator('.overview-chart-data [role=tooltip]').isHidden());
    await page.locator('.overview-daily summary').click();
    assert.equal(await page.locator('.overview-daily li').count(), 7);
    await page.locator('.overview-daily summary').click();
  });

  await t.test('音效默认关闭、主动开启、限流、零音量、关闭与重载', async () => {
    await page.getByRole('button', { name: '近 30 天', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.audioAudit), { contexts: 0, tones: 0 });
    await page.getByLabel('界面音效设置').click();
    await page.getByLabel('开启轻音效').check();
    assert.equal(await page.locator('[data-sound-label]').innerText(), '音效开');
    const before = await page.evaluate(() => window.audioAudit.tones);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) window.IDInteractionSound.play('success'); });
    assert.equal((await page.evaluate(() => window.audioAudit.tones)) - before, 1);
    await context.route(origin + '/interaction-sound-fixture.html', route => route.fulfill({ contentType: 'text/html', body: '<button id="sound-control">嵌入按钮</button>' }));
    await page.evaluate(origin => { const frame = document.createElement('iframe'); frame.id = 'sound-test-frame'; frame.src = origin + '/interaction-sound-fixture.html'; document.getElementById('main').append(frame); }, origin);
    await page.frameLocator('#sound-test-frame').locator('#sound-control').waitFor();
    await page.waitForTimeout(320);
    const beforeFrame = await page.evaluate(() => window.audioAudit.tones);
    await page.frameLocator('#sound-test-frame').locator('#sound-control').click();
    assert.equal(await page.evaluate(() => window.audioAudit.tones), beforeFrame, '同源嵌入页的普通点击保持静音');
    await page.evaluate(() => document.getElementById('sound-test-frame').remove());
    await page.getByLabel('界面音效设置').click();
    await page.locator('#sound-volume').waitFor();
    await page.locator('#sound-volume').press('Home');
    const muted = await page.evaluate(() => window.audioAudit.tones);
    await page.evaluate(() => window.IDInteractionSound.play('success'));
    assert.equal(await page.evaluate(() => window.audioAudit.tones), muted);
    await page.getByLabel('开启轻音效').uncheck();
    assert.equal(await page.locator('[data-sound-label]').innerText(), '音效关');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#interaction-preferences').getAttribute('open'), null);
    await page.reload();
    assert.deepEqual(await page.evaluate(() => window.audioAudit), { contexts: 0, tones: 0 });
    await page.getByLabel('界面音效设置').click();
    await page.evaluate(() => { window.rejectAudio = true; });
    await page.getByLabel('开启轻音效').click();
    await page.waitForFunction(() => !document.getElementById('sound-enabled').checked);
    assert.match(await page.locator('#sound-state').innerText(), /无法开启音效/);
    await page.keyboard.press('Escape');
  });

  await t.test('订单趋势从有数据切换为空状态时保留图表框架', async () => {
    const emptyContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const orders = fixtures.commerce.data.orders;
    const filtered = { ...fixtures, commerce: { version: 1, data: { ...fixtures.commerce.data,
      orders: orders.filter((_, i) => i % 7 !== 0) } } };
    await interceptDesign(emptyContext, { localFixtures: filtered });
    const emptyPage = await emptyContext.newPage();
    emptyPage.setDefaultTimeout(6000);
    const selectRange = async label => {
      const compact = emptyPage.getByRole('combobox', { name: '统计时间范围' });
      if (await compact.isVisible()) await compact.selectOption({ label });
      else await emptyPage.getByRole('button', { name: label, exact: true }).click();
    };
    try {
      await emptyPage.goto(origin + '/#/overview');
      await emptyPage.waitForFunction(() => document.querySelector('.overview-metric-value strong')?.textContent === '24');
      for (const width of [1920, 1440, 390, 320]) {
        await emptyPage.setViewportSize({ width, height: 1080 });
        await selectRange('近 7 天');
        await settle(emptyPage);
        const before = await emptyPage.locator('[aria-labelledby="overview-trend"]').boundingBox();
        await selectRange('今日');
        await settle(emptyPage);
        const after = await emptyPage.locator('[aria-labelledby="overview-trend"]').boundingBox();
        assert(Math.abs(after.height - before.height) <= 2, width + ': 图表空状态改变框架 ' + before.height + '/' + after.height);
      }
    } finally { await emptyContext.close(); }
  });

  const measurements = [];
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(200);
      const primary = page.locator('.overview-toolbar .button.primary');
      if (await primary.isVisible()) {
        await primary.hover();
        assert(await primary.evaluate(node => {
        const expected = document.createElement('span');
        expected.style.color = 'var(--on-primary)';
        node.append(expected);
        const matches = getComputedStyle(node).color === getComputedStyle(expected).color;
        expected.remove();
        return matches;
        }), width + '/' + theme + ' 主要按钮悬停文字不可读');
      }
      const snapshot = await page.evaluate(() => {
        const rect = n => { const r = n.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height }; };
        const headings = [...document.querySelectorAll('.overview-metric h2')].map(rect);
        const columns = [...document.querySelectorAll('.overview-columns')].map(n => [...n.children].map(rect));
        return { overflow: document.documentElement.scrollWidth > innerWidth, headings, columns };
      });
      assert(!snapshot.overflow, width + '/' + theme + ' 页面溢出');
      for (const [a, b] of snapshot.columns) if (a.left !== b.left) assert(Math.abs(a.top - b.top) < 1);
      await page.locator('.overview-metric .title-help summary').first().click();
      const popover = page.locator('.title-description:popover-open');
      const box = await popover.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width + 1);
      await page.keyboard.press('Escape');
      const soundTrigger = page.getByLabel('界面音效设置');
      const mobileTools = page.locator('#mobile-tools-toggle');
      if (!(await soundTrigger.isVisible())) await mobileTools.click();
      await soundTrigger.click();
      await page.locator('#sound-settings').waitFor({ state: 'visible' });
      const soundBox = await page.locator('#sound-settings').boundingBox();
      assert(soundBox.x >= 0 && soundBox.x + soundBox.width <= width + 1);
      await page.keyboard.press('Escape');
      if (await page.locator('#mobile-tools-panel').evaluate(node => node.matches(':popover-open'))) await mobileTools.click();
      measurements.push({ width, theme, ...snapshot });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await settle(page);
      if ([1440, 390].includes(width))
        await page.screenshot({ path: output + '/after-overview-' + width + '-' + theme + '.png', fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  for (const route of ['orders/gpt', 'orders/statistics', 'workspace/order/gpt', 'customers/list', 'plugins/mailboxes', 'online-recharge/chatgpt']) {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
    await settle(page);
    await page.screenshot({ path: output + '/after-' + route.replaceAll('/', '-') + '.png', fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim()), '0ms');
  assert.deepEqual(errors, []);
  assert.deepEqual(securityErrors, []);
  assert.deepEqual(requests.unavailable, []);
  assert.deepEqual(requests.external, []);
  await writeFile(output + '/visual-measurements.json', JSON.stringify(measurements, null, 2));
});
