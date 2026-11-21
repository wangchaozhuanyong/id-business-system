import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const url = origin + '/#/workspace/renewals';
const now = new Date('2026-11-21T01:40:00Z');
const order = (id, number, product, reminderState, expiry) => ({
  id, number, version: 1, customer: '合成客户', account: id + '@example.test', product, plan: '合成套餐',
  start: '2026-10-21T00:00:00Z', expiry, payment: '银行卡', owner: '合成归属人', reminderState
});
const crossing = order('crossing', 'QA-CROSSING', 'GPT', 'upcoming', '2026-11-21T01:41:00Z');
const future = order('future', 'QA-FUTURE', 'Gemini', 'upcoming', '2026-11-22T01:40:00Z');
const expired = Array.from({ length: 23 }, (_, index) => {
  const suffix = String(index + 1).padStart(2, '0');
  return order('expired-' + suffix, 'QA-EXPIRED-' + suffix, index === 6 ? 'Gemini' : 'GPT',
    'expired', '2026-11-20T01:40:00Z');
});
const refused = order('refused', 'QA-REFUSED', 'GPT', 'refused', '2026-11-19T01:40:00Z');
const renewed = order('renewed', 'QA-RENEWED', 'GPT', 'renewed', '2026-11-19T01:40:00Z');
const sent = { id: 'pending-handoff', status: 'pending', version: 1, submittedBy: '合成员工',
  order: order('sent', 'QA-SENT', 'GPT', 'expired', '2026-11-18T01:40:00Z') };
const badgeTitle = '续费提醒总数（含办理中订单）';
const commerce = { version: 1, data: { customers: [], orders: [], operating: [], tenants: [], logs: [], rentBatches: [] } };
const collectErrors = page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  return errors;
};

function entries(page) {
  const workbench = page.locator('#main [data-renewal-handoff]');
  const group = workbench.getByRole('group', { name: '订单状态', exact: true });
  const upcoming = group.getByRole('button', { name: /^即将到期/ });
  const overdue = group.getByRole('button', { name: /^已到期/ });
  const pager = workbench.locator('[data-pagination="renewal-handoff-pagination"]');
  const counts = async (before, after) => {
    await upcoming.waitFor();
    await overdue.waitFor();
    const format = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : value;
    await page.waitForFunction(([before, after]) =>
      document.querySelector('[data-renewal-period="upcoming"] [data-renewal-period-count]')?.textContent.trim() === before &&
      document.querySelector('[data-renewal-period="expired"] [data-renewal-period-count]')?.textContent.trim() === after,
    [format(before), format(after)]);
  };
  return { workbench, group, upcoming, overdue, pager, counts };
}

