import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, root, separatorSnapshot, settle } from './helpers/offline-design.mjs';
import { turnstileLoginPage } from '../server/login-security.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const actor = role => ({ id: 'staff-fixture-' + role, name: '测试账号', email: role + '@example.test', role });
const order = { id: 'test-order', orderNo: 'OD-READONLY-001', product: 'GPT', plan: 'Plus', email: 'customer@example.test',
  payment: '银行卡', businessType: '续费', source: '管理员手工', status: '已记录', createdAt: new Date().toISOString(),
  start: new Date().toISOString(), expiry: '2027-01-01T00:00:00+08:00', saleAmount: '111.00', saleCurrency: 'CNY',
  paidAmount: '20.00', paidCurrency: 'USD', paidConfirmed: true, receiptConfirmed: true, refunds: [],
  bankReturns: [{ id: 'return-01', amount: '2.00', currency: 'USD', at: '2026-11-13T12:00:00Z' }] };
const cards = { version: 7, strict: false, items: [{ id: 11, last4: '6022', active: true, uses: 2, plans: ['plus'] }] };
const localFixtures = {
  commerce: { version: 1, data: { orders: [order], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] } },
  'finance/expense-receipts': { version: 1, items: [] },
  'staff/finance/cards': cards,
  'staff/finance/reconciliation': { items: [{ time: '2026-11-13T05:00:00Z', reference: '账单-01', amount: '20',
    currency: 'USD', status: 'success', last4: '6022' }], hasMore: false },
  'staff/registration': { version: 1, data: { mailboxes: [{ id: 'mail-1', email: 'owned@example.test', type: 'google',
    hasAuthenticator: true, status: '正常' }], accounts: [],
    appleRelay: { parents: [{ id: 'apple1', email: 'parent@example.test', version: 1, status: 'ACTIVE' }] } } },
  'saved-totp': { version: 0, items: [] },
  'staff/mail-code': { items: [{ code: '123456', receivedAt: '2026-11-13 12:30' }] },
  'staff/registration-code': { code: '654321', expiresAt: 1794546000000 },
  'staff/team': { items: [{ name: '小组员工', customers: 1, orders: 2 }] },
  'staff/business-proxies': { version: 0, items: [] },
  'staff/customer-service': { version: 2, data: { customers: [{ id: 'customer-1', name: '本人客户', active: true }],
    orders: [{ ...order, customerId: 'customer-1' }] } },
  renewals: { version: 1, items: [], candidates: [{ id: order.id, version: 1, number: order.orderNo, account: order.email,
    product: order.product, plan: order.plan, customer: '本人客户', payment: order.payment, expiry: order.expiry }] },
  'auth/security/network': { policy: { version: 0, mode: 'observe', entries: [] }, connectable: false, challengeEnabled: false },
  'auth/security/device-requests': { items: [] },
  'auth/security/activity': { items: [] }
};

async function prepare(browser, role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access = await interceptDesign(context, { actor: actor(role), localFixtures, localAuthUi: true, skipRechargeAssets: true });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, access, errors };
}

test('role navigation uses business language and finance order operations remain read-only', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const expectations = [
    ['admin', 'settings/payment-countries', '访问受限'],
    ['super', 'settings/security', '登录安全'],
    ['supervisor', 'staff/team', '小组工作'],
    ['registrar', 'staff/registration', '注册工作台'],
    ['employee', 'staff/customers', '客户服务'],
    ['finance', 'orders/gpt', 'GPT 订单']
  ];
  for (const [role, route, title] of expectations) {
    const { context, page, errors, access } = await prepare(browser, role);
    try {
      await page.goto(origin + '/#/' + route);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      if (role === 'finance') {
        await page.getByText(order.email, { exact: true }).first().waitFor();
        assert.equal(await page.locator('[data-action="commerce-order-edit"],[data-action="commerce-order-refund"]').count(), 0);
        await page.evaluate(id => window.IDDesignAPI.go('orders/detail/' + id), order.id);
        await page.getByRole('tab', { name: '成本与汇率' }).click();
        assert.equal(await page.locator('[data-action="commerce-order-fx"],[data-action="commerce-order-auto-fx"]').count(), 0);
        await page.getByRole('tab', { name: '退款记录' }).click();
        await page.getByText('银行卡实际回款', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '登记银行卡实际回款' }).count(), 0);
        await page.evaluate(() => window.IDDesignAPI.go('orders/statistics'));
        await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
        await page.getByRole('tab', { name: '费用拆分', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '费用设置', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '登记实付凭据', exact: true }).count(), 0);
        await page.evaluate(() => window.IDDesignAPI.go('overview'));
        await page.getByRole('heading', { name: '网站总览', exact: true }).waitFor();
        await page.locator('[data-overview-metric="orders"] .overview-metric-value strong').getByText('1', { exact: true }).waitFor();
        assert.equal(await page.locator('.overview-stock-table').count(), 0);
        await page.evaluate(() => window.IDDesignAPI.go('staff/finance/reconciliation'));
        await page.getByText('账单-01').waitFor();
        await page.evaluate(() => window.IDDesignAPI.go('settings/accounts'));
        await page.getByRole('heading', { name: '访问受限' }).waitFor();
      } else if (role === 'supervisor') {
        await page.getByText('小组员工', { exact: true }).first().waitFor();
        await page.evaluate(() => window.IDDesignAPI.go('staff/finance/cards'));
        await page.getByRole('heading', { name: '访问受限' }).waitFor();
      } else if (role === 'registrar') {
        await page.getByRole('button', { name: '查邮箱验证码' }).click();
        await page.getByText('123456', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '动态验证码' }).click();
        await page.getByText('654321', { exact: true }).waitFor();
      } else if (role === 'employee') {
        await page.getByRole('button', { name: '提交续费' }).click();
        await page.getByRole('heading', { name: '续费管理', exact: true }).waitFor();
        assert.equal(await page.locator('[data-select="renewal-handoff"]').isChecked(), true);
      }
      assert.deepEqual(errors, [], role);
      assert.deepEqual(access.external, [], role);
    } finally { await context.close(); }
  }
});

