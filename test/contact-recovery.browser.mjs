import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const actor = { id: 'fixture-admin', role: 'admin', name: '合成管理员' };
const original = { id: '17', time: '2026-11-14 09:00:00', actor: '合成员工', action: '修改资料',
  subject: '客户资料', targetId: 'customer-a', result: '修改资料', recovery: 'original' };
const receipt = { status: 'receipt', originalId: original.id, reason: '资料填错',
  record: { ...original, id: '2032', actor: actor.name, action: '撤回资料操作',
    result: '已撤回原操作 #17', recovery: 'receipt' } };
const preview = { status: 'available', record: original, targetName: '合成客户', version: 2,
  changes: [{ label: '联系电话', current: '777777', restore: '555555' },
    { label: '客户微信', current: 'long-' + 'a'.repeat(55), restore: 'original' }],
  reasons: [['wrong_value', '资料填错'], ['wrong_contact', '选错客户或租户']] };

const fixtures = actor => ({ actor, localFixtures: { 'auth/session': { actor, configured: true } }, skipRechargeAssets: true });
const auditUrl = origin + '/api/local/audit/';

test('administrator can preview and restore on desktop and phone, and a lost response replays the same write', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, colorScheme] of [[1440, 'light'], [390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, serviceWorkers: 'block' });
    try {
      await interceptDesign(context, fixtures(actor));
      const writes = [], reads = [];
      let committed = false, verification = false, verificationCount = 0, loseResponses = 2, denyPreview = true;
      await context.route(auditUrl + 'page?*', route => {
        const params = new URL(route.request().url()).searchParams;
        reads.push(Object.fromEntries(params));
        const query = params.get('query');
        const items = params.get('view') === 'audit' ? [] :
          query === '无匹配' ? [] : committed ? [receipt.record, original] : [original];
        return route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 20, snapshot: 2032 } });
      });
      await context.route(auditUrl + '*/recovery', async route => {
        const request = route.request();
        const id = new URL(request.url()).pathname.split('/').at(-2);
        if (request.method() === 'GET') {
          if (denyPreview) {
            denyPreview = false;
            return route.fulfill({ status: 503, json: { error: '合成读取失败' } });
          }
          return route.fulfill({ json: id === receipt.record.id ? receipt :
            committed ? { status: 'recovered', record: original, receipt } : preview });
        }
        writes.push({ id: request.headers()['x-id-operation'], body: request.postDataJSON() });
        if (!verification)
          return route.fulfill({ status: 403, json: { code: 'SECURITY_CONFIRMATION_REQUIRED' } });
        committed = true;
        if (loseResponses-- > 0) return route.abort('connectionreset');
        return route.fulfill({ json: receipt });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('testVerify', () => { verificationCount++; verification = true; return true; });
      await page.addInitScript(() => { window.IDAccountSecurity = { verify: () => window.testVerify() }; });
      await page.goto(origin + '/#/settings/audit');
      if (colorScheme === 'dark') await toggleDesignTheme(page);
      const main = page.locator('#main'), dialog = page.locator('#drawer');
      await main.getByRole('combobox', { name: '日志范围' }).selectOption('recovery');
      await main.getByRole('button', { name: '查看恢复', exact: true }).waitFor();
      const spacing = await separatorSnapshot(page);
      assert.deepEqual(spacing.findings, []);
      assert.equal(reads.at(-1).view, 'recovery');
      const search = main.getByRole('textbox', { name: '搜索当前列表' });
      await search.fill('无匹配');
      await main.getByText('暂无符合条件的记录').waitFor();
      await search.fill('合成员工');
      await main.getByRole('button', { name: '查看恢复', exact: true }).click();
      assert.equal(reads.at(-1).query, '合成员工');
      await dialog.getByText('恢复详情读取失败，请重试。').waitFor();
      await dialog.getByRole('button', { name: '重试读取', exact: true }).click();
      await dialog.getByText('777777', { exact: true }).waitFor();
      assert(await dialog.getByText('555555', { exact: true }).isVisible());
      assert(await dialog.getByText('合成客户', { exact: true }).isVisible());
      const bounds = await dialog.locator('.drawer-body').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
      assert(bounds.scroll <= bounds.width + 1, 'the preview must fit the drawer');
      await dialog.getByRole('button', { name: '确认撤回', exact: true }).click();
      await dialog.getByText('请选择撤回原因。').waitFor();
      assert.equal(writes.length, 0);
      await dialog.getByLabel('撤回原因').selectOption('wrong_value');
      await dialog.getByRole('button', { name: '确认撤回', exact: true }).click();
      await dialog.getByText('暂时无法确认撤回结果，可重试核对原请求。').waitFor();
      assert(await dialog.getByLabel('撤回原因').isDisabled());
      await dialog.getByRole('button', { name: '重试撤回', exact: true }).click();
      await dialog.getByRole('heading', { name: '恢复回执' }).waitFor();
      assert(await dialog.getByText('资料填错', { exact: true }).isVisible());
      assert.match(writes[0].id, /^[a-f\d-]{36}$/);
      assert.deepEqual(writes[0].body, { version: 2, reason: 'wrong_value' });
      assert.deepEqual(writes, Array(4).fill(writes[0]));
      assert.equal(verificationCount, 1);
      await dialog.getByRole('button', { name: '查看原操作' }).click();
      await dialog.getByRole('heading', { name: '已撤回' }).waitFor();
      await dialog.getByRole('button', { name: '查看恢复回执' }).click();
      await dialog.getByRole('heading', { name: '恢复回执' }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('a conflict disables the old confirmation and an employee has no recovery entry', { timeout: 25_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await interceptDesign(context, fixtures(actor));
  await context.route(auditUrl + 'page?*', route =>
    route.fulfill({ json: { items: [original], total: 1, page: 1, pageSize: 20, snapshot: 17 } }));
  let conflicted = false;
  await context.route(auditUrl + '17/recovery', route => {
    if (route.request().method() === 'POST') {
      conflicted = true;
      return route.fulfill({ status: 409, json: { error: '合成资料已变化' } });
    }
    return route.fulfill({ json: conflicted ? { status: 'unavailable', record: original,
      message: '这条资料在原操作后已有更新，请到原业务页面核对。' } : preview });
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/settings/audit');
  await page.getByRole('button', { name: '查看恢复' }).click();
  const dialog = page.locator('#drawer');
  await dialog.getByLabel('撤回原因').selectOption('wrong_value');
  await dialog.getByRole('button', { name: '确认撤回' }).click();
  await dialog.getByText(/原操作后已有更新/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '确认撤回' }).count(), 0);
  await context.close();

  const employee = { id: 'fixture-employee', role: 'employee', name: '合成员工' };
  const scoped = await browser.newContext({ serviceWorkers: 'block' });
  await interceptDesign(scoped, fixtures(employee));
  const workerPage = await scoped.newPage();
  const reads = [];
  workerPage.on('request', request => { if (request.url().startsWith(auditUrl)) reads.push(request.url()); });
  await workerPage.goto(origin + '/#/settings/audit');
  assert.equal(await workerPage.getByRole('combobox', { name: '日志范围' }).count(), 0);
  assert.deepEqual(reads, []);
  await scoped.close();
});

test('leaving or clearing the account drops an in-flight preview', { timeout: 15_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await interceptDesign(context, fixtures(actor));
  await context.route(auditUrl + 'page?*', route =>
    route.fulfill({ json: { items: [original], total: 1, page: 1, pageSize: 20, snapshot: 17 } }));
  let reply;
  await context.route(auditUrl + '17/recovery', route => {
    reply = () => route.fulfill({ json: preview }).catch(() => {});
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/settings/audit');
  for (const clear of [false, true]) {
    const arrived = page.waitForRequest(auditUrl + '17/recovery');
    await page.getByRole('button', { name: '查看恢复' }).click();
    await arrived;
    await page.locator('#drawer').getByText('正在读取恢复详情…').waitFor();
    if (clear) {
      await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
    } else {
      await page.evaluate(() => { location.hash = '#/settings/login-logs'; });
      await page.locator('#main[data-layout-route="settings/login-logs"]').waitFor();
    }
    await reply?.();
    assert.equal(await page.locator('#drawer').getByText('555555').count(), 0);
    assert.equal(await page.locator('#drawer #ops-audit-recovery-form').count(), 0);
    if (!clear) await page.evaluate(() => { location.hash = '#/settings/audit'; });
  }
  await context.close();
});
