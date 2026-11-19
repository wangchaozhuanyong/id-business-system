import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');

test('登录安全在各尺寸保持分区和说明位置，加载、空数据及刷新失败可区分', async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  const at = Date.UTC(2026, 10, 19, 2, 18);
  const network = { policy: { version: 0, mode: 'observe', entries: [] }, address: '', connectable: false, challengeEnabled: false };
  const fixtures = { 'auth/security/device-requests': { items: [] }, 'auth/security/activity': { items: [] } };
  const traffic = await interceptDesign(context, { actor: { id: 'layout-fixture', name: '测试管理员', role: 'super' },
    localFixtures: fixtures, localAuthUi: true, skipRechargeAssets: true });
  const ready = Promise.withResolvers();
  let failureStatus = 503;
  await context.route('**/api/local/auth/security/network', async route => {
    await ready.promise;
    await route.fulfill(failureStatus ? { status: failureStatus, json: { error: '测试读取失败' } } : { json: network });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/settings/security');
  const surface = page.locator('[data-login-security]');
  const refresh = surface.getByRole('button', { name: '刷新' });
  const networks = surface.getByRole('region', { name: '允许登录的网络' });
  const devices = surface.getByRole('region', { name: '待批准的设备' });
  const activity = surface.getByRole('region', { name: '近期登录拦截' });
  await networks.getByText('正在读取…').waitFor();
  assert(await networks.getByRole('button', { name: '添加 IP' }).isDisabled());
  ready.resolve();
  await surface.getByRole('alert').getByText(/测试读取失败/).waitFor();
  await devices.getByText('暂未取得数据').waitFor();
  failureStatus = 0;
  await refresh.click();
  await networks.getByText('还没有登记允许登录的网络。').waitFor();
  await devices.getByText('暂无设备申请。').waitFor();
  await activity.getByText('暂无近期拦截记录。').waitFor();
  assert(await networks.getByRole('button', { name: '启用网络限制' }).isDisabled());

  const address = '2001:0db8:aaaa:ffff:bbbb:cccc:dddd:1111';
  Object.assign(network, { address, challengeEnabled: true, connectable: true, lastRecovery: { at } });
  Object.assign(network.policy, { version: 3, mode: 'enforce', entries: [{ id: 'office', name: '模拟网络'.repeat(10), network: address + '/128' }] });
  fixtures['auth/security/device-requests'].items.push({ id: 'device', employeeId: 'staff', employeeName: '测试员工', name: '测试设备'.repeat(12), at });
  fixtures['auth/security/activity'].items.push({ kind: 'network', at });
  await refresh.click();
  await devices.getByText('测试员工').waitFor();
  const bounds = node => node.boundingBox();
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await toggleDesignTheme(page);
    for (const width of [1920, 1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      const [left, right] = await Promise.all([bounds(networks), bounds(devices)]);
      if (width >= 1440) {
        assert(Math.abs(left.y - right.y) <= 1 && left.x + left.width < right.x);
        const titles = await Promise.all([networks, devices].map(panel => bounds(panel.getByRole('heading'))));
        assert(Math.abs(titles[0].y - titles[1].y) <= 1);
      } else assert(left.y + left.height < right.y && Math.abs(left.x - right.x) <= 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual((await separatorSnapshot(page, '[data-login-security]')).findings, []);
      const add = networks.getByRole('button', { name: '添加 IP' });
      const before = await bounds(add);
      const help = networks.locator('summary');
      assert.equal(await networks.locator('details[open]').count(), 0);
      await help.click();
      await networks.getByRole('note').waitFor();
      const after = await bounds(add);
      assert(Math.abs(before.y - after.y) < 1 && Math.abs(before.x - after.x) < 1);
      await help.press('Escape');
      assert.equal(await networks.locator('details[open]').count(), 0);
      await surface.getByText(address, { exact: true }).waitFor();
    }
  }
  network.policy.entries.push(...Array.from({ length: 23 }, (_, i) => ({
    id: 'sample-' + i, name: '测试网段 ' + i, network: '192.0.2.' + i
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await refresh.click();
  const rows = networks.getByRole('list');
  await rows.getByText('测试网段 22', { exact: true }).waitFor();
  assert(await rows.evaluate(el => el.scrollHeight > el.clientHeight));
  await rows.getByRole('button', { name: '移除' }).last().focus();
  assert(await rows.evaluate(el => el.scrollTop > 0));
  await page.setViewportSize({ width: 390, height: 900 });
  await settle(page);
  assert(await rows.evaluate(el => el.scrollHeight <= el.clientHeight + 1));
  failureStatus = 503;
  await refresh.click();
  await surface.getByRole('alert').getByText(/上次读取/).waitFor();
  await networks.getByText(address + '/128').waitFor();
  failureStatus = 403;
  await refresh.click();
  await devices.getByText('暂未取得数据').waitFor();
  assert.equal(await surface.getByText(address, { exact: true }).count(), 0);
  assert.equal(await surface.getByText('测试员工').count(), 0);
  assert(await networks.getByRole('button', { name: '添加 IP' }).isDisabled());
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('登录安全分区沿用原有确认、网络版本和设备申请人', async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const policy = { version: 4, mode: 'observe', entries: [] };
  const applications = ['a', 'b'].map(id => ({ id, employeeId: 'employee-' + id, employeeName: '员工 ' + id,
    name: '测试设备', at: Date.UTC(2026, 10, 19) }));
  const actions = [];
  await interceptDesign(context, { actor: { id: 'super-fixture', name: '测试管理员', role: 'super' }, localAuthUi: true,
    localFixtures: { 'auth/security': { passwordConfirmed: true }, 'auth/security/activity': { items: [] },
      'auth/security/device-requests': { items: applications } }, skipRechargeAssets: true });
  await context.route('**/api/local/auth/security/network', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { policy, connectable: true, address: '192.0.2.9' } });
    const command = route.request().postDataJSON();
    actions.push(command);
    assert.equal(command.version, policy.version);
    policy.version++;
    if (command.action === 'add') policy.entries.push({ id: 'office', name: command.name, network: command.network });
    if (command.action === 'mode') policy.mode = command.mode;
    if (command.action === 'remove') policy.entries = policy.entries.filter(row => row.id !== command.id);
    return route.fulfill({ json: { saved: true } });
  });
  await context.route('**/api/local/auth/security/device', route => {
    const command = route.request().postDataJSON();
    actions.push(command);
    const index = applications.findIndex(row => row.id === command.id && row.employeeId === command.employeeId);
    assert.notEqual(index, -1);
    applications.splice(index, 1);
    return route.fulfill({ json: { saved: true } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin + '/#/settings/security');
  const add = page.getByRole('button', { name: '添加 IP' });
  const dialog = page.getByRole('dialog');
  await add.click();
  await dialog.getByRole('button', { name: '取消' }).click();
  assert.equal(actions.length, 0);
  await add.click();
  await dialog.getByLabel('名称').fill('办公网络');
  await dialog.getByLabel('IP 地址或网段').fill('192.0.2.0/24');
  await dialog.getByRole('button', { name: '保存' }).click();
  await page.getByText('办公网络', { exact: true }).waitFor();
  for (const action of ['启用网络限制', '暂停网络限制', '移除', '批准', '拒绝']) {
    await page.getByRole('button', { name: action, exact: true }).first().click();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.local-auth-confirmation') && !document.querySelector('[data-login-security][aria-busy="true"]'));
  }
  await page.getByText('暂无设备申请。').waitFor();
  assert.deepEqual(actions.map(row => row.action), ['add', 'mode', 'mode', 'remove', 'approve', 'remove']);
  assert.deepEqual(actions.slice(1, 3).map(row => row.mode), ['enforce', 'observe']);
  await page.getByRole('link', { name: '查看操作记录' }).click();
  await page.waitForURL('**/#/settings/audit');
});
