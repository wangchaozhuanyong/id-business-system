import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

test('运营表单关闭和切页保留普通草稿，提交快照及敏感字段隔离', { timeout: 60_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'operations-drafts-'));
  const user = { name: '草稿验收管理员', email: 'operations-draft@example.test', password: randomBytes(24).toString('hex') };
  const authPath = join(directory, 'employees.json');
  await initializeLocalAdmin(authPath, user);
  const host = await startPreview(0, { databasePath: ':memory:', authPath });
  let browser;
  let release;
  t.after(async () => {
    release?.();
    await browser?.close();
    host.server.closeAllConnections();
    await new Promise((resolve) => host.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = new URL(host.url).origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/api/local/tools/website-analytics?*', (route) => route.fulfill({ json: { summary: null, daily: [] } }));
  await page.route('**/api/local/saved-totp', (route) => route.fulfill({ json: { version: 0, items: [] } }));
  let poolVersion = 0;
  let failPoolSave = false;
  let delayPoolSave = false;
  let acknowledged;
  let submitted;
  await page.route('**/api/local/tools/mailbox-pool', async (route) => {
    if (route.request().method() === 'PUT') {
      submitted = route.request().postDataJSON();
      if (failPoolSave) {
        failPoolSave = false;
        return route.fulfill({ status: 503, json: { error: '隔离测试保存失败' } });
      }
      poolVersion++;
      if (delayPoolSave) {
        delayPoolSave = false;
        acknowledged();
        await new Promise((resolve) => { release = resolve; });
      }
    }
    await route.fulfill({ json: { version: poolVersion, defaultValidDays: 7, items: [] } });
  });
  await page.goto(host.url + '#/settings/mail-types');
  await page.locator('#local-auth-email').fill(user.email);
  await page.locator('#local-auth-password').fill(user.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const drawer = page.locator('#drawer');
  const close = async () => {
    await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    if (await drawer.isVisible()) await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
  };
  const navigate = async (route) => {
    await page.evaluate((next) => { location.hash = '#/' + next; }, route);
    await page.waitForFunction((next) => window.IDDesignAPI.state.route === next, route);
  };
  const openTool = async (name) => {
    await page.getByRole('button', { name: '在线工具', exact: true }).click();
    await drawer.getByRole('button', { name, exact: true }).click();
  };
  const editCategory = () => page.locator('[data-action="ops-mail-type-edit"][data-id="google"]').click();
  await editCategory();
  await page.locator('#ops-type-label').fill('分类未提交草稿');
  const originalVersion = await page.locator('[name="ops-type-version"]').inputValue();
  await close();
  await navigate('customers/list');
  await navigate('settings/mail-types');
  await editCategory();
  assert.equal(await page.locator('#ops-type-label').inputValue(), '分类未提交草稿');
  assert.equal(await page.locator('[name="ops-type-version"]').inputValue(), originalVersion);
  await drawer.getByRole('button', { name: '核对并保存', exact: true }).click();
  await page.locator('[data-action="confirm-accept"]').click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增分类', exact: true }).click();
  assert.equal(await page.locator('#ops-type-label').inputValue(), '', '新增不串用编辑分类草稿');
  await close();

  await navigate('settings/costs');
  const fee = page.locator('#ops-cost-form input[inputmode="decimal"]').first();
  const originalForm = await page.locator('#ops-cost-form').elementHandle();
  await fee.fill('123');
  await page.locator('[data-action="ops-settings-reload"]').click();
  await page.getByRole('heading', { name: '确认重新读取费用规则' }).waitFor();
  const readStarted = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  await page.route('**/api/local/settings', async (route) => {
    readStarted.resolve();
    await releaseRead.promise;
    await route.continue();
  }, { times: 1 });
  try {
    await page.locator('[data-action="confirm-accept"]').click();
    await readStarted.promise;
    const progress = page.locator('[data-cost-read-status]:not([hidden])');
    await progress.waitFor();
    assert.equal(await progress.textContent(), '');
    await fee.fill('124');
  } finally {
    releaseRead.resolve();
  }
  await page.waitForFunction((form) => !form.isConnected, originalForm);
  await originalForm.dispose();
  assert.equal(await fee.inputValue(), '124', '重新读取完成不能清除请求期间的新输入');

  await openTool('抖音解析');
  await page.locator('#ops-media-text').fill('https://www.douyin.com/video/123456789');
  await close();
  await navigate('customers/list');
  await openTool('抖音解析');
  assert.equal(await page.locator('#ops-media-text').inputValue(), 'https://www.douyin.com/video/123456789');
  await close();
  await openTool('网站监控');
  await drawer.getByRole('tab', { name: '网站检测', exact: true }).click();
  await page.locator('#ops-monitor-url').fill('https://example.test/status');
  await drawer.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
  await page.locator('#ops-visits-days').selectOption('30');
  await page.locator('#ops-visits-sort').selectOption('oldest');
  await close();
  await openTool('网站监控');
  assert.equal(await page.locator('#ops-monitor-url').inputValue(), 'https://example.test/status');
  assert.equal(await page.locator('#ops-visits-days').inputValue(), '30');
  assert.equal(await page.locator('#ops-visits-sort').inputValue(), 'oldest');
  await close();

  await openTool('邮箱查询与邮箱池');
  await drawer.getByRole('tab', { name: '邮件查询', exact: true }).click();
  const mailResults = drawer.locator('#ops-managed-query-results');
  const mailProgress = drawer.locator('#ops-managed-query-progress');
  const queryMail = drawer.getByRole('button', { name: '查询邮件', exact: true });
  const refreshMail = drawer.getByRole('button', { name: '立即刷新', exact: true });
  let subject = '隔离测试邮件';
  await page.route('**/api/local/tools/mailbox-query', route =>
    route.fulfill({ json: { items: [{ subject }] } }));
  await drawer.locator('#ops-managed-query-code').fill('MBX-FIXTURE-ONLY');
  await queryMail.click();
  await mailResults.getByText(subject, { exact: true }).waitFor();
  const failMailRead = Promise.withResolvers();
  await page.route('**/api/local/tools/mailbox-query', async route => {
    await failMailRead.promise;
    await route.fulfill({ status: 503, json: { error: '隔离取信失败' } });
  }, { times: 1 });
  try {
    await refreshMail.click();
    await mailProgress.waitFor();
    assert.equal(await mailProgress.textContent(), '');
    assert((await mailProgress.boundingBox()).height <= 3);
    assert(await refreshMail.isDisabled());
    assert(await mailResults.getByText(subject, { exact: true }).isVisible());
  } finally { failMailRead.resolve(); }
  await mailProgress.getByText('隔离取信失败', { exact: true }).waitFor();
  assert(await mailResults.getByText(subject, { exact: true }).isVisible());
  const releaseOldMail = Promise.withResolvers();
  const oldMailResponse = page.waitForResponse(response =>
    response.url().endsWith('/tools/mailbox-query') && response.request().postDataJSON().limit === 5);
  await page.route('**/api/local/tools/mailbox-query', async route => {
    await releaseOldMail.promise;
    await route.fulfill({ json: { items: [{ subject: '迟到的旧邮件' }] } });
  }, { times: 1 });
  try {
    await refreshMail.click();
    await mailProgress.waitFor();
    await drawer.locator('#ops-managed-query-limit').fill('2');
    subject = '按新条件查询的邮件';
    await queryMail.click();
    await mailResults.getByText(subject, { exact: true }).waitFor();
  } finally { releaseOldMail.resolve(); }
  await (await oldMailResponse).finished();
  await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
  await drawer.getByRole('tab', { name: '邮件查询', exact: true }).click();
  await mailResults.getByText(subject, { exact: true }).waitFor();
  assert.equal(await mailResults.getByText('迟到的旧邮件', { exact: true }).count(), 0);
  await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
  await page.locator('#ops-mailbox-pool[data-version]').waitFor();
  await page.locator('#ops-mailbox-pool-search').fill('草稿搜索');
  await drawer.getByRole('button', { name: '登记邮箱', exact: true }).click();
  await page.locator('#ops-managed-email').fill('draft@example.test');
  await page.locator('#ops-managed-days').fill('23');
  await page.locator('#ops-managed-app-password').fill('fixture-secret-not-retained');
  await close();
  await openTool('邮箱查询与邮箱池');
  await page.locator('#ops-managed-email').waitFor();
  assert.equal(await page.locator('#ops-mailbox-pool-search').inputValue(), '草稿搜索');
  assert.equal(await page.locator('#ops-managed-email').inputValue(), 'draft@example.test');
  assert.equal(await page.locator('#ops-managed-days').inputValue(), '23');
  assert.equal(await page.locator('#ops-managed-app-password').inputValue(), '');
  await drawer.locator('[data-action="ops-mailbox-pool-cancel"]').click();
  await drawer.getByRole('button', { name: '登记邮箱', exact: true }).click();
  assert.equal(await page.locator('#ops-managed-email').inputValue(), 'draft@example.test');
  failPoolSave = true;
  await page.locator('#ops-managed-app-password').fill('fixture-only');
  await page.locator('#ops-managed-pool-form').locator('button[type="submit"]').click();
  await page.getByText('隔离测试保存失败', { exact: true }).waitFor();
  assert.equal(await page.locator('#ops-managed-email').inputValue(), 'draft@example.test');
  delayPoolSave = true;
  const received = new Promise((resolve) => { acknowledged = resolve; });
  await page.locator('#ops-managed-app-password').fill('fixture-only');
  await page.locator('#ops-managed-pool-form').locator('button[type="submit"]').click();
  await received;
  await page.locator('#ops-managed-email').fill('later@example.test');
  await close();
  await openTool('邮箱查询与邮箱池');
  await page.locator('#ops-managed-email').waitFor();
  release();
  await page.waitForFunction(() => document.querySelector('[name="ops-managed-version"]')?.value === '1');
  assert.equal(await page.locator('#ops-managed-email').inputValue(), 'later@example.test', '晚到响应不得清除之后填写的邮箱');
  assert.equal(submitted.email, 'draft@example.test');
  await page.locator('#ops-managed-app-password').fill('fixture-only');
  await page.locator('#ops-managed-pool-form').locator('button[type="submit"]').click();
  await page.locator('#ops-managed-pool-form').waitFor({ state: 'detached' });
  await drawer.getByRole('button', { name: '登记邮箱', exact: true }).click();
  assert.equal(await page.locator('#ops-managed-email').inputValue(), '', '成功只清除对应提交草稿');
  await close();

  await openTool('计算 2FA 验证码');
  await page.locator('#ops-saved-totp[data-version]').waitFor();
  await drawer.getByRole('button', { name: '新增账号', exact: true }).click();
  await page.locator('#ops-totp-name').fill('普通账号名称草稿');
  await page.locator('#ops-totp-save-secret').fill('fixture-not-secret');
  await close();
  await openTool('计算 2FA 验证码');
  await page.locator('#ops-totp-name').waitFor();
  assert.equal(await page.locator('#ops-totp-name').inputValue(), '普通账号名称草稿');
  assert.equal(await page.locator('#ops-totp-save-secret').inputValue(), '');
  await close();

  await navigate('settings/accounts');
  await page.locator('[data-action="ops-local-staff-add"]').click();
  await page.locator('#local-staff-name').fill('员工普通草稿');
  await page.locator('#local-staff-email').fill('draft-staff@example.test');
  await page.locator('#local-staff-role').selectOption('employee');
  await page.locator('#local-staff-password').fill(randomBytes(18).toString('hex'));
  await close();
  await page.locator('[data-action="ops-local-staff-add"]').click();
  assert.equal(await page.locator('#local-staff-name').inputValue(), '员工普通草稿');
  assert.equal(await page.locator('#local-staff-email').inputValue(), 'draft-staff@example.test');
  assert.equal(await page.locator('#local-staff-role').inputValue(), 'employee');
  assert.equal(await page.locator('#local-staff-password').inputValue(), '');
  await page.locator('#local-staff-password').fill(randomBytes(18).toString('hex'));
  const employeeCreated = page.waitForResponse((response) => response.url().endsWith('/auth/employees') && response.request().method() === 'POST');
  await page.locator('button[form="ops-local-staff-form"]').click();
  await page.locator('[data-action="confirm-accept"]').click();
  const { employee } = await (await employeeCreated).json();
  await drawer.waitFor({ state: 'hidden' });
  const employeeEdit = () => page.locator(`[data-action="ops-local-staff-edit"][data-id="${employee.id}"]`).click();
  const employeeRow = page.locator(`tr[data-row-id="${employee.id}"]`);
  await employeeRow.waitFor();
  await page.locator('#ops-list-search').fill(employee.name);
  const releaseEmployeeRead = Promise.withResolvers();
  await page.route('**/api/local/auth/employees', async route => {
    await releaseEmployeeRead.promise;
    await route.fulfill({ status: 503, json: { error: '隔离员工刷新失败' } });
  }, { times: 1 });
  try {
    await page.locator('[data-action="ops-local-staff-reload"]').click();
    const progress = page.locator('[data-employee-progress]');
    await progress.waitFor();
    assert.equal(await progress.textContent(), '');
    assert((await progress.boundingBox()).height <= 3);
    assert(await employeeRow.isVisible());
    await page.getByRole('tab', { name: '角色权限' }).click();
    await page.getByRole('tab', { name: '员工账户' }).click();
    assert(await employeeRow.isVisible());
  } finally { releaseEmployeeRead.resolve(); }
  await page.getByText(/隔离员工刷新失败/).waitFor();
  assert(await employeeRow.isVisible());
  assert.equal(await page.locator('#ops-list-search').inputValue(), employee.name);
  await page.locator('[data-action="ops-local-staff-reload"]').click();
  await page.getByText(/隔离员工刷新失败/).waitFor({ state: 'hidden' });
  assert(await employeeRow.isVisible());
  await page.locator('#ops-list-search').fill('');
  await employeeEdit();
  await page.locator('#local-staff-name').fill('员工提交快照');
  let delayedEmployeeResponse;
  const employeeReceived = new Promise((resolve) => { delayedEmployeeResponse = resolve; });
  let holdEmployee = true;
  await page.route(`**/api/local/auth/employees/${employee.id}`, async (route) => {
    if (route.request().method() !== 'PATCH' || !holdEmployee) return route.continue();
    holdEmployee = false;
    const response = await route.fetch();
    delayedEmployeeResponse();
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ response });
  });
  await page.locator('button[form="ops-local-staff-form"]').click();
  await page.locator('[data-action="confirm-accept"]').click();
  await employeeReceived;
  await page.locator('#local-staff-name').fill('员工晚到后输入');
  release();
  await page.waitForFunction((version) => document.querySelector('[name="staff-version"]')?.value === String(version), employee.version + 1);
  assert.equal(await page.locator('#local-staff-name').inputValue(), '员工晚到后输入');
  const employeeVersion = await page.locator('[name="staff-version"]').inputValue();
  await close();
  await employeeEdit();
  assert.equal(await page.locator('#local-staff-name').inputValue(), '员工晚到后输入');
  assert.equal(await page.locator('[name="staff-version"]').inputValue(), employeeVersion);
  const externalUpdate = await page.evaluate(async ({ id, version }) => {
    const response = await fetch('/api/local/auth/employees/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '并行修改员工', version, role: 'employee', active: true })
    });
    return response.status;
  }, { id: employee.id, version: Number(employeeVersion) });
  assert.equal(externalUpdate, 200);
  const staleResponse = page.waitForResponse((response) => response.url().endsWith('/employees/' + employee.id) && response.status() === 409);
  await page.locator('button[form="ops-local-staff-form"]').click();
  await page.locator('[data-action="confirm-accept"]').click();
  await staleResponse;
  await page.locator('#ops-local-staff-form .local-auth-error:not([hidden])').waitFor();
  await close();
  await employeeEdit();
  assert.equal(await page.locator('#local-staff-name').inputValue(), '员工晚到后输入', '员工版本变化仍保留未提交昵称');
  assert.equal(await page.locator('[name="staff-version"]').inputValue(), employeeVersion, '保留原版本校验依据');
  const bridge = await page.evaluate(() => {
    window.IDRechargeDrafts.write('admin', { gpt_api_base_url: 'https://example.test', tokenInput: 'fixture', gpt_api_key: 'fixture' });
    const first = window.IDRechargeDrafts.read('admin');
    first.gpt_api_base_url = 'modified';
    return window.IDRechargeDrafts.read('admin');
  });
  assert.deepEqual(bridge, { gpt_api_base_url: 'https://example.test' });
  assert.deepEqual(errors, []);
});
