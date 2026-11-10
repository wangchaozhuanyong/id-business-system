import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'synthetic-admin', name: '合成操作人', role: 'admin' };
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const plans = { GPT: 'Plus', Claude: 'Max 20x', Gemini: 'Google AI Pro', Grok: 'SuperGrok' };

test('四类订阅页面使用独立状态、真实复制入口与历史兼容路由', { timeout: 120_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    await t.test(`${width}px ${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
      t.after(() => context.close());
      const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
      fixtures['auth/session'] = { configured: true, actor };
      fixtures['auth/order-owners'] = { items: [actor, { id: 'synthetic-owner', name: '合成归属人', role: 'employee' }] };
      const intercepted = await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
      let confirmed = false, owner = '', version = 1;
      const commands = [];
      await context.route('**/api/local/subscriptions/list', route => {
        const request = route.request().postDataJSON(), status = confirmed ? 'active' : 'pending';
        const record = { source: 'order', sourceId: 'synthetic-order', orderNo: 'TEST-ORDER', plan: plans[request.product],
          start: '2026-11-01 10:00', expiry: '2026-12-01 10:00', status, remainingDays: 21,
          operatorName: actor.name, confirmed };
        const row = { id: 'synthetic-account', product: request.product, account: request.product === 'Grok' ? '@synthetic' : 'synthetic@example.test',
          registrationEmail: request.product === 'Grok' ? '' : 'synthetic@example.test', status, conflict: false,
          ownerId: owner, ownerName: owner ? '合成归属人' : '', operatorName: actor.name, accountId: 'asset',
          series: [{ key: request.product, ...record }], history: [record], queryCode: { status: 'missing', remainingDays: null } };
        if (request.product === 'Grok') row.series.push({ ...record, key: 'x_premium', plan: 'X Premium',
          status: 'expired', remainingDays: 0 });
        const items = (!request.status || row.series.some(series => series.status === request.status)) &&
          (!request.query || row.account.includes(request.query)) ? [row] : [];
        return route.fulfill({ json: { items, total: items.length, accountCount: 1, page: 1, pageSize: request.pageSize,
          counts: { active: confirmed ? 1 : 0, expired: request.product === 'Grok' ? 1 : 0, pending: confirmed ? 0 : 1, ended: 0 },
          revision: 'revision-' + version, now: '2026-11-10T02:00:00Z' } });
      });
      await context.route('**/api/local/subscriptions/copy', route => {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ json: { text: '邮箱账号：synthetic@example.test\n邮箱密码：SYNTHETIC', omitted: ['邮箱 2FA'] } });
      });
      await context.route('**/api/local/subscriptions/confirm', route => {
        commands.push(route.request().postDataJSON()); confirmed = true; version++;
        return route.fulfill({ json: { saved: true } });
      });
      await context.route('**/api/local/subscriptions/owner', route => {
        commands.push(route.request().postDataJSON()); owner = 'synthetic-owner'; version++;
        return route.fulfill({ json: { saved: true } });
      });
      await context.route('**/api/local/claude-google-subscriptions/copy-settings', route =>
        route.fulfill({ json: { version: 1, copy1: '原短后缀', copy2: '原完整后缀' } }));
      await context.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => window.syntheticCopies.push(value) } });
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(8000);
      await page.goto(origin + '/#/data-management/claude-google-subscriptions');
      await page.waitForURL('**/#/subscriptions/claude');
      await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
      if (theme === 'dark') await page.locator('#theme-toggle').click();
      for (const name of ['gpt', 'claude', 'gemini', 'grok']) {
        await page.evaluate(route => { location.hash = '#/subscriptions/' + route; }, name);
        await page.locator(`#main[data-layout-route="subscriptions/${name}"]`).waitFor();
        await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
        assert.match(await page.locator('#page-title').innerText(), new RegExp(name === 'gpt' ? 'GPT' : name === 'claude' ? 'Claude' : name === 'gemini' ? 'Gemini' : 'Grok'));
        assert.match(await page.locator('#subscription-list').innerText(), /订阅剩余天数/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (name === 'grok') {
          assert.match(await page.locator('#subscription-overview .summary-item').filter({ hasText: '全部账号' }).innerText(), /1\s*个/);
          assert.match(await page.locator('#subscription-overview .summary-item').filter({ hasText: '已过期' }).innerText(), /1\s*个/);
          const loaded = page.waitForResponse(response => response.url().endsWith('/api/local/subscriptions/list') &&
            response.request().postDataJSON().status === 'expired');
          await page.locator('#subscription-status').selectOption('expired'); await loaded;
          await page.locator('#subscription-list').getByText('X Premium', { exact: true }).waitFor();
        }
      }
      await page.evaluate(() => { location.hash = '#/subscriptions/claude'; });
      await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
      await page.locator('[data-action="subscriptions-copy"]').click();
      await page.waitForFunction(() => window.syntheticCopies.length === 1);
      assert.match(await page.evaluate(() => window.syntheticCopies[0]), /SYNTHETIC/);
      await page.locator('[data-action="subscriptions-detail"]').click();
      await page.locator('#drawer [data-action="subscriptions-confirm"]').click();
      await page.locator('#subscription-reason').fill('合成核对依据');
      await page.locator('#subscription-confirm-form input[name="confirmed"]').check();
      await page.locator('#subscription-confirm-form [type="submit"]').click();
      await page.locator('#subscription-list').getByText('有效', { exact: true }).waitFor();
      await page.locator('[data-action="subscriptions-more"]').click();
      await page.getByRole('menuitem', { name: '设置归属人' }).click();
      await page.locator('#subscription-owner:not([disabled])').waitFor();
      await page.locator('#subscription-owner').selectOption('synthetic-owner');
      await page.locator('#subscription-owner-form [type="submit"]').click();
      await page.locator('#subscription-list').getByText('合成归属人', { exact: true }).waitFor();
      assert.ok(commands.some(command => command.confirmed && command.reason === '合成核对依据'));
      assert.ok(commands.some(command => command.ownerId === 'synthetic-owner'));
      assert.deepEqual(errors, []);
      assert.deepEqual(intercepted.external, []);
    });
  }
});

