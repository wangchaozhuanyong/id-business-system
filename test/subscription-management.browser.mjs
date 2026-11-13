import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { toggleDesignTheme, interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const actor = { id: 'synthetic-admin', name: '合成操作人', role: 'admin' };
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const plans = { GPT: 'Plus', Claude: 'Max 20x', Gemini: 'Google AI Pro', Grok: 'SuperGrok' };

test('an older list response cannot hide a change in the first real-time snapshot', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  await interceptDesign(context, { localFixtures: fixtures, actor, changeEvents: true, skipRechargeAssets: true,
    dataVersions: { 'subscription-management': '1' } });
  await context.addInitScript(() => {
    const fetchLocal = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return fetchLocal(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.sendInitialSnapshot = () => controller.enqueue(new TextEncoder().encode(
          'event: snapshot\ndata: {"schema":1,"versions":{"subscription-management":"2"}}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
  let reads = 0;
  const first = Promise.withResolvers(), allowOlderReply = Promise.withResolvers();
  await context.route('**/api/local/subscriptions/list', async route => {
    const stale = ++reads === 1;
    if (stale) { first.resolve(); await allowOlderReply.promise; }
    await route.fulfill({ json: {
      items: [{ id: 'sub-race', account: 'race@example.test', product: 'GPT',
        ownerName: stale ? '旧归属' : '最新归属', series: [], history: [] }],
      total: 1, counts: {}, scopeCounts: {}, page: 1, pageSize: 20,
      revision: stale ? 'older' : 'current', now: '2026-11-13T12:00:00Z'
    } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6_000);
  await page.goto(origin + '/#/subscriptions/gpt');
  await first.promise;
  await page.waitForFunction(() => typeof window.sendInitialSnapshot === 'function');
  try {
    await page.evaluate(() => window.sendInitialSnapshot());
    await page.locator('#subscription-list').getByText('最新归属', { exact: true }).waitFor({ state: 'attached' });
  } finally { allowOlderReply.resolve(); }
  await settle(page);
  assert.equal(await page.locator('#subscription-list').getByText('旧归属', { exact: true }).count(), 0);
  assert(reads >= 2);
});

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
      const conflictCases = width === 1440 && theme === 'light';
      let confirmed = false, owner = '', version = 1, listReads = 0, plan;
      let copySettings = { version: 1, copy1: '原短后缀', copy2: '原完整后缀' };
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
        const record = { source: 'order', sourceId: 'synthetic-order', orderNo: 'TEST-ORDER', plan: plan || plans[request.product],
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
        const command = route.request().postDataJSON();
        commands.push(command);
        if (command.revision !== 'revision-' + version)
          return route.fulfill({ status: 409, json: { error: '订阅已变化' } });
        confirmed = true; version++;
        return route.fulfill({ json: { saved: true } });
      });
      await context.route('**/api/local/subscriptions/owner', route => {
        const command = route.request().postDataJSON();
        commands.push(command);
        if (command.revision !== 'revision-' + version)
          return route.fulfill({ status: 409, json: { error: '归属已变化' } });
        owner = command.ownerId; version++;
        return route.fulfill({ json: { saved: true } });
      });
      await context.route('**/api/local/claude-google-subscriptions/copy-settings', route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: copySettings });
        const command = route.request().postDataJSON();
        commands.push(command);
        if (command.version !== copySettings.version)
          return route.fulfill({ status: 409, json: { error: '设置已变化' } });
        copySettings = { ...command, version: copySettings.version + 1 };
        return route.fulfill({ json: copySettings });
      });
      await context.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => window.syntheticCopies.push(value) } });
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(8000);
      await page.clock.install({ time: new Date('2026-11-10T02:00:00Z') });
      const close = () => page.locator('#drawer[open] [data-action="drawer-close"]').first().click();
      const reread = async form => {
        await form.getByRole('button', { name: '重新读取并核对' }).click();
        await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
      };
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
        for (const item of metrics) {
          assert(Math.abs(item.y - metrics[0].y) <= 1, '紧凑概览的五项统计必须同一行');
          assert(Math.abs(item.labelTop - metrics[0].labelTop) <= 1, '统计标题真实文字对齐');
          assert(Math.abs(item.numberTop - metrics[0].numberTop) <= 1, '统计数字真实文字对齐');
          if (width > 900)
            assert(Math.abs(item.width - metrics[0].width) <= 1, '各项统计等宽');
        }
        if (width <= 900) {
          const overview = page.getByRole('group', { name: '当前视图统计' });
          await overview.focus();
          await overview.press('ArrowRight');
          await page.waitForFunction(() => document.querySelector('.subscription-center-content').scrollLeft > 0);
        }
        assert.match(await page.locator('#page-title').innerText(), new RegExp(name === 'gpt' ? 'GPT' : name === 'claude' ? 'Claude' : name === 'gemini' ? 'Gemini' : 'Grok'));
        const subscriptionRow = page.locator('#subscription-list tbody tr[data-row-id]');
        const days = subscriptionRow.locator('td[data-column="days"]');
        if (!(await days.isVisible())) await subscriptionRow.getByRole('button', { name: '更多资料', exact: true }).click();
        assert.equal(await days.getAttribute('data-label'), '到期倒计时');
        assert.equal(await days.innerText(), '剩余 21 天 2 小时');
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
      if (conflictCases) {
        const form = page.locator('#subscription-confirm-form');
        const original = version;
        version++; plan = 'Max 5x';
        await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'subscription-management')
          .onDataChanges(['commerce']));
        await form.locator('[type="submit"]').click();
        await form.getByRole('alert').filter({ hasText: /当前输入已保留/ }).waitFor();
        assert.equal(commands.at(-1).revision, 'revision-' + original);
        assert.equal(await page.locator('#subscription-reason').inputValue(), '合成核对依据');
        assert.equal(confirmed, false);
        await form.evaluate(node => node.requestSubmit());
        assert.equal(commands.filter(command => command.confirmed).length, 1);
        await reread(form);
        await page.waitForFunction(revision => document.querySelector('#subscription-confirm-form [name="revision"]')?.value === revision,
          'revision-' + version);
        await page.locator('#drawer').getByText('TEST-ORDER · Max 5x', { exact: true }).waitFor();
        assert.equal(await form.locator('[name="confirmed"]').isChecked(), false);
        await page.locator('#subscription-reason').fill('合成核对依据');
        await form.locator('[name="confirmed"]').check();
      }
      await page.locator('#subscription-confirm-form [type="submit"]').click();
      await page.locator('#subscription-list').getByText('有效', { exact: true }).waitFor();
      const openOwner = async () => {
        await page.locator('[data-action="subscriptions-more"]').click();
        await page.getByRole('menuitem', { name: '设置归属人' }).click();
      };
      await openOwner();
      await page.locator('#subscription-owner:not([disabled])').waitFor();
      await page.locator('#subscription-owner').selectOption('synthetic-owner');
      if (conflictCases) {
        const form = page.locator('#subscription-owner-form');
        const original = version;
        await close();
        version++; owner = actor.id;
        await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'subscription-management')
          .onDataChanges(['subscription-management']));
        await openOwner();
        await form.getByRole('alert').filter({ hasText: /当前输入已保留/ }).waitFor();
        assert.equal(await form.locator('[name="revision"]').inputValue(), 'revision-' + original);
        assert.equal(await form.locator('select').inputValue(), 'synthetic-owner');
        await form.locator('[type="submit"]').click();
        await form.locator('[type="submit"]:disabled').waitFor();
        assert.equal(commands.at(-1).revision, 'revision-' + original);
        assert.equal(owner, actor.id);
        await reread(form);
        await page.waitForFunction(revision => document.querySelector('#subscription-owner-form [name="revision"]')?.value === revision,
          'revision-' + version);
        await form.locator('select:not([disabled])').waitFor();
        assert.equal(await form.locator('select').inputValue(), actor.id);
        await form.locator('select').selectOption('synthetic-owner');
      }
      await page.locator('#subscription-owner-form [type="submit"]').click();
      const ownerName = page.locator('#subscription-list').getByText('合成归属人', { exact: true });
      await ownerName.waitFor({ state: 'attached' });
      if (!(await ownerName.isVisible()))
        await page.locator('#subscription-list').getByRole('button', { name: '更多资料', exact: true }).click();
      await ownerName.waitFor();
      assert.ok(commands.some(command => command.confirmed && command.reason === '合成核对依据'));
      assert.ok(commands.some(command => command.ownerId === 'synthetic-owner'));
      if (conflictCases) {
        const form = page.locator('#subscription-settings-form');
        const openSettings = () => page.locator('[data-action="subscriptions-settings"]').click();
        await openSettings();
        await form.locator('textarea:not([readonly])').first().waitFor();
        await form.locator('[name="copy1"]').fill('本人未保存短后缀');
        await form.locator('[name="copy2"]').fill('本人未保存完整后缀');
        await close();
        copySettings = { version: 2, copy1: '另一窗口短后缀', copy2: '另一窗口完整后缀' };
        await openSettings();
        await form.getByRole('alert').filter({ hasText: /当前输入已保留/ }).waitFor();
        assert.equal(await form.locator('[name="version"]').inputValue(), '1');
        assert.equal(await form.locator('[name="copy2"]').inputValue(), '本人未保存完整后缀');
        await form.locator('[type="submit"]').click();
        await form.locator('[type="submit"]:disabled').waitFor();
        assert.equal(commands.at(-1).version, 1);
        assert.equal(copySettings.copy1, '另一窗口短后缀');
        await reread(form);
        await page.waitForFunction(() => document.querySelector('#subscription-settings-form [name="version"]')?.value === '2');
        assert.equal(await form.locator('[name="copy1"]').inputValue(), '另一窗口短后缀');
        assert.equal(await form.locator('[name="copy2"]').inputValue(), '另一窗口完整后缀');
        await close();
      }
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

