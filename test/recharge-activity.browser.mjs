import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

const at = Date.parse('2026-11-12T06:32:18Z');
const id = '3'.repeat(32);
const staff = { id: 'fixture-staff', role: 'employee', name: '演示员工', email: 'staff@example.test', active: true };
const initial = {
  id, plan: 'Pro 200', email: 'li•••@example.test', codeTail: 'Z7K9', jobTail: '78a8f3k2',
  owner: { name: '演示员工' }, createdAt: at - 5000, updatedAt: at, status: 'running', event: 1, unread: true
};

test('the alert uses the live change channel and updates an accessible drawer in desktop and mobile themes', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [1440, true], [390, false], [320, true]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async () => {
      const context = await browser.newContext({ viewport: { width, height: 850 } });
      try {
        await interceptDesign(context, { actor: staff, localFixtures: {}, changeEvents: true, skipRechargeAssets: true });
        await context.addInitScript(() => {
          const original = window.fetch.bind(window);
          const frame = (type, version) => new TextEncoder().encode('event: ' + type + '\ndata: ' +
            JSON.stringify({ schema: 1, versions: { 'recharge-activity': version } }) + '\n\n');
          window.fetch = (input, options) => {
            if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
            return Promise.resolve(new Response(new ReadableStream({ start(controller) {
              window.emitRechargeRevision = (version, type = 'change') => controller.enqueue(frame(type, version));
              controller.enqueue(frame('snapshot', 'initial'));
            } }), { headers: { 'Content-Type': 'text/event-stream' } }));
          };
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let rows = [], read = [];
        await page.route('**/api/local/recharge-activity**', async route => {
          const url = new URL(route.request().url()), path = '/api/local/recharge-activity';
          if (url.pathname === path) return route.fulfill({ json: { items: rows, coverage: 'ready',
            unread: rows.filter(row => row.unread).length, page: 1, pages: 1 } });
          const row = rows.find(item => item.id === url.pathname.split('/')[4]);
          if (!row) return route.fulfill({ status: 404, json: { error: '未找到代充动态' } });
          if (route.request().method() === 'POST') {
            read.push([row.id, url.searchParams.get('event')]);
            row.unread = false;
            return route.fulfill({ json: { read: true } });
          }
          return route.fulfill({ json: { ...row, fullCode: 'FIXTURE-RECHARGE-Z7K9', batchNo: 'PC-DEMO-1',
            events: [{ status: 'running', at }, ...(row.status === 'review'
              ? [{ status: 'review', at: at + 10_000, reason: '付款结果待核对，请勿重复提交' }] : [])] } });
        });
        await page.goto(origin + '/#/workspace/order/gpt');
        if (dark) await toggleDesignTheme(page);
        const toggle = page.locator('#recharge-activity-toggle');
        const toast = page.locator('#recharge-activity-toast');
        const drawer = page.locator('#drawer');
        await toggle.waitFor();
        assert(await toast.isHidden(), '页面初始化不重复弹出旧任务');
        const form = page.locator('#main input:not([type="hidden"]):visible').first();
        if (await form.count()) await form.focus();
        const hadFocus = await form.count() && await form.evaluate(node => node === document.activeElement);
        rows = [{ ...initial }];
        await page.evaluate(() => window.emitRechargeRevision('started'));
        await toast.getByText('正在充值 · ChatGPT Pro 200', { exact: true }).waitFor();
        assert.match(await toast.innerText(), /li•••@example\.test/);
        assert.match(await toast.innerText(), /Z7K9/);
        assert.doesNotMatch(await toast.innerText(), /FIXTURE-RECHARGE/);
        if (hadFocus) assert(await form.evaluate(node => node === document.activeElement), '新提醒不抢走录单控件焦点');
        const bounds = await toast.boundingBox(), entryActions = await page.locator('#mobile-entry-actions').boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 850);
        assert(width < 900 || width - bounds.x - bounds.width <= 20, '桌面提醒贴右下角');
        if (entryActions) assert(entryActions.y - (bounds.y + bounds.height) >= 8, '手机提醒让开固定表单操作');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

        await page.evaluate(() => window.IDDesignAPI.go('overview'));
        await page.locator('#main[data-layout-route="overview"]').waitFor();
        assert(await toast.isVisible(), '切页保留同一全局提醒');
        await toast.getByRole('button', { name: '收起代充提醒' }).click();
        assert.equal(await toggle.getAttribute('aria-label'), '代充动态，1 条未读');
        await page.evaluate(() => window.emitRechargeRevision('started', 'snapshot'));
        assert(await toast.isHidden(), '相同版本重连不重弹');
        await page.reload();
        await toggle.waitFor();
        assert(await toast.isHidden(), '刷新后从未读列表补看已有任务');
        assert.equal(await toggle.getAttribute('aria-label'), '代充动态，1 条未读');

        await toggle.click();
        await drawer.getByRole('heading', { name: '代充动态', exact: true }).waitFor();
        const help = drawer.locator('.title-help');
        assert(await help.count());
        assert.equal(await help.getAttribute('open'), null);
        const helpBox = await help.boundingBox(), headingBox = await drawer.getByRole('heading', { name: '代充动态' }).boundingBox();
        assert(helpBox.x > headingBox.x && Math.abs(helpBox.y - headingBox.y) < 14);
        const list = drawer.locator('.recharge-activity-history');
        await list.waitFor();
        const before = await list.boundingBox();
        await help.locator('summary').click();
        assert.equal(await help.getAttribute('open'), '');
        assert.equal((await list.boundingBox()).y, before.y);
        await page.keyboard.press('Escape');
        assert.equal(await help.getAttribute('open'), null);
        assert(await drawer.isVisible());
        const spacing = await list.locator('li').evaluate(row => {
          const b = row.getBoundingClientRect(), control = row.querySelector('button').getBoundingClientRect();
          return b.bottom - control.bottom;
        });
        assert(spacing >= 8, '动态列表的操作按钮与分隔线留出至少 8px');

        await list.getByRole('button', { name: '查看任务' }).click();
        await drawer.getByText('FIXTURE-RECHARGE-Z7K9', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('#recharge-activity-toggle').getAttribute('aria-label') === '代充动态');
        assert.deepEqual(read, [[id, '1']]);
        await drawer.getByRole('button', { name: '关闭抽屉' }).click();

        rows[0] = { ...rows[0], status: 'review', event: 2, updatedAt: at + 10_000, unread: true };
        await page.evaluate(() => window.emitRechargeRevision('review'));
        await toast.getByText('付款待核对 · ChatGPT Pro 200', { exact: true }).waitFor();
        await toast.getByRole('button', { name: '查看任务' }).click();
        await drawer.getByText('付款结果待核对，请勿重复提交', { exact: true }).waitFor();
        assert.deepEqual(await drawer.locator('.recharge-activity-timeline strong').allTextContents(), ['正在充值', '付款待核对']);
        await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
        assert(await toggle.isHidden());
        assert(await toast.isHidden());
        assert.equal(await drawer.getByText('FIXTURE-RECHARGE-Z7K9', { exact: true }).count(), 0);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
});