test('未订阅的库存账号可先设置归属，录单选择该账号时带入归属人', { timeout: 30_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  const asset = fixtures.inventory.data.accounts.find(row => row.type === 'gpt');
  const owner = { id: 'synthetic-owner', name: '账号归属人', role: 'employee' };
  fixtures['auth/session'] = { configured: true, actor };
  fixtures['auth/order-owners'] = { items: [actor, owner] };
  await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  let saved = false;
  await context.route('**/api/local/subscriptions/account', route => route.fulfill({ json: {
    id: 'account-key', accountId: asset.id, account: asset.email, ownerId: '', ownerName: '', revision: 'account-revision'
  } }));
  await context.route('**/api/local/subscriptions/owner', route => {
    const body = route.request().postDataJSON();
    assert.equal(body.accountId, asset.id);
    assert.equal(body.ownerId, owner.id);
    saved = true;
    fixtures.inventory.accountSummaries = [{ assetId: asset.id, systemOwned: true, label: '首次可用',
      customerId: '', customer: '未分配', currentCustomers: [], currentOrderIds: [], disposition: 'new',
      orders: [], events: [], businessOwner: { id: owner.id, name: owner.name } }];
    return route.fulfill({ json: { saved: true } });
  });
  await context.route('**/api/local/subscriptions/lookup', route => {
    const { order } = route.request().postDataJSON();
    return route.fulfill({ json: saved && order.accountId === asset.id
      ? { ownerId: owner.id, ownerName: owner.name } : { ownerId: '', ownerName: '' } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/#/accounts/gpt');
  const row = page.locator(`tr[data-row-id="${asset.id}"]`);
  await row.waitFor();
  await row.locator('[data-action="inventory-more"]').click();
  await page.getByRole('menuitem', { name: '设置归属人' }).click();
  await page.locator('#subscription-owner:not([disabled])').waitFor();
  await page.locator('#subscription-owner').selectOption(owner.id);
  const receipt = page.waitForResponse(response => response.url().endsWith('/api/local/subscriptions/owner'));
  await page.locator('#subscription-owner-form [type="submit"]').click();
  await receipt;
  assert.equal(saved, true);
  await row.getByText(owner.name, { exact: true }).waitFor().catch(async error => {
    const state = await page.evaluate(id => ({ drawer: document.querySelector('#drawer')?.open,
      route: window.IDDesignAPI.state.route, summary: window.IDDesignAPI.modules.inventory.accountSummary(id),
      notice: document.querySelector('[role="status"]')?.textContent }), asset.id);
    throw new Error(`${error.message}; saved=${saved}; state=${JSON.stringify(state)}; errors=${JSON.stringify(errors)}`);
  });
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-order-form').waitFor();
  await page.locator('#commerce-businessType').selectOption('成品交付');
  await page.locator('#commerce-emailHistory-picker').click();
  await page.locator('#commerce-emailHistory-popover').getByRole('searchbox', { name: '搜索可用账号' }).fill(asset.email);
  await page.locator('#commerce-emailHistory-popover').getByRole('option').filter({ hasText: asset.email }).click();
  await page.waitForFunction(({ accountId, ownerId }) =>
    document.querySelector('#commerce-accountId')?.value === accountId &&
    document.querySelector('#commerce-ownerId')?.value === ownerId, { accountId: asset.id, ownerId: owner.id });
  assert.equal(await page.locator('#commerce-ownerId').inputValue(), owner.id);
  assert.deepEqual(errors, []);
});

test('清空账号后，迟到的归属查询不会覆盖当前录单人选择', { timeout: 30_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  const customer = fixtures.commerce.data.customers[0];
  const owner = { id: 'synthetic-owner', name: '历史账号归属人', role: 'employee' };
  fixtures['auth/session'] = { configured: true, actor };
  fixtures['auth/order-owners'] = { items: [actor, owner] };
  await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  const gate = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
  await context.route('**/api/local/subscriptions/lookup', async route => {
    const { order } = route.request().postDataJSON();
    if (order.email !== 'late-owner@example.test') return route.fulfill({ json: { ownerId: '', ownerName: '' } });
    gate.started.resolve(); await gate.release.promise;
    await route.fulfill({ json: { ownerId: owner.id, ownerName: owner.name } }).catch(() => {});
    gate.finished.resolve();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(origin + '/#/workspace/order/gpt');
    await page.locator('#commerce-customerId option[value="' + customer.id + '"]').waitFor({ state: 'attached' });
    await page.locator('#commerce-customerId-picker').click();
    await page.locator('#commerce-customerId-popover input').fill(customer.name);
    await page.locator('#commerce-customerId-options [data-value="' + customer.id + '"]').click();
    await page.locator('#commerce-ownerId option[value="' + owner.id + '"]').waitFor({ state: 'attached' });
    await page.locator('#commerce-email').fill('late-owner@example.test');
    await gate.started.promise;
    await page.locator('#commerce-email').fill('');
    gate.release.resolve(); await gate.finished.promise;
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#commerce-email').inputValue(), '');
    assert.equal(await page.locator('#commerce-ownerId').inputValue(), actor.id);
    assert.deepEqual(errors, []);
  } finally { gate.release.resolve(); }
});
