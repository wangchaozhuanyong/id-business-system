import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('全局外点收起与切页草稿保留', { timeout: 90_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(async () => {
    await browser.close();
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = new URL(host.url).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const drawer = page.locator('#drawer');
  const picker = page.locator('[data-customer-tag-picker]:visible');
  const form = page.locator('#commerce-contact-form:visible');
  const name = page.locator('#commerce-contact-name:visible');
  const outsideDrawer = async () => {
    const bounds = await drawer.boundingBox();
    assert(bounds.x > 0, '测试视口应留有抽屉遮罩');
    await page.mouse.click(bounds.x / 2, 500);
  };
  await page.goto(host.url + '#/customers/new');
  await name.fill('客户录入未保存');
  await page.locator('#commerce-contact-phone').fill('5550123');
  await go('settings/costs');
  await page.getByRole('tab', { name: '标签设置', exact: true }).click();
  const settings = page.locator('#ops-customer-tags-form');
  for (const tag of ['大客户', '测试']) {
    await settings.getByPlaceholder('请输入标签').fill(tag);
    await settings.getByRole('button', { name: '添加', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存标签设置', exact: true }).click();
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  await page.getByText('客户标签设置已保存', { exact: true }).waitFor();
  await go('customers/new');
  await picker.locator('summary').click();
  await picker.getByRole('checkbox', { name: '大客户', exact: true }).check();
  await picker.getByRole('checkbox', { name: '测试', exact: true }).check();
  assert(await picker.evaluate(node => node.open), '点击下拉内容不应收起');
  await name.click();
  assert.equal(await picker.evaluate(node => node.open), false, '点击外部应收起下拉');
  await go('customers/new/tenant');
  await name.fill('租户草稿');
  await go('customers/new');
  assert.equal(await name.inputValue(), '客户录入未保存');
  assert.equal(await page.locator('#commerce-contact-phone').inputValue(), '5550123');
  await picker.locator('summary').click();
  assert(await picker.getByRole('checkbox', { name: '大客户', exact: true }).isChecked());
  assert(await picker.getByRole('checkbox', { name: '测试', exact: true }).isChecked());
  await page.keyboard.press('Escape');
  assert.equal(await picker.evaluate(node => node.open), false);
  await go('customers/new/tenant');
  assert.equal(await name.inputValue(), '租户草稿', '客户和租户草稿应隔离');

  await go('customers/list');
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  await name.fill('抽屉未保存客户');
  await page.locator('#commerce-contact-source').selectOption('网站');
  // Inner whitespace and a pointer drag from inside to outside are not backdrop clicks.
  const bounds = await drawer.boundingBox();
  await page.mouse.click(bounds.x + 25, bounds.y + bounds.height - 80);
  assert(await drawer.evaluate(node => node.open));
  await page.mouse.move(bounds.x + 25, bounds.y + 400);
  await page.mouse.down();
  await page.mouse.move(bounds.x / 2, 400);
  await page.mouse.up();
  assert(await drawer.evaluate(node => node.open));
  await outsideDrawer();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  assert.equal(await name.inputValue(), '抽屉未保存客户');
  assert.equal(await page.locator('#commerce-contact-source').inputValue(), '网站');
  await picker.locator('summary').click();
  await picker.getByRole('checkbox', { name: '测试', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  assert(await drawer.evaluate(node => node.open), '第一次 Escape 只关下拉');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  await picker.locator('summary').click();
  assert.equal(await picker.getByRole('checkbox', { name: '测试', exact: true }).isChecked(), false);
  await name.click();

  await go('settings/costs');
  await page.getByRole('tab', { name: '标签设置', exact: true }).click();
  await settings.getByPlaceholder('请输入标签').fill('仍未添加的标签');
  await go('customers/list');
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  assert.equal(await name.inputValue(), '抽屉未保存客户', '设置切页后保留原客户草稿');
  await go('settings/costs');
  await page.getByRole('tab', { name: '标签设置', exact: true }).click();
  assert.equal(await settings.getByPlaceholder('请输入标签').inputValue(), '仍未添加的标签');
  await go('workspace/order');
  await page.locator('#commerce-notes').fill('订单切页草稿');
  await go('customers/list');
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  assert.equal(await name.inputValue(), '抽屉未保存客户');
  await outsideDrawer();
  await go('workspace/order');
  assert.equal(await page.locator('#commerce-notes').inputValue(), '订单切页草稿');

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await go('customers/new');
      await picker.locator('summary').click();
      await name.click();
      assert.equal(await picker.evaluate(node => node.open), false);
      assert.equal(await name.inputValue(), '抽屉未保存客户');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  const safeDraft = await page.evaluate(() => {
    const probe = document.createElement('form');
    probe.innerHTML = '<input name="ordinary" value="keep"><input name="unchecked" type="checkbox">' +
      '<input name="code" value="temporary" autocomplete="one-time-code">' +
      '<input name="auth-json" value="temporary" data-no-draft><input name="payment-cvv" value="temporary">';
    return window.IDDesignAPI.readDraft(probe);
  });
  assert.deepEqual(safeDraft, { ordinary: 'keep', unchecked: '' });
  assert.deepEqual(errors, []);
});

test('客户保存迟到响应不清除随后输入', { timeout: 30_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => {
    release();
    await browser.close();
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  let acknowledged;
  const sent = new Promise(resolve => { acknowledged = resolve; });
  await page.route('**/api/local/commerce', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    acknowledged();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto(host.url + '#/customers/new');
  await page.locator('#commerce-contact-name:visible').fill('首次提交客户');
  await page.locator('#commerce-contact-phone').fill('5550199');
  await page.locator('button[form="commerce-contact-form"]').click();
  await sent;
  await page.locator('#commerce-contact-name:visible').fill('保存期间继续编辑');
  release();
  await page.getByText('记录已保存，后续输入已保留', { exact: true }).waitFor();
  assert.equal(await page.locator('#commerce-contact-name:visible').inputValue(), '保存期间继续编辑');
  await page.evaluate(() => { location.hash = '#/workspace/order'; });
  await page.locator('#commerce-order-form').waitFor();
  await page.evaluate(() => { location.hash = '#/customers/new'; });
  assert.equal(await page.locator('#commerce-contact-name:visible').inputValue(), '保存期间继续编辑');
  await page.evaluate(() => { location.hash = '#/customers/list'; });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#commerce-contact-name:visible').fill('编辑已有客户');
  await page.unroute('**/api/local/commerce');
  let releaseEdit;
  const editGate = new Promise(resolve => { releaseEdit = resolve; });
  t.after(() => releaseEdit());
  let editAcknowledged;
  const editSent = new Promise(resolve => { editAcknowledged = resolve; });
  await page.route('**/api/local/commerce', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    editAcknowledged();
    await editGate;
    await route.fulfill({ response });
  });
  await page.locator('button[form="commerce-contact-form"]').click();
  await editSent;
  await page.locator('#commerce-contact-name:visible').fill('已有客户的后续编辑');
  releaseEdit();
  await page.waitForFunction(() => document.querySelector('#drawer [name="commerce-version"]').value === '2');
  assert.equal(await page.locator('#commerce-contact-name:visible').inputValue(), '已有客户的后续编辑');
  const nextSave = page.waitForResponse(response => response.url().endsWith('/api/local/commerce') &&
    response.request().method() === 'PUT');
  await page.locator('button[form="commerce-contact-form"]').click();
  assert.equal((await nextSave).status(), 200, '本次保存推进的版本应支持后续编辑继续保存');
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  const persisted = await (await page.request.get(host.url + 'api/local/commerce')).json();
  assert.equal(persisted.data.customers[0].name, '已有客户的后续编辑');
  assert.equal(persisted.data.customers[0].version, 3);
});
