import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { toggleDesignTheme, interceptDesign, origin } from './helpers/offline-design.mjs';

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
      const old = { ...fixtures.commerce.data.orders.find(row => row.product === 'GPT'),
        id: 'synthetic-unlinked-order', orderNo: 'TEST-UNLINKED', email: '', entitlementStatus: 'active' };
      fixtures.commerce.data.orders.push(old);
      const intercepted = await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
      let confirmed = false, owner = '', version = 1, listReads = 0;
      const commands = [];
      await context.route('**/api/local/subscriptions/list', route => {
        listReads++;
        const request = route.request().postDataJSON();
        const status = request.scope === 'dead' ? 'dead' : request.scope === 'expired' ? 'expired' :
          (request.product === 'Claude' && !confirmed) ? 'pending' : 'active';
        if (request.product === 'all' || (request.product === 'GPT' && request.scope === 'unlinked')) {
          const record = { source: 'order', sourceId: old.id, orderNo: old.orderNo, plan: old.plan,
            start: old.start, expiry: old.expiry, status: 'active', remainingDays: 21, confirmed: true, missingAssociation: true };
          return route.fulfill({ json: { items: [{ id: 'synthetic-unlinked', product: 'GPT', scope: 'unlinked',
            status: 'active', series: [{ ...record, key: 'gpt' }], history: [record], missingAssociation: true }],
            total: 1, accountCount: 0, page: 1, pageSize: request.pageSize, counts: {}, scopeCounts: { all: 1, unlinked: 1 },
            revision: 'unlinked-revision', now: '2026-11-10T02:00:00Z' } });
        }
        const record = { source: 'order', sourceId: 'synthetic-order', orderNo: 'TEST-ORDER', plan: plans[request.product],
          start: '2026-11-01 10:00', expiry: '2026-12-01 12:30', status, remainingDays: 21,
          operatorName: actor.name, confirmed: status !== 'pending' };
        const row = { id: 'synthetic-account', product: request.product, account: request.product === 'Grok' ? '@synthetic' : 'synthetic@example.test',
          registrationEmail: request.product === 'Grok' ? '' : 'synthetic@example.test', status, conflict: false, ownerEligible: confirmed,
          ownerId: owner, ownerName: owner ? '合成归属人' : '', operatorName: actor.name, accountId: 'asset',
          series: [{ key: request.product, ...record }], history: [record], queryCode: { status: 'missing', remainingDays: null },
          contacts: { wechat: 'qa-wechat', whatsapp: '+60 123 456 789', telegram: '@qa_customer', qq: '' } };
        if (request.product === 'Grok' && request.scope === 'expired') row.series = [{ ...record,
          key: 'x_premium', plan: 'X Premium', expiry: '2026-11-10 09:00', remainingDays: 0 }];
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
      await page.clock.install({ time: new Date('2026-11-10T02:00:00Z') });
      await page.goto(origin + '/#/data-management/claude-google-subscriptions');
      await page.waitForURL('**/#/subscriptions/claude');
      await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
      if (theme === 'dark') await toggleDesignTheme(page);
      for (const name of ['gpt', 'claude', 'gemini', 'grok']) {
        await page.evaluate(route => { location.hash = '#/subscriptions/' + route; }, name);
        await page.locator(`#main[data-layout-route="subscriptions/${name}"]`).waitFor();
        await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
        const metrics = await page.locator('#subscription-overview .summary-item').evaluateAll(items =>
          items.map(item => {
            const rect = item.getBoundingClientRect();
            const text = selector => {
              const range = document.createRange();
              range.selectNodeContents(item.querySelector(selector));
              return range.getBoundingClientRect().top;
            };
            return { x: rect.x, y: rect.y, right: rect.right, width: rect.width, height: rect.height,
              labelTop: text('.summary-label'), numberTop: text('.summary-number') };
          }));
        assert.equal(metrics.length, 5, '每类订阅都保留全部五项统计');
        if (width > 900) {
          for (const item of metrics) {
            assert(Math.abs(item.y - metrics[0].y) <= 1, '宽屏五项统计必须同一行');
            assert(Math.abs(item.width - metrics[0].width) <= 1, '各项统计等宽');
            assert(Math.abs(item.labelTop - metrics[0].labelTop) <= 1, '统计标题真实文字对齐');
            assert(Math.abs(item.numberTop - metrics[0].numberTop) <= 1, '统计数字真实文字对齐');
          }
        } else {
          assert(metrics[2].y >= metrics[0].y + metrics[0].height, '窄屏统计自然分行');
          assert(Math.abs(metrics[4].right - metrics[1].right) <= 1, '窄屏最后一项占满整行');
        }
        assert.match(await page.locator('#page-title').innerText(), new RegExp(name === 'gpt' ? 'GPT' : name === 'claude' ? 'Claude' : name === 'gemini' ? 'Gemini' : 'Grok'));
        const subscriptionRow = page.locator('#subscription-list tbody tr[data-row-id]');
        const days = subscriptionRow.locator('td[data-column="days"]');
        if (!(await days.isVisible())) await subscriptionRow.getByRole('button', { name: '更多资料', exact: true }).click();
        assert.equal(await days.getAttribute('data-label'), '到期倒计时');
        assert.equal(await days.innerText(), name === 'claude' ? '—' : '剩余 21 天 2 小时');
        if (name === 'gpt' && width === 1440 && theme === 'light') {
          const reads = listReads;
          await page.clock.fastForward(31 * 60_000);
          await days.getByText('剩余 21 天 1 小时', { exact: true }).waitFor();
          assert.equal(listReads, reads, '跨小时只更新倒计时文字');
          await subscriptionRow.getByRole('button', { name: /微信.*WhatsApp.*Telegram/ }).click();
          const contacts = page.locator('#drawer[open]');
          await contacts.getByText('qa-wechat', { exact: true }).waitFor();
          assert.equal(await contacts.getByText('QQ', { exact: true }).count(), 0);
          assert.equal(await contacts.getByRole('link', { name: /打开 WhatsApp/ }).getAttribute('href'), 'https://wa.me/60123456789');
          assert.equal(await contacts.getByRole('link', { name: /打开 Telegram/ }).getAttribute('href'), 'https://t.me/qa_customer');
          await contacts.getByRole('button', { name: '复制微信', exact: true }).click();
          await page.waitForFunction(() => window.syntheticCopies.at(-1) === 'qa-wechat');
          await page.keyboard.press('Escape');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (name === 'grok') {
          assert.match(await page.locator('#subscription-overview .summary-item').filter({ hasText: '订阅笔数' }).innerText(), /1\s*笔/);
          assert.match(await page.locator('#subscription-overview .summary-item').filter({ hasText: '已到期' }).innerText(), /1\s*个/);
          const loaded = page.waitForResponse(response => response.url().endsWith('/api/local/subscriptions/list') &&
            response.request().postDataJSON().scope === 'expired');
          await page.getByRole('tab', { name: '已到期', exact: true }).click(); await loaded;
          await page.locator('#subscription-list').getByText('X Premium', { exact: true }).waitFor();
          await page.locator('#subscription-list [data-column="days"]').getByText('已到期 1 小时', { exact: true }).waitFor({ state: 'attached' });
          await page.getByRole('tab', { name: '死号', exact: true }).click();
          await page.locator('#subscription-list').getByText('死号', { exact: true }).waitFor();
        }
      }
      await page.evaluate(() => { location.hash = '#/subscriptions/claude'; });
      await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
      await page.locator('[data-action="subscriptions-more"]').click();
      await page.getByRole('menuitem', { name: '复制账号资料', exact: true }).click();
      await page.waitForFunction(() => window.syntheticCopies.at(-1)?.includes('SYNTHETIC'));
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
      const ownerName = page.locator('#subscription-list').getByText('合成归属人', { exact: true });
      await ownerName.waitFor({ state: 'attached' });
      if (!(await ownerName.isVisible()))
        await page.locator('#subscription-list').getByRole('button', { name: '更多资料', exact: true }).click();
      await ownerName.waitFor();
      assert.ok(commands.some(command => command.confirmed && command.reason === '合成核对依据'));
      assert.ok(commands.some(command => command.ownerId === 'synthetic-owner'));
      await page.evaluate(() => { location.hash = '#/subscriptions/all'; });
      const all = page.locator('#subscription-list tbody tr[data-row-id="synthetic-unlinked"]');
      await all.getByText('邮箱未登记', { exact: true }).waitFor();
      assert.match(await page.locator('#subscription-overview').innerText(), /订阅笔数\s+1\s*笔/);
      await page.getByLabel('产品', { exact: true }).selectOption('GPT');
      await page.locator('#subscription-list tbody tr[data-row-id="synthetic-account"]').waitFor();
      await page.getByRole('tab', { name: '无邮箱', exact: true }).click();
      const unlinked = page.locator('#subscription-list tbody tr[data-row-id="synthetic-unlinked"]');
      await unlinked.getByText(new RegExp(old.orderNo)).waitFor();
      assert.match(await page.locator('#subscription-overview').innerText(), /无邮箱订阅\s+1\s*笔/);
      assert.equal(await unlinked.getByRole('button', { name: '复制', exact: true }).count(), 0);
      await unlinked.getByRole('button', { name: '详情', exact: true }).click();
      await page.locator('#drawer[open]').getByRole('button', { name: '查看订单', exact: true }).click();
      await page.waitForURL('**/#/orders/detail/synthetic-unlinked-order');
      await page.locator('#main .property-list').getByText(old.orderNo, { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(intercepted.external, []);
    });
  }
});

