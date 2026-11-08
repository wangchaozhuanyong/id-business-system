import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkInventoryEntryFields } from '../server/inventory-entry-fields.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('新增表单默认当前注册时间、统一必填并安全打开虚拟电话链接，国家及按钮保持可见', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'admin', name: '合成管理员', role: 'admin' } });
  const output = new URL('../.runtime/follow-through-20261108/', import.meta.url); await mkdir(output, { recursive: true });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  const drawer = page.locator('#drawer[open]');
  for (const type of ['google', 'claude', 'apple', 'gpt']) {
    await page.goto(origin + '/#/' + (type === 'google' ? 'workspace/mail-submit' : 'workspace/account-submit'));
    await page.locator(`[data-action="inventory-add-type"][data-type="${type}"]`).click();
    const registered = await drawer.locator('#inventory-registered').inputValue();
    const beijing = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
    assert(Math.abs(Date.parse(registered + 'Z') - Date.parse(beijing + 'Z')) <= 60_000, type + ' 默认打开时间');
    if (['google', 'claude'].includes(type)) {
      await page.locator('button[form="inventory-asset-form"][type="submit"]').click();
      await drawer.locator('#inventory-device-error').waitFor();
      if (type === 'claude') await drawer.locator('#inventory-proxy-url-error').waitFor();
      else await drawer.locator('#inventory-country-edit-error').waitFor();
    }
    if (['google', 'apple'].includes(type)) {
      const phone = drawer.locator('#inventory-phone'), link = drawer.locator('#inventory-phone-code-link');
      await phone.fill('https://sms.example.test/code?ref=synthetic');
      await link.waitFor({ state: 'visible' });
      assert.equal(await link.getAttribute('href'), 'https://sms.example.test/code?ref=synthetic');
      assert.equal(await link.getAttribute('target'), '_blank'); assert.match(await link.getAttribute('rel'), /noopener/);
      await phone.fill('javascript:alert(1)'); assert(await link.isHidden());
      await phone.fill('0123456789'); assert(await link.isHidden());
    }
    if (type === 'claude') {
      const country = drawer.locator('#inventory-country-edit');
      await country.selectOption({ label: '马来西亚' });
      const setting = country.locator('..').getByRole('button', { name: '设置', exact: true });
      for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
        const c = await country.boundingBox(), b = await setting.boundingBox();
        assert(c.width >= 90, `${width} ${theme} 国家选择框过窄: ${c.width}`);
        assert(c.x + c.width + 4 <= b.x && b.x + b.width <= width, '设置按钮与国家不重叠');
        assert(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        if (width === 1440 || width === 390) await page.screenshot({ path: fileURLToPath(new URL(`claude-entry-${width}-${theme}.png`, output)) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  }
  await page.goto(origin + '/#/workspace/mail-submit');
  await page.locator('[data-action="inventory-import"][data-type="google"]').click();
  const content = drawer.locator('#inventory-import-content');
  const csvHeader = '邮箱,密码,电话,国家,城市,注册时间,资料类型,登录设备,注册代理链接\n';
  await content.fill(csvHeader + 'import-google@example.test,DEMO,0123,马来西亚,吉隆坡,,谷歌邮箱,,');
  await page.locator('button[form="inventory-import-form"][type="submit"]').click();
  await drawer.getByText('缺少登录设备', { exact: true }).waitFor();
  assert(await drawer.locator('[data-action="inventory-import-confirm"]').isDisabled());
  await content.fill(csvHeader + 'import-google@example.test,DEMO,0123,马来西亚,吉隆坡,,谷歌邮箱,合成设备,');
  await page.locator('button[form="inventory-import-form"][type="submit"]').click();
  await drawer.getByText('可导入', { exact: true }).waitFor();
  const writes = [];
  await context.route(origin + '/api/local/inventory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.inventory });
    const command = route.request().postDataJSON();
    assert.equal(checkInventoryEntryFields(fixture.inventory.data, command.data, command.action), undefined);
    writes.push(command);
    fixture.inventory = { version: command.version + 1, data: command.data };
    return route.fulfill({ json: fixture.inventory });
  });
  await drawer.locator('[data-action="inventory-import-confirm"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
  assert.equal(writes.length, 1);
  assert.equal(fixture.inventory.data.mailboxes.find(row => row.email === 'import-google@example.test').device, '合成设备');
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});