test('续费到期入口与表格共享筛选和分页，跨到期自动更新并保留失败前快照', { timeout: 35_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const standardOrders = [crossing, future, ...expired, sent.order].map(candidate => ({
    ...candidate, orderNo: candidate.number, email: candidate.account, source: '管理员手工', customerId: 'renewal-customer'
  }));
  const localFixtures = { commerce: { ...commerce, data: { ...commerce.data, orders: standardOrders,
    customers: [{ id: 'renewal-customer', name: '合成客户' }] } }, 'renewal-sidebar': { count: 26, nextAt: null } };
  const traffic = await interceptDesign(context, { skipRechargeAssets: true, localFixtures,
    actor: { id: 'renewal-status-super', name: '合成超级管理员', role: 'super' } });
  let fail = true, reads = 0;
  const writes = [];
  await context.route(requestUrl => requestUrl.pathname === '/api/local/renewals', route => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().method());
      return route.fulfill({ status: 405, json: { error: '只读测试' } });
    }
    reads++;
    return fail ? route.fulfill({ status: 503, json: { error: '合成续费读取失败' } })
      : route.fulfill({ json: { version: 1, candidates: [crossing, future, ...expired, refused, renewed],
        items: [sent], canSubmitToFinance: true, reminderHours: 72 } });
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.clock.install({ time: now });
  await page.goto(url);
  const { workbench, group, upcoming, overdue, pager, counts } = entries(page);
  const errorsInView = workbench.getByText('合成续费读取失败', { exact: true });
  await errorsInView.waitFor();
  await counts('—', '—');
  assert(await upcoming.isDisabled());
  assert(await overdue.isDisabled());
  assert.equal(await pager.count(), 0);
  const badge = page.locator('#renewal-reminder-count');
  await badge.waitFor();
  assert.equal((await badge.textContent()).trim(), '26');
  assert.equal(await badge.getAttribute('title'), badgeTitle);
  assert(await badge.evaluate(node => [node, node.closest('a')].some(element =>
    ['aria-label', 'aria-description'].some(attribute => element?.getAttribute(attribute)?.includes('办理中')))));

  fail = false;
  const refresh = workbench.getByRole('button', { name: '刷新', exact: true });
  await refresh.click();
  await counts(2, 23);
  assert.equal(await upcoming.getAttribute('aria-pressed'), 'true');
  assert.equal(await pager.getAttribute('data-total'), '2');
  await workbench.getByRole('checkbox', { name: '选择 crossing', exact: true }).check();
  await workbench.getByRole('button', { name: '提交给财务（1）', exact: true }).waitFor();
  await overdue.press('Enter');
  assert.equal(await overdue.getAttribute('aria-pressed'), 'true');
  assert(await overdue.evaluate(node => node === document.activeElement));
  assert.equal(await pager.getAttribute('data-total'), '23');
  assert.equal(await workbench.getByText('QA-SENT', { exact: true }).count(), 0);
  assert(await workbench.getByRole('button', { name: '提交给财务', exact: true }).isDisabled());
  await pager.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await pager.getAttribute('data-page'), '2');
  await upcoming.click();
  await overdue.click();
  assert.equal(await pager.getAttribute('data-page'), '1');

  const product = workbench.getByLabel('产品', { exact: true });
  const search = workbench.getByRole('textbox', { name: '搜索续费订单' });
  await product.selectOption('Gemini');
  await counts(1, 1);
  assert.equal(await pager.getAttribute('data-total'), '1');
  await search.fill('qa-expired-07');
  await search.press('Enter');
  await counts(0, 1);
  await upcoming.click();
  assert.equal(await pager.getAttribute('data-total'), '0');
  await search.fill('');
  await product.selectOption('');
  await counts(2, 23);

  const refusedButton = group.getByRole('button', { name: /^已拒续/ });
  const renewedButton = group.getByRole('button', { name: /^已续费/ });
  assert.equal(await workbench.getByRole('combobox', { name: '订单状态' }).count(), 0);
  assert.deepEqual(await group.getByRole('button').allTextContents(),
    ['即将到期 2', '已到期 23', '已拒续 1', '已续费 1']);
  await refusedButton.focus();
  await page.keyboard.press('Space');
  await workbench.getByText('QA-REFUSED', { exact: true }).waitFor();
  assert.equal(await upcoming.getAttribute('aria-pressed'), 'false');
  assert.equal(await overdue.getAttribute('aria-pressed'), 'false');
  assert.equal(await refusedButton.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('ArrowRight');
  await workbench.getByText('QA-RENEWED', { exact: true }).waitFor();
  assert(await renewedButton.evaluate(button => button === document.activeElement));
  assert.equal(await renewedButton.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await upcoming.getAttribute('aria-pressed'), 'true');
  assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);

  const navigation = page.getByRole('navigation', { name: '续费办理进度' });
  await navigation.getByRole('link', { name: '已送财务', exact: true }).click();
  await workbench.getByText('QA-SENT', { exact: true }).waitFor();
  assert.equal(await group.count(), 0);
  await navigation.getByRole('link', { name: '选订单', exact: true }).click();
  await counts(2, 23);

  fail = true;
  await refresh.click();
  await errorsInView.waitFor();
  await counts(2, 23);
  assert.equal(await pager.getAttribute('data-total'), '2');
  const beforeExpiryReads = reads;
  await page.clock.fastForward(65_000);
  await counts(1, 24);
  assert.equal(await workbench.getByText('QA-CROSSING', { exact: true }).count(), 0);
  assert.equal(await pager.getAttribute('data-total'), '1');
  await overdue.click();
  assert.equal(await pager.getAttribute('data-total'), '24');
  assert.equal(reads, beforeExpiryReads, '已知到期时间只重新分类，无需再次查询');
  assert.equal((await badge.textContent()).trim(), '26');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
  assert.deepEqual(traffic.unavailable, []);
});