test('finance verifies a card change and staff pages fit narrow screens with readable controls', { timeout: 40_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { context, page, errors } = await prepare(browser, 'finance');
  t.after(() => context.close());
  let verified = false, writes = 0, pending = false;
  await context.route('**/api/local/auth/security**', route => {
    if (route.request().url().endsWith('/verify')) {
      assert.equal(route.request().postDataJSON().code, '123456');
      verified = true;
      return route.fulfill({ json: { confirmed: true } });
    }
    return route.fulfill({ json: { available: true, bound: true, recentlyVerified: verified, deviceLock: false, devices: [] } });
  });
  await context.route('**/api/local/staff/finance/cards', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...cards, pending: pending ?
      [{ id: 'pending-fixture', label: '设置套餐', at: '2026-11-13T12:00:00Z', submittedBy: '测试账号', canReview: true }] : [] } });
    assert(verified);
    const command = route.request().postDataJSON();
    if (command.action === 'reconcile') {
      assert.deepEqual(command, { version: 7, action: 'reconcile', id: 'pending-fixture', confirmed: true });
      pending = false;
      return route.fulfill({ json: { saved: true, reconciled: true } });
    }
    assert.deepEqual(command, { version: 7, action: 'plans', cardIds: [11], plans: ['plus', 'pro200'] });
    writes++;
    pending = true;
    return route.fulfill({ status: 503, json: { error: '银行卡维护结果待核对' } });
  });
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByText('6022', { exact: true }).waitFor();
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), width + ' ' + theme);
    assert.deepEqual((await separatorSnapshot(page)).findings, []);
  }
  await page.getByRole('button', { name: '设置套餐', exact: true }).click();
  await page.locator('#staff-edit-plan-pro200').check();
  await page.getByRole('button', { name: '保存套餐' }).click();
  await page.getByLabel('身份验证器的六位验证码').fill('123456');
  await page.getByRole('button', { name: '验证', exact: true }).click();
  await page.getByRole('heading', { name: '待核对的银行卡维护' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.locator('#drawer').getByRole('button', { name: '关闭抽屉' }).click();
  await page.getByRole('button', { name: '核对上次操作' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('已核对银行卡维护结果', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '待核对的银行卡维护' }).count(), 0);
  assert.equal(writes, 1);
  assert.deepEqual(errors, []);
});

test('sign-in waits for a human check and then requests the authenticator code', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 850 } });
  await interceptDesign(context, { skipRechargeAssets: true });
  let passwordChecks = 0, factorChecks = 0;
  await context.route(url => url.origin === origin && url.pathname === '/', async route => {
    const source = await readFile(root + '/frontend/index.html', 'utf8');
    const body = turnstileLoginPage(source, 'fixture-site').replace('<head>', '<head><meta name="id-local-auth" content="required">' +
      '<link rel="stylesheet" href="/local-auth.css">')
      .replace('    <script src="./prototype.js', '    <script src="/local-auth.js" defer></script>\n    <script src="./prototype.js')
      .replace(/^ *<script src="\.\/[^"]+" defer><\/script>\n/gm, '');
    return route.fulfill({ contentType: 'text/html', body });
  });
  await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'text/javascript',
    body: `window.turnstile = { ready: cb => cb(), render: (host, config) => {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = '完成真人验证';
      control.dataset.turnstileSize = config.size;
      control.onclick = () => config.callback('fixture-challenge'); host.append(control); return 'fixture';
    }, reset() {} };` }));
  await context.route('**/api/local/auth/login**', route => {
    if (route.request().url().endsWith('/verify')) {
      factorChecks++;
      assert.deepEqual(route.request().postDataJSON(), { code: '123456', verification: 'fixture-verification' });
      return route.fulfill({ status: 202, json: { pendingDevice: true } });
    }
    passwordChecks++;
    assert.equal(route.request().postDataJSON().challenge, 'fixture-challenge');
    return route.fulfill({ status: 202, json: { needsCode: true, verification: 'fixture-verification' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    (window.fixtureViolations ||= []).push(event.effectiveDirective + ' ' + event.blockedURI);
  }));
  await page.goto(origin + '/');
  await page.getByLabel('登录邮箱').fill('account@example.test');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: '完成真人验证' }).waitFor().catch(async error => {
    assert.fail(JSON.stringify({ err: error.message, browserErrors,
      state: await page.evaluate(() => ({ policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
        violations: window.fixtureViolations || [], challenge: document.querySelector('#local-auth-challenge')?.innerText,
        notice: document.querySelector('.local-auth-error')?.innerText,
        rendered: Boolean(window.turnstile) })) }));
  });
  assert.equal(await page.getByRole('button', { name: '完成真人验证' }).getAttribute('data-turnstile-size'), 'compact');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert(await page.locator('#local-auth-gate button[type="submit"]').isDisabled());
  await page.getByRole('button', { name: '完成真人验证' }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('六位动态验证码或恢复码').fill('123456');
  assert.equal(passwordChecks, 1);
  assert(await page.getByLabel('密码', { exact: true }).isHidden());
  await page.getByRole('button', { name: '验证并登录' }).click();
  await page.getByText('已提交设备申请。', { exact: false }).waitFor();
  assert.equal(factorChecks, 1);
});