test('订阅页签按产品显示全量计数，手机选中项在数字更新后仍可见', { timeout: 20_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
  const initial = Promise.withResolvers(), gpt = Promise.withResolvers(), gptStarted = Promise.withResolvers();
  const totals = {
    all: { all: 52, customer: 31, owned: 7, upcoming: 12, expired: 8, dead: 0, unlinked: 4 },
    GPT: { all: 4, customer: 3, owned: 0, upcoming: 1, expired: 0, dead: 0, unlinked: 1 },
    Claude: { all: 12345, customer: 10982, owned: 1225, upcoming: 294, expired: 78, dead: 0, unlinked: 60 }
  };
  let first = true, status = 200;
  await context.route('**/api/local/subscriptions/list', async route => {
    const query = route.request().postDataJSON();
    if (first) { first = false; await initial.promise; }
    if (query.product === 'GPT') { gptStarted.resolve(); await gpt.promise; }
    if (status !== 200) return route.fulfill({ status, json: { error: '隔离读取失败' } });
    const scopeCounts = totals[query.product];
    const total = query.query ? 0 : scopeCounts[query.scope];
    const items = Array.from({ length: Math.min(total, query.pageSize) }, (_, i) => ({
      id: 'badge-sample-' + i, product: query.product, account: query.scope === 'unlinked' ? '' : `badge-${i}@example.test`,
      series: [{ plan: 'Pro', status: 'active' }], history: [], queryCode: {}
    }));
    return route.fulfill({ json: { items, total, page: 1, pageSize: query.pageSize, counts: {}, scopeCounts,
      revision: 'badge-qa', now: '2026-11-10T02:00:00Z' } });
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/subscriptions/all');
  const tabs = page.getByRole('tablist', { name: '订阅列表' });
  const badges = tabs.locator('.tab-count');
  const all = tabs.getByRole('tab', { name: '全部订阅', exact: true }).locator('.tab-count');
  const pager = page.locator('#subscription-list [data-pagination]');
  await tabs.waitFor();
  assert.deepEqual(await badges.allTextContents(), Array(7).fill('—'));
  initial.resolve();
  await all.filter({ hasText: /^52$/ }).waitFor({ state: 'attached' });
  assert.deepEqual(await badges.allTextContents(), ['52', '31', '7', '12', '8', '0', '4']);
  await page.locator('#subscription-query').fill('无匹配结果');
  await page.locator('#subscription-query').press('Enter');
  await pager.and(page.locator('[data-total="0"]')).waitFor();
  assert.equal(await all.textContent(), '52');
  await tabs.getByRole('tab', { name: '无邮箱', exact: true }).click();
  await pager.waitFor();
  const product = page.getByLabel('产品', { exact: true });
  await product.selectOption('GPT');
  await gptStarted.promise;
  assert.deepEqual(await badges.allTextContents(), Array(7).fill('—'));
  await product.selectOption('Claude');
  await all.filter({ hasText: /^12,345$/ }).waitFor({ state: 'attached' });
  const lateReply = page.waitForResponse(response => response.url().endsWith('/subscriptions/list') &&
    response.request().postDataJSON().product === 'GPT');
  gpt.resolve();
  await (await lateReply).finished();
  await settle(page);
  assert.deepEqual(await badges.allTextContents(), ['12,345', '10,982', '1,225', '294', '78', '0', '60']);
  assert(await tabs.evaluate(strip => {
    const active = strip.querySelector('[aria-selected="true"]').getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
  }), '更新多个大数字后，手机仍完整显示选中页签');
  status = 403;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('当前账号无权读取订阅资料', { exact: true }).waitFor();
  assert.deepEqual(await badges.allTextContents(), Array(7).fill('—'));
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
      scopeCounts: { all: 1, upcoming: status === 'active' ? 1 : 0, expired: status === 'expired' ? 1 : 0 },
      revision: 'qa-expiry-revision', now: reads === 1 ? '2026-11-10T02:00:00Z' : expiry } });
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-10T02:00:00Z') });
  await page.goto(origin + '/#/subscriptions/gpt');
  const list = page.locator('#subscription-list');
  const upcomingCount = page.getByRole('tab', { name: '即将到期', exact: true }).locator('.tab-count');
  const expiredCount = page.getByRole('tab', { name: '已到期', exact: true }).locator('.tab-count');
  await list.getByText('剩余不足 1 小时', { exact: true }).waitFor();
  assert.equal(await upcomingCount.textContent(), '1');
  assert.equal(await expiredCount.textContent(), '0');
  await page.clock.fastForward(31_000);
  await page.getByText(/已保留上次读取的资料/).waitFor();
  await list.getByText('qa-expiring@example.test', { exact: true }).waitFor();
  assert.equal(await upcomingCount.textContent(), '1');
  assert.equal(await expiredCount.textContent(), '0');
  await page.clock.fastForward(60_000);
  assert.equal(reads, 2, '到期失败后不反复发起读取');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expiredCount.filter({ hasText: /^1$/ }).waitFor();
  await list.getByText('已到期不足 1 小时', { exact: true }).waitFor();
  assert.equal(await upcomingCount.textContent(), '0');
  assert.equal(await expiredCount.textContent(), '1');
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
