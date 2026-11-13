import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { customerQuery } from '../server/customer-query.mjs';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const actor = { id: 'workspace-design-qa', name: '离线验收', role: 'admin' };
const now = Date.parse('2026-11-13T04:00:00Z');
const at = days => new Date(now + days * 86_400_000).toISOString();
const fixtures = async () => {
  const data = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  data['auth/order-owners'] = { items: [actor] };
  data['auth/display-names'] = { items: [actor] };
  return data;
};
async function start(t) {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}
async function capture(page, name) {
  if (!process.env.ID_LAYOUT_QA_OUTPUT) return;
  await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
  await page.screenshot({ path: join(process.env.ID_LAYOUT_QA_OUTPUT, name + '.png'), fullPage: true });
}
const go = (page, route) => page.evaluate(route => window.IDDesignAPI.go(route), route);

test('单客户档案：唯一匹配、候选分页、粘贴失败、空结果、权限及迟到响应', { timeout: 60_000 }, async t => {
  const browser = await start(t);
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const fixture = await fixtures();
    fixture.commerce.data.customers = Array.from({ length: 22 }, (_, i) => ({
      id: `query-person-${i}`, name: '同名客户', wechat: `unique-contact-${String(i).padStart(2, '0')}`, active: true,
      notes: '仅用于离线验收', version: 1
    }));
    fixture.commerce.data.orders = [];
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { async readText() {
      if (window.failClipboard) throw new Error('合成剪贴板拒绝');
      return window.clipboardValue || '';
    } } }));
    let forbidden = false, failNext = false, delayed = false;
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await context.route(origin + '/api/local/customer-query/**', async route => {
      const action = route.request().url().split('/').at(-1), command = route.request().postDataJSON();
      if (forbidden) return route.fulfill({ status: 403, json: { error: '没有查询客户资料的权限' } });
      if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: '合成读取失败，请重试' } }); }
      const result = customerQuery(fixture, {}, action, command, now);
      if (delayed && action === 'detail' && command.customerId === 'query-person-3') {
        pending.resolve(); await release.promise;
      }
      return route.fulfill({ json: result });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.goto(origin + '/#/workspace/customer-query');
    if (width === 390) await toggleDesignTheme(page);
    const input = page.getByRole('searchbox', { name: '客户姓名或微信' });
    const beforeHelp = await input.boundingBox();
    const help = page.locator('summary[aria-label="查看客户资料查询说明"]');
    assert.equal(await help.locator('..').getAttribute('open'), null);
    await help.click();
    await page.locator('.title-description:popover-open').waitFor();
    assert.deepEqual(await input.boundingBox(), beforeHelp, '说明浮层不挤动查询框');
    await page.keyboard.press('Escape');
    assert.equal(await help.locator('..').getAttribute('open'), null);
    const submit = () => page.getByRole('button', { name: '查询', exact: true }).click();
    const query = async value => { await input.fill(value); await submit(); };
    await submit();
    await page.locator('#customer-query-input-notice').getByText('请输入客户姓名或微信。').waitFor();
    await page.evaluate(() => { window.clipboardValue = ' unique-contact-00 '; });
    await page.getByRole('button', { name: '粘贴查询', exact: true }).click();
    await page.locator('.customer-query-profile').getByText('query-person-0', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-customer-query-candidate]').count(), 0);
    assert.equal(await page.locator('[data-customer-query-content] table').count(), 0);
    await page.evaluate(() => { window.failClipboard = true; });
    await page.getByRole('button', { name: '粘贴查询', exact: true }).click();
    await page.locator('#customer-query-input-notice').getByText(/请手动粘贴/).waitFor();
    assert.equal(await input.inputValue(), 'unique-contact-00');
    await page.evaluate(() => { window.failClipboard = false; window.clipboardValue = ''; });
    await page.getByRole('button', { name: '粘贴查询', exact: true }).click();
    await page.locator('#customer-query-input-notice').getByText(/剪贴板为空/).waitFor();
    await query('同名客户');
    const candidates = page.locator('[data-customer-query-candidate]');
    await candidates.first().waitFor();
    assert.equal(await candidates.count(), 20);
    await capture(page, 'customer-candidates-' + width);
    const pager = page.locator('[data-pagination="customer-query-search"]');
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-customer-query-candidate]').length === 2);
    assert.equal(await page.locator('.customer-query-profile').count(), 0);
    await query('没有此客户');
    await page.getByText('未找到匹配客户', { exact: true }).waitFor();
    assert.equal(await candidates.count(), 0);
    failNext = true;
    await query('unique-contact-01');
    await page.locator('[data-customer-query-error]').getByText(/合成读取失败/).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.customer-query-profile').getByText('query-person-1', { exact: true }).waitFor();
    await capture(page, 'customer-profile-' + width);
    delayed = true;
    await query('unique-contact-03');
    await pending.promise;
    await query('unique-contact-01');
    await page.locator('.customer-query-profile').getByText('query-person-1', { exact: true }).waitFor();
    release.resolve();
    await settle(page);
    assert.doesNotMatch(await page.locator('.customer-query-profile').innerText(), /query-person-3\b/);
    forbidden = true;
    await query('unique-contact-02');
    await page.locator('[data-customer-query-error]').getByText(/没有查询客户资料的权限/).waitFor();
    assert.equal(await page.locator('.customer-query-profile').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
  });
});

