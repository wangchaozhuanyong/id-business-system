import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('库存、订单、运营和员工的更多操作直接下拉，不出现操作中转页', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  for (const row of [...fixture.inventory.data.mailboxes, ...fixture.inventory.data.accounts]) row.health = 'normal';
  for (const row of fixture.commerce.data.orders) { row.cancelled = false; row.corrections = []; }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { localFixtures: fixture });
  const writes = [], errors = [];
  await context.route('**/api/**', route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.fallback();
    writes.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 503, json: { error: '禁止业务写入' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  const menu = page.locator('.row-action-menu:popover-open');
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const close = () => page.evaluate(() => window.IDDesignAPI.closeDrawer());
  const inspectMenu = async (trigger, width) => {
    const id = await trigger.getAttribute('data-id');
    await trigger.click();
    await menu.waitFor();
    assert.equal(await page.locator('#drawer').isVisible(), false, '更多操作不得打开中转抽屉');
    assert.equal(await menu.locator(':scope > :not(button)').count(), 0, '下拉菜单只保留直接操作按钮');
    const items = menu.getByRole('menuitem');
    assert(await items.count() > 0);
    assert(await items.evaluateAll((nodes, id) => nodes.every(node => node.dataset.id === id), id), '操作保持正确记录归属');
    const bounds = await menu.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900);
    if (width <= 900) assert((await items.first().boundingBox()).height >= 44);
    return items;
  };
  const cases = [
    ['mailboxes/google', 'inventory-more', 'inventory-detail', '查看记录'],
    ['accounts/gpt', 'inventory-more', 'inventory-detail', '查看记录'],
    ['accounts/claude', 'inventory-more', 'inventory-detail', '查看记录'],
    ['orders/gpt', 'commerce-order-more', 'commerce-order-edit', '更正订单资料'],
    ['orders/pro', 'commerce-order-more', 'commerce-order-edit', '更正订单资料'],
    ['orders/max', 'commerce-order-more', 'commerce-order-edit', '更正订单资料'],
    ['orders/exclusive', 'commerce-subscription-more', 'commerce-subscription-state', '冻结']
  ];
  await page.goto(origin + '/#/accounts/gpt');
  for (const width of [1440, 768, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    for (const [route, action, targetAction, label] of cases) {
      await go(route);
      const trigger = page.locator(`#main [data-action="${action}"]`).first();
      await trigger.waitFor();
      let items = await inspectMenu(trigger, width);
      const target = menu.locator(`[data-action="${targetAction}"]`).first();
      assert(await target.isVisible());
      assert.match(await target.innerText(), new RegExp(label));
      if (action === 'inventory-more') assert(await menu.getByRole('menuitem', { name: '撤回最近修改', exact: true }).isDisabled());
      if (action === 'commerce-order-more') assert(await menu.getByRole('menuitem', { name: '补偿撤回最近更正', exact: true }).isDisabled());
      if (width === 1440 && !dark) {
        await target.click();
        if (targetAction === 'commerce-subscription-state') {
          await page.locator('#confirm-dialog[open]').waitFor();
          await page.locator('#confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
        } else {
          await page.locator('#drawer[open]').waitFor();
          assert.doesNotMatch(await page.locator('#drawer-title').innerText(), /^(资料操作|订单操作|Claude 账号运营)$/);
          await close();
        }
        if (action === 'inventory-more') {
          await trigger.click();
          await menu.getByRole('menuitem', { name: '移入死号', exact: true }).click();
          await page.locator('#confirm-dialog[open]').waitFor();
          await page.locator('#confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
        }
      } else await page.keyboard.press('Escape');
      if (process.env.ID_LAYOUT_QA_OUTPUT && route === 'accounts/gpt' && !dark && [1440, 390].includes(width)) {
        await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
        await trigger.click();
        await menu.waitFor();
        await page.screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/account-more-${width}.png` });
        await page.keyboard.press('Escape');
      }
      assert.equal(await menu.count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);

  // Staff preview and existing base-page fallbacks have no local business API.
  const preview = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await interceptDesign(preview);
  await preview.route(/\/(?:inventory|commerce)-prototype\.js(?:\?|$)/,
    route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  const demo = await preview.newPage();
  demo.setDefaultTimeout(5000);
  demo.on('pageerror', error => errors.push(error.message));
  await demo.goto(origin + '/#/settings/accounts');
  await demo.locator('#ops-role-preview').selectOption('super');
  const staff = demo.locator('[data-action="ops-staff-more"]').first();
  await staff.click();
  const previewMenu = demo.locator('.row-action-menu:popover-open');
  assert.equal(await demo.locator('#drawer').isVisible(), false);
  assert(await previewMenu.getByRole('menuitem', { name: '模拟重置密码', exact: true }).isEnabled());
  await demo.keyboard.press('Escape');
  await demo.locator('#ops-role-preview').selectOption('admin');
  await staff.click();
  assert.equal(await previewMenu.locator('button:not(:disabled)').count(), 0, '原有权限禁用条件不变');
  await demo.keyboard.press('Escape');
  for (const [route, action, expected] of [
    ['mailboxes/google', 'mail-more', 'mail-transition'],
    ['orders/exclusive', 'claude-more', 'claude-transition']
  ]) {
    await demo.evaluate(route => window.IDDesignAPI.go(route), route);
    await demo.locator(`#main[data-layout-route="${route}"]`).waitFor();
    await demo.locator(`[data-action="${action}"]`).first().click();
    assert.equal(await demo.locator('#drawer').isVisible(), false);
    assert(await previewMenu.locator(`[data-action="${expected}"]`).first().isVisible());
    assert.equal(await previewMenu.locator(':scope > :not(button)').count(), 0);
    await demo.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
});
