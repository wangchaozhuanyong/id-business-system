import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';
import { interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';

// All requests stay inside the disposable demo host; no business writes or external calls.
test('recharge transitions keep content and geometry through delayed, superseded and failed loads', { timeout: 90_000 }, async t => {
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
  if (output) await mkdir(output, { recursive: true });
  const results = [];

  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const statusPath = '/integrations/codexdaichong/status';
      let statusChecks = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname === statusPath) statusChecks++;
      });
      page.setDefaultTimeout(8000);
      if (offline) await interceptDesign(page.context(), { localFixtures: {} });
      if (!offline) await page.route('**/*', route => new URL(route.request().url()).origin === origin &&
        ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
      const frameSelector = '#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])';
      const frame = () => page.frameLocator(frameSelector);
      const idle = () => page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const startProbe = () => page.evaluate(() => {
        const probe = { running: true, frames: [] };
        window.__layoutTransitionProbe = probe;
        function tick() {
          const frame = document.querySelector('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])');
          const bar = document.querySelector('#main > [data-page-region]:not([hidden]) .recharge-integration__toolbar');
          probe.frames.push({ height: frame?.getBoundingClientRect().height || 0,
            view: frame?.dataset.view, toolbarHeight: bar?.getBoundingClientRect().height,
            documentHeight: document.documentElement.scrollHeight,
            ...(frame?.dataset.view === 'bit-login' ? {
              form: Boolean(frame.contentDocument?.querySelector('#bit-login-form')),
              theme: frame.contentDocument?.documentElement.dataset.theme,
              scroll: scrollY
            } : {}),
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
        assert.equal(statusChecks, 1, '首次打开应检查服务');
        if (dark) await page.locator('#theme-toggle').click();
        await settle();
        const before = await page.locator(frameSelector).boundingBox();
        const started = Promise.withResolvers();
        const release = Promise.withResolvers();
        await page.route('**/integrations/codexdaichong/admin?view=dashboard', async route => {
          started.resolve();
          await release.promise;
          await (offline ? route.fallback() : route.continue()).catch(() => {});
        }, { times: 1 });
        await startProbe();
        try {
          await page.locator('button[data-view="dashboard"]').click();
          await started.promise;
          const progress = page.locator('.design-region-progress:not([hidden])');
          await progress.waitFor();
          assert.equal(await progress.textContent(), '', '切换只显示进度线');
          assert((await progress.boundingBox()).height <= 3, '进度线不能遮住内容');
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
        assert.equal(statusChecks, 1, '切换充值页签时复用已确认的服务状态');

        // Returning to the workspace and admin entries should load their pages without probing again.
        await page.evaluate(() => { location.hash = '#/workspace/recharge'; });
        await page.locator('[data-recharge-module="workspace"] iframe:not([hidden])').waitFor();
        await idle();
        await page.evaluate(() => { location.hash = '#/online-recharge/chatgpt'; });
        await frame().locator('#querySection').waitFor();
        await idle();
        assert.equal(statusChecks, 1, '兑换开通和充值管理共用已确认的服务状态');

        const oldFrame = await page.locator(frameSelector).evaluateHandle(n => n);
        await page.route('**' + statusPath, route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
        await page.locator('[data-action="ops-integrated-refresh"]').click();
        await idle();
        assert.equal(statusChecks, 2, '主动刷新重新检查服务');
        assert(await page.locator(frameSelector).evaluate((n, old) => n === old, oldFrame), '刷新失败替换了现有内容');
        await oldFrame.dispose();
        await page.locator('[data-action="ops-integrated-refresh"]').click();
        await idle();
        assert.equal(statusChecks, 3, '恢复后重新记录服务状态');

        // Identity cleanup must discard every retained page before the next entry.
        await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
        assert.equal(await page.locator('#main [data-page-region]').count(), 0);
        const expired = route => route.fulfill({ status: 401, json: { message: '请通过统一账号登录' } });
        await page.route('**' + statusPath, expired, { times: 1 });
        await page.evaluate(() => { location.hash = '#/workspace/recharge'; });
        const denied = page.locator('[data-recharge-module="workspace"] [data-unavailable="401"]');
        await denied.getByRole('button', { name: /去登录/ }).waitFor();
        await idle();
        assert.equal(statusChecks, 4, '身份清理后的新页面重新核验会话');

        await page.setViewportSize({ width, height: 460 });
        const navigate = async route => {
          if (width <= 900) await page.locator('#nav-toggle').click();
          await page.locator(`#sidebar a[href="#/${route}"]`).click();
        };
        const bitSelector = '.recharge-integration__frame--bit-local';
        const bitReady = () => page.locator(bitSelector + ':not([hidden])').waitFor();
        const bitStarted = Promise.withResolvers();
        const bitRelease = Promise.withResolvers();
        await page.route('**/integrations/bitbrowser/local-login', async route => {
          bitStarted.resolve();
          await bitRelease.promise;
          await (offline ? route.fallback() : route.continue()).catch(() => {});
        }, { times: 1 });
        await startProbe();
        try {
          await navigate('recharge/start');
          await bitStarted.promise;
          await page.locator('[data-recharge-module="bit"] .design-region-progress:not([hidden])').waitFor();
          assert.equal(await page.locator(bitSelector + ':not([hidden])').count(), 0, '未测量的比特登录空框不应可见');
        } finally { bitRelease.resolve(); }
        await bitReady();
        await settle();
        const bitFirst = (await stopProbe()).filter(sample => sample.view === 'bit-login');
        const bitHeight = (await page.locator(bitSelector).boundingBox()).height;
        assert(bitFirst.length > 0 && bitFirst.every(sample =>
          sample.form && sample.theme === (dark ? 'dark' : 'light') &&
          Math.abs(sample.height - bitHeight) <= 1 && !sample.overflow),
        '比特登录首帧应包含完整表单、正确主题和测量后的高度');

        await page.evaluate(() => scrollTo(0, 180));
        await settle();
        const bitScroll = await page.evaluate(() => scrollY);
        assert(bitScroll > 0, '比特登录页面必须覆盖实际滚动');
        await navigate('workspace/order/gpt');
        await page.locator('#commerce-payment').waitFor();
        await startProbe();
        await navigate('recharge/start');
        await bitReady();
        await settle();
        const bitReturned = (await stopProbe()).filter(sample => sample.view === 'bit-login');
        assert(bitReturned.length > 0 && bitReturned.every(sample => sample.scroll === bitScroll),
          '返回比特登录的第一个可见帧应恢复阅读位置');
        if (width === 1440 && !dark) {
          await page.frameLocator(bitSelector).getByRole('button', { name: '地址管理' }).click();
          const addressList = page.locator('#bit-address-list');
          await addressList.getByText('暂无地址', { exact: true }).waitFor();
          const releaseAddressRead = Promise.withResolvers();
          await page.route('**/api/local/bitbrowser-addresses?*', async route => {
            await releaseAddressRead.promise;
            await route.fulfill({ status: 503, json: { error: '地址读取暂时失败' } });
          }, { times: 1 });
          const refreshAddresses = page.getByRole('dialog').getByRole('button', { name: '刷新', exact: true });
          try {
            await refreshAddresses.click();
            const progress = page.locator('[data-bit-address-read-status]:not([hidden])');
            await progress.waitFor();
            assert.equal(await progress.textContent(), '');
            assert((await progress.boundingBox()).height <= 3);
            assert(await refreshAddresses.isDisabled());
            await addressList.getByText('暂无地址', { exact: true }).waitFor();
          } finally {
            releaseAddressRead.resolve();
          }
          await page.getByText(/地址读取暂时失败/).waitFor();
          await addressList.getByText('暂无地址', { exact: true }).waitFor();
          await page.getByRole('button', { name: '关闭抽屉' }).click();
        }
        assert.deepEqual(errors, []);
        if (output) await page.screenshot({ path: join(output, `transition-${width}-${dark ? 'dark' : 'light'}.png`) });
        results.push({ width, theme: dark ? 'dark' : 'light', delayed, rapid, bitFirst, bitReturned, retainedOnFailure: true });
      } finally { await page.close(); }
    });
  }
  if (output) await writeFile(join(output, 'transition-frames.json'), JSON.stringify(results, null, 2));
});
