import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFinanceReconciliation } from '../server/finance/recharge-reconciliation.mjs';
import { reconciliationFixture } from './helpers/reconciliation-fixture.mjs';
import { interceptDesign, origin, root, separatorSnapshot, settle } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const output = process.env.ID_LAYOUT_QA_OUTPUT || join(root, '.runtime/finance-reconciliation-20261114');
assert(!relative(root, output).startsWith('..') && !isAbsolute(relative(root, output)));
const route = 'staff/finance/reconciliation';
const table = '[data-table="代充对账记录"]';
const actor = { id: 'fixture-finance', name: '离线验收账号', email: 'finance@example.test', role: 'finance' };

async function prepare(t, { count = 45, stream = false, role = 'finance' } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  t.after(() => context.close());
  const access = await interceptDesign(context, { actor: { ...actor, role }, localFixtures: {}, skipRechargeAssets: true,
    changeEvents: stream, dataVersions: stream ? { 'recharge-billing': '2:1' } : undefined });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.fixtureCopied = value; } } });
  });
  const fixture = reconciliationFixture(count), requests = [], writes = [], errors = [];
  const state = { status: 200 };
  const read = createFinanceReconciliation(fixture.client, fixture.store);
  await context.route('**/api/local/**', async request => {
    if (!['GET', 'HEAD'].includes(request.request().method())) {
      writes.push(new URL(request.request().url()).pathname);
      return request.fulfill({ status: 405, json: { error: '离线对账检查禁止业务写入' } });
    }
    const url = new URL(request.request().url());
    if (url.pathname !== '/api/local/' + route) return request.fallback();
    requests.push(Object.fromEntries(url.searchParams));
    if (state.status !== 200) return request.fulfill({ status: state.status, json: { error: '对账资料暂不可用' } });
    try { return request.fulfill({ json: await read(url.searchParams, { ...actor, role }) }); }
    catch (error) { return request.fulfill({ status: error.status || 503, json: { error: error.message } }); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  return { ...fixture, page, context, access, requests, writes, errors, response: state };
}

async function open(page) {
  await page.goto(origin + '/#/' + route);
  await page.locator(table + ' tbody tr').first().waitFor();
  await settle(page);
}

function healthy(fixture) {
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.access.external, []);
  assert.deepEqual(fixture.access.unavailable, []);
}

test('对账直接显示完整卡号和邮箱，长资料可复制，宽窄屏与主题均可读', { timeout: 60_000 }, async t => {
  const f = await prepare(t, { count: 3, role: 'super' });
  const { page } = f;
  // Exercise the maximum supported PAN length and genuinely long source fields.
  f.state.cards[0].card_number = f.state.records[0].card_number = '0000000000000002468';
  f.state.records[0].email = 'long-reconciliation-account-for-readonly-verification@example.test';
  f.state.records[0].stripe_session_id = 'cs_test_' + 'synthetic_payment_reference_'.repeat(6);
  await open(page);
  const first = page.locator(table + ' tbody tr').first();
  assert.equal(await page.locator(table + ' th').count(), 10);
  assert.equal(await first.locator('[data-column="cardNumber"]').innerText(), f.state.records[0].card_number);
  assert.match(await first.locator('td[data-column="cardType"]').innerText(), /样例虚拟卡/);
  await first.getByRole('button', { name: '复制完整卡号', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureCopied), f.state.records[0].card_number);
  for (const [label, value] of [['充值邮箱', f.state.records[0].email], ['支付单号', f.state.records[0].stripe_session_id]]) {
    await first.getByRole('button', { name: '查看' + label + '完整内容', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: label + '完整内容', exact: true }).inputValue(), value);
    await page.getByRole('button', { name: '复制完整内容', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureCopied), value);
    await page.locator('#drawer').getByRole('button', { name: '关闭抽屉' }).click();
  }
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  const measurements = [];
  await mkdir(output, { recursive: true });
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await settle(page);
    if (width <= 760 && await first.getByRole('button', { name: '更多资料', exact: true }).isVisible())
      await first.getByRole('button', { name: '更多资料', exact: true }).click();
    const geometry = await page.locator('[data-finance-reconciliation]').evaluate(region => {
      const controls = [...region.querySelectorAll('.finance-toolbar input,.finance-toolbar select,.finance-toolbar button,.finance-toolbar a')]
        .filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect());
      const copy = region.querySelector('[data-action="billing-copy"]'), box = copy.getBoundingClientRect();
      const text = copy.querySelector('span'), textBox = text.getBoundingClientRect(), row = copy.closest('tr').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
        controlsOutside: controls.some(b => b.left < 0 || b.right > innerWidth + 1),
        overlap: controls.some((a, index) => controls.slice(index + 1).some(b =>
          Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1)),
        clippedCard: text.scrollWidth > text.clientWidth + 1 || textBox.right > box.right + 1 ||
          (innerWidth <= 760 && box.right > row.right + 1),
        cardHeight: box.height, toolbarBottoms: controls.map(box => box.bottom) };
    });
    assert.equal(geometry.overflow || geometry.controlsOutside || geometry.overlap || geometry.clippedCard,
      false, JSON.stringify({ width, theme, geometry }));
    if (width <= 760) assert(geometry.cardHeight >= 44);
    if (width >= 1440) assert(Math.max(...geometry.toolbarBottoms) - Math.min(...geometry.toolbarBottoms) <= 2);
    assert.deepEqual((await separatorSnapshot(page)).findings, [], width + ' ' + theme);
    measurements.push({ width, theme, ...geometry });
    if (width === 1920 && theme === 'light' || width === 1440 && theme === 'dark' || width === 390 && theme === 'light') {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(output, width === 1920 ? 'desktop.png' : theme === 'dark' ? 'dark.png' : 'mobile.png'), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const label of ['代充对账', '卡类型', '支付单号']) {
    const help = page.getByLabel('查看' + label + '说明', { exact: true });
    await help.scrollIntoViewIfNeeded();
    const before = await first.boundingBox();
    assert.equal(await help.evaluate(node => node.parentElement.open), false);
    await help.click();
    assert.equal(await help.evaluate(node => node.parentElement.open), true);
    assert.deepEqual(await first.boundingBox(), before);
    await page.keyboard.press('Escape');
    assert.equal(await help.evaluate(node => node.parentElement.open), false);
  }
  await writeFile(join(output, 'layout-measurements.json'), JSON.stringify(measurements, null, 2));
  healthy(f);
});

