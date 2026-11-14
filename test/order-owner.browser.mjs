import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('管理员代录订单可指定员工，草稿、列表与实际录入人保持一致', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const index = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  for (const role of ['admin', 'super', 'employee']) await t.test(role, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const actor = { id: 'operator', name: '代录管理员', role };
    const staff = { id: 'staff', name: '业务员工甲', role: 'employee' };
    const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
    await interceptDesign(context, { localFixtures: fixture });
    await context.route(url => url.origin === origin && url.pathname === '/', route => route.fulfill({
      contentType: 'text/html', body: index.replace('<head>', `<head><meta name="id-local-auth" content="required"><meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify(actor))}">`)
        .replace('<script src="./prototype.js', '<script src="/local-data.js" defer></script><script src="./prototype.js')
    }));
    let enabled = true, fail = role === 'admin', reads = 0;
    await context.route('**/api/local/auth/order-owners', route => {
      reads++;
      if (fail) return route.fulfill({ status: 503, json: { error: '模拟读取失败' } });
      return route.fulfill({ json: { items: [actor, ...(enabled ? [staff] : [])] } });
    });
    await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor, staff].map(({id,name})=>({id,name})) } }));
    const writes = [];
    await context.route('**/api/local/commerce', route => {
      if (route.request().method() === 'GET') return route.fallback();
      const command = route.request().postDataJSON();
      writes.push(command);
      fixture.commerce = { version: command.version + 1, data: command.data };
      return route.fulfill({ json: fixture.commerce });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/workspace/order/gpt');
    if (role === 'employee') {
      await page.locator('#main').waitFor();
      assert.equal(await page.locator('#commerce-ownerId-picker').count(), 0);
      assert.equal(await page.locator('#commerce-order-form').count(), 0, '保留现有员工页面权限');
      assert.equal(reads, 0, '员工不请求可指定人员目录');
      assert.equal(writes.length, 0);
      await context.close();
      return;
    }
    await page.locator('#commerce-customerId option').first().waitFor({state:'attached'});
    const trigger = page.locator('#commerce-ownerId-picker');
    const popup = page.locator('#commerce-ownerId-popover');
    const search = popup.getByRole('searchbox', {name:'搜索归属人'});
    const selected = page.locator('#commerce-ownerId');
    if (role === 'admin') {
      await page.locator('#commerce-ownerId-error').waitFor();
      await page.locator('#commerce-email').fill('preserve@example.test');
      fail = false;
      await page.locator('[data-action="commerce-order-owner-refresh"]').click();
      await page.locator('#commerce-ownerId option[value="staff"]').waitFor({state:'attached'});
      assert.equal(await page.locator('#commerce-email').inputValue(), 'preserve@example.test');
    } else await page.locator('#commerce-ownerId option[value="staff"]').waitFor({state:'attached'});
    assert.equal(await selected.inputValue(), actor.id);
    await trigger.click();
    await page.locator('#commerce-ownerId-picker[aria-expanded="true"]').waitFor();
    await search.fill('员工 甲');
    await popup.locator('[data-value="staff"]').click();
    assert.equal(await selected.inputValue(), staff.id);
    await page.goto(origin + '/#/workspace/order/claude');
    assert(await trigger.isVisible(), 'Claude 新订单同样可选择归属');
    await page.goto(origin + '/#/workspace/order/gpt');
    assert.equal(await selected.inputValue(), staff.id, '切页保留归属草稿');
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:900});
      for (const dark of [false,true]) {
        await page.evaluate(dark=>{document.documentElement.dataset.theme=dark?'dark':'light';},dark);
        await trigger.click();
        await page.locator('#commerce-ownerId-picker[aria-expanded="true"]').waitFor();
        const layout = await popup.evaluate(node=>{const r=node.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,noOverflow:document.documentElement.scrollWidth<=innerWidth,searchFirst:node.firstElementChild.matches('input')};});
        assert(layout.fits && layout.noOverflow && layout.searchFirst);
        await search.press('Escape');
      }
    }
    await page.setViewportSize({width:1440,height:900});
    const customer = fixture.commerce.data.customers.find(row => row.active !== false);
    await page.locator('#commerce-customerId').evaluate((node, id) => {
      node.value = id; node.dispatchEvent(new Event('change', { bubbles: true }));
    }, customer.id);
    await page.locator('#commerce-email').fill('owner@example.test');
    await page.locator('#commerce-paidAmount').fill('20');
    await page.locator('#commerce-saleAmount').fill('120');
    enabled = false;
    await page.locator('[data-action="commerce-order-owner-refresh"]').click();
    await page.locator('#commerce-ownerId-error').waitFor();
    await page.locator('#commerce-proMaterialMode').selectOption('');
    await page.locator('button[form="commerce-order-form"][type="submit"]').click();
    assert.equal(writes.length, 0, '失效归属不能被静默改成自己后保存');
    assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
    enabled = true;
    await page.locator('[data-action="commerce-order-owner-refresh"]').click();
    await page.locator('#commerce-ownerId option[value="staff"]:not([disabled])').waitFor({state:'attached'});
    const response = page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/local/commerce');
    await page.locator('button[form="commerce-order-form"][type="submit"]').click();
    await response;
    assert.equal(writes.length, 1);
    const saved = writes[0].data.orders.find(row=>row.ownerId===staff.id);
    assert(saved);
    assert.equal(saved.owner, staff.name);
    assert.equal(saved.createdById, actor.id);
    assert.equal(saved.createdBy, actor.name);
    await page.goto(origin + '/#/orders/gpt');
    const row = page.locator(`tr[data-row-id="${saved.id}"]`);
    await row.waitFor();
    assert.match(await row.innerText(), /业务员工甲/);
    assert.match(await row.innerText(), /代录管理员/);
    await page.locator(`[data-action="commerce-order-edit"][data-id="${saved.id}"]`).click();
    assert.equal(await trigger.count(), 0, '已有订单只读显示归属');
    assert.equal(await selected.getAttribute('readonly'), '');
    assert.equal(await selected.inputValue(), staff.name);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
