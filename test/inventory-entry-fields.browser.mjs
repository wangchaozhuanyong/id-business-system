import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkAccountLocations } from '../server/inventory-account-location.mjs';
import { checkInventoryEntryFields } from '../server/inventory-entry-fields.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('邮箱和账号按最少实际资料新增、导入及编辑', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.inventory.data.accounts.push({ id: 'legacy-claude-entry', type: 'claude', email: 'legacy-claude@example.test',
    emailType: '旧邮箱类型', country: '旧地区', city: '旧城市', proxyUrl: '旧代理资料', status: '正常', version: 1 });
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'admin', name: '合成管理员', role: 'admin' } });
  const output = new URL('../.runtime/follow-through-20261108/', import.meta.url); await mkdir(output, { recursive: true });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  const drawer = page.locator('#drawer[open]');
  const writes = [];
  await context.route(origin + '/api/local/inventory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.inventory });
    const command = route.request().postDataJSON();
    assert.equal(command.version, fixture.inventory.version);
    assert.equal(checkAccountLocations(fixture.inventory.data, command.data), undefined);
    assert.equal(checkInventoryEntryFields(fixture.inventory.data, command.data, command.action), undefined);
    writes.push(command.action);
    fixture.inventory = { version: command.version + 1, data: command.data };
    return route.fulfill({ json: fixture.inventory });
  });
  const mailbox = email => fixture.inventory.data.mailboxes.find(row => row.email === email);
  const account = email => fixture.inventory.data.accounts.find(row => row.email === email);
  const submit = page.locator('button[form="inventory-asset-form"][type="submit"]');
  async function confirmSave() {
    const response = page.waitForResponse(result => result.url() === origin + '/api/local/inventory' && result.request().method() === 'PUT');
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    assert.equal((await response).status(), 200);
    await drawer.waitFor({ state: 'hidden' });
  }
  for (const type of ['google', 'claude', 'apple', 'gpt']) {
    await page.goto(origin + '/#/' + (type === 'google' ? 'workspace/mail-submit' : 'workspace/account-submit'));
    await page.locator(`[data-action="inventory-add-type"][data-type="${type}"]`).click();
    const registered = await drawer.locator('#inventory-registered').inputValue();
    const beijing = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
    assert(Math.abs(Date.parse(registered + 'Z') - Date.parse(beijing + 'Z')) <= 60_000, type + ' 默认打开时间');
    for (const name of ['device', 'country-edit', 'city', 'proxy-url', 'phone', 'emailType'])
      assert.equal(await drawer.locator(`label[for="inventory-${name}"] .required`).count(), 0);
    if (['google', 'apple'].includes(type)) {
      const phone = drawer.locator('#inventory-phone'), link = drawer.locator('#inventory-phone-code-link');
      await phone.fill('https://sms.example.test/code?ref=synthetic');
      await link.waitFor({ state: 'visible' });
      assert.equal(await link.getAttribute('href'), 'https://sms.example.test/code?ref=synthetic');
      assert.equal(await link.getAttribute('target'), '_blank'); assert.match(await link.getAttribute('rel'), /noopener/);
      await phone.fill('javascript:alert(1)'); assert(await link.isHidden());
      await phone.fill('0123456789'); assert(await link.isHidden());
      await phone.fill('');
      assert.equal(await drawer.locator('#inventory-no-phone').count(), 0);
      await drawer.locator('#inventory-password').fill('Fixture only');
      if (type === 'apple') await drawer.locator('#inventory-appStoreRegion').selectOption('US');
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
      await country.selectOption('');
    }
    const email = `new-${type}@example.test`;
    await drawer.locator('#inventory-email').fill(email);
    if (type === 'gpt') await page.setViewportSize({ width: 390, height: 900 });
    await submit.click();
    await confirmSave();
    const saved = (['google', 'apple'].includes(type) ? mailbox : account)(email);
    assert.equal(saved.country, '');
    assert.equal(saved.device, '');
    if (type === 'google' || type === 'apple') assert.equal(saved.phone, '');
    if (type === 'gpt' || type === 'claude') assert.equal(saved.emailType, '');
    if (type === 'claude') assert.equal(saved.proxyUrl, '');
    if (type === 'apple') assert.equal(saved.appStoreRegion, 'US');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.goto(origin + '/#/workspace/mail-submit');
  await page.locator('[data-action="inventory-import"][data-type="google"]').click();
  const content = drawer.locator('#inventory-import-content');
  const csvHeader = '邮箱,密码,电话,国家,城市,注册时间,资料类型,登录设备,注册代理链接\n';
  const importedBlank = 'import-without-device@example.test', importedDevice = 'import-with-device@example.test';
  await content.fill(csvHeader + `${importedBlank},Fixture only\n` +
    `${importedDevice},Fixture only,0123,马来西亚,吉隆坡,,谷歌邮箱,合成设备,`);
  await page.locator('button[form="inventory-import-form"][type="submit"]').click();
  await drawer.getByText('可导入', { exact: true }).last().waitFor();
  assert.equal(await drawer.getByText('可导入', { exact: true }).count(), 2);
  await drawer.locator('[data-action="inventory-import-confirm"]').click();
  await confirmSave();
  assert.equal(mailbox(importedBlank).device, '');
  assert.equal(mailbox(importedBlank).phone, '');
  assert.equal(mailbox(importedBlank).country, '');
  assert.equal(mailbox(importedDevice).device, '合成设备');

  await page.goto(origin + '/#/mailboxes/google');
  await page.locator('#inventory-list-query').fill(importedDevice);
  await page.locator(`[data-action="inventory-edit"][data-id="${mailbox(importedDevice).id}"]`).click();
  const device = drawer.locator('#inventory-device');
  assert.equal(await device.inputValue(), '合成设备');
  await device.fill('');
  await submit.click();
  await confirmSave();
  assert.equal(mailbox(importedDevice).device, '');
  await page.goto(origin + '/#/workspace/account-submit');
  await page.locator('[data-action="inventory-import"][data-type="claude"]').click();
  await drawer.locator('#inventory-import-content').fill('账号邮箱\nimported-claude@example.test');
  await page.locator('button[form="inventory-import-form"][type="submit"]').click();
  await drawer.getByText('可导入', { exact: true }).waitFor();
  await drawer.locator('[data-action="inventory-import-confirm"]').click();
  await confirmSave();
  assert.equal(account('imported-claude@example.test').emailType, '');
  await page.goto(origin + '/#/accounts/claude');
  await page.locator('#inventory-list-query').fill('legacy-claude@example.test');
  await page.locator('[data-action="inventory-edit"][data-id="legacy-claude-entry"]').click();
  await drawer.locator('#inventory-notes').fill('历史补充备注');
  await submit.click();
  await confirmSave();
  const historical = account('legacy-claude@example.test');
  assert.equal(historical.notes, '历史补充备注');
  assert.equal(historical.proxyUrl, '旧代理资料');
  assert.equal(historical.emailType, '旧邮箱类型');
  assert.deepEqual(writes, ['inventory_create', 'inventory_create', 'inventory_create', 'inventory_create',
    'inventory_import', 'inventory_edit', 'inventory_import', 'inventory_edit']);
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});
