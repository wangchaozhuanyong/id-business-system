import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { columnPreferencesRoute, createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

test('列设置刷新后按账户及表格恢复，覆盖共享列表和比特地址管理', { timeout: 60_000 }, async t => {
  const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
    ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('column-preferences-', runtime));
  let server, browser;
  t.after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const authPath = join(directory, 'accounts.json');
  const databasePath = join(directory, 'business.sqlite');
  const supervisor = { email: 'layout-owner@example.test', name: '列设置管理员', password: randomUUID() };
  const employee = { email: 'layout-employee@example.test', name: '列设置员工', password: randomUUID(), role: 'employee' };
  const owner = await initializeLocalAdmin(authPath, supervisor);
  const preview = await startPreview(0, { databasePath, authPath });
  server = preview.server;
  const origin = new URL(preview.url).origin;
  browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const mail = 'mailboxes/google';
  const gpt = 'accounts/gpt';
  const addresses = 'recharge/start';
  const url = route => `${origin}/#/${route}`;
  const main = page.locator('#main');
  const header = name => main.getByRole('columnheader', { name, exact: true });
  const settings = main.locator('button[data-action="column-settings"]');
  const drawer = page.getByRole('dialog', { name: '列设置', exact: true });
  const checkbox = id => drawer.locator(`[data-column="${id}"]`);
  const done = () => drawer.getByRole('button', { name: '完成', exact: true }).click();
  const login = async (target, account) => {
    await target.locator('#local-auth-email').fill(account.email);
    await target.locator('#local-auth-password').fill(account.password);
    await target.getByRole('button', { name: '登录', exact: true }).click();
    await target.locator('#main table').first().waitFor();
  };
  const logout = async () => {
    await page.locator('#profile-button').click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.locator('#local-auth-email').waitFor();
    assert.equal(await page.locator('meta[name="id-column-preferences"]').count(), 0);
  };
  const patch = (data, requestOrigin = origin) => page.request.patch(origin + columnPreferencesRoute,
    { data, headers: { Origin: requestOrigin } });
  const addressPanel = page.locator('#bit-addresses-panel');
  const addressHeader = name => addressPanel.getByRole('columnheader', { name, exact: true });

  await page.goto(url(mail));
  assert.equal((await patch({})).status(), 401);
  await login(page, supervisor);
  const created = await page.request.post(origin + '/api/local/auth/employees', { data: employee, headers: { Origin: origin } });
  assert.equal(created.status(), 201);
  const tableId = await settings.getAttribute('data-table-id');
  await settings.click();
  assert(await checkbox('email').isDisabled());
  assert(await checkbox('email').isChecked());

  await page.route('**' + columnPreferencesRoute, route =>
    route.fulfill({ status: 503, json: { error: '隔离测试写入失败' } }), { times: 1 });
  await checkbox('password').uncheck();
  await page.getByRole('alert').getByText('隔离测试写入失败', { exact: true }).waitFor();
  assert(await checkbox('password').isChecked());
  assert(await header('邮箱密码').isVisible());

  await checkbox('password').uncheck();
  await header('邮箱密码').waitFor({ state: 'hidden' });
  await done();
  const concurrentChanges = await Promise.all(['notes', 'country'].map(columnId =>
    patch({ actorId: owner.id, tableId, columnId, visible: false })));
  assert.deepEqual(concurrentChanges.map(response => response.status()), [200, 200]);
  await page.reload();
  await header('邮箱账号').waitFor();
  for (const name of ['邮箱密码', '备注 1', '国家地区']) assert.equal(await header(name).count(), 0);

  await page.goto(url(gpt));
  await header('账号密码').waitFor();
  await page.goto(url(addresses));
  await addressHeader('街道地址').waitFor();
  await addressPanel.getByRole('button', { name: '列设置', exact: true }).click();
  await addressPanel.getByRole('checkbox', { name: '城市', exact: true }).uncheck();
  await addressHeader('城市').waitFor({ state: 'hidden' });
  await page.reload();
  await addressHeader('街道地址').waitFor();
  assert.equal(await addressHeader('城市').count(), 0);
  await addressPanel.getByRole('tab', { name: /^已使用/ }).click();
  await addressHeader('使用时间').waitFor();
  assert.equal(await addressHeader('城市').count(), 0);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const phone = await mobile.newPage();
    await phone.goto(url(mail));
    await login(phone, supervisor);
    await phone.locator('#main [data-action="mobile-list-actions"]').click();
    await phone.getByRole('menuitem', { name: '列设置', exact: true }).click();
    for (const id of ['password', 'notes', 'country'])
      assert.equal(await phone.locator(`#drawer [data-column="${id}"]`).isChecked(), false);
  } finally { await mobile.close(); }

  await page.goto(url(mail));
  await logout();
  await login(page, employee);
  await header('邮箱密码').waitFor();
  assert.equal((await patch({ actorId: owner.id, tableId, columnId: 'password', visible: false })).status(), 409);
  const employeeId = (await created.json()).employee.id;
  assert.equal((await patch({ actorId: employeeId, tableId, reset: true }, 'https://other.example.test')).status(), 403);
  await settings.click();
  await checkbox('notes2').uncheck();
  await header('备注 2').waitFor({ state: 'hidden' });
  await done();
  await page.reload();
  await header('邮箱密码').waitFor();
  assert.equal(await header('备注 2').count(), 0);

  await logout();
  await login(page, supervisor);
  assert.equal(await header('邮箱密码').count(), 0);
  assert(await header('备注 2').isVisible());
  await settings.click();
  await drawer.getByRole('button', { name: '恢复全部列', exact: true }).click();
  await header('邮箱密码').waitFor();
  await done();
  await page.reload();
  await header('邮箱密码').waitFor();
  assert(await header('国家地区').isVisible());
  await page.goto(url(addresses));
  await addressHeader('街道地址').waitFor();
  assert.equal(await addressHeader('城市').count(), 0);
  assert.deepEqual(errors, []);

  const reopened = createLocalBusinessStore(databasePath);
  try {
    assert.deepEqual(reopened.loadColumnPreferences(owner), [[tableId, []], ['bitbrowser-addresses', ['city']]]);
    assert.deepEqual(reopened.loadColumnPreferences({ id: employeeId }), [[tableId, ['notes2']]]);
  } finally { reopened.close(); }
});