test('对账筛选在分页前生效，失败保留结果和草稿，空记录与缺失资料明确显示', { timeout: 40_000 }, async t => {
  const f = await prepare(t), { page } = f;
  await open(page);
  const submit = page.getByRole('button', { name: '查询账单', exact: true });
  const refresh = page.getByRole('button', { name: '刷新', exact: true });
  assert.equal(await page.locator(table + ' tbody tr').count(), 20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('第 2 页', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('第 3 页', { exact: true }).waitFor();
  assert.equal(await page.locator(table + ' tbody tr').count(), 5);
  assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
  const beforeDraft = f.requests.length;
  await page.getByLabel('开始日期', { exact: true }).fill('2026-11-14');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-11-14');
  await page.getByLabel('卡号后四位', { exact: true }).fill('1357');
  await page.getByLabel('套餐', { exact: true }).selectOption('pro100');
  await page.getByLabel('扣款状态', { exact: true }).selectOption('failed');
  assert.equal(f.requests.length, beforeDraft);
  await submit.click();
  await page.getByText('共 4 笔 · 本页 4 笔', { exact: true }).waitFor();
  assert.equal(await page.locator(table + ' tbody tr').count(), 4);
  assert.equal(f.requests.at(-1).page, '1');
  assert.equal(await page.locator(table + ' [data-column="status"]').filter({ hasText: '扣款失败' }).count(), 4);
  assert.equal(await page.locator(table + ' td[data-column="errorCode"]').filter({ hasText: 'card_declined' }).count(), 4);
  await page.getByLabel('卡号后四位', { exact: true }).fill('9999');
  f.response.status = 503;
  await submit.click();
  await page.getByText('暂时无法读取。这里显示的是上次取得的账单。', { exact: true }).waitFor();
  assert.equal(await page.locator(table + ' tbody tr').count(), 4);
  assert(await page.getByText('卡号后四位 1357', { exact: true }).isVisible());
  assert.equal(await page.getByLabel('卡号后四位', { exact: true }).inputValue(), '9999');
  f.response.status = 200;
  await refresh.click();
  await page.getByRole('heading', { name: '暂无扣款记录', exact: true }).waitFor();
  assert(await page.getByText('共 0 笔 · 本页 0 笔', { exact: true }).isVisible());
  assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
  f.state.records[1].card_number = null;
  f.state.records[1].email = null;
  await page.getByLabel('卡号后四位', { exact: true }).fill('1357');
  await submit.click();
  await page.getByText('未留存（尾号 1357）', { exact: true }).waitFor();
  assert(await page.getByText('未留存邮箱', { exact: true }).isVisible());
  assert(await page.getByText('卡号未留存', { exact: true }).isVisible());
  f.state.failCards = true;
  await refresh.click();
  await page.getByText('卡池暂未读取，未能确认的卡类型已标注；账单原始资料保持可见。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '复制完整卡号', exact: true }).count(), 3);
  await page.getByLabel('扣款状态', { exact: true }).selectOption('pending');
  await page.evaluate(() => window.IDDesignAPI.go('overview'));
  await page.getByRole('heading', { name: '网站总览', exact: true }).waitFor();
  await page.evaluate(route => window.IDDesignAPI.go(route), route);
  await page.getByText('未留存（尾号 1357）', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('扣款状态', { exact: true }).inputValue(), 'pending');
  assert.equal(f.requests.at(-1).status, 'failed');
  f.response.status = 403;
  await refresh.click();
  await page.locator('[data-billing-error]:not([hidden])').waitFor();
  assert.equal(await page.getByRole('button', { name: '复制完整卡号', exact: true }).count(), 0);
  healthy(f);
});

test('卡分类版本更新沿用提交后通知，保留草稿，同版本不重复读取', { timeout: 30_000 }, async t => {
  const f = await prepare(t, { count: 1, stream: true }), { page, context } = f;
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    const frame = (type, versions) => `event: ${type}\ndata: ${JSON.stringify({ schema: 1, versions })}\n\n`;
    window.fixtureRevision = revision => window.fixtureStream.enqueue(new TextEncoder().encode(frame('change', { 'recharge-billing': revision })));
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.fixtureStream = controller;
        controller.enqueue(new TextEncoder().encode(frame('snapshot', { 'recharge-billing': '2:1' })));
        options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } }));
    };
  });
  const idle = () => page.waitForFunction(() => {
    const state = window.IDChangeSync?.status();
    return state?.connected && state.snapshots && !state.refreshing && !state.pending;
  });
  await open(page);
  await idle();
  await page.getByLabel('卡号后四位', { exact: true }).fill('9999');
  f.types.data.items[0].name = '更新后的样例卡类型';
  await page.evaluate(() => window.fixtureRevision('3:1'));
  await page.getByText('更新后的样例卡类型', { exact: true }).waitFor();
  await idle();
  assert.equal(await page.getByLabel('卡号后四位', { exact: true }).inputValue(), '9999');
  assert.equal(f.requests.at(-1).last4, '');
  const reads = f.requests.length;
  await page.evaluate(() => {
    window.fixtureRevision('3:1');
    window.fixtureStream.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
  });
  await idle();
  await settle(page);
  assert.equal(f.requests.length, reads);
  healthy(f);
});

