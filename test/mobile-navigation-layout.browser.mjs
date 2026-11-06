import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';

test('mobile navigation remains reachable without losing the long-page reading position', { timeout: 45_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
  const host = offline ? { url: offlineOrigin + '/' } : await startCodexdaichongDemoSite(0);
  if (!offline) t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const origin = new URL(host.url).origin;
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  const results = [];
  if (output) await mkdir(output, { recursive: true });
  for (const width of [900, 768, 390, 320]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      if (offline) await interceptDesign(page.context(), { localFixtures: {} });
      page.setDefaultTimeout(5000);
      await page.route('**/*', route => new URL(route.request().url()).origin === origin &&
        ['GET', 'HEAD'].includes(route.request().method()) ? (offline ? route.fallback() : route.continue()) : route.abort());
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      try {
        await page.goto(origin + '/#/workspace/order/gpt');
        await page.locator('#commerce-payment').waitFor();
        if (dark) await page.locator('#theme-toggle').click();
        // The first route restores its scroll position on the next animation frame.
        // Finish that initial paint before starting the reading-position scenario.
        await settle();
        await page.evaluate(() => scrollTo(0, 600));
        await settle();
        const before = await page.evaluate(() => scrollY);
        assert(before > 0);
        const header = await page.locator('.topbar').boundingBox();
        assert(header.y >= 0 && header.y + header.height <= 900, '手机长页的导航入口已滚出视口');
        await page.locator('#nav-toggle').click();
        assert.equal(await page.evaluate(() => scrollY), before, '打开侧栏不应先滚回顶部');
        await page.locator('#sidebar-shade').click({ position: { x: width - 8, y: 200 } });
        await settle();
        assert(await page.locator('#nav-toggle').evaluate((button) => button === document.activeElement));
        assert.equal(await page.evaluate(() => scrollY), before, '取消侧栏不应改变阅读位置');
        await page.locator('#nav-toggle').click();
        await page.locator('#sidebar a[href="#/customers/new"]').click();
        await page.locator('#commerce-contact-name').waitFor();
        await settle();
        await page.locator('#nav-toggle').click();
        await page.locator('#sidebar a[href="#/workspace/order/gpt"]').click();
        await page.locator('#commerce-payment').waitFor();
        await settle();
        await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 1);
        await page.waitForFunction((position) => scrollY === position, before);
        assert.equal(await page.evaluate(() => scrollY), before, '手机侧栏切页返回未恢复阅读位置');
        assert.equal(await page.locator('#nav-toggle').getAttribute('aria-expanded'), 'false');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        results.push({ width, theme: dark ? 'dark' : 'light', before, after: await page.evaluate(() => scrollY), headerTop: header.y });
        if (output) await page.screenshot({ path: join(output, `mobile-navigation-${width}-${dark ? 'dark' : 'light'}.png`) });
      } finally { await page.close(); }
    });
  }
  if (output) await writeFile(join(output, 'mobile-navigation.json'), JSON.stringify(results, null, 2));
});
