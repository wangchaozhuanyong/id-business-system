import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin, separatorSnapshot, settle } from './helpers/offline-design.mjs';
import { checkInventoryEntryFields } from '../server/inventory-entry-fields.mjs';
import { attributeInventory, defaultInventoryRegistrationTimes } from '../server/inventory-attribution.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';

const route = '/#/mailboxes/microsoft';
const actor = { id: 'ms-fixture-admin', name: '离线验收员', role: 'admin' };
const loginFixture = 'Fixture login only';
const recovery = { id: 'google-fixture', type: 'google', email: 'recovery@example.test',
  status: '正常', country: '马来西亚', device: '离线设备' };
const security = { loginMode: 'password', recoveryAccess: 'unknown', twoStep: 'unknown',
  verificationMethods: [], verificationDevice: '' };

async function fixture(browser, width, rows = [], operator = actor) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: {}, actor: operator });
  let version = 1;
  let data = { mailboxes: [recovery, ...rows], accounts: [], batches: [], returnRecords: [],
    importRecords: [], registrationRecords: [], tableSettings: [], undo: [] };
  let unavailable = false;
  const actions = [];
  await context.route(origin + '/api/local/inventory', async (requestRoute) => {
    const request = requestRoute.request();
    if (request.method() === 'PUT') {
      const write = request.postDataJSON();
      if (unavailable) return requestRoute.fulfill({ status: 503, json: { error: '合成保存失败' } });
      if (version !== write.version)
        return requestRoute.fulfill({ status: 409, json: { error: '库存版本已变化' } });
      const issue = checkInventoryEntryFields(data, write.data, write.action) ||
        attributeInventory(data, write.data, operator, write.action) || checkInventoryHistory(data, write.data);
      if (issue) return requestRoute.fulfill({ status: 400, json: { error: issue } });
      defaultInventoryRegistrationTimes(data, write.data);
      data = write.data;
      version++;
      actions.push(write.action);
    }
    await requestRoute.fulfill({ json: { version, data, usageReview: [], accountSummaries: [] } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + route);
  const main = page.locator('#main'), drawer = page.locator('#drawer'), confirm = page.locator('#confirm-dialog');
  await page.locator('#main[data-layout-route="mailboxes/microsoft"]').waitFor();
  await main.getByRole('tab', { name: /未使用/ }).waitFor();
  return { context, page, main, drawer, confirm, requests, errors, actions,
    snapshot: () => data, failSaves: (fail) => { unavailable = fail; } };
}

test('微软库存录入、失败重试、回读、编辑、关联、状态及批量导入', { timeout: 50000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const f = await fixture(browser, 1440);
  const { page, main, drawer, confirm, actions } = f;
  const accept = () => confirm.locator('[data-action="confirm-accept"]').click();
  const save = () => drawer.getByRole('button', { name: '核对并保存' }).click();
  const close = () => drawer.getByRole('button', { name: '关闭抽屉' }).click();
  const address = 'stock-ms@example.test';
  const stock = () => f.snapshot().mailboxes.find(row => row.email === address);
  const detail = (email) => main.getByRole('button', { name: email, exact: true }).click();

  await main.getByRole('button', { name: '新增邮箱' }).click();
  await drawer.locator('#inventory-email').fill(' STOCK-MS@Example.Test ');
  await save();
  assert.match(await drawer.locator('#inventory-password-error').innerText(), /必填|必须填写/);
  assert.equal(await confirm.isVisible(), false);
  await drawer.locator('#inventory-microsoft-login').selectOption('passwordless');
  await save();
  assert.match(await drawer.locator('#inventory-microsoft-methods-error').innerText(), /选择实际使用/);
  await drawer.locator('#inventory-microsoft-method-authenticator').check();
  await drawer.locator('#inventory-auxiliary').fill('recovery@example.test');
  await drawer.locator('#inventory-microsoft-recovery').selectOption('inventory');
  await drawer.locator('#inventory-microsoft-two-step').selectOption('enabled');
  await drawer.locator('#inventory-microsoft-device').fill('离线确认手机');
  await close();
  await main.getByRole('button', { name: '新增邮箱' }).click();
  assert.equal(await drawer.locator('#inventory-microsoft-method-authenticator').isChecked(), true);
  f.failSaves(true);
  await save();
  await accept();
  await page.getByText('本次操作未保存，请检查本机服务后重试', { exact: true }).waitFor();
  assert.equal(stock(), undefined);
  assert.equal(await drawer.locator('#inventory-microsoft-device').inputValue(), '离线确认手机');
  f.failSaves(false);
  await save();
  await accept();
  await drawer.waitFor({ state: 'hidden' });
  await detail(address);
  assert.equal(stock().phone, '');
  assert.equal(stock().microsoftSecurity.recoveryMailboxId, recovery.id);
  assert.equal(stock().createdById, actor.id);
  assert.match(await drawer.innerText(), /无密码登录/);
  await drawer.getByRole('button', { name: '查看辅助邮箱资料' }).click();
  assert.match(await drawer.innerText(), /recovery@example\.test/);
  await close();

  await page.reload();
  await main.getByRole('button', { name: address, exact: true }).waitFor();
  const row = main.locator('tr', { hasText: address });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await drawer.locator('#inventory-email').getAttribute('readonly'), '');
  assert.equal(await drawer.locator('#inventory-microsoft-login').inputValue(), 'passwordless');
  await drawer.locator('#inventory-microsoft-login').selectOption('password');
  await drawer.locator('#inventory-password').fill(loginFixture);
  await save();
  await accept();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(stock().password, loginFixture);
  await row.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '移入解封中' }).click();
  await accept();
  await main.getByRole('tab', { name: /解封中/ }).click();
  await main.getByRole('button', { name: address, exact: true }).waitFor();
  assert.equal(stock().health, 'unlocking');

  await main.getByRole('button', { name: '批量导入' }).click();
  const csv = drawer.locator('#inventory-import-content');
  const preview = () => drawer.getByRole('button', { name: '检查并预览' }).click();
  const importButton = drawer.getByRole('button', { name: '确认导入', exact: true });
  assert.equal(await drawer.getByRole('button', { name: '复制示例 CSV' }).isVisible(), true);
  await csv.fill(`邮箱,登录密码\n${address.toUpperCase()},${loginFixture}\nnew@example.test,${loginFixture}`);
  await preview();
  assert.equal(await importButton.isDisabled(), true);
  assert.match(await drawer.locator('#inventory-import-results').innerText(), /相同类型邮箱重复/);
  assert.equal(f.snapshot().importRecords.length, 0);
  const rowPassword = '  fixture quoted password  ';
  await csv.fill(`邮箱,登录密码,登录方式,辅助邮箱,取码方式,两步验证,验证方式,2FA密钥\nimport-ms@example.test,"${rowPassword}",密码登录,recovery@example.test,系统内邮箱,已开启,邮箱验证码;动态验证码,FIXTURESEED`);
  await preview();
  assert.doesNotMatch(await drawer.locator('#inventory-import-results').innerHTML(), /FIXTURESEED|fixture quoted password/);
  await drawer.locator('#inventory-import-source').selectOption('线上购买');
  await importButton.click();
  assert.equal(await confirm.isVisible(), false);
  await importButton.click();
  await accept();
  await drawer.waitFor({ state: 'hidden' });
  const imported = f.snapshot().mailboxes.find(row => row.email === 'import-ms@example.test');
  assert.equal(imported.password, rowPassword);
  assert.equal(imported.source, '线上购买');
  assert.equal(imported.totp, 'FIXTURESEED');
  assert.deepEqual(imported.microsoftSecurity.verificationMethods, ['email', 'totp']);
  assert.equal(imported.microsoftSecurity.recoveryMailboxId, recovery.id);
  assert.deepEqual(actions, ['inventory_create', 'inventory_edit', 'inventory_health_change', 'inventory_import']);
  assert.doesNotMatch(JSON.stringify(f.snapshot().importRecords), /FIXTURESEED|fixture quoted password/);
  await main.getByRole('tab', { name: '导入记录' }).click();
  await main.getByRole('button', { name: '详情', exact: true }).click();
  assert.match(await drawer.innerText(), /import-ms@example\.test/);
  await close();
  for (const path of ['workspace/mail-extract', 'workspace/mail-submit', 'workspace/account-submit']) {
    await page.evaluate(path => { location.hash = '#/' + path; }, path);
    const target = path.replace(/-submit$/, '-extract');
    await page.locator(`#main[data-layout-route="${target}"]`).waitFor();
    const submission = main.locator('.inventory-submission-panel');
    for (const action of ['inventory-add-type', 'inventory-import']) {
      assert.equal(await submission.locator(`[data-action="${action}"][data-type="microsoft"]`).count(),
        target === 'workspace/mail-extract' ? 1 : 0);
    }
    assert.equal(await main.locator('#inventory-extract-type option[value="microsoft"]').count(), 0);
  }
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
});

