import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';
import { interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';

const active = '#main > [data-page-region]:not([hidden])';
const frameSelector = active + ' .recharge-integration__content iframe:not([hidden])';
const online = 'online-recharge/chatgpt';
const workspace = 'workspace/recharge';
const bit = 'recharge/start';

test('warm navigation reuses connected page documents, scopes refresh and clears identity state', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
  const host = offline ? { url: offlineOrigin + '/' } : await startCodexdaichongDemoSite(0);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(async () => {
    await browser.close();
    if (!offline) await new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); });
  });
  const origin = new URL(host.url).origin;
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];

  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      if (offline) await interceptDesign(page.context());
      page.setDefaultTimeout(7000);
      const errors = [];
      const requests = { query: 0, admin: 0, workspace: 0, bit: 0 };
      const identities = new Map();
      let adminReads = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/integrations/codexdaichong/api/admin/data') adminReads++;
        if (request.resourceType() !== 'document') return;
        const path = new URL(request.url()).pathname;
        const key = ({
          '/integrations/codexdaichong/redeem': 'query',
          '/integrations/codexdaichong/admin': 'admin',
          '/integrations/codexdaichong/workspace': 'workspace',
          '/integrations/bitbrowser/local-login': 'bit'
        })[path];
        if (key) requests[key]++;
      });
      await page.route('**/*', route => new URL(route.request().url()).origin === origin &&
        ['GET', 'HEAD'].includes(route.request().method()) ? (offline ? route.fallback() : route.continue()) : route.abort());
      const frame = () => page.frameLocator(frameSelector);
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const idle = () => page.locator(active + ' .recharge-integration__view[aria-busy="false"]').waitFor();
      const ready = async route => {
        await page.locator(`${active}[data-page-region="${route}"]`).waitFor();
        await frame().locator(route === bit ? '#bit-login-form' : route === workspace ? '#workspaceOperation' : '#querySection').waitFor();
        await idle();
        await settle();
      };
      const navigate = async route => {
        if (width <= 900) await page.locator('#nav-toggle').click();
        const label = { [online]: '线上代充', [workspace]: '快速操作', [bit]: '管理快捷' }[route];
        const group = page.locator(`#sidebar .nav-group:has(> [data-group="${label}"])`);
        const link = group.locator(`a[href="#/${route}"]`);
        if (!await link.count()) await group.locator('[data-action="nav-group"]').click();
        await link.click();
        await page.waitForURL(origin + '/#/' + route);
        await ready(route);
        if (width <= 900) await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 1);
      };
      const remember = async key => {
        const identity = await page.locator(frameSelector).evaluateHandle(node => ({ node, document: node.contentDocument }));
        identities.set(key, identity);
      };
      const same = async key => assert(await page.locator(frameSelector).evaluate(
        (node, previous) => node === previous.node && node.contentDocument === previous.document,
        identities.get(key)), `${key} 返回时重建了 iframe 或 document`);
      const startProbe = () => page.evaluate(() => {
        const probe = { running: true, frames: [] };
        window.__pageLifecycleProbe = probe;
        const tick = () => {
          const region = document.querySelector('#main > [data-page-region]:not([hidden])');
          const frame = region?.querySelector('iframe:not([hidden])');
          const toolbar = region?.querySelector('.recharge-integration__toolbar');
          probe.frames.push({ route: region?.dataset.pageRegion, height: frame?.getBoundingClientRect().height || 0,
            toolbarHeight: toolbar?.getBoundingClientRect().height || 0,
            overflow: document.documentElement.scrollWidth > innerWidth,
            content: Boolean(frame?.contentDocument?.body?.children.length) });
          if (probe.running) requestAnimationFrame(tick);
        };
        tick();
      });
      const stopProbe = () => page.evaluate(() => {
        window.__pageLifecycleProbe.running = false;
        return window.__pageLifecycleProbe.frames;
      });

      try {
        await page.goto(origin + '/#/' + online);
        await ready(online);
        if (dark) await page.locator('#theme-toggle').click();
        await remember('query');
        await page.locator(`${active} button[data-view="dashboard"]`).click();
        await frame().locator('#dashboard.active').waitFor();
        await idle();
        await remember('admin');
        await startProbe();
        for (const view of ['query', 'dashboard', 'query', 'dashboard', 'query']) {
          await page.locator(`${active} button[data-view="${view}"]`).click();
          await frame().locator(view === 'query' ? '#querySection' : '#dashboard.active').waitFor();
          await idle();
          await same(view === 'query' ? 'query' : 'admin');
          await settle();
        }
        const tabs = await stopProbe();
        assert.deepEqual(requests, { query: 1, admin: 1, workspace: 0, bit: 0 });
        if (width === 1440 && !dark) {
          const hiddenReads = adminReads;
          // Cross the upstream's documented 3-second UI polling interval.
          await page.waitForTimeout(3200);
          assert.equal(adminReads, hiddenReads, '后台页面隐藏后仍在轮询概览数据');
        }

        await navigate(bit);
        await remember('bit');
        await navigate(workspace);
        await remember('workspace');
        await startProbe();
        for (const route of [online, bit, workspace, bit, online, workspace, online]) {
          await navigate(route);
          await same(route === online ? 'query' : route === bit ? 'bit' : 'workspace');
        }
        const sidebar = await stopProbe();
        assert.deepEqual(requests, { query: 1, admin: 1, workspace: 1, bit: 1 }, '普通返回不得重新请求嵌入文档');
        for (const sample of [...tabs, ...sidebar]) {
          assert(sample.height > 0 && sample.content, '已加载页面切换出现空白帧');
          assert(!sample.overflow && sample.toolbarHeight < 90, '切换导致导航换行或页面溢出');
        }

        await page.locator(`${active} button[data-view="dashboard"]`).click();
        await frame().locator('#dashboard.active').waitFor();
        const status = '**/integrations/codexdaichong/status';
        await page.route(status, route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
        await page.locator(`${active} [data-action="ops-integrated-refresh"]`).click();
        await idle();
        await same('admin');
        assert.equal(requests.admin, 1, '服务刷新失败不得重建已有文档');
        await page.locator(`${active} [data-action="ops-integrated-refresh"]`).click();
        await idle();
        await frame().locator('#dashboard.active').waitFor();
        assert.equal(requests.admin, 2, '手动刷新只重建当前分组');
        assert(await identities.get('admin').evaluate(previous => !previous.node.isConnected));
        await page.locator(`${active} button[data-view="query"]`).click();
        await frame().locator('#querySection').waitFor();
        await same('query');
        assert.equal(requests.query, 1, '刷新后台不得销毁查询页面');

        await navigate(bit);
        await frame().locator('html').evaluate(root => { root.dataset.rechargeNavigationLocked = 'true'; });
        if (width <= 900) await page.locator('#nav-toggle').click();
        await page.locator(`#sidebar a[href="#/${workspace}"]`).click();
        await page.getByText('充值任务正在执行，请等待任务处理完成后再切换或刷新。', { exact: true }).waitFor();
        assert.equal(new URL(page.url()).hash, '#/' + bit, '比特登录执行锁未阻止导航');
        await same('bit');
        await frame().locator('html').evaluate(root => { root.dataset.rechargeNavigationLocked = 'false'; });
        // A blocked mobile navigation leaves the menu open.
        if (width <= 900 && await page.locator('#nav-toggle').getAttribute('aria-expanded') === 'true')
          await page.locator('#sidebar-shade').click({ position: { x: width - 8, y: 200 } });
        await navigate(workspace);
        await same('workspace');
        assert.deepEqual(requests, { query: 1, admin: 2, workspace: 1, bit: 1 });
        assert.deepEqual(errors, []);
        await page.getByText('充值任务正在执行，请等待任务处理完成后再切换或刷新。', { exact: true }).waitFor({ state: 'hidden' });
        if (output) await page.screenshot({ path: join(output, `page-lifecycle-${width}-${dark ? 'dark' : 'light'}.png`) });
        await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
        assert.equal(await page.locator('#main [data-page-region]').count(), 0, '身份清理必须移除全部已挂载页面');
        for (const identity of identities.values())
          assert(await identity.evaluate(previous => !previous.node.isConnected));
        results.push({ width, theme: dark ? 'dark' : 'light', requests: { ...requests }, tabs, sidebar });
      } finally {
        for (const identity of identities.values()) await identity.dispose();
        await page.close();
      }
    });
  }
  if (output) await writeFile(join(output, 'page-lifecycle.json'), JSON.stringify(results, null, 2));
});
