import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const subscription = 'subscriptions/claude';
const recharge = 'online-recharge/chatgpt';
const panelSelector = '#subscriptions-panel';
const frameSelector = '#main > [data-page-region]:not([hidden]) iframe:not([hidden])';
const actor = { id: 'transition-admin', name: '隔离验收管理员', role: 'super' };
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/subscription-transition-fix-20261110';

test('订阅与银行卡池切换保留几何框架、清除敏感资料并隔离迟到响应', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(output, { recursive: true });
  const measurements = [];
  t.after(() => writeFile(output + '/subscription-frames.json', JSON.stringify(measurements, null, 2)));

  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const total of [0, 43]) {
    await t.test(`${width}px ${theme} ${total ? '有记录' : '空列表'}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const requests = await interceptDesign(context, { actor, localFixtures: { 'auth/session': { configured: true, actor } } });
      const gates = [], errors = [], calls = [];
      let pending, sequence = 0, settingsGate;
      const hold = (status = 200, late = false) => {
        const gate = { status, late, started: Promise.withResolvers(), released: Promise.withResolvers(), done: Promise.withResolvers() };
        pending = gate; gates.push(gate); return gate;
      };
      await context.route('**/api/local/subscriptions/list', async route => {
        const parameters = route.request().postDataJSON();
        calls.push(parameters);
        const id = ++sequence, gate = pending;
        pending = undefined;
        const rows = Array.from({ length: parameters.query === '空结果' ? 0 : total }, (_, i) => ({
          id: `transition-row-${i}`, product: 'Claude', account: `transition-${i}@example.test`,
          registrationEmail: `transition-${i}@example.test`, ownerName: '', conflict: false,
          series: [{ plan: gate?.late ? 'LATE-CANCELLED' : 'Pro', start: '2026-11-01 10:00',
            expiry: '2026-12-01 10:00', status: 'active', remainingDays: 21 }], history: [],
          queryCode: { status: 'missing', remainingDays: null }, operatorName: '隔离样例'
        }));
        const page = Math.min(parameters.page, Math.max(1, Math.ceil(rows.length / parameters.pageSize)));
        const data = { items: rows.slice((page - 1) * parameters.pageSize, page * parameters.pageSize),
          total: rows.length, page, pageSize: parameters.pageSize,
          counts: { active: rows.length, expired: 0, pending: 0, ended: 0 }, revision: `transition-${id}`, now: new Date().toISOString() };
        if (gate) { gate.started.resolve(); await gate.released.promise; }
        await route.fulfill({ status: gate?.status || 200, json: gate?.status >= 400 ? { error: '隔离读取失败' } : data }).catch(() => {});
        gate?.done.resolve();
      });
      await context.route('**/api/local/claude-google-subscriptions/copy-settings', async route => {
        assert.equal(route.request().method(), 'GET', '本测试不保存设置');
        settingsGate.started.resolve(); await settingsGate.released.promise;
        await route.fulfill({ json: { version: 1, copy1: '', copy2: '' } }).catch(() => {});
      });
      const page = await context.newPage(); page.setDefaultTimeout(6000);
      page.on('pageerror', error => errors.push(error.message));
      const ready = () => page.locator(panelSelector + ' > .design-async-region[aria-busy="false"]').waitFor();
      const panelHeight = () => page.locator(panelSelector).evaluate(node => node.getBoundingClientRect().height);
      const navigate = async route => {
        if (width <= 900) await page.locator('#nav-toggle').click();
        const link = page.locator(`#sidebar a[href="#/${route}"]`);
        if (!await link.isVisible()) {
          const group = await page.evaluate(route => window.IDDesignAPI.navigation.find(([, , items]) => items.some(([, key]) => key === route))[0], route);
          await page.locator('#sidebar').getByRole('button', { name: group, exact: true }).click();
        }
        await link.click();
        await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
      };
      const startProbe = () => page.evaluate(() => {
        const probe = window.subscriptionTransitionProbe = { running: true, frames: [] };
        const tick = () => {
          const main = document.getElementById('main'), region = main.querySelector(':scope > [data-page-region]:not([hidden])');
          const panel = region?.querySelector('#subscriptions-panel'), frame = region?.querySelector('iframe:not([hidden])');
          const progress = panel?.querySelector('[data-region-loading]:not([hidden])');
          probe.frames.push({ route: main.dataset.layoutRoute, height: panel?.getBoundingClientRect().height,
            frameHeight: frame?.getBoundingClientRect().height, frameView: frame?.dataset.view,
            progressHeight: progress?.getBoundingClientRect().height || 0,
            overflow: document.documentElement.scrollWidth > innerWidth });
          if (probe.running) requestAnimationFrame(tick);
        };
        tick();
      });
      const stopProbe = () => page.evaluate(() => { window.subscriptionTransitionProbe.running = false; return window.subscriptionTransitionProbe.frames; });
      const record = async direction => {
        await settle(page);
        const frames = await stopProbe();
        measurements.push({ width, theme, total, direction, frames });
        assert(frames.every(frame => !frame.overflow));
        return frames;
      };
      const unchanged = (frames, key, value) => assert(frames.length >= 3 && frames.every(frame => Math.abs(frame[key] - value) <= 1),
        JSON.stringify({ key, value, observed: [...new Set(frames.map(frame => frame[key]))] }));
      try {
        await page.goto(origin + '/#/' + subscription); await ready();
        if (theme === 'dark') await toggleDesignTheme(page);
        await settle(page);
        const original = await panelHeight();
        const oldPanel = await page.locator(panelSelector).elementHandle();
        await navigate(recharge);
        assert(!await oldPanel.evaluate(node => node.textContent.includes('SYNTHETIC-')), '离页后的旧 DOM 应清除资料');
        await oldPanel.dispose();
        await page.locator('[data-view="cards"]').first().click();
        await page.frameLocator(frameSelector).locator('#cards.active').waitFor(); await settle(page);
        const cardHeight = await page.locator(frameSelector).evaluate(node => node.getBoundingClientRect().height);
        for (let i = 0; i < 2; i++) {
          const gate = hold(); await startProbe(); await navigate(subscription); await gate.started.promise;
          await page.locator('#subscription-read-status:not([hidden])').waitFor();
          assert.equal(await page.locator('#subscription-list tr[data-row-id]').count(), 0, '重新读取前不显示旧资料');
          assert(!await page.locator(panelSelector).evaluate(node => /SYNTHETIC-|transition-\d+@/.test(node.textContent)));
          await settle(page); gate.released.resolve(); await ready();
          const forward = (await record('cards-to-subscriptions')).filter(frame => frame.route === subscription);
          unchanged(forward, 'height', original);
          assert(forward.some(frame => frame.progressHeight === 3), '覆盖实际延迟加载线');
          await startProbe(); await navigate(recharge);
          await page.frameLocator(frameSelector).locator('#cards.active').waitFor();
          await page.waitForTimeout(180);
          const backward = (await record('subscriptions-to-cards')).filter(frame => frame.route === recharge);
          unchanged(backward, 'frameHeight', cardHeight);
        }

        // Cancelled reads must not replace a later successful visit.
        const late = hold(200, true); await navigate(subscription); await late.started.promise;
        await navigate(recharge); await navigate(subscription); await ready();
        late.released.resolve(); await late.done.promise; await settle(page);
        assert(!await page.locator(panelSelector).evaluate(node => node.textContent.includes('LATE-CANCELLED')));

        const form = await page.locator('#subscription-filter').elementHandle();
        const search = page.locator('#subscription-query');
        const failure = hold(503); const beforeRefresh = await panelHeight();
        await page.locator('[data-action="subscriptions-refresh"]').click(); await failure.started.promise;
        await page.locator('#subscription-read-status:not([hidden])').waitFor();
        await search.fill('未提交的搜索内容');
        assert.equal(await panelHeight(), beforeRefresh, '加载文字不得撑高页面');
        failure.released.resolve(); await ready();
        await page.locator('#subscription-read-error').getByText(/已保留上次读取的资料/).waitFor();
        assert.equal(await search.inputValue(), '未提交的搜索内容');
        assert(await page.locator('#subscription-filter').evaluate((node, previous) => node === previous, form));
        assert.equal(await page.locator('#subscription-list tr[data-row-id]').count(), total ? 20 : 0);
        await page.locator('[data-action="subscriptions-refresh"]').click(); await ready();
        assert(await page.locator('#subscription-read-error').isHidden());
        await form.dispose();

        if (total) {
          const firstHeight = await panelHeight();
          for (let i = 0; i < 2; i++) {
            await page.getByRole('button', { name: '下一页', exact: true }).focus();
            await page.keyboard.press('Enter'); await ready();
            assert(await page.evaluate(() => Boolean(document.activeElement.closest('#subscription-list .pagination'))), '异步翻页完成后保留键盘操作位置');
          }
          assert.equal(calls.at(-1).page, 3); assert.equal(await page.locator('#subscription-list tr[data-row-id]').count(), 3);
          assert.equal(await panelHeight(), firstHeight, '末页不缩小表格框架');
          await page.locator('#subscription-list [data-pagination-size]').selectOption('10'); await ready();
          assert.equal(calls.at(-1).pageSize, 10); assert.equal(calls.at(-1).page, 1);
          const fullHeight = await panelHeight();
          await search.fill('空结果'); await search.press('Enter'); await ready();
          assert.equal(await page.locator('#subscription-list tr[data-row-id]').count(), 0);
          assert.equal(await panelHeight(), fullHeight, '空结果不缩小表格框架');
          await search.fill(''); await search.press('Enter'); await ready();
        }

        // The same shared loading primitive also serves a drawer form.
        settingsGate = { started: Promise.withResolvers(), released: Promise.withResolvers() }; gates.push(settingsGate);
        await page.locator('[data-action="subscriptions-settings"]').click(); await settingsGate.started.promise;
        const input = page.locator('#subscription-copy1'), bounds = await input.boundingBox();
        await page.locator('#subscription-settings-status:not([hidden])').waitFor();
        assert.deepEqual(await input.boundingBox(), bounds, '抽屉加载反馈不移动输入');
        await input.fill('读取期间的新输入'); settingsGate.released.resolve();
        await page.locator('#subscription-settings-form [type="submit"]:enabled').waitFor();
        assert.equal(await input.inputValue(), '读取期间的新输入');
        await page.keyboard.press('Escape');
        await page.locator('#drawer').waitFor({ state: 'hidden' });
        if (width === 1440 && theme === 'light' && total) {
          const firstFailure = hold(503);
          await page.evaluate(() => { window.IDDesignAPI.clearPageRegions(); window.IDDesignAPI.render(); });
          await firstFailure.started.promise;
          assert(!await page.locator(panelSelector).evaluate(node => node.textContent.includes('SYNTHETIC-')), '身份清理后不保留旧资料');
          assert.equal(await page.locator('#subscription-list .pagination').count(), 0, '首次未读取时不显示虚假的零条总数');
          firstFailure.released.resolve(); await ready();
          await page.locator('#subscription-list').getByRole('heading', { name: '读取订阅资料失败，请刷新重试', exact: true }).waitFor();
          await page.locator('[data-action="subscriptions-refresh"]').click(); await ready();
          assert.equal(await page.locator('#subscription-list tr[data-row-id]').count(), 10, '保留用户选中的每页条数');
        }
        await page.screenshot({ path: output + `/subscriptions-${width}-${theme}-${total}.png` });
        assert.deepEqual(errors, []); assert.deepEqual(requests.unavailable, []); assert.deepEqual(requests.external, []);
      } finally {
        gates.forEach(gate => gate.released.resolve());
        await context.close();
      }
    });
  }
});
