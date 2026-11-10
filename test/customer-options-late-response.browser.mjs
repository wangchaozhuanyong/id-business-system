import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('下拉设置晚到保存不重绘新表单，跨页签草稿及失败重试保持有效', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const snapshots = { commerce: { version: 0, data: null }, settings: { version: 0, data: null } };
  const traffic = await interceptDesign(context, { localFixtures: snapshots, skipRechargeAssets: true });
  const release = Promise.withResolvers(), acknowledged = Promise.withResolvers();
  t.after(() => release.resolve());
  let delayFirst = true, failNext = false;
  await context.route('**/api/local/settings', async route => {
    if (route.request().method() !== 'PUT') return route.fulfill({ json: snapshots.settings });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { error: '合成保存失败' } });
    }
    const body = route.request().postDataJSON();
    assert.equal(body.version, snapshots.settings.version);
    snapshots.settings = { version: body.version + 1, data: body.data };
    if (delayFirst) {
      delayFirst = false; acknowledged.resolve(); await release.promise;
    }
    return route.fulfill({ json: snapshots.settings });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const tab = label => page.getByRole('tab', { name: label, exact: true }).click();
  const add = async (form, label, value) => {
    await form.getByPlaceholder('请输入' + label).fill(value);
    await form.getByRole('button', { name: '添加', exact: true }).click();
  };
  const save = async label => {
    await page.getByRole('button', { name: '保存' + label + '设置', exact: true }).click();
    await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  };
  await page.goto(origin + '/#/customers/new');
  await page.locator('#commerce-contact-name').fill('待录入客户');
  await go('settings/costs');
  await page.locator('#ops-cost-gmailCostCny').fill('0.25');
  await tab('来源设置');
  const sourceForm = page.locator('#ops-customer-sources-form');
  await add(sourceForm, '来源', '首个保存来源');
  await save('来源'); await acknowledged.promise;
  assert.equal(await sourceForm.getAttribute('aria-busy'), 'true');
  await tab('标签设置');
  const tagForm = page.locator('#ops-customer-tags-form');
  await add(tagForm, '标签', '保留重试标签');
  await tab('来源设置');
  await add(sourceForm, '来源', '晚到后新增来源');
  const reopened = await sourceForm.elementHandle();
  release.resolve();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  assert(await sourceForm.evaluate((node, expected) => node === expected, reopened), '晚到响应不重绘当前编辑表单');
  assert(await sourceForm.getByRole('button', { name: '移除来源 晚到后新增来源', exact: true }).isVisible());
  assert.equal(await sourceForm.locator('[name="ops-customer-sources-version"]').inputValue(), '1');
  await reopened.dispose();
  await save('来源');
  await sourceForm.locator('[name="ops-customer-sources-version"][value="2"]').waitFor({ state: 'attached' });
  assert(snapshots.settings.data.customerSources.includes('晚到后新增来源'));
  await tab('标签设置');
  assert.equal(await tagForm.locator('[name="ops-customer-tags-version"]').inputValue(), '2', '保存其他配置后保留该页签草稿并更新文档版本');
  failNext = true;
  await save('标签');
  await page.getByText('本机设置未保存，请重试', { exact: true }).waitFor();
  assert(await tagForm.getByRole('button', { name: '移除标签 保留重试标签', exact: true }).isVisible());
  assert(await page.getByRole('button', { name: '保存标签设置', exact: true }).isEnabled());
  assert.notEqual(await tagForm.getAttribute('aria-busy'), 'true');
  await save('标签');
  await tagForm.locator('[name="ops-customer-tags-version"][value="3"]').waitFor({ state: 'attached' });
  assert.deepEqual(snapshots.settings.data.customerTags, ['保留重试标签']);
  await tab('费用规则');
  assert.equal(await page.locator('#ops-cost-gmailCostCny').inputValue(), '0.25');
  await page.getByRole('button', { name: '核对费用规则', exact: true }).click();
  await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  await page.getByText('费用规则已保存到本机', { exact: true }).waitFor();
  assert.equal(snapshots.settings.version, 4);
  assert.equal(snapshots.settings.data.costSettings.gmailCostCny, '0.25');
  assert.deepEqual(snapshots.settings.data.customerTags, ['保留重试标签']);
  assert(snapshots.settings.data.customerSources.includes('晚到后新增来源'));
  await go('customers/new');
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '待录入客户');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});
