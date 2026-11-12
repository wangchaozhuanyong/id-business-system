import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, root, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';
import { cardDisplayFixture, cardDisplayOrigin as origin, cardDisplayActor as actor,
  cardDisplayTime, syntheticCards } from './helpers/subscription-card-display-fixture.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const output = process.env.ID_LAYOUT_QA_OUTPUT || join(root, '.runtime/bank-card-details-20261112/display');
const active = '#main > [data-page-region]:not([hidden])';
const groupTable = active + ' [data-table="commerce-bank-card-groups"]';
const orderTable = active + ' [data-table="commerce-subscription-cards"]';
const frozenTable = active + ' [data-table="commerce-frozen-cards"]';
const results = [];

async function interceptCards(context, fixture, statusResponse = () => fixture.request()) {
  const fixtures = JSON.parse(await readFile(join(root, 'docs/audits/2026-11-06-design-review/visual-fixtures.json'), 'utf8'));
  Object.assign(fixtures, fixture.snapshots, { 'card-types': { version: 1, ...fixture.documents['card-types'].data },
    'subscription-card-estimates': { items: [] } });
  const requests = await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  requests.cardPreparations = [];
  await context.route('**/api/local/subscription-card-status*', async route => {
    assert.equal(new URL(route.request().url()).searchParams.get('includeDetails'), '1');
    const result = await statusResponse();
    await route.fulfill({ status: result.status, json: result.body });
  });
  await context.route('**/api/local/subscription-renewal-card', route => {
    requests.cardPreparations.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: '关联订单弹窗无需准备银行卡' } });
  });
  return requests;
}

async function cell(page, table, rowId, column) {
  return page.locator(`${table} tr[data-row-id="${rowId}"] td[data-column="${column}"]`).innerText();
}
async function closeDrawer(page) {
  await page.locator('#drawer[open]').getByRole('button', { name: '关闭抽屉', exact: true }).click();
}
async function geometry(page, label) {
  await settle(page);
  const snapshot = await page.locator(active).evaluate(region => {
    const visible = node => node.checkVisibility() && node.getBoundingClientRect().width > 0;
    const clipped = [...region.querySelectorAll('.table-actions button, .pagination [aria-current="page"]')]
      .filter(visible).filter(node => {
        const box = node.getBoundingClientRect();
        // Vertical list scrolling is expected; inspect clipping within the card/operation cell.
        const parent = node.closest('.table-actions, .pagination-pages, .pagination');
        const bounds = parent.getBoundingClientRect();
        return box.left < bounds.left - 1 || box.right > bounds.right + 1;
      }).map(node => node.textContent.trim());
    return { pageOverflow: document.documentElement.scrollWidth > innerWidth,
      clipped, rows: region.querySelectorAll('tbody tr[data-row-id]').length };
  });
  assert(!snapshot.pageOverflow, label + ': 页面横向溢出');
  assert.deepEqual(snapshot.clipped, [], label + ': 操作或页码被裁切');
  const spacing = await spacingSnapshot(page);
  assert.deepEqual(spacing.findings, [], label + ': 控件距分隔线不足');
  results.push({ label, ...snapshot, spacing });
}

