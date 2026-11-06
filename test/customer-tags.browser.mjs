import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('客户页来源与标签抽屉支持持久化、历史选项和嵌套返回', { timeout: 60_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const { server, url } = await startPreview(0, { databasePath: ':memory:' });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url + '#/customers/new');
  const picker = page.locator('[data-customer-tag-picker]');
  const summary = picker.locator('summary');
  await page.locator('#commerce-contact-name').fill('多标签测试客户');
  await page.locator('#commerce-contact-phone').fill('5550123');
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  const sourceSettings = page.locator('#ops-customer-sources-form');
  await sourceSettings.getByPlaceholder('请输入来源').fill('门店咨询');
  await sourceSettings.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '保存来源设置', exact: true }).click();
  await page.locator('[data-action="confirm-accept"]').click();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '多标签测试客户');
  await page.locator('#commerce-contact-source').selectOption('门店咨询');
  await page.getByRole('button', { name: '标签设置', exact: true }).click();
  const settings = page.locator('#ops-customer-tags-form');
  for (const name of ['企业客户', '复购客户']) {
    await settings.getByPlaceholder('请输入标签').fill(name);
    await settings.getByRole('button', { name: '添加', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存标签设置' }).click();
  const settingsSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/local/settings') &&
      response.request().method() !== 'GET' &&
      response.ok()
  );
  await page.locator('[data-action="confirm-accept"]').click();
  await settingsSaved;
  await page.getByText('客户标签设置已保存', { exact: true }).waitFor();

  await page.locator('#drawer').waitFor({ state: 'hidden' });
  const form = page.locator('#commerce-contact-form');
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '多标签测试客户');
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '门店咨询');
  const controls = await form
    .locator('[data-commerce-section="01"] .field > label')
    .evaluateAll((labels) => labels.map((node) => node.getBoundingClientRect().y));
  assert.equal(controls.length, 3);
  assert(Math.max(...controls) - Math.min(...controls) < 1, '基本资料标签应对齐');
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
  await page.getByRole('button', { name: '核对并保存' }).click();
  await page.locator('[data-action="confirm-accept"]').click();
  await page.getByText('多标签测试客户', { exact: true }).first().waitFor();

  const response = await page.request.get(url + 'api/local/commerce');
  assert.deepEqual((await response.json()).data.customers[0].tags, ['企业客户', '复购客户']);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await summary.click();
  assert(await picker.getByRole('checkbox', { name: '企业客户' }).isChecked());
  assert(await picker.getByRole('checkbox', { name: '复购客户' }).isChecked());
  const bounds = await picker.locator('.customer-tag-options').boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await form.locator('[data-option-input]').count(), 0);

  // Replacing the customer drawer with settings must restore its unsaved fields.
  await summary.click();
  await form.getByLabel('客户姓名').fill('保留中的客户草稿');
  await page.locator('#drawer').getByRole('button', { name: '来源设置', exact: true }).click();
  await sourceSettings.getByRole('button', { name: '移除来源 门店咨询' }).click();
  await page.getByRole('button', { name: '保存来源设置' }).click();
  await page.locator('[data-action="confirm-accept"]').click();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  await form.waitFor();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  assert.equal(await form.getByLabel('来源渠道').inputValue(), '门店咨询');
  assert.match(await form.getByLabel('来源渠道').innerText(), /已移出选项/);
  await page.locator('#drawer').getByRole('button', { name: '标签设置', exact: true }).click();
  await settings.getByRole('button', { name: '移除标签 企业客户' }).click();
  await page.getByRole('button', { name: '保存标签设置' }).click();
  await page.locator('[data-action="confirm-accept"]').click();
  await page.getByText('客户标签设置已保存', { exact: true }).waitFor();

  await form.waitFor();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  await summary.click();
  assert(await picker.getByRole('checkbox', { name: '企业客户 历史标签' }).isChecked());
  await summary.click();
  await page.locator('#drawer').getByRole('button', { name: '标签设置', exact: true }).click();
  await settings.getByPlaceholder('请输入标签').fill('未提交的标签');
  await page.getByRole('button', { name: '返回客户资料', exact: true }).click();
  await form.waitFor();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '保留中的客户草稿');
  await page.locator('#drawer').getByRole('button', { name: '标签设置', exact: true }).click();
  assert.equal(await settings.getByPlaceholder('请输入标签').inputValue(), '未提交的标签');
  await page.getByRole('button', { name: '返回客户资料', exact: true }).click();
  await form.waitFor();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url + '#/workspace/order');
  await page.locator('[data-action="commerce-quick-customer"]').click();
  await form.getByLabel('客户姓名').fill('订单快捷客户');
  await page.locator('#drawer').getByRole('button', { name: '来源设置', exact: true }).click();
  await page.getByRole('button', { name: '返回客户资料', exact: true }).click();
  await form.waitFor();
  assert.equal(await form.getByLabel('客户姓名').inputValue(), '订单快捷客户');
  await summary.click();
  assert.equal(await picker.getByRole('checkbox').count(), 1);
  assert.equal(await picker.getByRole('checkbox', { name: '复购客户' }).isChecked(), false);
  await page.goto(url + '#/customers/list');
  await page.getByRole('button', { name: '标签设置', exact: true }).click();
  await settings.waitFor();
  await page.reload();
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  await sourceSettings.waitFor();
  assert.equal(await sourceSettings.getByRole('button', { name: '移除来源 门店咨询' }).count(), 0);
  const persisted = await (await page.request.get(url + 'api/local/commerce')).json();
  assert.equal(persisted.data.customers[0].source, '门店咨询');
  assert.deepEqual(persisted.data.customers[0].tags, ['企业客户', '复购客户']);
  await page.goto(url + '#/settings/customer-tags');
  await page.locator('#main[data-layout-route="customers/list"]').waitFor();
  assert.equal(await page.locator('.sidebar a[href="#/settings/customer-tags"]').count(), 0);
  assert.deepEqual(errors, []);
});
