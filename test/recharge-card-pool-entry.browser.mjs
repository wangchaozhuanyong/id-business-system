import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT ||
  join(root, 'node_modules/playwright/index.mjs')).href);
const route = 'staff/finance/cards';
const frameSelector = '[data-page-region="staff/finance/cards"] iframe[data-view="cards"]:visible';
const output = process.env.ID_LAYOUT_QA_OUTPUT;
const sampleCards = [
  { id: 1, last4: '2468', card_number: '****2468', card_expiry: '10/31', is_active: 1,
    usage_count: 2, allowed_plans: ['plus'], card_holder: 'Sample Holder' },
  { id: 2, last4: '1357', card_number: '****1357', card_expiry: '06/30', is_active: 1,
    usage_count: 0, allowed_plans: ['pro200'] }
];

async function prepare(browser, { role = 'super', viewport = { width: 1440, height: 1000 }, pending = [] } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 901 });
  const snapshot = { version: 3, strict: false, items: sampleCards.map(card => ({ id: card.id,
    last4: card.last4, active: true, plans: card.allowed_plans, uses: card.usage_count })), pending };
  const types = { version: 1, items: [{ id: 'sample', name: '样例虚拟卡', active: true }],
    assignments: { 'recharge:1': 'sample', 'recharge:2': 'sample' } };
  const traffic = await interceptDesign(context, { actor: { id: 'card-entry-' + role,
    name: '离线验收账号', email: 'card-entry@example.test', role },
    localFixtures: { 'staff/finance/cards': snapshot, 'card-types': types } });
  const reads = [], writes = [];
  const state = { ready: true, admin: role === 'super', status: 200, cards: structuredClone(sampleCards),
    policy: { version: 3, strict: false } };
  await context.route('**/integrations/codexdaichong/status', request =>
    request.fulfill({ status: state.status, json: state }));
  await context.route('**/integrations/codexdaichong/api/admin/cards', request => {
    reads.push('cards');
    return request.fulfill({ json: { success: true, cards: state.cards, planPolicy: state.policy } });
  });
  await context.route('**/integrations/codexdaichong/api/admin/cards/plan-policy', request => {
    const command = request.request().postDataJSON();
    writes.push(command);
    if (command.cardIds) for (const card of state.cards)
      if (command.cardIds.includes(card.id)) card.allowed_plans = command.allowedPlans;
    state.policy = { version: state.policy.version + 1, strict: command.strict ?? state.policy.strict };
    return request.fulfill({ json: { success: true, planPolicy: state.policy } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  return { context, page, traffic, errors, reads, writes, state };
}

async function open(page) {
  await page.goto(origin + '/#/' + route);
  const frame = page.frameLocator(frameSelector);
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  await settle(page);
  return frame;
}

function healthy(fixture) {
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.traffic.external, []);
  assert.deepEqual(fixture.traffic.unavailable, []);
}

test('自动代充银行卡复用完整卡池，旧页签回到同一个运行页面并保留编辑状态', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = await prepare(browser);
  t.after(() => fixture.context.close());
  const { page, writes } = fixture;
  const frame = await open(page);
  assert.equal(await page.getByRole('heading', { name: '自动代充银行卡', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-staff-action="card-import-open"]').count(), 0);
  assert.equal(await frame.locator('#cards [data-switch-panel="local"] th').count(), 12);
  for (const name of ['银行卡列表', 'Orbitcard 用卡记录', 'Orbitcard 开卡策略'])
    await frame.getByRole('tab', { name, exact: true }).waitFor();
  await frame.getByRole('button', { name: '批量导入', exact: true }).click();
  const importBox = frame.locator('#card_pool_import_box');
  await importBox.getByRole('combobox', { name: '银行卡类型', exact: true }).waitFor();
  await importBox.getByRole('textbox', { name: '待导入银行卡资料', exact: true }).waitFor();
  assert.equal(await importBox.getByRole('checkbox').count(), 4);
  await frame.getByRole('button', { name: '批量导入', exact: true }).click();
  await frame.locator('[data-card-plan-select][value="1"]').check();
  await frame.locator('[data-card-plan-select][value="2"]').check();
  await frame.getByRole('button', { name: '设置所选 2 张卡' }).click();
  const dialog = frame.getByRole('dialog', { name: '设置允许套餐' });
  await dialog.getByRole('checkbox', { name: 'Pro 500', exact: true }).check();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator(frameSelector).evaluate(node => { node.contentWindow.cardEntryIdentity = 'same-runtime'; });
  for (let index = 0; index < 3; index++) {
    await page.evaluate(() => window.IDDesignAPI.go('online-recharge/chatgpt'));
    await page.locator('[data-action="ops-integrated-view"][data-view="cards"]:visible').click();
    await page.waitForURL('**/#/' + route);
    await frame.locator('#card_pool_list_body tr').first().waitFor();
  }
  assert.equal(await page.locator('iframe[data-view="cards"]').count(), 1);
  assert.equal(await page.locator(frameSelector).evaluate(node => node.contentWindow.cardEntryIdentity), 'same-runtime');
  await frame.getByRole('button', { name: '设置所选 2 张卡' }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Pro 500', exact: true }).isChecked(), true);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await frame.locator('[data-card-plan-edit="1"]').getByText('Pro 500').waitFor();
  assert.deepEqual(writes, [{ version: 3, cardIds: [1, 2], allowedPlans: ['pro500'] }]);
  await frame.locator('[data-edit-recharge-card-type="recharge:1"]').click();
  await page.locator('#drawer[open]').getByRole('heading', { name: '设置银行卡类型' }).waitFor();
  await page.locator('#drawer[open]').getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('#card_pool_list_body tr').first().getByTitle('删除', { exact: true }).click();
  await frame.locator('#admin_confirm_cancel').click();
  await frame.getByRole('button', { name: '仅使用已设置套餐的卡' }).click();
  await frame.locator('#admin_confirm_cancel').click();
  await frame.getByRole('tab', { name: 'Orbitcard 用卡记录', exact: true }).click();
  await frame.locator('#orbitcard_usage_filters').waitFor();
  await frame.getByRole('tab', { name: 'Orbitcard 开卡策略', exact: true }).click();
  await frame.locator('#orbitcard_strategy_product_code').waitFor();
  await frame.getByRole('tab', { name: '银行卡列表', exact: true }).click();
  const reads = fixture.reads.length;
  const reloaded = page.waitForResponse(response => new URL(response.url()).pathname ===
    '/integrations/codexdaichong/api/admin/cards');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await reloaded;
  await page.locator('[data-recharge-module="cards"] .recharge-integration__view[aria-busy="false"]').waitFor();
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  assert(fixture.reads.length > reads);
  assert.equal(await page.locator('iframe[data-view="cards"]').count(), 1);
  const retained = await page.locator(frameSelector).elementHandle();
  await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
  assert.equal(await retained.evaluate(node => node.isConnected), false);
  assert.equal(await page.locator('#main iframe').count(), 0);
  await retained.dispose();
  healthy(fixture);
});

test('待核对记录读取缓慢时完整银行卡池仍能加载和刷新', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = await prepare(browser);
  let release;
  t.after(async () => { release?.(); await fixture.context.close(); });
  await fixture.context.route('**/api/local/staff/finance/cards', async request => {
    await new Promise(resolve => { release = resolve; });
    await request.fulfill({ json: { version: 3, strict: false, items: [], pending: [] } });
  });
  const frame = await open(fixture.page);
  const reads = fixture.reads.length;
  const reloaded = fixture.page.waitForResponse(response => new URL(response.url()).pathname ===
    '/integrations/codexdaichong/api/admin/cards');
  await fixture.page.getByRole('button', { name: '刷新', exact: true }).click();
  await reloaded;
  assert(fixture.reads.length > reads);
  release();
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  healthy(fixture);
});

test('银行卡入口保留待核对记录，服务失败可以重试且刷新失败保留完整卡池', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = await prepare(browser, { pending: [{ id: 'pending-sample', label: '设置套餐',
    submittedBy: '样例财务', at: '2026-11-14T00:00:00Z', canReview: true }] });
  t.after(() => fixture.context.close());
  const { page, state } = fixture;
  state.status = 503;
  state.ready = false;
  await page.goto(origin + '/#/' + route);
  await page.getByText('ChatGPT 充值服务未就绪', { exact: true }).waitFor();
  await page.getByRole('button', { name: '核对上次操作', exact: true }).waitFor();
  await page.getByRole('button', { name: '登记未确认', exact: true }).waitFor();
  state.status = 200;
  state.ready = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const frame = page.frameLocator(frameSelector);
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  state.status = 503;
  state.ready = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('ChatGPT 充值服务未就绪，已保留当前内容。', { exact: true }).waitFor();
  assert.equal(await frame.locator('#card_pool_list_body tr').count(), 2);
  assert.equal(await page.getByRole('button', { name: '核对上次操作', exact: true }).count(), 1);
  healthy(fixture);
});

test('财务账号保持原有授权入口，普通管理员不能打开该页面', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const role of ['finance', 'admin']) {
    const fixture = await prepare(browser, { role });
    try {
      await fixture.page.goto(origin + '/#/' + route);
      if (role === 'finance') {
        await fixture.page.getByRole('button', { name: '导入银行卡', exact: true }).waitFor();
        await fixture.page.getByText('2468', { exact: true }).waitFor();
      } else await fixture.page.getByRole('heading', { name: '访问受限' }).waitFor();
      assert.equal(await fixture.page.locator('iframe').count(), 0);
      assert.deepEqual(fixture.reads, []);
      healthy(fixture);
    } finally { await fixture.context.close(); }
  }
});

