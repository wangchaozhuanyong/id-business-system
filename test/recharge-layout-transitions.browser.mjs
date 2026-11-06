import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';

// All requests stay inside the disposable demo host; no business writes or external calls.
test('recharge transitions keep content and geometry through delayed, superseded and failed loads', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const host = await startCodexdaichongDemoSite(0);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const origin = new URL(host.url).origin;
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];

  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(8000);
      await page.route('**/*', route => new URL(route.request().url()).origin === origin &&
        ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
      const frameSelector = '.recharge-integration__content iframe:not([hidden])';
      const frame = () => page.frameLocator(frameSelector);
      const idle = () => page.locator('.recharge-integration__view[aria-busy="false"]').waitFor();
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const startProbe = () => page.evaluate(() => {
        const probe = { running: true, frames: [] };
        window.__layoutTransitionProbe = probe;
        function tick() {
          const frame = document.querySelector('.recharge-integration__content iframe:not([hidden])');
          const bar = document.querySelector('.recharge-integration__toolbar');
          probe.frames.push({ height: frame?.getBoundingClientRect().height || 0,
            view: frame?.dataset.view, toolbarHeight: bar?.getBoundingClientRect().height,
            documentHeight: document.documentElement.scrollHeight,
            overflow: document.documentElement.scrollWidth > innerWidth });
          if (probe.running) requestAnimationFrame(tick);
        }
        tick();
      });
      const stopProbe = () => page.evaluate(() => {
        window.__layoutTransitionProbe.running = false;
        return window.__layoutTransitionProbe.frames;
      });
      const checkFrames = frames => {
        assert(frames.length > 2, '必须覆盖切换中间帧');
        assert(frames.every(f => f.height > 0), '切换过程中出现空白帧');
        assert(frames.every(f => !f.overflow && f.toolbarHeight < 90), '切换过程中导航换行或整页横向溢出');
      };

      try {
        await page.goto(origin + '/#/online-recharge/chatgpt');
        await frame().locator('#querySection').waitFor();
        await idle();
        if (dark) await page.locator('#theme-toggle').click();
        await settle();
        const before = await page.locator(frameSelector).boundingBox();
        const started = Promise.withResolvers();
        const release = Promise.withResolvers();
        await page.route('**/integrations/codexdaichong/admin?view=dashboard', async route => {
          started.resolve();
          await release.promise;
          await route.continue().catch(() => {});
        }, { times: 1 });
        await startProbe();
        try {
          await page.locator('button[data-view="dashboard"]').click();
          await started.promise;
          await page.locator('.design-region-progress:not([hidden])').waitFor();
          assert.equal(await page.locator(frameSelector).getAttribute('data-view'), 'query');
          assert.equal((await page.locator(frameSelector).boundingBox()).height, before.height);
          await settle();
        } finally { release.resolve(); }
        await frame().locator('#dashboard.active').waitFor();
        await idle();
        await settle();
        const after = await page.locator(frameSelector).boundingBox();
        const delayed = await stopProbe();
        checkFrames(delayed);
        assert(delayed.every(f => f.height <= Math.max(before.height, after.height) + 1), '新内容就绪前出现临时撑高');

        // Keep status responses pending long enough to overlap successive user selections.
        const delayStatus = async route => {
          await new Promise(resolve => setTimeout(resolve, 180));
          await route.continue().catch(() => {});
        };
        await page.route('**/integrations/codexdaichong/status', delayStatus);
        await startProbe();
        for (const view of ['query', 'dashboard', 'query', 'dashboard', 'query', 'dashboard', 'query'])
          await page.locator(`button[data-view="${view}"]`).click();
        await frame().locator('#querySection').waitFor();
        await idle();
        await settle();
        const rapid = await stopProbe();
        checkFrames(rapid);
        assert.equal(await page.locator('button[data-view="query"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator(frameSelector).getAttribute('data-view'), 'query');
        await page.unroute('**/integrations/codexdaichong/status', delayStatus);

        const oldFrame = await page.locator(frameSelector).evaluateHandle(n => n);
        await page.route('**/integrations/codexdaichong/status', route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
        await page.locator('[data-action="ops-integrated-refresh"]').click();
        await idle();
        assert(await page.locator(frameSelector).evaluate((n, old) => n === old, oldFrame), '刷新失败替换了现有内容');
        await oldFrame.dispose();
        assert.deepEqual(errors, []);
        if (output) await page.screenshot({ path: join(output, `transition-${width}-${dark ? 'dark' : 'light'}.png`) });
        results.push({ width, theme: dark ? 'dark' : 'light', delayed, rapid, retainedOnFailure: true });
      } finally { await page.close(); }
    });
  }
  if (output) await writeFile(join(output, 'transition-frames.json'), JSON.stringify(results, null, 2));
});