test('邮箱工作台录入和导入微软邮箱，共用库存及录入草稿', { timeout: 30000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const f = await fixture(browser, 390);
  const { page, main, drawer, confirm } = f;
  const workspace = 'workspace/mail-extract';
  const go = async path => {
    await page.evaluate(path => window.IDDesignAPI.go(path), path);
    await page.locator(`#main[data-layout-route="${path}"]`).waitFor();
  };
  const close = () => drawer.getByRole('button', { name: '关闭抽屉' }).click();
  const save = async () => {
    const response = page.waitForResponse(r =>
      r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/inventory');
    await confirm.locator('[data-action="confirm-accept"]').click();
    assert.equal((await response).status(), 200);
    await drawer.waitFor({ state: 'hidden' });
  };
  const address = 'workbench-ms@example.test';
  const importedAddress = 'workbench-import-ms@example.test';
  const card = main.locator('.inventory-submission-panel .guide-item').filter({
    has: page.getByRole('heading', { name: '微软邮箱', exact: true })
  });
  const add = () => card.getByRole('button', { name: '单条录入', exact: true }).click();

  await go(workspace);
  const notes = main.locator('#inventory-extract-notes');
  await notes.fill('提取草稿独立保留');
  await add();
  await drawer.getByRole('heading', { name: '新增微软邮箱', exact: true }).waitFor();
  assert.equal(await drawer.locator('#inventory-asset-type').inputValue(), 'microsoft');
  await drawer.locator('#inventory-email').fill(address);
  await drawer.locator('#inventory-password').fill(loginFixture);
  await close();
  await go('mailboxes/microsoft');
  await main.getByRole('button', { name: '新增邮箱' }).click();
  assert.equal(await drawer.locator('#inventory-email').inputValue(), address);
  await close();
  await go(workspace);
  await add();
  await drawer.getByRole('button', { name: '核对并保存' }).click();
  await save();
  const created = f.snapshot().mailboxes.find(row => row.email === address);
  assert.equal(created.type, 'microsoft');
  assert.equal(created.microsoftSecurity.verificationDevice, '');

  await card.getByRole('button', { name: '批量导入', exact: true }).click();
  assert.equal(await drawer.locator('#inventory-import-type-display').inputValue(), '微软邮箱');
  assert.equal(await drawer.getByRole('button', { name: '复制示例 CSV' }).isVisible(), true);
  await drawer.locator('#inventory-import-content').fill(`邮箱,登录密码\n${importedAddress},${loginFixture}`);
  await drawer.getByRole('button', { name: '检查并预览' }).click();
  await drawer.getByRole('button', { name: '确认导入', exact: true }).click();
  await save();
  assert.equal(f.snapshot().importRecords[0].type, 'microsoft');
  assert.equal(f.snapshot().importRecords[0].success, 1);
  const recent = main.getByRole('region', { name: '提交资料' }).locator('.inventory-workspace-records li');
  assert.match(await recent.innerText(), /微软邮箱/);
  await recent.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByText(importedAddress, { exact: true }).waitFor();
  await close();

  assert.equal(await notes.inputValue(), '提取草稿独立保留');
  assert.equal(await main.locator('#inventory-extract-type option[value="microsoft"]').count(), 0);
  await go('mailboxes/microsoft');
  for (const email of [address, importedAddress]) {
    await main.getByRole('button', { name: email, exact: true }).waitFor();
  }
  assert.deepEqual(f.actions, ['inventory_create', 'inventory_import']);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
});

test('旧微软邮箱可补使用状态，健康状态独立筛选', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const historical = { id: 'old-ms', type: 'microsoft', email: 'old-ms@example.test',
    source: '自己注册', status: '封控中' };
  const f = await fixture(browser, 1440, [historical]);
  t.after(() => f.context.close());
  const { main, drawer, confirm } = f;
  const row = main.locator('tr[data-row-id="old-ms"]');
  await row.locator('[data-column="use"] .tag').filter({ hasText: '未登记' }).waitFor();
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await drawer.getByLabel('使用状态', { exact: true }).selectOption('used');
  await drawer.getByRole('button', { name: '核对并保存' }).click();
  await confirm.locator('[data-action="confirm-accept"]').click();
  await row.locator('[data-column="use"] .tag').filter({ hasText: '已使用' }).waitFor();
  assert.equal(f.snapshot().mailboxes.find(item => item.id === historical.id).mailboxUsage, 'used');
  await row.getByRole('button', { name: '详情', exact: true }).click();
  const usage = drawer.locator('.property-row').filter({ hasText: '使用状态' });
  await usage.getByText('已使用', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await main.getByLabel('筛选邮箱状态').selectOption('封控中');
  await main.getByLabel('筛选使用状态').selectOption('used');
  await row.getByText('封控中', { exact: true }).waitFor();
  await main.getByLabel('筛选使用状态').selectOption('unknown');
  assert.equal(await row.count(), 0);
  assert.deepEqual(f.errors, []);
});

test('微软邮箱桌面与手机的列表和抽屉布局', { timeout: 50000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const rows = Array.from({ length: 26 }, (_, index) => ({
    id: `ms-layout-${index}`, type: 'microsoft', email: `layout-${index}@example.test`,
    password: loginFixture, source: '自己注册', status: '正常', microsoftSecurity: security
  }));
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'dark']]) {
    const { context, page, main, drawer, errors } = await fixture(browser, width, rows);
    try {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const measure = async (scope) => {
        await settle(page);
        assert.deepEqual((await separatorSnapshot(page, scope)).findings, [], `${width} ${theme} ${scope}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      };
      await measure('#main');
      const table = main.locator('.table-viewport');
      const firstHeight = (await table.boundingBox()).height;
      const next = main.getByRole('button', { name: '下一页' });
      await next.click();
      await measure('#main');
      const lastHeight = (await table.boundingBox()).height;
      if (width > 900) assert(Math.abs(lastHeight - firstHeight) <= 1, '桌面末页表格外框应保持稳定');
      else {
        assert(lastHeight < firstHeight, '手机末页只为实际资料卡保留空间');
        assert(await main.getByRole('button', { name: '上一页' }).isVisible());
        assert(await next.isDisabled());
      }
      const search = main.getByRole('textbox', { name: '搜索库存资料' });
      await search.fill('不存在的邮箱');
      await page.waitForFunction(() => !document.querySelector('#main tbody tr[data-row-id]'));
      assert.equal(await main.locator('tbody tr[data-row-id]').count(), 0);
      await measure('#main');
      await main.getByRole('button', { name: '新增邮箱' }).click();
      await measure('#drawer');
      const titleHelp = drawer.locator('.drawer-title-row .title-help');
      const field = drawer.locator('#inventory-email');
      const fieldTop = (await field.boundingBox()).y;
      assert.equal(await titleHelp.getAttribute('open'), null);
      await titleHelp.locator('summary').click();
      assert.notEqual(await titleHelp.getAttribute('open'), null);
      assert.equal((await field.boundingBox()).y, fieldTop);
      await page.keyboard.press('Escape');
      assert.equal(await titleHelp.getAttribute('open'), null);
      const controls = await drawer.locator('#inventory-microsoft-methods').evaluate(node => {
        const parent = node.closest('#drawer').getBoundingClientRect();
        return [...node.querySelectorAll('label')].map(label => label.getBoundingClientRect())
          .every(rect => rect.width > 0 && rect.left >= parent.left && rect.right <= parent.right + 1);
      });
      assert.equal(controls, true, `${width} ${theme} 验证方式选项不可裁切`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test('微软邮箱沿用员工库存只读权限', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { main, drawer, actions } = await fixture(browser, 1440, [{
    id: 'ms-read-fixture', type: 'microsoft', email: 'read@example.test',
    password: loginFixture, source: '自己注册', status: '正常', microsoftSecurity: security
  }], { id: 'ms-fixture-employee', name: '合成普通员工', role: 'employee' });
  assert.equal(await main.getByRole('button', { name: '新增邮箱' }).count(), 0);
  assert.equal(await main.getByRole('button', { name: '批量导入' }).count(), 0);
  assert.equal(await main.getByRole('button', { name: '编辑', exact: true }).count(), 0);
  await main.getByRole('button', { name: 'read@example.test', exact: true }).click();
  assert.match(await drawer.innerText(), /登录密码/);
  assert.deepEqual(actions, []);
});
