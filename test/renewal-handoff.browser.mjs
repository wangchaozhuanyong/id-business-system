import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, settle } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const source = { id: 'fixture-subscription', version: 2, number: 'OD-QA-140', customer: '测试客户',
  account: 'fixture@example.test', product: 'Claude Max', plan: 'Max 5x', payment: '银行卡',
  previousPaidCurrency: 'USD', start: '2026-11-01T10:00', expiry: '2026-11-14T10:00' };
const second = { ...source, id: 'fixture-second', number: 'OD-QA-141', account: 'second@example.test' };
const orderFixture = { ...source, orderNo: source.number, email: source.account, source: '管理员手工',
  status: '已记录', businessType: '续费', refunds: [] };

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
          canFinish: role === 'employee' && row.status === 'paid', assignedToMe: role === 'finance' }));
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
  await drawer.getByLabel('我已核对付款成功及本次用卡').check();
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
  assert.deepEqual(actions, ['submit', 'claim', 'paid', 'finish']);
  assert.deepEqual(errors, []);
  for (const { requests } of [staff, finance, admin]) assert.deepEqual(requests.external, []);
});