test('手机员工可触屏选择两个到期入口，页签数量来自当前岗位', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: true });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true,
    actor: { id: 'renewal-status-employee', name: '合成员工', role: 'employee' },
    localFixtures: { commerce, renewals: { version: 1, candidates: [future, expired[0]], items: [sent] } } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.clock.setFixedTime(now);
  await page.goto(url);
  const { workbench, group, upcoming, overdue, pager, counts } = entries(page);
  await counts(1, 1);
  assert.deepEqual(await group.getByRole('button').allTextContents(), ['即将到期 1', '已到期 1']);
  assert.equal(await workbench.getByRole('combobox', { name: '订单状态' }).count(), 0);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of [upcoming, overdue]) {
      const bounds = await control.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.height >= 44,
        '到期入口应在手机视口内保留 44px 触控高度');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await overdue.tap();
  await workbench.locator('tr[data-row-id="' + expired[0].id + '"] [data-column="days"]').waitFor();
  assert.equal(await overdue.getAttribute('aria-pressed'), 'true');
  assert.equal(await pager.getAttribute('data-total'), '1');
  await upcoming.tap();
  await workbench.locator('tr[data-row-id="' + future.id + '"] [data-column="days"]').waitFor();
  assert.equal(await upcoming.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
  assert.deepEqual(traffic.unavailable, []);
});

test('到期选单在千条和万条岗位可见资料下先统计筛选范围再分页', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true, localFixtures: { commerce },
    actor: { id: 'renewal-status-volume', name: '合成员工', role: 'employee' } });
  let size = 1000, reads = 0;
  await context.route(requestUrl => requestUrl.pathname === '/api/local/renewals', async route => {
    assert.equal(route.request().method(), 'GET');
    assert.equal(new URL(route.request().url()).searchParams.get('view'), 'staff');
    const candidates = Array.from({ length: size }, (_, index) => {
      const upcoming = index % 2 === 0;
      return order('volume-' + index, (index % 5 === 0 ? 'QA-SCOPE-' : 'QA-OTHER-') + index,
        index % 4 < 2 ? 'GPT' : 'Gemini', upcoming ? 'upcoming' : 'expired',
        upcoming ? future.expiry : expired[0].expiry);
    });
    await route.fulfill({ json: { version: ++reads, candidates, items: [] } });
  });
  const page = await context.newPage(), errors = collectErrors(page);
  await page.clock.setFixedTime(now);
  await page.goto(url);
  const { workbench, overdue, upcoming, pager, counts } = entries(page);
  const product = workbench.getByLabel('产品', { exact: true });
  const search = workbench.getByRole('textbox', { name: '搜索续费订单' });
  for (const total of [1000, 10000]) {
    if (total !== size) {
      size = total;
      await workbench.getByRole('button', { name: '刷新', exact: true }).click();
    }
    await counts(total / 2, total / 2);
    assert.equal(await pager.getAttribute('data-total'), String(total / 2));
    assert.equal(await workbench.locator('tbody tr[data-row-id]').count(), 20);
    await product.selectOption('Gemini');
    await search.fill('qa-scope');
    await search.press('Enter');
    await counts(total / 20, total / 20);
    await overdue.click();
    assert.equal(await pager.getAttribute('data-total'), String(total / 20));
    assert.equal(await workbench.locator('tbody tr[data-row-id]').count(), 20);
    await search.fill('');
    await product.selectOption('');
    await upcoming.click();
  }
  assert.equal(reads, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
  assert.deepEqual(traffic.unavailable, []);
});
