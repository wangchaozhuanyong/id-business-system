import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';
import { toggleDesignTheme, interceptDesign, origin } from './helpers/offline-design.mjs';

test('下拉设置页签支持来源标签持久化、历史选项和客户草稿返回', { timeout: 60_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
  const { server, url } = offline ? { url: origin + '/' } : await startPreview(0, { databasePath: ':memory:' });
  if (server) t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const snapshots = { commerce: { version: 0, data: null }, settings: { version: 0, data: null } };
  if (offline) {
    await interceptDesign(page.context(), { localFixtures: snapshots, skipRechargeAssets: true });
    await page.route('**/api/local/{settings,commerce}', route => {
      const domain = new URL(route.request().url()).pathname.split('/').at(-1);
      if (route.request().method() !== 'GET') {
        const request = route.request().postDataJSON();
        assert.equal(request.version, snapshots[domain].version);
        snapshots[domain] = { version: request.version + 1, data: request.data };
      }
      return route.fulfill({ json: snapshots[domain] });
    });
  }
  const readCommerce = async () => offline ? snapshots.commerce : (await page.request.get(url + 'api/local/commerce')).json();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url + '#/customers/new');
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const openSettings = async label => {
    await go('settings/costs');
    await page.getByRole('tab', { name: label, exact: true }).click();
  };
  const reopenCustomer = async () => {
    await go('customers/list');
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  };
  const picker = page.locator('[data-customer-tag-picker]');
  const summary = picker.locator('summary');
  assert.equal(await page.getByLabel('来源渠道').inputValue(), '咸鱼');
  await page.locator('#commerce-contact-name').fill('多标签测试客户');
  await page.locator('#commerce-contact-phone').fill('+60125550199');
  await openSettings('来源设置');
  const sourceSettings = page.locator('#ops-customer-sources-form');
  await sourceSettings.getByPlaceholder('请输入来源').fill('门店咨询');
  await sourceSettings.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '保存来源设置', exact: true }).click();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/settings/costs');
  await go('customers/new');
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '多标签测试客户');
  await page.locator('#commerce-contact-source').selectOption('门店咨询');
  await openSettings('标签设置');
  const settings = page.locator('#ops-customer-tags-form');
  for (const name of ['企业客户', '复购客户']) {
    await settings.getByPlaceholder('请输入标签').fill(name);
    await settings.getByRole('button', { name: '添加', exact: true }).click();
  }
  const settingsSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/local/settings') &&
      response.request().method() !== 'GET' &&
      response.ok()
  );
  await page.getByRole('button', { name: '保存标签设置' }).click();
  await settingsSaved;
  await page.getByText('客户标签设置已保存', { exact: true }).waitFor();

  assert.equal(new URL(page.url()).hash, '#/settings/costs');
  await go('customers/new');
  const form = page.locator('#commerce-contact-form');
  await page.setViewportSize({ width: 2040, height: 900 });
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '多标签测试客户');
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '门店咨询');
  const controls = await form
    .locator('[data-commerce-section="01"] .field > label')
    .evaluateAll((labels) => labels.map((node) => node.getBoundingClientRect().y));
  assert.equal(controls.length, 3);
  assert(Math.abs(controls[0] - controls[1]) < 1, '姓名与来源标签应同排对齐');
  assert(controls[2] > controls[0], '客户标签进入第二行，不挤压两个主字段');
  const following = form.getByRole('heading', { name: '联系方式' });
  const beforeOpen = await following.boundingBox();
  await summary.focus();
  await page.keyboard.press('Enter');
  await picker.getByRole('checkbox', { name: '企业客户' }).check();
  await picker.getByRole('checkbox', { name: '复购客户' }).check();
  assert.equal((await following.boundingBox()).y, beforeOpen.y, '展开选项时表单不跳动');
  await summary.click();
  assert.equal(await summary.innerText(), '企业客户、复购客户');
  await page.goto(url + '#/customers/list');
  await page.goto(url + '#/customers/new');
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '多标签测试客户');
  assert.equal(await summary.innerText(), '企业客户、复购客户');
  const recent = page.locator('#commerce-entry-records');
  const period = recent.getByRole('combobox', { name: '录入时间', exact: true });
  await period.selectOption('today');
  await page.getByRole('button', { name: '核对并保存' }).click();
  await recent.getByText('多标签测试客户', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/customers/new');
  assert.equal(await period.inputValue(), 'today');
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '');
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '咸鱼');
  assert.equal(await summary.innerText(), '请选择标签（可多选）');

  assert.deepEqual((await readCommerce()).data.customers[0].tags, ['企业客户', '复购客户']);

  const toastClose = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await toastClose.isVisible()) await toastClose.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await toggleDesignTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: '返回客户数据', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await summary.click();
  assert(await picker.getByRole('checkbox', { name: '企业客户' }).isChecked());
  assert(await picker.getByRole('checkbox', { name: '复购客户' }).isChecked());
  const bounds = await picker.locator('.customer-tag-options').boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await form.locator('[data-option-input]').count(), 0);

  // Visiting system settings and reopening the customer retains its unsaved fields.
  await summary.click();
  await form.getByLabel('客户姓名').fill('保留中的客户草稿');
  await openSettings('来源设置');
  await sourceSettings.getByRole('button', { name: '移除来源 门店咨询' }).click();
  await page.getByRole('button', { name: '保存来源设置' }).click();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  await reopenCustomer();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '门店咨询');
  assert.match(await form.getByLabel('来源渠道').innerText(), /已移出选项/);
  await openSettings('标签设置');
  await settings.getByRole('button', { name: '移除标签 企业客户' }).click();
  await page.getByRole('button', { name: '保存标签设置' }).click();
  await page.getByText('客户标签设置已保存', { exact: true }).waitFor();

  await reopenCustomer();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  await summary.click();
  assert(await picker.getByRole('checkbox', { name: '企业客户 历史标签' }).isChecked());
  await summary.click();
  await openSettings('标签设置');
  await settings.getByPlaceholder('请输入标签').fill('未提交的标签');
  await reopenCustomer();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  await openSettings('标签设置');
  assert.equal(await settings.getByPlaceholder('请输入标签').inputValue(), '未提交的标签');
  await reopenCustomer();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url + '#/workspace/order');
  const orderForm = page.locator('#commerce-order-form');
  const orderName = orderForm.locator('#commerce-customerName');
  const orderSource = orderForm.locator('#commerce-customerSource');
  const orderTags = orderForm.locator('[data-customer-tag-picker]');
  await orderForm.locator('#commerce-email').fill('quick-draft@example.test');
  await orderName.fill('订单随单客户');
  await orderForm.locator('#commerce-wechat').fill('order_customer_wechat');
  await orderForm.locator('#commerce-customerPhone').fill('5550199');
  await orderForm.locator('#commerce-qq').fill('quick-qq');
  await orderSource.selectOption('网站');
  await orderTags.locator('summary').click();
  await orderTags.getByRole('checkbox', { name: '复购客户' }).check();
  await orderTags.locator('summary').click();
  await openSettings('来源设置');
  await go('workspace/order');
  assert.equal(await orderName.inputValue(), '订单随单客户');
  assert.equal(await orderForm.locator('#commerce-customerPhone').inputValue(), '5550199');
  assert.equal(await orderSource.inputValue(), '网站');
  await orderTags.locator('summary').click();
  assert(await orderTags.getByRole('checkbox', { name: '复购客户' }).isChecked());
  await orderTags.locator('summary').click();
  assert.equal(await orderForm.locator('#commerce-email').inputValue(), 'quick-draft@example.test');
  assert.equal(await page.locator('#drawer[open]').count(), 0);
  assert(!(await readCommerce()).data.customers.some(row => row.name === '订单随单客户'),
    '草稿切页不写入客户档案');
  await page.goto(url + '#/customers/list');
  await openSettings('标签设置');
  await settings.waitFor();
  await page.reload();
  await openSettings('来源设置');
  await sourceSettings.waitFor();
  assert.equal(await sourceSettings.getByRole('button', { name: '移除来源 门店咨询' }).count(), 0);
  const persisted = await readCommerce();
  const savedCustomer = persisted.data.customers.find(row => row.name === '多标签测试客户');
  assert.equal(savedCustomer?.source, '门店咨询');
  assert.deepEqual(savedCustomer.tags, ['企业客户', '复购客户']);
  await page.goto(url + '#/settings/customer-tags');
  await page.locator('#main[data-layout-route="settings/costs"]').waitFor();
  assert.equal(await page.getByRole('tab', { name: '标签设置', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.sidebar a[href="#/settings/costs"]').innerText(), '下拉设置');
  assert.equal(await page.locator('.sidebar a[href="#/settings/customer-tags"]').count(), 0);
  await go('customers/list');
  await page.getByRole('button', { name: '新增客户', exact: true }).click();
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '咸鱼');
  await form.getByLabel('客户姓名').fill('默认来源测试客户');
  await page.getByRole('button', { name: '核对并保存' }).click();
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  const newCustomer = (await readCommerce()).data.customers.find(row => row.name === '默认来源测试客户');
  assert.equal(newCustomer?.source, '咸鱼');
  assert.deepEqual([newCustomer.phone, newCustomer.wechat, newCustomer.qq, newCustomer.whatsapp,
    newCustomer.telegram, newCustomer.notes, newCustomer.tags], ['', '', '', '', '', '', []]);

  assert.deepEqual(errors, []);
});
