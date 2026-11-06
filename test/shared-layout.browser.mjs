import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';

// Geometry assertions cover the user-visible regressions; no business writes are allowed.
test('shared layouts preserve alignment, readable controls and stable navigation', { timeout: 120_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = playwright.default || playwright;
  const host = await startCodexdaichongDemoSite(0);
  t.after(() => new Promise(resolve => {
    host.server.close(resolve);
    host.server.closeAllConnections();
  }));
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const origin = new URL(host.url).origin;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === origin && ['GET', 'HEAD'].includes(request.method())
      ? route.continue() : route.abort();
  });
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
    await settled();
  };
  const theme = async dark => {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark') !== dark)
      await page.locator('#theme-toggle').click();
    await settled();
  };
  const box = selector => page.locator(selector).boundingBox();
  const aligned = (a, b, message) => assert(Math.abs(a.y - b.y) <= 1, message);
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), page.url());
  const frame = () => page.frameLocator('.recharge-integration__content iframe:not([hidden])');
  await page.goto(origin + '/#/workspace/order');

  await t.test('order columns align with helper text; Apple payment and narrow labels remain usable', async () => {
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        await go('workspace/order');
        await page.locator('#commerce-payment').selectOption('银行卡');
        await settled();
        const groups = await page.locator('.order-financial-group').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
        if (groups[0] === groups[2]) {
          aligned(await box('#commerce-paidAmount'), await box('#commerce-expiry'), '金额和到期控件第二行不齐');
          aligned(await box('label[for="commerce-paidAmount"]'), await box('label[for="commerce-expiry"]'), '第二行文字不齐');
        }
        if (width === 1440) {
          aligned(await box('#commerce-payment'), await box('#commerce-cardId'), '银行卡编号应同排');
          aligned(await box('#commerce-payment'), await box('#commerce-paymentId'), '卡尾号不应单独占一行');
        }
        await page.locator('#commerce-payment').selectOption('苹果内购');
        assert(await page.locator('#commerce-appleIdId').isVisible());
        await noOverflow();
        const leftLabels = await page.locator('.field:visible').evaluateAll(nodes => nodes.every(n => {
          const label = n.querySelector(':scope > label');
          const control = n.querySelector(':scope > .field-control');
          return !label || !control || label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1;
        }));
        assert(leftLabels, '窄屏标签必须仍在控件左侧');
      }
    }
  });

  await t.test('title notes escape clipped panels and drawers without moving fields', async () => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await go('customers/new');
      const entryTabs = page.locator('.form-panel > .tabs');
      if (await entryTabs.count()) {
        const tabs = await entryTabs.boundingBox();
        const form = await box('#commerce-contact-form');
        assert(form.y - tabs.y - tabs.height >= 16, '表单页签与首行资料应保留间距');
      }
      const before = await box('#commerce-contact-name');
      await page.locator('summary[aria-label="查看联系方式说明"]').click();
      await page.locator('.title-description:popover-open').waitFor();
      const bounds = await box('.title-description:popover-open');
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '说明越过视口');
      assert.deepEqual(await box('#commerce-contact-name'), before, '说明展开推动表单');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.title-help[open]').count(), 0);
      await page.evaluate(() => {
        const api = window.IDDesignAPI;
        api.openDrawer('布局验证', '仅用于隔离验证的长说明。'.repeat(12), api.field('测试字段', 'layout-field', api.input('layout-field')));
      });
      await page.locator('#drawer .title-help summary').click();
      await page.locator('#drawer .title-description:popover-open').waitFor();
      const drawerNote = await box('#drawer .title-description:popover-open');
      assert(drawerNote.x >= 0 && drawerNote.x + drawerNote.width <= width);
      await page.locator('#drawer [data-action="drawer-close"]').click();
    }
  });

  await t.test('active inventory tabs remain visible after repeated rerender', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await go('mailboxes/google');
      for (const last of [true, false, true]) {
        const target = last ? page.locator('.tabs .tab').filter({ hasText: '解封中' }).first()
          : page.locator('.tabs .tab').first();
        await target.click();
        await settled();
        assert(await page.locator('.tabs').first().evaluate(n => {
          const active = n.querySelector('.active').getBoundingClientRect();
          const bounds = n.getBoundingClientRect();
          return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
        }), '当前页签被藏到滚动区外');
      }
    }
  });

  await t.test('long-page return restores reading position; empty rates do not reserve a sidebar', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await go('workspace/order');
    await page.evaluate(() => scrollTo(0, 220));
    const before = await page.evaluate(() => scrollY);
    assert(before > 0);
    await go('customers/new');
    await go('workspace/order');
    assert.equal(await page.evaluate(() => scrollY), before);
    await go('settings/costs');
    assert.equal(await page.locator('.side-panel').count(), 0);
    assert.match(await page.locator('#main').innerText(), /暂无汇率报价/);
    const form = await box('.form-panel');
    const main = await box('#main');
    assert(form.width > main.width - 70, '空侧栏仍挤压费用表单');
  });

  await t.test('relay filters and actions share one toolbar and empty guidance stays inside the table', async () => {
    await page.setViewportSize({ width: 1591, height: 900 });
    await go('mailboxes/relay');
    await page.getByRole('tab', { name: '隐藏邮箱管理' }).click();
    const toolbar = page.locator('.relay-alias-toolbar');
    const table = page.locator('table[data-table="relay-aliases"]');
    await table.getByRole('heading', { name: '请先添加 Apple 主邮箱' }).waitFor();
    assert.equal(await toolbar.evaluate(node => node.parentElement.querySelectorAll(':scope > .toolbar').length), 1);
    assert.equal(await table.getByText('可调整搜索或筛选条件。', { exact: true }).count(), 0);
    for (const width of [1591, 1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await theme(dark);
        const controls = await toolbar.evaluate(node => {
          const middle = element => element.top + element.height / 2;
          return [...node.querySelectorAll('button, input, select, .relay-status-group > span')].map(control => {
            const range = document.createRange();
            range.selectNodeContents(control);
            const bounds = control.getBoundingClientRect();
            return {
              y: middle(control.matches('span') ? range.getBoundingClientRect() : bounds),
              left: bounds.left, right: bounds.right, height: bounds.height,
              label: control.matches('span')
            };
          });
        });
        if (width === 1591)
          assert(Math.max(...controls.map(c => c.y)) - Math.min(...controls.map(c => c.y)) <= 1, '宽屏按钮和状态文字未同排对齐');
        if (width === 1440) {
          const search = await box('#relay-search');
          const action = await box('[data-action="relay-parent-add"]');
          aligned(search, action, '空间不足时搜索和操作应整组换行');
        }
        assert(controls.every(c => c.left >= 0 && c.right <= width), '工具栏控件越过视口');
        if (width <= 390)
          assert(controls.filter(c => !c.label).every(c => c.height >= 44), '手机控件触控高度不足');
        const guidance = await table.locator('.empty-state p').boundingBox();
        const viewport = await box('.table-viewport');
        assert(guidance.x >= viewport.x && guidance.x + guidance.width <= viewport.x + viewport.width,
          '空状态操作说明不应被表格横向裁切');
        await noOverflow();
      }
    }
    await theme(false);
  });

  await t.test('recharge navigation stays on one row and frames never show an intermediate default height', async () => {
    await go('online-recharge/chatgpt');
    await frame().locator('#querySection').waitFor();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const toolbar = await box('.recharge-integration__toolbar');
      assert(toolbar.height < 90, '充值导航不应占多行');
      const button = await box('.recharge-integration__toolbar > button');
      assert(button.x + button.width <= width, '刷新不可被挤出视口');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const target of ['dashboard', 'query', 'dashboard']) {
      const before = await box('iframe:not([hidden])');
      const samples = page.evaluate(() => new Promise(resolve => {
        const records = [];
        const end = performance.now() + 600;
        function tick() {
          records.push(document.querySelector('iframe:not([hidden])')?.getBoundingClientRect().height || 0);
          if (performance.now() < end) requestAnimationFrame(tick); else resolve(records);
        }
        tick();
      }));
      await page.locator(`button[data-view="${target}"]`).click();
      await frame().locator(target === 'query' ? '#querySection' : '#dashboard.active').waitFor();
      const heights = await samples;
      const after = await box('iframe:not([hidden])');
      assert(heights.every(h => h > 0 && h <= Math.max(before.height, after.height) + 1), JSON.stringify(heights));
    }
    const oldFrame = await page.locator('iframe:not([hidden])').evaluateHandle(n => n);
    await page.route('**/integrations/codexdaichong/status', route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
    await page.locator('[data-action="ops-integrated-refresh"]').click();
    await page.locator('.recharge-integration__view[aria-busy="false"]').waitFor();
    assert(await page.locator('iframe:not([hidden])').evaluate((n, old) => n === old, oldFrame), '刷新失败应保留原内容');
    await oldFrame.dispose();
  });

  await t.test('recharge log tables scroll within their containers with readable single-line headings', async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await go('settings/login-logs');
    await page.locator('[data-action="ops-login-log-tab"][data-tab="recharge"]').click();
    await frame().locator('#admin_login_logs.active').waitFor();
    const tables = await frame().locator('#admin_login_logs table').evaluateAll(nodes => nodes.map(n => ({
      scroll: getComputedStyle(n.parentElement).overflowX,
      headings: [...n.querySelectorAll('th')].map(th => ({ height: th.getBoundingClientRect().height, wrapping: getComputedStyle(th).whiteSpace }))
    })));
    assert.equal(tables.length, 2);
    for (const table of tables) {
      assert.equal(table.scroll, 'auto');
      assert(table.headings.every(th => th.height < 60 && th.wrapping === 'nowrap'));
    }
    await noOverflow();
  });
  assert.deepEqual(errors, []);
});
