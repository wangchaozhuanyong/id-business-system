import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('手机记录卡、工具入口、表单与草稿使用同一套业务控件', { timeout: 180_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [320, 390, 768, 1440]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? '深色' : '浅色'}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const mock = await interceptDesign(context, { localFixtures: fixture });
      let writes = 0;
      await context.route('**/*', route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) { writes++; return route.abort(); }
        return route.fallback();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(origin + '/#/accounts/gpt');
        await page.locator('#main tr[data-row-id]').first().waitFor();
        if (dark) {
          if (width <= 900) await page.locator('#mobile-tools-toggle').click();
          await page.locator('#theme-toggle').click();
          if (width <= 900) await page.locator('#mobile-tools-toggle').click();
        }
        for (const route of ['accounts/gpt', 'mailboxes/google', 'orders/gpt']) {
          if (!page.url().endsWith(route)) await page.evaluate(route => { location.hash = '#/' + route; }, route);
          await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
          await page.locator('#main tr[data-row-id]').first().waitFor();
          await settle(page);
          const geometry = await page.evaluate(() => {
            const row = document.querySelector('#main tr[data-row-id]');
            const viewport = row.closest('.table-viewport');
            const box = row.getBoundingClientRect();
            const actions = [...row.querySelectorAll('button')].filter(n => n.checkVisibility()).map(n => ({ label: n.textContent.trim(), width: n.getBoundingClientRect().width, left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right }));
            return { pageWidth: document.documentElement.scrollWidth, screen: innerWidth, row: box.toJSON(), viewport: viewport.getBoundingClientRect().toJSON(), scrollWidth: viewport.scrollWidth, actions };
          });
          assert(geometry.pageWidth <= width, `${route}: 页面横向溢出`);
          if (width <= 900) {
            assert(geometry.scrollWidth <= geometry.viewport.width + 1, `${route}: 手机仍需横滑表格`);
            assert(geometry.actions.every(a => a.left >= geometry.row.left && a.right <= geometry.row.right + 1), `${route}: 操作离开卡片`);
            if (route === 'accounts/gpt' && width <= 390) assert(geometry.row.y < 560, `首条资料过低：${geometry.row.y}`);
            const row = page.locator('#main tr[data-row-id]').first();
            const toggle = row.locator('[data-action="table-mobile-toggle"]');
            if (await toggle.count()) {
              assert.equal(await row.locator('[data-mobile-field="secondary"]:visible').count(), 0);
              await toggle.click();
              assert(await row.locator('[data-mobile-field="secondary"]:visible').count() > 0);
              await toggle.click();
            }
          }
          if (output && route === 'accounts/gpt') await page.evaluate(() => scrollTo(0, 0));
          if (output && route === 'accounts/gpt') await page.screenshot({ path: join(output, `accounts-${width}-${dark ? 'dark' : 'light'}.png`) });
          if (route === 'accounts/gpt' && width <= 900) {
            await page.locator('#main [data-action="mobile-list-actions"]').click();
            assert(!(await page.getByRole('menuitem', { name: '复制所选', exact: true }).isEnabled()));
            await page.keyboard.press('Escape');
            const selection = page.locator('#main tbody tr').first().locator('input[type="checkbox"]');
            await selection.check();
            assert.equal(await page.locator('#main tbody input:checked').count(), 1);
            const menu = page.locator('#main [data-action="mobile-list-actions"]');
            assert.equal(await menu.count(), 1, '同一列表只保留一个更多操作入口');
            await menu.click();
            assert(await page.getByRole('menuitem', { name: '复制所选', exact: true }).isEnabled());
            await page.getByRole('menuitem', { name: '列设置', exact: true }).click();
            await page.locator('#drawer[open]').waitFor();
            await page.locator('#drawer [data-column="password"]').uncheck();
            assert.equal(await page.locator('#main td[data-column="password"]').count(), 0);
            await page.locator('#drawer [data-column="password"]').check();
            await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            assert(await page.locator('#main td[data-column="password"]').count() > 0);
          }
          results.push({ route, width, dark, geometry });
        }
        await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
        await page.locator('#commerce-order-form').waitFor();
        await page.locator('#commerce-email').fill('mobile-layout@example.test');
        if (width <= 900) {
          await page.locator('[data-action="mobile-entry-view"][data-view="records"]').click();
          assert(await page.locator('#commerce-entry-records').isVisible());
          assert(!(await page.locator('#mobile-entry-actions').isVisible()));
          await page.locator('[data-action="mobile-entry-view"][data-view="form"]').click();
          assert.equal(await page.locator('#commerce-email').inputValue(), 'mobile-layout@example.test');
          const footer = await page.locator('#mobile-entry-actions').boundingBox();
          assert(footer.y >= 0 && footer.y + footer.height <= 845, '保存入口离开手机视口');
          const labels = await page.locator('#commerce-order-form .field:visible').evaluateAll(nodes => nodes.map(n => {
            const label = n.querySelector(':scope > label'), control = n.querySelector(':scope > .field-control');
            return !label || !control || label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1;
          }));
          assert(labels.every(Boolean), '标签必须留在控件左侧');
          const header = await page.locator('.topbar').boundingBox();
          assert(header.height <= 60, '手机顶栏仍占两行');
          await page.locator('#mobile-tools-toggle').click();
          assert.equal(await page.locator('#mobile-tools-panel [data-action="tools-open"]:visible').count(), 3);
          await page.locator('#mobile-tools-toggle').click();
          await page.evaluate(() => { location.hash = '#/accounts/gpt'; });
          await page.locator('#main[data-layout-route="accounts/gpt"]').waitFor();
          assert(!(await page.locator('#mobile-entry-actions').isVisible()));
          await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
          await page.locator('#commerce-order-form').waitFor();
          assert.equal(await page.locator('#commerce-email').inputValue(), 'mobile-layout@example.test');
          await page.setViewportSize({ width, height: 460 });
          await settle(page);
          const shortFooter = await page.locator('#mobile-entry-actions').boundingBox();
          assert(shortFooter.y >= 0 && shortFooter.y + shortFooter.height <= 461);
          await page.setViewportSize({ width, height: 844 });
          await settle(page);
        }
        if (output) await page.screenshot({ path: join(output, `order-${width}-${dark ? 'dark' : 'light'}.png`) });
        await page.setViewportSize({ width: 1440, height: 844 });
        await settle(page);
        assert(await page.locator('.topbar #theme-toggle').isVisible());
        assert(await page.locator('.commerce-entry-columns > .form-panel > .form-footer').isVisible());
        assert.equal(await page.locator('#commerce-email').inputValue(), 'mobile-layout@example.test');
        assert.deepEqual(errors, []);
        assert.equal(writes, 0);
        assert.deepEqual(mock.external, []);
      } finally { await context.close(); }
    });
  }
  if (output) await writeFile(join(output, 'mobile-layout-results.json'), JSON.stringify(results, null, 2));
});