test('收起的历史不触发刷新，当前账号倒计时不被历史快照覆盖，重新展开读取最新记录', { timeout: 20_000 }, async t => {
  const browser = await start(t), fixture = await fixtures(), sample = fixture.commerce.data.orders[0];
  const customerId = 'timer-customer';
  fixture.commerce.data.customers = [{ id: customerId, name: '时序验收客户', wechat: 'timer-query', active: true }];
  fixture.commerce.data.orders = ['timer-current', 'timer-history'].map((id, index) => ({
    ...sample, id, orderNo: id, customerId, email: 'timer@example.test', product: 'GPT', plan: 'Plus',
    start: at(index ? -2 : -1), expiry: index ? at(-1) : new Date(now + 10_000).toISOString(),
    platformAccountId: '', accountId: '', cancelled: false, subscriptionEnded: false,
    source: '管理员手工', entitlementStatus: 'active', status: '', draft: false
  }));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
  const page = await context.newPage(), reads = [];
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1000));
  await context.route(origin + '/api/local/customer-query/**', async route => {
    const action = route.request().url().split('/').at(-1), command = route.request().postDataJSON();
    const current = await page.evaluate(() => Date.now());
    const result = customerQuery(fixture, {}, action, command, current);
    reads.push({ action, tab: command.tab });
    if (command.tab === 'orders' && current < now + 10_000) {
      // A separately cached history reply must not replace the visible account's newer expiry.
      result.items.find(row => row.id === 'timer-current').expiry = new Date(now + 4000).toISOString();
    }
    return route.fulfill({ json: result });
  });
  await page.goto(origin + '/#/workspace/customer-query');
  await page.getByRole('searchbox', { name: '客户姓名或微信' }).fill('timer-query');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const accounts = page.locator('#customer-query-accounts-content'), history = page.locator('#customer-query-orders-content');
  await accounts.getByText('有效', { exact: true }).waitFor();
  await page.getByRole('button', { name: '展开订单历史', exact: true }).click();
  await history.locator('[data-customer-query-row]').nth(1).waitFor();
  await page.getByRole('button', { name: '收起订单历史', exact: true }).click();
  const beforeExpiry = reads.length;
  await page.clock.runFor(4000);
  assert.equal(reads.length, beforeExpiry, '隐藏历史过期不得发起读取');
  await accounts.getByText('有效', { exact: true }).waitFor();
  await page.getByRole('button', { name: '展开订单历史', exact: true }).click();
  await history.locator('[data-customer-query-row="timer-history"]').waitFor();
  assert.equal(reads.length, beforeExpiry + 1, '重新展开读取历史，不重复读取已有账号快照');
  await page.clock.runFor(6000);
  await accounts.getByText('已过期', { exact: true }).waitFor();
  assert.equal(reads.length, beforeExpiry + 3, '旧历史中的同名订单不能覆盖当前账号的到期刷新时刻');
  await page.getByRole('button', { name: '收起订单历史', exact: true }).click();
  const afterExpiry = reads.length;
  await page.clock.runFor(3_600_000);
  assert.equal(reads.length, afterExpiry, '收起历史中的旧有效状态不能持续刷新');
  await page.getByRole('button', { name: '展开订单历史', exact: true }).click();
  await history.getByText('已过期', { exact: true }).nth(1).waitFor();
  assert.equal(reads.filter(row => row.tab === 'orders').length, 4, '重新展开必须读取新的历史');
  const afterReopen = reads.length;
  await page.clock.runFor(3_600_000);
  assert.equal(reads.length, afterReopen, '重复订单编号不能让已过期账号重新参与过期刷新');
  assert.deepEqual(traffic.external, []);
});