test('完整银行卡入口在深浅主题、宽窄屏和空结果下保持可操作', { timeout: 100_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  if (output) await mkdir(output, { recursive: true });
  const measurements = [];
  for (const theme of ['light', 'dark']) for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) {
    await t.test(theme + '-' + width, async () => {
      const fixture = await prepare(browser, { viewport: { width, height: 950 } });
      try {
        const { page, state } = fixture;
        const frame = await open(page);
        if (theme === 'dark') await toggleDesignTheme(page);
        const help = page.getByLabel('查看自动代充银行卡说明', { exact: true });
        const before = await page.locator(frameSelector).boundingBox();
        await help.click();
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.locator(frameSelector).boundingBox(), before);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await frame.locator('[data-card-plan-edit="1"]').click();
        const dialog = frame.getByRole('dialog', { name: '设置允许套餐' });
        const geometry = await dialog.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return { width: innerWidth, dialog: rect.toJSON(), overflow: node.scrollWidth > node.clientWidth,
            choices: [...node.querySelectorAll('.card-plan-choice')].map(label => label.getBoundingClientRect().height) };
        });
        assert.equal(geometry.overflow, false);
        assert(geometry.choices.every(height => height >= 44));
        measurements.push({ theme, width, ...geometry });
        if (output && [1920, 1440, 390].includes(width))
          await page.screenshot({ path: join(output, theme + '-' + width + '-dialog.png') });
        await dialog.getByRole('button', { name: '关闭套餐设置', exact: true }).click();
        await frame.getByRole('button', { name: '批量导入', exact: true }).click();
        await frame.locator('#card_pool_import_box').getByRole('checkbox', { name: 'Pro 500', exact: true }).check();
        await frame.getByRole('button', { name: '批量导入', exact: true }).click();
        if (output && [1920, 1440, 390].includes(width)) {
          await frame.locator('#cards [data-switch-panel="local"] .table-container').evaluate(node => { node.scrollLeft = 0; });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(output, theme + '-' + width + '.png') });
        }
        state.cards = [];
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await frame.locator('#card_pool_list_body').getByText(/暂无/).waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        healthy(fixture);
      } finally { await fixture.context.close(); }
    });
  }
  if (output) await writeFile(join(output, 'layout.json'), JSON.stringify(measurements, null, 2));
});