test('银行卡列表、详情和搜索展示实际卡号、类型和序列号，兼容手机及深浅主题', { timeout: 120_000 }, async t => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await t.test(`${width}px ${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const fixture = cardDisplayFixture(), requests = await interceptCards(context, fixture);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(cardDisplayTime);
      try {
        await page.goto(origin + '/#/subscriptions/bank-cards');
        if (theme === 'dark') await toggleDesignTheme(page);
        await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.shared }).waitFor();
        assert.equal(await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.shared }).count(), 1);
        assert.equal(await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.sameTail }).count(), 1);
        assert(!/尾号\s*\d/.test(await page.locator(groupTable).innerText()));
        const group = page.locator(groupTable + ' tbody tr').filter({ hasText: syntheticCards.shared });
        assert.match(await group.locator('[data-column="typeName"]').innerText(), /wise潘/);
        assert.match(await group.locator('td[data-column="serial"]').innerText(), /0007-A/);
        await geometry(page, `${width}-${theme}-groups`);
        await page.screenshot({ path: join(output, `groups-${width}-${theme}.png`) });
        assert(!/余额/.test(await page.locator(groupTable).innerText()));
        await group.getByRole('button', { name: '查看关联订单', exact: true }).click();
        await page.locator('#drawer[open]').getByRole('heading', { name: '银行卡关联订单', exact: true }).waitFor();
        const drawer = await page.locator('#drawer[open]').innerText();
        for (const text of [syntheticCards.shared, 'wise潘', '0007-A', '0007-B']) assert(drawer.includes(text), text);
        assert(!/余额|尾号/.test(drawer));
        for (const id of ['manual', 'manual-history', 'pool']) {
          const linked = page.locator(`#drawer[open] tr[data-row-id="${id}"]`);
          assert.equal(await linked.locator('td[data-column="orderNo"]').innerText(), 'TEST-' + id);
          assert(await linked.locator('td[data-column="orderNo"]').isVisible());
        }
        assert.equal(await page.locator('#drawer[open] tr[data-row-id="same-tail"]').count(), 0);
        await settle(page);
        assert.deepEqual(requests.cardPreparations, [], '打开关联订单不应发起银行卡准备或余额读取');
        const bounds = await page.locator('#drawer[open]').evaluate(drawer => {
          const viewport = drawer.querySelector('.table-viewport');
          return { drawer: drawer.scrollWidth > drawer.clientWidth + 1,
            table: viewport.scrollWidth > viewport.clientWidth + 1 };
        });
        assert.deepEqual(bounds, { drawer: false, table: false }, '关联订单应完整显示，不挤出抽屉');
        await page.screenshot({ path: join(output, `linked-orders-${width}-${theme}.png`) });
        await page.locator('#drawer[open] tr[data-row-id="manual-history"]')
          .getByRole('button', { name: '查看订单', exact: true }).click();
        await page.locator('#drawer[open]').getByText('TEST-manual-history', { exact: true }).waitFor();
        await closeDrawer(page);

        const search = page.locator(active + ' #commerce-search');
        for (const query of [syntheticCards.sameTail, '0008']) {
          await search.fill(query);
          await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1,
            groupTable + ' tbody tr[data-row-id]');
          assert.match(await page.locator(groupTable).innerText(), new RegExp(syntheticCards.sameTail));
        }
        await search.fill('NO-CARD-MATCH');
        await page.locator(groupTable).getByText('暂无符合条件的记录', { exact: true }).waitFor();
        await geometry(page, `${width}-${theme}-empty`);
        await search.fill('');
        await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.shared }).waitFor();
        await page.locator('[data-action="commerce-subscription-card-tab"][data-tab="orders"]').click();
        await page.locator(orderTable + ' tr[data-row-id="preferred"]').waitFor();
        assert.equal(await cell(page, orderTable, 'preferred', 'tail'), syntheticCards.replacement);
        assert.equal(await cell(page, orderTable, 'preferred', 'typeName'), 'vccwc999');
        assert.equal(await cell(page, orderTable, 'preferred', 'serial'), '0012');
        for (const column of ['tail', 'typeName', 'serial'])
          assert(await page.locator(orderTable + ` tr[data-row-id="preferred"] td[data-column="${column}"]`).isVisible());
        assert.equal(await cell(page, orderTable, 'missing', 'tail'), '完整卡号待核对');
        assert.equal(await cell(page, orderTable, 'missing', 'serial'), '未登记');
        await geometry(page, `${width}-${theme}-orders`);
        await page.locator(orderTable + ' tr[data-row-id="preferred"] [data-action="commerce-subscription-card-detail"]').click();
        const history = await page.locator('#drawer[open]').innerText();
        assert(history.includes(syntheticCards.replacement));
        assert(history.includes('0012'));
        await closeDrawer(page);
        await page.locator('[data-action="commerce-subscription-card-tab"][data-tab="frozen"]').click();
        await page.locator(frozenTable + ' tr[data-row-id="frozen-card"]').waitFor();
        assert.equal(await cell(page, frozenTable, 'frozen-card', 'last4'), syntheticCards.frozen);
        assert.equal(await cell(page, frozenTable, 'frozen-card', 'typeName'), 'vccwc999');
        assert.equal(await cell(page, frozenTable, 'frozen-card', 'serial'), 'FRZ-0001');
        await geometry(page, `${width}-${theme}-frozen`);
        assert.deepEqual(errors, []);
        assert.deepEqual(requests.unavailable, []);
        assert.deepEqual(requests.external, []);
        const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage }));
        for (const number of Object.values(syntheticCards)) assert(!persisted.includes(number));
      } catch (error) {
        await page.screenshot({ path: join(output, `failure-${width}-${theme}.png`), fullPage: true });
        throw error;
      } finally { await context.close(); }
    });
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2));
});