test('到期读取失败时保留上次列表，重试后账号进入已过期', { timeout: 20_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
  let reads = 0;
  const start = '2026-11-01T02:00:00Z', expiry = '2026-11-10T02:00:30Z';
  await context.route('**/api/local/subscriptions/list', route => {
    const query = route.request().postDataJSON();
    if (++reads === 2) return route.fulfill({ status: 503, json: { error: '模拟读取失败' } });
    const status = reads === 1 ? 'active' : 'expired';
    const series = { key: 'gpt', plan: 'Plus', start, expiry, status };
    const items = status === 'active' || ['all', 'expired'].includes(query.scope) ? [{ id: 'qa-expiring', product: 'GPT',
      account: 'qa-expiring@example.test', status, series: [series], history: [], queryCode: {} }] : [];
    return route.fulfill({ json: { items, total: items.length, counts: {}, page: 1, pageSize: 20,
      revision: 'qa-expiry-revision', now: reads === 1 ? '2026-11-10T02:00:00Z' : expiry } });
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-10T02:00:00Z') });
  await page.goto(origin + '/#/subscriptions/gpt');
  const list = page.locator('#subscription-list');
  await list.getByText('剩余不足 1 小时', { exact: true }).waitFor();
  await page.clock.fastForward(31_000);
  await page.getByText(/已保留上次读取的资料/).waitFor();
  await list.getByText('qa-expiring@example.test', { exact: true }).waitFor();
  await page.clock.fastForward(60_000);
  assert.equal(reads, 2, '到期失败后不反复发起读取');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await list.getByText('已到期不足 1 小时', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '已到期', exact: true }).click();
  await list.getByText('已到期不足 1 小时', { exact: true }).waitFor();
  await list.getByText('qa-expiring@example.test', { exact: true }).waitFor();
  const afterArchive = reads;
  await page.clock.fastForward(3_601_000);
  await list.getByText('已到期 1 小时', { exact: true }).waitFor();
  assert.equal(reads, afterArchive, '已到期时长跨小时只更新界面');
});

test('账号管理保留注册国家和操作人，未开通库存不会给新订单预填归属', { timeout: 30_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  const asset = fixtures.inventory.data.accounts.find(row => row.type === 'gpt');
  asset.createdAt = '2026-11-12 23:59';
  fixtures['auth/session'] = { configured: true, actor };
  fixtures['auth/order-owners'] = { items: [actor] };
  await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/#/accounts/gpt');
  const row = page.locator(`tr[data-row-id="${asset.id}"]`);
  await row.waitFor();
  const table = page.locator('#main table');
  assert.equal(await table.getByRole('columnheader', { name: '归属人', exact: true }).count(), 0);
  assert.equal(await table.getByRole('columnheader', { name: /城市/ }).count(), 0);
  await table.getByRole('columnheader', { name: '注册国家', exact: true }).waitFor();
  await table.getByRole('columnheader', { name: '最近操作人', exact: true }).waitFor();
  await row.locator('[data-action="inventory-more"]').click();
  assert.equal(await page.getByRole('menuitem', { name: '设置归属人' }).count(), 0);
  await page.keyboard.press('Escape');
  await row.locator('[data-action="inventory-edit"]').click();
  await page.locator('#inventory-country-edit').waitFor();
  assert.equal(await page.locator('#inventory-city').count(), 0);
  await page.locator('#drawer').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const csv = page.locator('#inventory-import-content');
  await csv.waitFor();
  assert.doesNotMatch(await csv.getAttribute('placeholder'), /城市/);
  await page.locator('#drawer').getByRole('button', { name: '取消', exact: true }).click();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-order-form').waitFor();
  assert.equal(await page.locator('#commerce-ownerId').inputValue(), actor.id);
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
