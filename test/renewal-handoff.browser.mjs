import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const source = { id: 'fixture-subscription', version: 2, number: 'OD-QA-140', customer: '测试客户',
  account: 'fixture@example.test', product: 'Claude Max', plan: 'Max 5x', payment: '银行卡',
  previousPaidCurrency: 'USD', start: '2026-11-01T10:00', expiry: '2026-11-14T10:00' };
const second = { ...source, id: 'fixture-second', number: 'OD-QA-141', account: 'second@example.test' };
const orderFixture = { ...source, orderNo: source.number, email: source.account, source: '管理员手工',
  status: '已记录', businessType: '续费', refunds: [] };

test('renewal page controls share one row when they fit and wrap within the panel', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true,
    actor: { id: 'renewal-layout', name: '合成管理员', role: 'super' }, localFixtures: {
      commerce: { version: 1, data: { customers: [], orders: [], operating: [], tenants: [], logs: [], rentBatches: [] } },
      renewals: { version: 1, candidates: [source], items: [] }
    } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  const routes = ['renewals', 'renewals/sent', 'renewals/ready', 'renewals/history', 'renewals/reminders', 'finance-renewals'];
  await page.goto(origin + '/#/workspace/renewals');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await toggleDesignTheme(page);
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of routes) {
        const route = 'workspace/' + path;
        const region = page.locator(`#main[data-layout-route="${route}"]`);
        const toolbar = region.locator('.renewal-toolbar');
        await page.evaluate(route => { location.hash = '#/' + route; }, route);
        await toolbar.locator('input').waitFor();
        await settle(page);
        const reminder = path === 'renewals/reminders';
        const hasTabs = reminder || path === 'finance-renewals';
        const row = hasTabs ? region.locator('.renewal-controls') : toolbar;
        const layout = await row.evaluate(node => {
          const controls = [...node.querySelectorAll('button, a, input, select, label, .footnote')]
            .filter(control => control.checkVisibility()).map(control => {
              const box = control.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
            });
          const panel = node.closest('.panel').getBoundingClientRect();
          return { controls, panel: { left: panel.left, right: panel.right } };
        });
        const label = `${route} ${width}px ${theme}`;
        for (const [i, control] of layout.controls.entries()) {
          assert(control.left >= layout.panel.left + 10 && control.right <= layout.panel.right - 10, label);
          assert(layout.controls.slice(i + 1).every(other => control.right <= other.left + 1 ||
            other.right <= control.left + 1 || control.bottom <= other.top + 1 || other.bottom <= control.top + 1), label);
        }
        if (width === 1440) {
          const centers = layout.controls.map(control => (control.top + control.bottom) / 2);
          assert(Math.max(...centers) - Math.min(...centers) <= 1, `${label} 顶部控件应在同一行`);
        }
        if (hasTabs) assert.equal(await row.getByRole('tab').count(), 3, label);
        if (!reminder) assert(await row.getByRole('button', { name: '刷新', exact: true }).isVisible(), label);
        if (path === 'renewals') assert(await row.getByRole('button', { name: '提交给财务', exact: true }).isDisabled(), label);
        if (path.startsWith('renewals') && !reminder)
          assert(await row.getByRole('link', { name: '续费提醒', exact: true }).isVisible(), label);
        const spacing = await spacingSnapshot(page);
        assert.equal(spacing.overflow, false, label);
        assert.deepEqual(spacing.findings, [], label);
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.unavailable, []);
  assert.deepEqual(traffic.external, []);
});

