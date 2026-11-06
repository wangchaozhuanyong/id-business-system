import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('客户选项晚到保存不关闭新抽屉或丢弃编辑，失败后保留草稿可重试', { timeout: 45_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  let browser;
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  t.after(async () => {
    releaseFirst();
    await browser?.close();
    host.server.closeAllConnections();
    await new Promise((resolve) => host.server.close(resolve));
  });
  browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = new URL(host.url).origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  let delayFirst = true;
  let failNext = false;
  let acknowledgeFirst;
  const firstAcknowledged = new Promise((resolve) => { acknowledgeFirst = resolve; });
  await page.route('**/api/local/settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"隔离测试读取失败"}' });
    }
    if (!delayFirst) return route.continue();
    delayFirst = false;
    const response = await route.fetch();
    acknowledgeFirst();
    await firstRelease;
    await route.fulfill({ response });
  });
  const openSources = () => page.locator('#main').getByRole('button', { name: '来源设置', exact: true }).click();
  const sourceForm = page.locator('#ops-customer-sources-form');
  const sourceSave = page.getByRole('button', { name: '保存来源设置', exact: true });
  const confirm = () => page.locator('[data-action="confirm-accept"]').click();
  const nextSave = () => page.waitForResponse((response) =>
    response.url().endsWith('/api/local/settings') && response.request().method() === 'PUT');

  await page.goto(host.url + '#/customers/new');
  await page.locator('#commerce-contact-name').fill('待录入客户');
  await openSources();
  await sourceForm.getByPlaceholder('请输入来源').fill('首个保存来源');
  await sourceForm.getByRole('button', { name: '添加', exact: true }).click();
  await sourceSave.click();
  await confirm();
  await firstAcknowledged;
  assert.equal(await sourceForm.getAttribute('aria-busy'), 'true');
  await page.getByRole('button', { name: '返回客户资料', exact: true }).click();
  await sourceForm.waitFor({ state: 'hidden' });
  await openSources();
  await sourceForm.getByPlaceholder('请输入来源').fill('晚到后新增来源');
  await sourceForm.getByRole('button', { name: '添加', exact: true }).click();
  const reopened = await sourceForm.elementHandle();
  releaseFirst();
  await page.getByText('客户来源设置已保存', { exact: true }).waitFor();
  assert(await sourceForm.isVisible(), '晚到响应不得关闭重新打开的设置抽屉');
  assert(await sourceForm.evaluate((node, expected) => node === expected, reopened), '晚到响应不得重绘新表单');
  assert(await sourceForm.getByRole('button', { name: '移除来源 晚到后新增来源', exact: true }).isVisible());
  assert.equal(await sourceForm.locator('[name="ops-customer-sources-version"]').inputValue(), '1');
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '待录入客户');
  await reopened.dispose();

  await sourceSave.click();
  const secondSave = nextSave();
  await confirm();
  assert.equal((await secondSave).status(), 200, '新抽屉应能以更新版本继续保存');
  await sourceForm.waitFor({ state: 'hidden' });
  const afterSources = await (await page.request.get(host.url + 'api/local/settings')).json();
  assert.equal(afterSources.version, 2);
  assert(afterSources.data.customerSources.includes('首个保存来源'));
  assert(afterSources.data.customerSources.includes('晚到后新增来源'));

  await page.locator('#main').getByRole('button', { name: '标签设置', exact: true }).click();
  const tagForm = page.locator('#ops-customer-tags-form');
  const tagSave = page.getByRole('button', { name: '保存标签设置', exact: true });
  await tagForm.getByPlaceholder('请输入标签').fill('保留重试标签');
  await tagForm.getByRole('button', { name: '添加', exact: true }).click();
  failNext = true;
  await tagSave.click();
  const failedSave = nextSave();
  await confirm();
  assert.equal((await failedSave).status(), 503);
  await page.getByText('本机设置未保存，请重试', { exact: true }).waitFor();
  assert(await tagForm.isVisible());
  assert(await tagForm.getByRole('button', { name: '移除标签 保留重试标签', exact: true }).isVisible());
  assert(await tagSave.isEnabled(), '失败后保存按钮应可重试');
  assert.notEqual(await tagForm.getAttribute('aria-busy'), 'true');
  assert.equal(await tagForm.locator('[name="ops-customer-tags-version"]').inputValue(), '2');
  await tagSave.click();
  const retrySave = nextSave();
  await confirm();
  assert.equal((await retrySave).status(), 200);
  await tagForm.waitFor({ state: 'hidden' });
  const finalSettings = await (await page.request.get(host.url + 'api/local/settings')).json();
  assert.equal(finalSettings.version, 3);
  assert.deepEqual(finalSettings.data.customerTags, ['保留重试标签']);
  assert(finalSettings.data.customerSources.includes('晚到后新增来源'));
  assert.deepEqual(errors, []);
});