test('首次读取失败可重试，身份清理移除对账快照及共享完整资料缓存', { timeout: 20_000 }, async t => {
  const f = await prepare(t, { count: 1 }), { page } = f;
  f.response.status = 503;
  await page.goto(origin + '/#/' + route);
  await page.locator('[data-billing-error]:not([hidden])').waitFor();
  assert.equal(await page.locator(table).count(), 0);
  f.response.status = 200;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator(table + ' tbody tr').first().waitFor();
  const cleared = await page.evaluate(() => {
    const oldControl = document.querySelector('[data-table="代充对账记录"] [data-column="email"][data-action="table-cell-view"]').cloneNode(true);
    window.IDDesignAPI.clearPageRegions();
    // An old detached control cannot reopen data left in the shared table registry.
    document.querySelector('#main').append(oldControl);
    oldControl.click();
    oldControl.remove();
    return { drawerOpen: document.querySelector('#drawer').open,
      snapshot: window.IDLocalData.queries.peek('recharge-billing', { page: 1, from: '', to: '', last4: '', plan: '', status: '' }),
      cards: document.querySelectorAll('[data-action="billing-copy"]').length };
  });
  assert.equal(cleared.drawerOpen, false);
  assert.equal(cleared.snapshot, undefined);
  assert.equal(cleared.cards, 0);
  healthy(f);
});