test('renewal countdown uses Beijing dates, updates across expiry and keeps the current selection', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' });
  const traffic = await interceptDesign(context, { skipRechargeAssets: true, localFixtures: {},
    actor: { id: 'countdown-employee', name: '合成员工', role: 'employee' } });
  const candidates = [
    ['future', '2026-11-17T15:30', '剩余 3 天 5 小时'],
    ['expired', '2026-11-12 08:30', '已到期 2 天 1 小时'],
    ['soon', '2026-11-14T10:01', '剩余不足 1 小时'],
    ['just-expired', '2026-11-14T10:00', '已到期不足 1 小时'],
    ['utc', '2026-11-17T07:30:00Z', '剩余 3 天 5 小时'],
    ['offset', '2026-11-17T07:30:00+0000', '剩余 3 天 5 小时'],
    ['missing', '', '未登记到期时间'],
    ['invalid', 'invalid', '到期时间待核对']
  ].map(([id, expiry, expected]) => ({ ...source, id, number: 'OD-QA-' + id, expiry, expected }));
  let reads = 0;
  await context.route('**/api/local/renewals**', route => {
    assert.equal(route.request().method(), 'GET');
    reads++;
    return route.fulfill({ json: { version: 1, candidates, items: [] } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-14T02:00:00Z') });
  await page.goto(origin + '/#/workspace/renewals');
  const counter = id => page.locator(`tr[data-row-id="${id}"] [data-column="days"]`);
  const header = page.getByRole('columnheader', { name: '到期倒计时', exact: true });
  await header.waitFor();
  assert.equal(await header.evaluate(node => node.previousElementSibling.textContent), '原到期时间');
  for (const row of candidates) await counter(row.id).getByText(row.expected, { exact: true }).waitFor();
  const selection = page.getByRole('checkbox', { name: '选择 future', exact: true });
  await selection.check();
  const initialReads = reads;
  const originalCheckbox = await selection.elementHandle();
  await page.clock.fastForward(61_000);
  await counter('soon').getByText('已到期不足 1 小时', { exact: true }).waitFor();
  assert(await counter('soon').locator('.tag.danger').isVisible());
  await page.clock.fastForward(30 * 60_000);
  await counter('future').getByText('剩余 3 天 4 小时', { exact: true }).waitFor();
  await counter('expired').getByText('已到期 2 天 2 小时', { exact: true }).waitFor();
  assert.equal(reads, initialReads, '倒计时更新不请求业务列表');
  assert(await originalCheckbox.evaluate(node => node.isConnected && node.checked), '更新文字保留已勾选的订单');
  await page.getByRole('button', { name: '提交给财务（1）', exact: true }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await counter('future').isVisible(), '手机默认显示到期倒计时');
    const bounds = await counter('future').evaluate(cell => {
      const text = cell.querySelector('[data-renewal-countdown]').getBoundingClientRect();
      const card = cell.closest('tr').getBoundingClientRect();
      return text.left >= card.left && text.right <= card.right;
    });
    assert(bounds, '倒计时留在手机卡片内');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  const beforeHidden = await counter('future').innerText();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(3_600_000);
  assert.equal(await counter('future').innerText(), beforeHidden, '后台暂停倒计时');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await counter('future').getByText('剩余 3 天 3 小时', { exact: true }).waitFor();
  const detachedCounter = await counter('future').elementHandle();
  const lastText = await counter('future').innerText();
  await page.getByRole('link', { name: '已送财务', exact: true }).click();
  await page.locator('#main[data-layout-route="workspace/renewals/sent"]').waitFor();
  await page.clock.fastForward(3_600_000);
  assert.equal(await detachedCounter.evaluate(node => node.textContent), lastText, '离页后停止旧倒计时');
  assert.equal(reads, initialReads);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.unavailable, []);
  assert.deepEqual(traffic.external, []);
});

test('finance source review preserves the reason but requires a fresh version and confirmation', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const errors = [], posts = [];
    const requests = await interceptDesign(context, { skipRechargeAssets: true, localAuthUi: true,
      actor: { id: 'finance-fixture', name: '测试财务', role: 'finance' }, localFixtures: {} });
    let sourceVersion = 2, reviewed = false;
    await context.route('**/api/local/auth/security**', route => route.fulfill({ json: {
      available: true, bound: true, recentlyVerified: true, devices: []
    } }));
    await context.route('**/api/local/renewals**', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { version: 3, candidates: [], items: [{
        id: 'changed-paid', version: 3, status: 'paid', order: source,
        sourceChanged: !reviewed, amount: '21.25', currency: 'USD',
        ...(!reviewed && { sourceReview: { version: sourceVersion, expiry: '2026-11-15T10:00', originalLast4: '4242' } })
      }] } });
      const command = route.request().postDataJSON(); posts.push(command);
      assert.equal(command.action, 'review-source');
      assert.equal(command.confirmed, true);
      if (posts.length === 1) {
        sourceVersion = 3;
        return route.fulfill({ status: 409, json: { error: '原单再次变化，请刷新后核对' } });
      }
      assert.equal(command.sourceVersion, sourceVersion);
      assert.equal(command.reason, '已核对到期时间更正');
      reviewed = true;
      return route.fulfill({ json: { saved: true } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/workspace/finance-renewals');
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole('tab', { name: '已处理', exact: true }).click();
    await page.getByRole('button', { name: '核对原单', exact: true }).click();
    const form = page.locator('#renewal-review-source-form');
    const confirm = form.getByRole('checkbox');
    const submit = page.getByRole('button', { name: '确认并交回员工' });
    await form.getByLabel('原单更正原因').fill('已核对到期时间更正');
    await submit.click(); assert.equal(posts.length, 0);
    await confirm.check(); await submit.click();
    await form.getByText('原单再次变化，请刷新后核对', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '核对原单', exact: true }).click();
    assert.equal(await form.getAttribute('data-source-version'), '3');
    assert.equal(await confirm.isChecked(), false);
    assert.equal(await form.getByLabel('原单更正原因').inputValue(), '已核对到期时间更正');
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual((await separatorSnapshot(page)).findings, []);
    await confirm.check(); await submit.click();
    await page.getByText('原单已核对，员工可以补资料提交订单', { exact: true }).waitFor();
    assert.equal(posts.length, 2);
    assert.deepEqual(errors, []); assert.deepEqual(requests.external, []);
    await context.close();
  }
});