test('银行卡资料读取失败可重试，长序列号与跨页数据可完整查看', { timeout: 60_000 }, async t => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const fixture = cardDisplayFixture();
    const longSerial = '0000-' + 'SERIAL'.repeat(20);
    fixture.orders.find(order => order.id === 'same-tail').proCardSerial = longSerial;
    for (let i = 0; i < 24; i++) fixture.orders.push({ ...fixture.orders[0], id: 'extra-' + i,
      email: `extra-${i}@example.test`, proCardNumber: '411111111111' + String(i).padStart(4, '0'),
      paymentId: String(i).padStart(4, '0'), proCardSerial: 'EXTRA-' + i });
    let failed = true;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await interceptCards(context, fixture, () => failed
      ? { status: 503, body: { error: '合成读取失败' } } : fixture.request());
    const page = await context.newPage();
    await page.clock.setFixedTime(cardDisplayTime);
    page.setDefaultTimeout(7000);
    try {
      await page.goto(origin + '/#/subscriptions/bank-cards');
      await page.getByText('银行卡资料暂未更新', { exact: false }).waitFor();
      assert(!Object.values(syntheticCards).some(number => page.url().includes(number)));
      assert.equal(await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.shared }).count(), 0);
      failed = false;
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.locator(groupTable + ' [data-column="tail"]').filter({ hasText: syntheticCards.shared }).waitFor();
      await geometry(page, `${width}-first-page`);
      const sameTail = page.locator(groupTable + ' tbody tr').filter({ hasText: syntheticCards.sameTail });
      await sameTail.getByRole('button', { name: '查看卡序列号完整内容', exact: true }).click();
      assert.equal(await page.locator('#table-cell-full-value').inputValue(), longSerial);
      await closeDrawer(page);
      await page.locator(active + ' .pagination button[aria-label="下一页"]').click();
      await page.locator(active + ' .pagination[data-page="2"]').waitFor();
      await geometry(page, `${width}-last-page`);
    } finally { await context.close(); }
  }
});

test('身份清理后，迟到的银行卡资料不能恢复旧页面或旧卡号', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = cardDisplayFixture();
  let release, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await interceptCards(context, fixture, async () => {
    if (++reads === 1) { await pending; return fixture.request(); }
    return { status: 200, body: { items: [], frozen: [] } };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.clock.setFixedTime(cardDisplayTime);
  await page.goto(origin + '/#/subscriptions/bank-cards');
  await page.locator(groupTable + ' td[data-column="tail"]').filter({ hasText: '正在读取…' }).first().waitFor();
  const response = page.waitForResponse('**/api/local/subscription-card-status*');
  await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
  release();
  await (await response).finished();
  await settle(page);
  assert.equal(await page.locator('#main [data-page-region]').count(), 0, '迟到响应不能重新挂载旧页面');
  await page.evaluate(() => window.IDDesignAPI.render());
  await page.locator(groupTable + ' td[data-column="tail"]').filter({ hasText: '完整卡号待核对' }).first().waitFor();
  const text = await page.locator(groupTable).innerText();
  for (const number of Object.values(syntheticCards)) assert(!text.includes(number));
  assert.equal(reads, 2, '身份清理后重新读取资料');
  await context.close();
});

test('换卡版本通知更新卡片资料，重读失败保留上次结果并可重试', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = cardDisplayFixture();
  let failed = false;
  await interceptCards(context, fixture, () => failed
    ? { status: 503, body: { error: '合成重读失败' } } : fixture.request());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.clock.setFixedTime(cardDisplayTime);
  await page.goto(origin + '/#/subscriptions/bank-cards');
  await page.locator(groupTable + ' td[data-column="tail"]').filter({ hasText: syntheticCards.shared }).waitFor();
  await page.locator('[data-action="commerce-subscription-card-tab"][data-tab="orders"]').click();
  assert.equal(await cell(page, orderTable, 'preferred', 'tail'), syntheticCards.replacement);
  Object.assign(Object.values(fixture.snapshots.subscriptions.data.renewalCards)[0], {
    number: syntheticCards.sameTail, last4: '4242'
  });
  failed = true;
  const refreshed = await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'commerce')
    .onDataChanges(['subscription-management']));
  assert.equal(refreshed, false);
  assert.equal(await cell(page, orderTable, 'preferred', 'tail'), syntheticCards.replacement);
  await page.getByText('银行卡资料暂未更新', { exact: false }).waitFor();
  failed = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.locator(orderTable + ' tr[data-row-id="preferred"] td[data-column="tail"]')
    .filter({ hasText: syntheticCards.sameTail }).waitFor();
  assert.equal(await cell(page, orderTable, 'preferred', 'serial'), '0008');
  await context.close();
});

test('续费待办不展示银行卡余额，保留原来的用卡与备款资料', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const fixture = cardDisplayFixture();
    fixture.orders[0].expiry = '2026-11-11T12:00:00+08:00';
    await interceptCards(context, fixture);
    await context.route('**/api/local/subscription-renewal-card', route => route.fulfill({ json: {
      orderId: 'manual', last4: '4242', availability: 'normal', hasCard: true, canCopy: true,
      estimate: { usd: '22.30' }, balance: { amount: '78.20', currency: 'USD' }
    } }));
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await page.clock.setFixedTime(cardDisplayTime);
    await page.goto(origin + '/#/workspace/renewals');
    await page.locator('[data-action="commerce-renewal-tab"][data-tab="expired"]').click();
    await page.locator('[data-action="commerce-renewal-select"][data-id="manual"]').click();
    const detail = page.locator('.renewal-workbench-detail');
    await detail.getByText('22.30 USD', { exact: true }).waitFor();
    assert(!/余额|78\.20/.test(await detail.innerText()));
    assert(await detail.getByRole('button', { name: '复制银行卡', exact: true }).isVisible());
    await context.close();
  }
});
