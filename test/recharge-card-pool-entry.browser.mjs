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
const poolTabs = page => page.getByRole('navigation', { name: '银行卡池功能' });
const output = process.env.ID_LAYOUT_QA_OUTPUT;
const sampleCards = [
  { id: 1, last4: '2468', card_number: '****2468', card_expiry: '10/31', is_active: 1,
    usage_count: 2, allowed_plans: ['plus'], card_holder: 'Sample Holder' },
  { id: 2, last4: '1357', card_number: '****1357', card_expiry: '06/30', is_active: 1,
    usage_count: 0, allowed_plans: ['pro200'] }
];

async function prepare(browser, { role = 'super', viewport = { width: 1440, height: 1000 }, pending = [], localAuthUi = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 901 });
  const snapshot = { version: 3, strict: false, items: sampleCards.map(card => ({ id: card.id,
    last4: card.last4, cardNumber: card.id === 1 ? '1000000000002468' : '', active: true, plans: card.allowed_plans, uses: card.usage_count })), pending };
  const types = { version: 1, items: [{ id: 'sample', name: '样例虚拟卡', active: true }],
    assignments: { 'recharge:1': 'sample', 'recharge:2': 'sample' } };
  const traffic = await interceptDesign(context, { localAuthUi, actor: { id: 'card-entry-' + role,
    name: '离线验收账号', email: 'card-entry@example.test', role },
    localFixtures: { 'staff/finance/cards': snapshot, 'staff/finance/cards/pending': { pending }, 'card-types': types } });
  const reads = [], writes = [];
  const state = { ready: true, admin: role === 'super', status: 200, cards: structuredClone(sampleCards),
    policy: { version: 3, strict: false, reuseLimits: null }, cardsStatus: 200 };
  await context.route('**/integrations/codexdaichong/status', request =>
    request.fulfill({ status: state.status, json: state }));
  await context.route('**/integrations/codexdaichong/api/admin/cards', request => {
    reads.push('cards');
    return request.fulfill({ status: state.cardsStatus, json: { success: true, cards: state.cards, planPolicy: state.policy } });
  });
  await context.route('**/integrations/codexdaichong/api/admin/cards/plan-policy', request => {
    const command = request.request().postDataJSON();
    writes.push(command);
    if (command.version !== state.policy.version)
      return request.fulfill({ status: 409, json: { success: false, message: '套餐设置已更新，请核对最新设置后重试' } });
    if (command.cardIds) for (const card of state.cards)
      if (command.cardIds.includes(card.id)) card.allowed_plans = command.allowedPlans;
    state.policy = { version: state.policy.version + 1, strict: command.strict ?? state.policy.strict,
      reuseLimits: command.reuseLimits ?? state.policy.reuseLimits };
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

test('银行卡池从左侧子导航进入并保留完整功能和编辑状态', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = await prepare(browser);
  t.after(() => fixture.context.close());
  const { page, writes, state } = fixture;
  const frame = await open(page);
  assert.equal(await page.getByRole('heading', { name: '银行卡设置', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-staff-action="card-import-open"]').count(), 0);
  assert.equal(await frame.locator('#cards [data-switch-panel="local"] th').count(), 12);
  assert.equal(await poolTabs(page).count(), 0);
  assert.equal(await frame.locator('#cards .admin-switcher-tabs').isVisible(), false);
  await frame.getByRole('button', { name: '一卡几充设置', exact: true }).click();
  const reuseDrawer = frame.locator('#card_reuse_limits_drawer');
  await reuseDrawer.waitFor({ state: 'visible' });
  await reuseDrawer.getByText('保存后开始按套餐限制取卡').waitFor();
  assert.equal(await frame.locator('#card_reuse_limit_plus').inputValue(), '4');
  await reuseDrawer.getByRole('button', { name: '增加 Plus 上限', exact: true }).click();
  assert.equal(await frame.locator('#card_reuse_limit_plus').inputValue(), '5');
  await reuseDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
  await reuseDrawer.getByText('已保存并生效').waitFor();
  assert.deepEqual(writes.shift(), { version: 3, reuseLimits: { plus: 5, pro100: 1, pro200: 1, pro500: 1 } });
  assert.equal(await frame.locator('#card_pool_list_body tr').first().locator('.card-usage-metric').textContent(), '2 / 5');
  await reuseDrawer.getByRole('button', { name: '关闭一卡几充设置', exact: true }).click();
  await reuseDrawer.waitFor({ state: 'hidden' });
  state.cardsStatus = 503;
  await frame.getByRole('button', { name: '一卡几充设置', exact: true }).click();
  await reuseDrawer.getByText('配置读取失败，请关闭后重试').waitFor();
  assert(await reuseDrawer.getByRole('button', { name: '保存设置', exact: true }).isDisabled());
  await reuseDrawer.getByRole('button', { name: '关闭一卡几充设置', exact: true }).click();
  state.cardsStatus = 200;
  await frame.getByRole('button', { name: '一卡几充设置', exact: true }).click();
  const plusLimit = frame.locator('#card_reuse_limit_plus:not(:disabled)');
  await plusLimit.waitFor();
  assert.equal(await plusLimit.inputValue(), '5');
  const help = reuseDrawer.locator('summary[aria-label="查看一卡几充设置说明"]');
  await help.click();
  await reuseDrawer.getByText('达到某个套餐上限的银行卡将跳过该套餐。', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  assert(await reuseDrawer.isVisible());
  assert.equal(await reuseDrawer.locator('details[open]').count(), 0);
  await page.keyboard.press('Escape');
  await reuseDrawer.waitFor({ state: 'hidden' });
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
  const sidebar = page.getByRole('navigation', { name: '业务模块导航' });
  const tabs = page.getByRole('navigation', { name: 'ChatGPT 充值功能' });
  for (let index = 0; index < 3; index++) {
    await sidebar.getByRole('link', { name: 'ChatGPT 充值', exact: true }).click();
    await tabs.getByRole('button', { name: '支付链接调试', exact: true }).waitFor();
    assert.equal(await tabs.getByRole('button', { name: '银行卡池', exact: true }).count(), 0);
    await sidebar.getByRole('link', { name: '银行卡设置', exact: true }).click();
    await page.waitForURL('**/#/' + route);
    await frame.locator('#card_pool_list_body tr').first().waitFor();
  }
  assert.equal(await page.locator('iframe[data-view="cards"]').count(), 1);
  assert.equal(await page.locator(frameSelector).evaluate(node => node.contentWindow.cardEntryIdentity), 'same-runtime');
  await frame.getByRole('button', { name: '设置所选 2 张卡' }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Pro 500', exact: true }).isChecked(), true);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await frame.locator('[data-card-plan-edit="1"]').getByText('Pro 500').waitFor();
  assert.deepEqual(writes, [{ version: 4, cardIds: [1, 2], allowedPlans: ['pro500'] }]);
  await frame.locator('[data-edit-recharge-card-type="recharge:1"]').click();
  await page.locator('#drawer[open]').getByRole('heading', { name: '设置银行卡类型' }).waitFor();
  await page.locator('#drawer[open]').getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('#card_pool_list_body tr').first().getByTitle('删除', { exact: true }).click();
  await frame.locator('#admin_confirm_cancel').click();
  await frame.getByRole('button', { name: '仅使用已设置套餐的卡' }).click();
  await frame.locator('#admin_confirm_cancel').click();
  assert.equal(await frame.locator('#card_pool_list_body tr').first().locator('.card-usage-metric').textContent(), '2 / 1');
  assert.equal(await frame.locator('#card_pool_list_body tr').first().locator('.status-exhausted').first().textContent(), '已用满');
  const reloaded = page.waitForResponse(response => new URL(response.url()).pathname ===
    '/integrations/codexdaichong/api/admin/cards');
  await frame.locator('#refresh_card_pool_btn').click();
  await reloaded;
  await frame.locator('#card_pool_list_body tr').first().waitFor();
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
  await fixture.context.route('**/api/local/staff/finance/cards/pending', async request => {
    await new Promise(resolve => { release = resolve; });
    await request.fulfill({ json: { pending: [] } });
  });
  const frame = await open(fixture.page);
  const reads = fixture.reads.length;
  const reloaded = fixture.page.waitForResponse(response => new URL(response.url()).pathname ===
    '/integrations/codexdaichong/api/admin/cards');
  await frame.locator('#refresh_card_pool_btn').click();
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
  await page.getByRole('button', { name: '重新检查服务', exact: true }).click();
  const frame = page.frameLocator(frameSelector);
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  const original = await page.locator(frameSelector).elementHandle();
  await fixture.context.route('**/integrations/codexdaichong/api/admin/cards', request =>
    request.fulfill({ status: 503, json: { success: false } }), { times: 1 });
  const failedList = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith('/api/admin/cards') && response.status() === 503);
  await frame.locator('#refresh_card_pool_btn').click();
  await failedList;
  await frame.locator('#card_pool_list_body tr').first().waitFor();
  assert(await page.locator(frameSelector).evaluate((node, previous) => node === previous, original));
  assert.equal(await frame.locator('#card_pool_list_body tr').count(), 2);
  await original.dispose();
  healthy(fixture);
});

test('待核对记录的旧读回不会覆盖较新的版本通知', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page } = await prepare(browser);
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  t.after(async () => { releaseFirst(); await context.close(); });
  const path = '/api/local/staff/finance/cards/pending';
  let reads = 0;
  await context.route('**' + path, async request => {
    const original = ++reads === 1;
    if (original) await gate;
    const row = { id: 'review', label: original ? '旧回执' : '新回执', submittedBy: '样例财务', canReview: true };
    await request.fulfill({ json: { pending: [row] } });
  });
  await open(page);
  assert.equal(reads, 1);
  await page.evaluate(() => {
    const scope = 'recharge-card-plans';
    window.IDLocalData.queries.invalidate([scope]);
    return window.IDDesignModules.find(item => item.id === 'staff-finance-cards').onDataChanges([scope]);
  });
  await page.getByText('新回执', { exact: true }).waitFor();
  const old = page.waitForResponse(response => new URL(response.url()).pathname === path);
  releaseFirst();
  await (await old).finished();
  await settle(page);
  assert(await page.getByText('新回执', { exact: true }).isVisible());
  assert.equal(await page.getByText('旧回执', { exact: true }).count(), 0);
  assert.equal(reads, 2);
});

test('管理员核对使用确认前的卡池版本，只有内嵌列表未就绪时才按需读取', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const ready of [true, false]) {
    const row = { id: 'sample', label: '停用银行卡', submittedBy: '样例财务', canReview: true };
    const fixture = await prepare(browser, { localAuthUi: true });
    const { context, page, state } = fixture;
    try {
      state.status = ready ? 200 : 503;
      state.ready = ready;
      let pending = [row], fullReads = 0;
      const commands = [];
      await context.route('**/api/local/staff/finance/cards/pending', request => request.fulfill({ json: { pending } }));
      await context.route('**/api/local/staff/finance/cards', request => {
        if (request.request().method() === 'GET') {
          fullReads++;
          return request.fulfill({ json: { version: state.policy.version, pending, items: [] } });
        }
        const command = request.request().postDataJSON();
        commands.push(command);
        if (command.version !== state.policy.version)
          return request.fulfill({ status: 409, json: { error: '请刷新列表并核对当前银行卡资料' } });
        pending = [];
        return request.fulfill({ json: { reconciled: true } });
      });
      if (ready) await open(page);
      else {
        await page.goto(origin + '/#/' + route);
        await page.getByText('ChatGPT 充值服务未就绪', { exact: true }).waitFor();
      }
      const review = page.getByRole('button', { name: '核对上次操作', exact: true });
      await review.waitFor();
      assert.equal(fullReads, 0);
      await review.click();
      const confirm = page.getByRole('button', { name: '确认', exact: true });
      await confirm.waitFor();
      if (ready) state.policy = { ...state.policy, version: 4 };
      await confirm.click();
      if (ready) {
        await page.locator('[data-staff-status]').filter({ hasText: '请刷新列表并核对当前银行卡资料' }).waitFor();
        assert(await review.isVisible());
      } else {
        await page.getByText('已核对银行卡维护结果', { exact: true }).waitFor();
        assert.equal(await review.count(), 0);
      }
      assert.equal(fullReads, ready ? 0 : 1);
      assert.deepEqual(commands, [{ action: 'reconcile', id: 'sample', version: 3, confirmed: true }]);
      healthy(fixture);
    } finally { await context.close(); }
  }
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
        await fixture.page.getByText('1000000000002468', { exact: true }).waitFor();
        await fixture.page.getByText('未留存完整卡号', { exact: true }).waitFor();
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
        const listHeader = frame.locator('#cards [data-switch-panel="local"] > .panel-header');
        const headerLayout = await listHeader.evaluate(header => {
          const strip = header.querySelector('.card-plan-toolbar');
          const summary = strip.querySelector('[role="status"]');
          const importButton = header.querySelector('.card-pool-header-actions button.btn-success');
          const bounds = node => node.getBoundingClientRect();
          const center = node => bounds(node).top + bounds(node).height / 2;
          const offsets = [...strip.children].map(node => Math.abs(center(node) - center(importButton)));
          const scrolls = strip.scrollWidth > strip.clientWidth;
          strip.scrollLeft = strip.scrollWidth;
          const endReachable = bounds(summary).right <= bounds(strip).right + 1;
          strip.scrollLeft = 0;
          return { offsets, scrolls, endReachable, stacked: innerWidth <= 900,
            importVisible: (innerWidth <= 900 ? bounds(importButton).left >= 0 : bounds(importButton).left >= bounds(strip).right) && bounds(importButton).right <= innerWidth,
            startVisible: bounds(strip.querySelector('h2')).left >= bounds(strip).left - 1 };
        });
        if (!headerLayout.stacked) assert(headerLayout.offsets.every(offset => offset <= 2), '列表标题、套餐操作、说明与导入按钮必须同排居中');
        assert(headerLayout.importVisible && headerLayout.startVisible && headerLayout.endReachable,
          '导入按钮固定可见，横向滑动可读完整说明');
        if (width >= 1440) assert.equal(headerLayout.scrolls, false, '宽屏直接展示全部操作');
        if (headerLayout.stacked) assert.equal(headerLayout.scrolls, false, '窄屏操作换行显示');
        if (output && theme === 'light' && width === 1920)
          await listHeader.screenshot({ path: join(output, 'card-list-header.png') });
        assert.equal(await poolTabs(page).count(), 0);
        await frame.getByRole('button', { name: '一卡几充设置', exact: true }).waitFor();
        await frame.locator('#refresh_card_pool_btn').waitFor();
        const help = page.getByLabel('查看银行卡设置说明', { exact: true });
        const before = await page.locator(frameSelector).boundingBox();
        await help.click();
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.locator(frameSelector).boundingBox(), before);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const table = frame.locator('#cards [data-switch-panel="local"] .table-container');
        const planButton = frame.locator('[data-card-plan-edit="1"]');
        if (width <= 768) {
          await planButton.scrollIntoViewIfNeeded();
          const planHit = await planButton.evaluate(button => {
            const scroller = button.closest('.table-container');
            const edge = scroller.getBoundingClientRect().right;
            scroller.scrollLeft += button.getBoundingClientRect().right - edge + 12;
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.right - 8, rect.top + rect.height / 2));
          });
          assert(planHit, 'card actions must leave the scrolled plan button clickable');
          await planButton.tap();
        } else {
          await planButton.click();
        }
        const dialog = frame.getByRole('dialog', { name: '设置允许套餐' });
        const geometry = await dialog.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return { width: innerWidth, dialog: rect.toJSON(), overflow: node.scrollWidth > node.clientWidth,
            choices: [...node.querySelectorAll('.card-plan-choice')].map(label => label.getBoundingClientRect().height) };
        });
        assert.equal(geometry.overflow, false);
        assert(geometry.choices.every(height => height >= 44));
        measurements.push({ theme, width, ...geometry, headerLayout });
        if (output && [1920, 1440, 390].includes(width))
          await page.screenshot({ path: join(output, theme + '-' + width + '-dialog.png') });
        await dialog.getByRole('button', { name: '关闭套餐设置', exact: true }).click();
        if (width <= 768) {
          const extra = table.locator('tbody tr').first().getByRole('button', {name: '更多资料'});
          await extra.click();
          assert(await table.locator('tbody tr').first().locator('td[data-field-label=CVC]').isVisible());
          await table.locator('#card_pool_list_body tr td:last-child button').first().scrollIntoViewIfNeeded();
          const actionsReachable = await table.evaluate(scroller => {
            scroller.scrollLeft = scroller.scrollWidth;
            const button = scroller.querySelector('#card_pool_list_body tr td:last-child button');
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          });
          assert(actionsReachable, 'row actions must be reachable at the end of the table');
        }
        await frame.getByRole('button', { name: '批量导入', exact: true }).click();
        await frame.locator('#card_pool_import_box').getByRole('checkbox', { name: 'Pro 500', exact: true }).check();
        await frame.getByRole('button', { name: '批量导入', exact: true }).click();
        if (output && [1920, 1440, 390].includes(width)) {
          await table.evaluate(node => { node.scrollLeft = 0; });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(output, theme + '-' + width + '.png') });
        }
        state.cards = [];
        await frame.locator('#refresh_card_pool_btn').click();
        await frame.locator('#card_pool_list_body').getByText(/暂无/).waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        healthy(fixture);
      } finally { await fixture.context.close(); }
    });
  }
  if (output) await writeFile(join(output, 'layout.json'), JSON.stringify(measurements, null, 2));
});