test('staff confirms a batch and finance returns a verified replacement for a new order', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  let rows = [], available = [source, second], verified = false;
  const actions = [], errors = [];
  const timing = [];
  const diagnostic = 'ac6cc6fd-707d-49c4-9d1c-37eee88a7bf8';
  let rejectFinish = true;
  async function open(role, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const actor = { id: role + '-fixture', name: '测试' + role, email: role + '@example.test', role };
    const requests = await interceptDesign(context, { actor, localAuthUi: true, changeEvents: true, siteTelemetry: true,
      skipRechargeAssets: true, localFixtures: {
      commerce: { version: 2, data: { customers: [], orders: [orderFixture], operating: [], tenants: [], logs: [], rentBatches: [] } }
    } });
    await context.route('**/api/local/site-management/timing', route =>
      route.fulfill({ status: 204 }).then(() => timing.push(route.request().postDataJSON())));
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, options) => {
        if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const revision = (type, value) => controller.enqueue(new TextEncoder().encode(
            'event: ' + type + '\ndata: ' + JSON.stringify({ schema: 1, versions: { 'renewal-handoffs': value + ':0:0' } }) + '\n\n'));
          revision('snapshot', '0');
          window.renewalChanged = value => revision('change', value);
        } }), { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    await context.route('**/api/local/auth/security**', route => {
      if (route.request().url().endsWith('/verify')) {
        verified = true;
        return route.fulfill({ status: 200, json: { verified: true } });
      }
      return route.fulfill({ status: 200, json: { available: true, bound: true, recentlyVerified: verified, devices: [] } });
    });
    await context.route('**/api/local/renewals**', route => {
      const request = route.request();
      if (request.method() === 'GET') {
        const current = rows.map(row => ({ ...row, canTake: role === 'finance' && row.status === 'pending',
          canFinish: role === 'employee' && row.status === 'paid' && !row.sourceChanged, assignedToMe: role === 'finance' }));
        return route.fulfill({ json: { version: actions.length, items: current, candidates: available, reminderHours: 168 } });
      }
      const body = request.postDataJSON();
      assert.match(request.headers()['x-id-operation'], /^[\da-f-]{36}$/);
      if (body.action === 'finish') {
        assert.equal(request.headers()['x-id-measured-action'], 'order-save');
        if (rejectFinish) {
          rejectFinish = false;
          return route.fulfill({ status: 409, headers: { 'X-ID-Diagnostic': diagnostic },
            json: { error: '合成原单发生变化，请重新核对' } });
        }
      }
      actions.push(body.action);
      if (body.action === 'submit') {
        assert.equal(body.confirmed, true);
        assert.deepEqual(body.orders, [{ id: source.id, version: 2 }, { id: second.id, version: 2 }]);
        rows = available.map((order, index) => ({ id: 'case-' + index, version: 1, status: 'pending', order,
          submittedAt: '2026-11-13T05:00:00Z', submittedBy: '客服甲' }));
        available = [];
      } else {
        const row = rows.find(item => item.id === body.id);
        assert.equal(body.version, row.version);
        row.version++;
        if (body.action === 'claim') row.status = 'processing';
        if (body.action === 'paid') {
          assert(verified);
          assert.equal(body.cardMode, 'manual');
          assert.equal(body.amount, '22.25');
          assert.equal(body.cardNumber, '4111111111111111');
          assert.equal(body.confirmed, true);
          Object.assign(row, { status: 'paid', amount: body.amount, currency: body.currency, last4: '1111' });
        }
        if (body.action === 'review-source') {
          assert(verified);
          assert.deepEqual(body, { action: 'review-source', id: row.id, version: 4, sourceVersion: 3,
            reason: '原到期时间登记更正', confirmed: true });
          row.sourceChanged = false;
          delete row.sourceReview;
        }
        if (body.action === 'finish') {
          assert.equal(body.saleAmount, '160.00');
          assert.equal(body.expiry, '2026-12-14T10:00');
          assert.equal(body.cardNumber, undefined);
          Object.assign(row, { status: 'complete', newOrderNo: 'OD-QA-NEW', completedAt: '2026-11-13T08:00:00Z' });
          return route.fulfill({ json: { saved: true, orderNo: 'OD-QA-NEW' } });
        }
      }
      return route.fulfill({ json: { saved: true } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6500);
    page.on('pageerror', error => errors.push(error.message));
    return { page, requests };
  }
  const staff = await open('employee', 390);
  await staff.page.goto(origin + '/#/workspace/renewals');
  await staff.page.getByRole('heading', { name: '续费管理', exact: true }).waitFor();
  const navigation = staff.page.getByRole('navigation', { name: '续费办理进度' });
  const workbench = staff.page.locator('[data-renewal-handoff]');
  assert.equal(await navigation.getByRole('link', { name: '选订单' }).getAttribute('aria-current'), 'page');
  const mobile = await navigation.boundingBox();
  assert(mobile.y + mobile.height <= (await workbench.boundingBox()).y);
  await staff.page.setViewportSize({ width: 1440, height: 900 });
  const desktop = await navigation.boundingBox();
  const queue = await workbench.boundingBox();
  assert(desktop.x >= queue.x + queue.width && Math.abs(desktop.y - queue.y) <= 1);
  await staff.page.setViewportSize({ width: 390, height: 900 });
  await staff.page.getByRole('checkbox', { name: '选择当前页' }).check();
  await staff.page.getByRole('button', { name: '提交给财务（2）' }).click();
  await staff.page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(actions.length, 0);
  await staff.page.getByRole('button', { name: '提交给财务（2）' }).click();
  await staff.page.getByRole('button', { name: '确认送财务' }).click();
  await staff.page.waitForURL('**/#/workspace/renewals/sent');
  await staff.page.getByText('待财务', { exact: true }).first().waitFor();
  await staff.page.evaluate(() => window.IDDesignAPI.go('workspace/finance-renewals'));
  await staff.page.getByRole('heading', { name: '访问受限' }).waitFor();
  const finance = await open('finance', 1440);
  await finance.page.goto(origin + '/#/workspace/finance-renewals');
  const initialFinance = finance.page.locator('tr[data-row-id="case-0"]');
  await initialFinance.getByRole('button', { name: '接手' }).click();
  await finance.page.getByRole('tab', { name: '处理中' }).click();
  await initialFinance.getByRole('button', { name: '登记实付' }).click();
  const drawer = finance.page.locator('#drawer');
  await drawer.getByLabel('实际付款金额').fill('22.25');
  await drawer.getByLabel('本次使用的卡').selectOption('manual');
  await drawer.getByLabel('本次银行卡号').fill('4111111111111111');
  await drawer.getByLabel('我已确认付款成功，已填写的用卡资料与本次付款一致').check();
  await drawer.getByRole('button', { name: '提交实付给员工' }).click();
  await finance.page.getByLabel('身份验证器的六位验证码').fill('123456');
  await finance.page.getByRole('button', { name: '验证', exact: true }).click();
  await finance.page.getByText('已交回续费管理，等待员工补资料').waitFor();
  await finance.page.getByRole('tab', { name: '已处理' }).click();
  await finance.page.getByText('1111', { exact: true }).waitFor();
  await finance.page.setViewportSize({ width: 320, height: 850 });
  await finance.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await settle(finance.page);
  assert.equal(await finance.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual((await separatorSnapshot(finance.page)).findings, []);
  Object.assign(rows[0], { version: 4, sourceChanged: true, sourceReview: {
    version: 3, expiry: '2026-11-15T10:00', originalLast4: '4242'
  } });
  await finance.page.evaluate(() => window.renewalChanged(4));
  await initialFinance.getByRole('button', { name: '核对原单' }).click();
  await drawer.getByText('2026-11-15 10:00', { exact: true }).waitFor();
  assert.equal(await finance.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await drawer.getByLabel('原单更正原因').fill('原到期时间登记更正');
  await drawer.getByLabel('我已核对本次付款仍对应这张订单').check();
  await drawer.getByRole('button', { name: '确认并交回员工' }).click();
  await finance.page.getByText('原单已核对，员工可以补资料提交订单').waitFor();
  await staff.page.evaluate(() => window.IDDesignAPI.go('workspace/renewals/ready'));
  await staff.page.getByText('暂无符合条件的订单', { exact: true }).waitFor();
  await staff.page.waitForFunction(() => window.IDChangeSync?.status().snapshots > 0);
  await staff.page.evaluate(() => window.renewalChanged(3));
  await staff.page.getByRole('link', { name: '补资料并提交' }).click();
  const form = staff.page.locator('#renewal-finish-form');
  const receipt = form.getByLabel('客户实收金额');
  await receipt.fill('160.00');
  await receipt.focus();
  await staff.page.evaluate(() => window.renewalChanged(4));
  await staff.page.waitForFunction(() => window.IDLocalData.pendingChangeVersions(['renewal-handoffs'])['renewal-handoffs'] === undefined);
  assert.equal(await receipt.evaluate(input => input === document.activeElement), true);
  await staff.page.getByRole('link', { name: '返回待补资料' }).click();
  await staff.page.getByRole('link', { name: '补资料并提交' }).click();
  assert.equal(await form.getByLabel('客户实收金额').inputValue(), '160.00');
  await form.getByLabel('新到期时间（北京）').fill('2026-12-14T10:00');
  await form.getByRole('button', { name: '提交订单' }).click();
  await form.getByRole('button', { name: '复制编号' }).waitFor();
  assert.equal(await form.getByLabel('客户实收金额').inputValue(), '160.00');
  assert.equal(await form.getByRole('alert').getByText(diagnostic, { exact: true }).count(), 1);
  await form.getByRole('button', { name: '提交订单' }).click();
  await staff.page.getByText('OD-QA-NEW', { exact: true }).first().waitFor();
  assert.deepEqual(timing.filter(row => row.id === diagnostic).map(row => [row.activity, row.result]), [['order-save', 'blocked']]);
  assert.match(staff.page.url(), /#\/workspace\/renewal-submit\/case-0$/);
  await staff.page.getByRole('link', { name: '查看办理记录' }).click();
  await staff.page.waitForURL('**/#/workspace/renewals/history');
  await staff.page.getByText('已续费', { exact: true }).waitFor();
  const admin = await open('admin', 1440);
  await admin.page.goto(origin + '/#/orders/claude');
  await admin.page.getByText(source.account, { exact: true }).first().waitFor();
  assert.equal(await admin.page.getByRole('checkbox', { name: '选择当前页' }).count(), 0);
  assert.equal(await admin.page.getByRole('button', { name: '付租批次', exact: true }).count(), 0);
  assert.deepEqual(actions, ['submit', 'claim', 'paid', 'review-source', 'finish']);
  assert.deepEqual(errors, []);
  for (const { requests } of [staff, finance, admin]) assert.deepEqual(requests.external, []);
});