test('续费历史按客户与账号隔离，独立分页、原单及切换客户重置范围', { timeout: 45_000 }, async t => {
  const browser = await start(t);
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const fixture = await fixtures(), sample = fixture.commerce.data.orders[0];
    fixture.commerce.data.customers = [
      { id: 'history-a', name: '历史客户甲', active: true, version: 1 },
      { id: 'history-b', name: '历史客户乙', active: true, version: 1 }
    ];
    const order = (id, customerId, email, start, expiry) => ({ ...sample, id, orderNo: id,
      customerId, email, product: 'GPT', plan: 'Plus', start: at(start), expiry: at(expiry),
      customerName: '', wechat: '', customerPhone: '', qq: '', whatsapp: '', telegram: '',
      platformAccountId: '', accountId: '', cancelled: false, subscriptionEnded: false,
      source: '管理员手工', businessType: '续费', payment: '银行卡', cardId: '', paymentId: '',
      paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', previousOrderId: '' });
    fixture.commerce.data.orders = [
      order('HISTORY-CURRENT', 'history-a', 'shared-history@example.test', -31, -1),
      ...Array.from({ length: 22 }, (_, i) => order(`HISTORY-PAST-${i}`, 'history-a', 'shared-history@example.test', -61 - i * 30, -31 - i * 30)),
      order('HISTORY-OTHER-ACCOUNT', 'history-a', 'another-account@example.test', -40, -10),
      order('HISTORY-B', 'history-b', 'shared-history@example.test', -32, -2),
      order('HISTORY-UNRESOLVED', '', 'unresolved@example.test', -33, -3)
    ];
    fixture.commerce.data.orders.find(row => row.id === 'HISTORY-PAST-0').cancelled = true;
    fixture.commerce.data.orders.find(row => row.id === 'HISTORY-PAST-1').status = '已撤单';
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.clock.setFixedTime(now);
    await page.goto(origin + '/#/workspace/renewals/reminders');
    if (width === 390) await toggleDesignTheme(page);
    await page.getByRole('tab', { name: /^已到期/ }).click();
    const select = async id => {
      if (width < 760 && await page.locator('[data-action="commerce-renewal-back"]').isVisible())
        await page.locator('[data-action="commerce-renewal-back"]').click();
      await page.locator(`[data-action="commerce-renewal-select"][data-id="${id}"]`).click();
    };
    await select('HISTORY-CURRENT');
    const history = page.locator('[data-renewal-history]'), rows = history.locator('[data-renewal-history-order]');
    await history.getByRole('heading', { name: '历史订阅', exact: true }).waitFor();
    assert.equal(await rows.count(), 20);
    assert.equal(await history.locator('[aria-current="true"]').count(), 1);
    assert.equal(await history.locator('[data-renewal-history-order="HISTORY-B"]').count(), 0);
    for (const id of ['HISTORY-PAST-0', 'HISTORY-PAST-1'])
      await history.locator(`[data-renewal-history-order="${id}"]`).getByText('已撤单', { exact: true }).waitFor();
    const pager = history.locator('[data-pagination="commerce-renewal-history"]');
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await rows.count(), 3);
    await history.getByRole('button', { name: '本客户全部', exact: true }).click();
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert.equal(await pager.getAttribute('data-total'), '24');
    await history.getByText('another-account@example.test', { exact: true }).waitFor();
    await page.locator('.renewal-workbench-detail').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, 'renewal-history-' + width);
    await history.locator('[data-renewal-history-order="HISTORY-CURRENT"]').getByRole('button', { name: '查看原单', exact: true }).click();
    await page.locator('#drawer[open]').getByText('HISTORY-CURRENT', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await select('HISTORY-B');
    assert.equal(await history.getByRole('button', { name: '当前账号', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().getAttribute('data-renewal-history-order'), 'HISTORY-B');
    await select('HISTORY-UNRESOLVED');
    await history.getByText(/客户归属待核对/).waitFor();
    assert.equal(await rows.count(), 0);
    assert.equal(await history.getByRole('button', { name: '本客户全部', exact: true }).isDisabled(), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
  });
});

test('客户租户侧栏独立入口保留草稿，Claude 补充资料宽屏两列窄屏一列', { timeout: 45_000 }, async t => {
  const browser = await start(t);
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const traffic = await interceptDesign(context, { actor, localFixtures: await fixtures(), skipRechargeAssets: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.goto(origin + '/#/customers/new');
    if (width === 390) await toggleDesignTheme(page);
    const name = page.locator('#commerce-contact-name');
    await name.fill('客户独立草稿');
    const navigate = async label => {
      if (width < 900) await page.locator('#nav-toggle').click();
      await page.locator('#sidebar').getByRole('link', { name: label, exact: true }).click();
      assert.equal(await page.locator('#sidebar [aria-current="page"]').count(), 1);
      assert.equal(await page.locator('.tabs[aria-label="录入类型"]').count(), 0);
    };
    await navigate('租户录入');
    assert.equal(await name.inputValue(), '');
    await name.fill('租户独立草稿');
    await capture(page, 'tenant-entry-' + width);
    await navigate('客户录入');
    assert.equal(await name.inputValue(), '客户独立草稿');
    await capture(page, 'customer-entry-' + width);
    await navigate('租户录入');
    assert.equal(await name.inputValue(), '租户独立草稿');
    assert(page.url().endsWith('/#/customers/new/tenant'));
    await go(page, 'workspace/order/claude');
    await page.locator('#commerce-plan').selectOption('Pro');
    await page.locator('#commerce-businessType').selectOption('首次开通');
    await page.locator('summary').filter({ hasText: /^Claude 补充资料$/ }).click();
    const certification = page.locator('#commerce-kyc'), phone = page.locator('#commerce-phone');
    await certification.selectOption('KYC 认证');
    await phone.fill('+60123456789');
    await phone.scrollIntoViewIfNeeded();
    await settle(page);
    const a = await certification.boundingBox(), b = await phone.boundingBox();
    if (width === 1440) assert(Math.abs(a.y - b.y) < 2 && b.x >= a.x + a.width, '认证状态与订阅电话同排');
    else assert(b.y >= a.y + a.height + 8, '窄屏按行排列');
    await capture(page, 'claude-supplement-' + width);
    await go(page, 'customers/new');
    await go(page, 'workspace/order/claude');
    assert.equal(await certification.inputValue(), 'KYC 认证');
    assert.equal(await phone.inputValue(), '+60123456789');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
  });
});
