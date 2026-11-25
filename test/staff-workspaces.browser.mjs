import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, root, separatorSnapshot, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { turnstileLoginPage } from '../server/login-security.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const actor = role => ({ id: 'staff-fixture-' + role, name: '测试账号', email: role + '@example.test', role });
const order = { id: 'test-order', orderNo: 'OD-READONLY-001', product: 'GPT', plan: 'Plus', email: 'customer@example.test',
  payment: '银行卡', businessType: '续费', source: '管理员手工', status: '已记录', createdAt: new Date().toISOString(),
  start: new Date().toISOString(), expiry: '2027-01-01T00:00:00+08:00', saleAmount: '111.00', saleCurrency: 'CNY',
  paidAmount: '20.00', paidCurrency: 'USD', paidConfirmed: true, receiptConfirmed: true, refunds: [],
  bankReturns: [{ id: 'return-01', amount: '2.00', currency: 'USD', at: '2026-11-13T12:00:00Z' }] };
const financeCardNumber = '1000000000006022';
const cards = { version: 7, strict: false,
  items: [{ id: 11, last4: '6022', cardNumber: financeCardNumber, active: true, uses: 2, plans: ['plus'] }] };
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
  'auth/security/network': { policy: { version: 0, mode: 'observe', entries: [] }, connectable: false, challengeEnabled: false },
  'auth/security/device-requests': { items: [] },
  'auth/security/activity': { items: [] }
};

async function prepare(browser, role, fixtures = localFixtures) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access = await interceptDesign(context, { actor: actor(role), localFixtures: fixtures, localAuthUi: true, skipRechargeAssets: true });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, access, errors };
}

test('注册员复用产品身份控件和微软验证方式，切换类型隔离草稿并清理凭据', async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { context, page, errors } = await prepare(browser, 'registrar');
  const submitted = [];
  await context.route('**/api/local/staff/registration', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: localFixtures['staff/registration'] });
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ json: { saved: true } });
  });
  await page.goto(origin + '/#/staff/registration');
  const form = page.locator('[data-staff-form="registration"]');
  const type = form.locator('#staff-type');
  await type.waitFor();
  assert.ok(await form.locator('#staff-password').evaluate(input => input.required));
  await form.locator('#staff-email').fill('google@example.test');
  await form.locator('#staff-password').fill('test-input');
  await type.selectOption('grok');
  assert.equal(await form.locator('#staff-password').inputValue(), '');
  await form.locator('#staff-loginMethod').selectOption('x');
  await form.locator('#staff-xHandle').fill('@sample_a');
  await type.selectOption('google');
  assert.equal(await form.locator('#staff-email').inputValue(), 'google@example.test');
  assert.equal(await form.locator('#staff-password').inputValue(), '');
  await type.selectOption('grok');
  assert.equal(await form.locator('#staff-xHandle').inputValue(), '@sample_a');
  await form.getByRole('button', { name: '保存登记' }).click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(submitted[0].loginMethod, 'x');
  assert.equal(submitted[0].email, '');
  await type.selectOption('gemini');
  assert.equal(await form.locator('#staff-loginMethod').inputValue(), 'google');
  await type.selectOption('microsoft');
  await form.locator('#staff-email').fill('mail@example.test');
  await form.locator('#staff-microsoft-login').selectOption('passwordless');
  await form.getByRole('button', { name: '保存登记' }).click();
  await page.getByText('无密码登录请选择实际使用的验证方式', { exact: true }).waitFor();
  assert.equal(submitted.length, 1);
  await form.getByLabel('通行密钥').check();
  await form.getByRole('button', { name: '保存登记' }).click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.deepEqual(submitted[1].microsoftSecurity.verificationMethods, ['passkey']);
  assert.deepEqual(errors, []);
});

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
        await page.getByRole('heading', { name: '本人订单', exact: true }).waitFor();
        await page.getByText(order.orderNo, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /^(提交续费|提交给财务|登记已完成续费)$/ }).count(), 0);
        assert.equal(await page.evaluate(() => window.IDDesignAPI.canVisit('workspace/renewals')), true);
      }
      assert.deepEqual(errors, [], role);
      assert.deepEqual(access.external, [], role);
    } finally { await context.close(); }
  }
});

test('员工从本人客户进入核心录单分组，草稿按客户和产品隔离并通过岗位接口提交', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'employee');
  t.after(() => context.close());
  const customers = [{ id: 'staff-a', name: '合成客户甲', active: true }, { id: 'staff-b', name: '合成客户乙', active: true }];
  const commands = [];
  let failNextRead = false, staffVersion = 2;
  await context.route('**/api/local/staff/customer-service', async route => {
    if (route.request().method() === 'GET') {
      if (failNextRead) {
        failNextRead = false;
        return route.fulfill({ status: 503, json: { error: '列表暂不可读' } });
      }
      return route.fulfill({ json: { version: staffVersion, data: { customers, orders: [] },
        orderCurrenciesByProduct: { GPT: commands.length ? [{ code: 'GBP', name: '英镑' }] : [{ code: 'EUR', name: '欧元' }] } } });
    }
    commands.push({ data: route.request().postDataJSON(), operation: route.request().headers()['x-id-operation'] });
    if (commands.length === 1) {
      staffVersion++;
      return route.fulfill({ status: 503, json: { error: '保存结果待核对' } });
    }
    failNextRead = true;
    return route.fulfill({ json: { savedId: 'staff-receipt' } });
  });
  await page.goto(origin + '/#/staff/customers');
  const open = id => page.locator(`[data-staff-action="order"][data-id="${id}"]`).click();
  const profile = page.locator('form[data-staff-form="customer"]');
  await profile.waitFor();
  assert.deepEqual(await profile.locator('.section-heading h2').allTextContents(), ['基本资料', '联系方式']);
  assert.equal(await profile.locator('#staff-wechat').getAttribute('maxlength'), '60');
  assert.equal(await profile.locator('input').count(), 2, '员工沿用客户建档模板及本人可写字段');
  const back = page.getByRole('button', { name: '返回本人客户' });
  const form = page.locator('form.order-submission-form');
  await open('staff-a');
  assert.deepEqual(await form.locator('.section-heading h2').allTextContents(), ['客户与账号', '付款与金额', '订阅周期']);
  assert.equal(await page.getByLabel('客户资料').inputValue(), customers[0].name);
  assert(await page.getByLabel('客户资料').evaluate(node => node.readOnly));
  const product = form.getByLabel('产品', { exact: false });
  assert.deepEqual(await product.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['GPT', 'Claude Max', 'Gemini', 'Grok']);
  const email = form.getByLabel('邮箱账号');
  assert.deepEqual(await form.getByLabel('实收币种').locator('option').allTextContents(), ['欧元 EUR']);
  await email.fill('draft-a@example.test');
  await product.selectOption('Grok');
  assert.equal(await email.inputValue(), '');
  assert.deepEqual(await form.getByLabel('支付方式').locator('option').allTextContents(), ['银行卡']);
  await product.selectOption('GPT');
  assert.equal(await email.inputValue(), 'draft-a@example.test');
  await back.click();
  await open('staff-b');
  assert.equal(await email.inputValue(), '');
  await back.click();
  await open('staff-a');
  assert.equal(await email.inputValue(), 'draft-a@example.test');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await toggleDesignTheme(page);
      const [start, expiry, paid, sale] = await Promise.all(['#staff-start', '#staff-expiry', '#staff-paidAmount', '#staff-saleAmount']
        .map(id => form.locator(id).boundingBox()));
      assert(width === 1440 ? Math.abs(start.y - expiry.y) < 2 : expiry.y > start.y + start.height);
      assert(width === 1440 ? Math.abs(paid.y - sale.y) < 2 : sale.y > paid.y + paid.height);
      assert(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    }
  }
  await form.getByLabel('代付币种').selectOption('CLP');
  await form.getByLabel('实际代付金额').fill('24999');
  await form.getByLabel('客户实收金额').fill('119');
  await form.getByLabel('支付方式').selectOption('苹果内购');
  assert.deepEqual(await form.getByLabel('代付币种').locator('option').allTextContents(), ['USD']);
  assert.equal(await form.getByLabel('实际代付金额').inputValue(), '');
  assert.equal(await form.getByLabel('客户实收金额').inputValue(), '119');
  await form.getByLabel('实际代付金额').fill('19');
  await form.getByLabel('支付方式').selectOption('银行卡');
  await form.getByLabel('支付方式').selectOption('苹果内购');
  assert.equal(await form.getByLabel('实际代付金额').inputValue(), '19');
  await form.getByLabel('客户实收金额').fill('119');
  await form.getByLabel('开通时间').fill('2026-11-21T12:00');
  await form.getByLabel('到期时间').fill('2026-12-21T12:00');
  assert.equal(commands.length, 0);
  await form.getByRole('button', { name: '提交订单' }).click();
  await page.getByText('保存结果待核对', { exact: true }).waitFor();
  await back.click();
  await page.evaluate(() => window.IDDesignAPI.go('orders/gpt'));
  await page.getByRole('heading', { name: 'GPT 订单', exact: true }).waitFor();
  await page.evaluate(() => window.IDDesignAPI.go('staff/customers'));
  await open('staff-a');
  assert.equal(await form.getByLabel('实收币种').inputValue(), 'EUR', '未知结果重试须保留原币种及幂等请求');
  await form.getByRole('button', { name: '提交订单' }).click();
  await page.getByText('订单提交成功，列表刷新失败，请点击刷新。').waitFor();
  assert.equal(await page.getByRole('link', { name: '查看此订单' }).getAttribute('href'), '#/orders/detail/staff-receipt');
  assert.equal(await form.count(), 0);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1], commands[0], '同一份订单在本地版本变化后重试仍应使用原操作编号和版本');
  assert.ok(commands[0].operation);
  assert.deepEqual(commands[0].data, { action: 'manual-order', customerId: 'staff-a', version: 2,
    planChoice: 'GPT|Plus', email: 'draft-a@example.test', payment: '苹果内购', paidAmount: '19', paidCurrency: 'USD',
    saleAmount: '119', saleCurrency: 'EUR', start: '2026-11-21T12:00', expiry: '2026-12-21T12:00' });
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('员工使用 X 账号录 Grok，原单冲突直接显示有权限的续费入口', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, access, errors } = await prepare(browser, 'employee');
  t.after(() => context.close());
  const requests = [];
  await context.route('**/api/local/staff/customer-service', route => {
    if (route.request().method() === 'GET') return route.fallback();
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: '该订阅已有原单，请选择续费' } });
  });
  await page.goto(origin + '/#/staff/customers');
  await page.getByRole('button', { name: '登记订单' }).click();
  const form = page.locator('[data-staff-form="manual-order"]');
  await form.locator('#order-entry-product').selectOption('Grok');
  const account = form.getByLabel('邮箱账号');
  await account.fill('@invalid space');
  await form.getByLabel('实际代付金额').fill('20');
  await form.getByLabel('客户实收金额').fill('100');
  await form.getByLabel('开通时间').fill('2026-11-21T12:00');
  await form.getByLabel('到期时间').fill('2026-12-21T12:00');
  await form.getByRole('button', { name: '提交订单' }).click();
  await form.getByText('请填写有效的订单邮箱或 X @账号').waitFor();
  assert.equal(requests.length, 0);
  await account.fill('@synthetic_user');
  await form.getByRole('button', { name: '提交订单' }).click();
  const renewal = page.getByRole('link', { name: '前往续费管理' });
  await renewal.waitFor();
  assert.equal(requests[0].email, '@synthetic_user');
  assert.equal(await account.inputValue(), '@synthetic_user');
  await renewal.click();
  await page.waitForURL('**/#/workspace/renewals');
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('主管只在比特执行 IP 入口填写名称和协议，切换后保留个人草稿', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, access, errors } = await prepare(browser, 'supervisor');
  t.after(() => context.close());
  const requests = [];
  await context.route('**/api/local/staff/business-proxies', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const command = route.request().postDataJSON();
    requests.push(command);
    const recharge = [{ added: 0, labeled: 1, skipped: 0 }, { added: 0, labeled: 0, skipped: 1 }];
    return route.fulfill({ json: { saved: true, ...(command.action === 'recharge' ? recharge[requests.length - 2] : {}) } });
  });
  await page.goto(origin + '/#/staff/business-proxies');
  const form = page.locator('[data-staff-form="proxy"]');
  const scope = form.getByLabel('使用范围'), protocol = form.getByLabel('代理协议');
  const name = form.getByLabel('名称', { exact: true }), link = form.getByLabel('代理链接');
  const submit = form.getByRole('button', { name: '登记业务 IP' });
  await protocol.selectOption('http');
  await link.fill('proxy.example.test:8080');
  await submit.click();
  await page.getByText('请填写 IP 名称。', { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  await name.fill('合成地址');
  await submit.click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(requests[0].name, '合成地址');
  assert.equal(requests[0].protocol, 'http');
  await name.fill('待登记的个人地址');
  await protocol.selectOption('https');
  await scope.selectOption('recharge');
  assert.equal(await protocol.isVisible(), false);
  assert.equal(await name.isVisible(), false);
  await scope.selectOption('personal');
  assert(await name.isVisible());
  assert.equal(await name.inputValue(), '待登记的个人地址');
  assert.equal(await protocol.inputValue(), 'https');
  await scope.selectOption('recharge');
  await form.getByLabel('国家或地区代码').fill('PH');
  await link.fill('proxy.example.test:8080');
  await submit.click();
  await page.getByText('自动代充代理新增 0 条，补标国家 1 条，跳过重复 0 条', { exact: true }).waitFor();
  assert.equal(requests[1].action, 'recharge');
  assert.equal(requests[1].countryCode, 'PH');
  assert.equal(Object.hasOwn(requests[1], 'name'), false);
  assert.equal(Object.hasOwn(requests[1], 'protocol'), false);
  assert.equal(await name.inputValue(), '待登记的个人地址');
  assert.equal(await protocol.inputValue(), 'https');
  assert.equal(await link.inputValue(), '');
  await page.setViewportSize({ width: 390, height: 844 });
  await scope.selectOption('recharge');
  assert.equal(await name.isVisible(), false);
  await form.getByLabel('国家或地区代码').fill('PH');
  await link.fill('proxy.example.test:8080');
  await submit.click();
  await page.getByText('自动代充代理新增 0 条，补标国家 0 条，跳过重复 1 条', { exact: true }).waitFor();
  assert.equal(Object.hasOwn(requests[2], 'name'), false);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('主管登记代充代理后收到迟到回执时保留当前个人输入', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const leaveAndReturn of [false, true]) {
    await t.test(leaveAndReturn ? '切页返回，先前列表读取仍在等待' : '留在原页', async t => {
      const { context, page, access, errors } = await prepare(browser, 'supervisor');
      t.after(() => context.close());
      const respond = Promise.withResolvers();
      const respondToOldRead = Promise.withResolvers();
      const routePath = '/api/local/staff/business-proxies';
      let returning = false, saved = false, writes = 0;
      try {
        await context.route('**' + routePath, async route => {
          if (route.request().method() === 'GET') {
            if (saved) return route.fulfill({ json: { version: 1, items: [{ name: '已更新的个人地址', countryCode: 'PH' }] } });
            if (!returning) return route.fallback();
            await respondToOldRead.promise;
            return route.fulfill({ headers: { 'x-fixture-snapshot': 'old' },
              json: { version: 0, items: [{ name: '保存前的旧列表', countryCode: 'PH' }] } });
          }
          writes += 1;
          await respond.promise;
          saved = true;
          return route.fulfill({ json: { saved: true, added: 1, labeled: 0, skipped: 0 } });
        });
        await page.goto(origin + '/#/staff/business-proxies');
        const form = page.locator('[data-staff-form="proxy"]');
        const scope = form.getByLabel('使用范围'), country = form.getByLabel('国家或地区代码');
        const name = form.getByLabel('名称', { exact: true }), link = form.getByLabel('代理链接');
        const protocol = form.getByLabel('代理协议');
        await scope.selectOption('recharge');
        await country.fill('PH');
        await link.fill('business.example.test:8080');
        const submit = form.getByRole('button', { name: '登记业务 IP' });
        const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === routePath);
        await submit.click();
        assert.equal((await submitted).postDataJSON().action, 'recharge');

        if (leaveAndReturn) {
          await page.evaluate(() => window.IDDesignAPI.go('staff/team'));
          await page.getByRole('heading', { name: '小组工作', exact: true }).waitFor();
          returning = true;
          const oldRead = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === routePath);
          await page.evaluate(() => window.IDDesignAPI.go('staff/business-proxies'));
          await oldRead;
          assert.equal(await link.inputValue(), '');
        }
        await scope.selectOption('personal');
        await name.fill('下次登记的个人地址');
        await protocol.selectOption('https');
        await country.fill('MY');
        await link.fill('https://personal.example.test:8081');
        respond.resolve();
        await page.getByText('自动代充代理新增 1 条，补标国家 0 条，跳过重复 0 条', { exact: true }).waitFor();
        if (leaveAndReturn) {
          const oldResponse = page.waitForResponse(response => response.headers()['x-fixture-snapshot'] === 'old');
          respondToOldRead.resolve();
          await (await oldResponse).finished();
        }
        await page.getByRole('cell', { name: '已更新的个人地址' }).waitFor();
        assert.equal(await scope.inputValue(), 'personal');
        assert.equal(await name.inputValue(), '下次登记的个人地址');
        assert.equal(await protocol.inputValue(), 'https');
        assert.equal(await country.inputValue(), 'MY');
        assert.equal(await link.inputValue(), 'https://personal.example.test:8081');
        assert.equal(writes, 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(access.external, []);
      } finally {
        respond.resolve();
        respondToOldRead.resolve();
      }
    });
  }
});

test('注册工作台隐藏邮箱使用主表字段及单条登记请求', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, access, errors } = await prepare(browser, 'registrar');
  t.after(() => context.close());
  const sent = [];
  await context.route('**/api/local/apple-relay/alias-register', route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { registered: 1 } });
  });
  await page.goto(origin + '/#/staff/registration');
  const form = page.locator('[data-staff-form="alias"]');
  await form.getByLabel('所属主邮箱').selectOption('apple1');
  const address = form.getByLabel(/^隐藏邮箱地址/);
  const note = form.getByLabel('备注', { exact: true });
  assert.equal(await address.getAttribute('maxlength'), '254');
  assert.equal(await note.getAttribute('maxlength'), '500');
  await address.fill('alias-fixture@example.test');
  await note.fill('合成备注'.repeat(35));
  const response = page.waitForResponse('**/api/local/apple-relay/alias-register');
  await form.getByRole('button', { name: '登记隐藏邮箱' }).click();
  assert.equal((await response).status(), 200);
  assert.deepEqual(sent, [{ parentId: 'apple1', parentVersion: 1, days: 30, batch: false,
    rows: [{ email: 'alias-fixture@example.test', note: '合成备注'.repeat(35) }] }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('finance reconciliation loads on demand and keeps dates, rows and page together across slow or failed reads', { timeout: 35_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'finance');
  t.after(() => context.close());
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [], assets = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/finance-reconciliation.mjs')) assets.push(request.url());
  });
  const oldRequested = Promise.withResolvers(), releaseOld = Promise.withResolvers(), oldCompleted = Promise.withResolvers();
  const row = reference => ({ items: [{ reference, time: '2026-11-13T05:00:00Z' }], hasMore: true });
  const showReference = async reference => {
    const value = page.getByText(reference, { exact: true });
    await value.waitFor({ state: 'attached' });
    const details = value.locator('xpath=ancestor::tr').getByRole('button', { name: '更多资料', exact: true });
    if (await details.isVisible()) await details.click();
    await value.waitFor();
  };
  await context.route(url => url.pathname === '/api/local/staff/finance/reconciliation', async route => {
    assert.equal(route.request().method(), 'GET');
    const params = new URL(route.request().url()).searchParams;
    const from = params.get('from'), to = params.get('to'), pageNumber = Number(params.get('page'));
    requests.push([from, to, pageNumber]);
    if (from === '2026-11-01') {
      oldRequested.resolve();
      await releaseOld.promise;
      await route.fulfill({ json: row('第一组账单') });
      oldCompleted.resolve();
      return;
    }
    if (from === '2026-11-03') return route.fulfill({ status: 503, json: { error: '暂时无法读取' } });
    return route.fulfill({ json: row(from ? '第二组账单' + pageNumber : '未筛选账单') });
  });

  await page.goto(origin + '/#/overview');
  await page.getByRole('heading', { name: '网站总览', exact: true }).waitFor();
  assert.equal(assets.length, 0);
  assert.equal(requests.length, 0);
  await page.evaluate(() => window.IDDesignAPI.go('staff/finance/reconciliation'));
  await showReference('未筛选账单');
  assert.equal(assets.length, 1);
  const dateRange = page.getByRole('combobox', { name: '账单日期范围', exact: true });
  const dateDrawer = page.locator('#date-filter-drawer');
  const fromInput = dateDrawer.getByLabel('开始日期'), toInput = dateDrawer.getByLabel('结束日期');
  const submit = page.getByRole('button', { name: '查询账单' });
  const queryDates = async (from, to) => {
    await dateRange.selectOption('choose-custom');
    await fromInput.fill(from);
    await toInput.fill(to);
    await dateDrawer.getByRole('button', { name: '应用日期', exact: true }).click();
    await submit.click();
  };
  await queryDates('2026-11-01', '2026-11-06');
  await oldRequested.promise;
  await queryDates('2026-11-02', '2026-11-08');
  await showReference('第二组账单1');
  releaseOld.resolve();
  await oldCompleted.promise;
  await settle(page);
  assert.equal(await page.getByText('第一组账单', { exact: true }).count(), 0);

  await queryDates('2026-11-03', '2026-11-08');
  await page.getByText('暂时无法读取。这里显示的是上次取得的账单。', { exact: true }).waitFor();
  assert(await page.getByText('账单日期 2026-11-02 至 2026-11-08', { exact: true }).isVisible());
  assert(await page.getByText('第二组账单1', { exact: true }).isVisible());
  await page.getByRole('button', { name: '下一页' }).click();
  await showReference('第二组账单2');
  assert.deepEqual(requests.at(-1), ['2026-11-02', '2026-11-08', 2]);
  await dateRange.selectOption('choose-custom');
  assert.equal(await fromInput.inputValue(), '2026-11-03');
  assert.equal(await toInput.inputValue(), '2026-11-08');
  await dateDrawer.getByRole('button', { name: '取消', exact: true }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual((await separatorSnapshot(page)).findings, []);
  await page.evaluate(() => window.IDDesignAPI.go('overview'));
  await page.getByRole('heading', { name: '网站总览', exact: true }).waitFor();
  await page.evaluate(() => window.IDDesignAPI.go('staff/finance/reconciliation'));
  await showReference('第二组账单2');
  assert.equal(assets.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('finance verifies a card change and staff pages fit narrow screens with readable controls', { timeout: 40_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { context, page, errors } = await prepare(browser, 'finance');
  t.after(() => context.close());
  let verified = false, writes = 0, pending = false;
  await context.route('**/api/local/auth/security**', route => {
    if (route.request().url().endsWith('/confirm-password')) {
      assert.deepEqual(route.request().postDataJSON(), { password: 'fixture-action-only' });
      verified = true;
      return route.fulfill({ json: { confirmed: true } });
    }
    return route.fulfill({ json: { available: true, bound: true, passwordConfirmed: verified, deviceLock: false, devices: [] } });
  });
  await context.route('**/api/local/staff/finance/cards', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...cards, pending: pending ?
      [{ id: 'pending-fixture', label: '设置套餐', at: '2026-11-13T12:00:00Z', submittedBy: '测试账号', canReview: true }] : [] } });
    const command = route.request().postDataJSON();
    if (command.action === 'reconcile') {
      assert(!verified);
      assert.deepEqual(command, { version: 7, action: 'reconcile', id: 'pending-fixture', confirmed: true });
      pending = false;
      return route.fulfill({ json: { saved: true, reconciled: true } });
    }
    assert(verified);
    assert.deepEqual(command, { version: 7, action: 'plans', cardIds: [11], plans: ['plus', 'pro200'] });
    writes++;
    pending = true;
    return route.fulfill({ status: 503, json: { error: '银行卡维护结果待核对' } });
  });
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByText(financeCardNumber, { exact: true }).waitFor();
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), width + ' ' + theme);
    assert.deepEqual((await separatorSnapshot(page)).findings, []);
  }
  await page.getByRole('button', { name: '设置套餐', exact: true }).click();
  await page.locator('#drawer').getByText('银行卡号 ' + financeCardNumber, { exact: true }).waitFor();
  await page.locator('#staff-edit-plan-pro200').check();
  await page.getByRole('button', { name: '保存套餐' }).click();
  const important = page.getByRole('dialog', { name: '确认重要操作' });
  await important.getByLabel('当前登录密码').fill('fixture-action-only');
  await important.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('heading', { name: '待核对的银行卡维护' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.locator('#drawer').getByRole('button', { name: '关闭抽屉' }).click();
  verified = false;
  await page.getByRole('button', { name: '核对上次操作' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('已核对银行卡维护结果', { exact: true }).waitFor();
  assert.equal(await important.count(), 0);
  assert.equal(await page.getByRole('heading', { name: '待核对的银行卡维护' }).count(), 0);
  assert.equal(writes, 1);
  assert.deepEqual(errors, []);
});

test('finance lists keep filters, status and pagination readable across widths and empty results', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const number = index => '100000000000' + (6000 + index);
  const items = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, last4: String(6000 + i),
    cardNumber: number(i), uses: i,
    active: i % 4 !== 3, state: ['可用', '暂缓使用', '不可用', '已停用'][i % 4],
    plans: i % 2 ? [] : ['plus', 'pro100', 'pro200', 'pro500'], lastUsedAt: '2026-11-14T02:15:00Z' }));
  const { context, page, access, errors } = await prepare(browser, 'finance', {
    ...localFixtures, 'staff/finance/cards': { ...cards, items }
  });
  t.after(() => context.close());
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByText(number(0), { exact: true }).waitFor();
  assert.equal(await page.locator('[data-staff-content] textarea').count(), 0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText(number(20), { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText(number(44), { exact: true }).waitFor();
  assert.equal(await page.locator('[data-table="银行卡和套餐"] tbody tr').count(), 5);
  assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
  await page.getByLabel('银行卡状态', { exact: true }).selectOption('不可用');
  await page.getByLabel('允许套餐', { exact: true }).selectOption('plus');
  assert.equal(await page.locator('[data-table="银行卡和套餐"] tbody tr').count(), 11);
  await page.getByRole('searchbox').fill(number(2));
  await page.getByRole('searchbox').press('Enter');
  await page.getByText(number(2), { exact: true }).waitFor();
  assert.equal(await page.locator('[data-table="银行卡和套餐"] tbody tr').count(), 1);
  await page.getByRole('searchbox').fill('9999');
  await page.getByRole('searchbox').press('Enter');
  await page.getByRole('heading', { name: '没有符合条件的银行卡' }).waitFor();
  await page.getByRole('searchbox').fill('');
  await page.getByLabel('银行卡状态', { exact: true }).selectOption('');
  await page.getByLabel('允许套餐', { exact: true }).selectOption('');
  await page.getByLabel('每页条数').selectOption('10');
  assert.equal(await page.locator('[data-table="银行卡和套餐"] tbody tr').count(), 10);
  for (const route of ['staff/finance/cards', 'staff/finance/reconciliation']) {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator('.finance-workspace tbody tr').first().waitFor();
    for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await settle(page);
      const geometry = await page.locator('.finance-toolbar').evaluate(node => {
        const boxes = [...node.querySelectorAll('input,select,button,a.button')]
          .filter(control => control.getClientRects().length).map(control => control.getBoundingClientRect());
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
          outside: boxes.some(b => b.left < 0 || b.right > innerWidth + 1),
          overlap: boxes.some((a, i) => boxes.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
            Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1)),
          bottoms: boxes.map(b => b.bottom) };
      });
      assert.equal(geometry.overflow || geometry.outside || geometry.overlap, false, `${route} ${width} ${theme}`);
      if (width === 1440) assert(Math.max(...geometry.bottoms) - Math.min(...geometry.bottoms) <= 2, 'desktop controls share one row');
      assert.deepEqual((await separatorSnapshot(page)).findings, [], `${route} ${width} ${theme}`);
    }
    const help = page.getByLabel('查看' + (route.endsWith('cards') ? '银行卡设置' : '代充对账') + '说明', { exact: true });
    const before = await page.locator('.finance-toolbar').boundingBox();
    assert.equal(await help.evaluate(node => node.parentElement.open), false);
    await help.click();
    assert.equal(await help.evaluate(node => node.parentElement.open), true);
    assert.deepEqual(await page.locator('.finance-toolbar').boundingBox(), before);
    await page.keyboard.press('Escape');
    assert.equal(await help.evaluate(node => node.parentElement.open), false);
  }
  assert(await page.getByText('20 USD', { exact: false }).isVisible());
  assert(await page.locator('[data-table="代充对账记录"]').getByText('扣款成功', { exact: true }).isVisible());
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('财务停卡确认遇到卡池更新须重新确认', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'finance');
  t.after(() => context.close());
  const writes = [];
  let snapshot = structuredClone(cards);
  await context.route('**/api/local/auth/security**', route =>
    route.fulfill({ json: { available: true, bound: true, passwordConfirmed: true } }));
  await context.route('**/api/local/staff/finance/cards', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    const command = route.request().postDataJSON();
    writes.push(command);
    assert.equal(command.version, snapshot.version);
    snapshot = { ...snapshot, version: snapshot.version + 1, items: [{ ...snapshot.items[0], active: false }] };
    return route.fulfill({ json: { saved: true } });
  });
  await page.goto(origin + '/#/staff/finance/cards');
  const stop = page.getByRole('button', { name: '停用', exact: true });
  const confirm = page.locator('dialog[open]').getByRole('button', { name: '确认', exact: true });
  await stop.click();
  await page.getByRole('heading', { name: '停用银行卡', exact: true }).waitFor();
  snapshot = { ...snapshot, version: 8, items: [{ ...snapshot.items[0], plans: ['pro100'] }] };
  await page.evaluate(() => window.IDDesignModules.find(item => item.id === 'staff-finance-cards').onDataChanges(['recharge-card-plans']));
  await confirm.click();
  await page.getByText('银行卡资料已更新，请核对当前资料后重新确认停用。', { exact: true }).waitFor();
  assert.deepEqual(writes, []);
  await stop.click();
  await confirm.click();
  await stop.waitFor({ state: 'hidden' });
  assert.deepEqual(writes, [{ action: 'stop', id: 11, version: 8 }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('财务设置套餐在其他人更新后保留选择，读取最新版本并确认前不覆盖', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'finance');
  t.after(() => context.close());
  const writes = [];
  let snapshot = structuredClone(cards);
  await context.route('**/api/local/auth/security**', route =>
    route.fulfill({ json: { available: true, bound: true, passwordConfirmed: true } }));
  await context.route('**/api/local/staff/finance/cards', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    const command = route.request().postDataJSON();
    writes.push(command);
    if (command.version !== snapshot.version)
      return route.fulfill({ status: 409, json: { error: '资料已更新，请刷新后重新核对，输入已保留' } });
    snapshot = { ...snapshot, version: snapshot.version + 1, items: [{ ...snapshot.items[0], plans: command.plans }] };
    return route.fulfill({ json: { saved: true } });
  });
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByRole('button', { name: '设置套餐', exact: true }).click();
  const drawer = page.locator('#drawer');
  const save = drawer.getByRole('button', { name: '保存套餐' });
  const latest = drawer.getByRole('button', { name: '读取最新套餐' });
  await drawer.getByLabel('Pro 200').check();
  snapshot = { ...snapshot, version: 8, items: [{ ...snapshot.items[0], plans: ['pro100'] }] };
  await page.evaluate(() => window.IDDesignModules.find(item => item.id === 'staff-finance-cards').onDataChanges(['recharge-card-plans']));
  await save.click();
  assert.equal(writes.length, 0);
  await drawer.getByText(/套餐设置已更新，已保留你的选择/).waitFor();
  assert(await drawer.getByLabel('Plus', { exact: true }).isChecked());
  assert(await drawer.getByLabel('Pro 200').isChecked());
  await latest.click();
  await drawer.getByText('当前已设置套餐：Pro 100', { exact: true }).waitFor();
  assert(await drawer.getByLabel('Pro 200').isChecked());
  assert.equal(writes.length, 0);
  await save.click();
  await drawer.waitFor({ state: 'hidden' });
  assert.deepEqual(writes, [{ action: 'plans', cardIds: [11], plans: ['plus', 'pro200'], version: 8 }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('card drawers preserve plan choices, clear private input and submit imports once and preserve write contracts', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'finance');
  t.after(() => context.close());
  const writes = [];
  let strict = false, failFirstRead = true;
  await context.route('**/api/local/auth/security**', route => route.fulfill({ json: {
    available: true, bound: true, passwordConfirmed: true, deviceLock: false, devices: []
  } }));
  await context.route('**/api/local/staff/finance/cards', route => {
    if (route.request().method() === 'GET') {
      if (failFirstRead) {
        failFirstRead = false;
        return route.fulfill({ status: 503, json: { error: '银行卡暂时无法读取' } });
      }
      return route.fulfill({ json: { ...cards, strict } });
    }
    const body = route.request().postDataJSON();
    writes.push(body);
    assert(route.request().headers()['x-id-operation']);
    if (body.action === 'strict') strict = body.strict;
    return route.fulfill({ json: body.action === 'import' ? { count: 1 } : { saved: true } });
  });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByRole('heading', { name: '资料未能读取', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '导入银行卡', exact: true }).isDisabled());
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '刷新', exact: true }).click();
  await page.getByText(financeCardNumber, { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  const openImport = () => page.getByRole('button', { name: '导入银行卡', exact: true }).click();
  const drawer = page.locator('#drawer');
  await openImport();
  await page.getByLabel('银行卡资料', { exact: false }).fill('isolated-fixture-only');
  await page.getByRole('button', { name: '保存导入' }).click();
  await drawer.getByText('请至少选择一个套餐。', { exact: true }).waitFor();
  assert.equal(writes.length, 0);
  await drawer.getByLabel('Plus', { exact: true }).check();
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: '保存导入' }).click();
  await drawer.getByText('存在格式错误。整批未提交，输入已保留。', { exact: true }).waitFor();
  assert.equal(writes.length, 0);
  assert.equal(await page.getByLabel('银行卡资料', { exact: false }).inputValue(), 'isolated-fixture-only');
  await page.getByRole('button', { name: '关闭抽屉' }).click();
  assert.equal(await page.locator('#staff-lines').inputValue(), '');
  await page.setViewportSize({ width: 320, height: 850 });
  await openImport();
  assert(await drawer.getByLabel('Plus', { exact: true }).isChecked());
  assert.equal(await page.getByLabel('银行卡资料', { exact: false }).inputValue(), '');
  const valid = '0000000000010044 01/29 000';
  await page.getByLabel('银行卡资料', { exact: false }).fill(valid + '\n\n' + financeCardNumber + ' 01/29 000');
  await drawer.locator('[data-card-import-preview]').getByText('待导入 1 行（第 1 行） · 已知重复 1 行（第 3 行） · 格式有误 0 行。格式有误时整批不提交。').waitFor();
  assert.deepEqual((await separatorSnapshot(page)).findings, []);
  await page.getByRole('button', { name: '保存导入' }).click();
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  await page.getByText('已导入 1 张银行卡', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].lines === valid + '\n\n' + financeCardNumber + ' 01/29 000', true);
  assert.deepEqual({ action: writes[0].action, plans: writes[0].plans, version: writes[0].version },
    { action: 'import', plans: ['plus'], version: 7 });
  assert.equal(await drawer.evaluate(node => node.open), false);
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '取卡设置' }).click();
  await drawer.getByRole('heading', { name: '取卡设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '仅使用已配置套餐的卡', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('取卡规则：仅使用已配置套餐的卡', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { action: 'strict', strict: true, version: 7 });
  assert.equal(await drawer.evaluate(node => node.open), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('财务导入保留卡池退回的行，并用本次已确认版本重新导入', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, errors, access } = await prepare(browser, 'finance');
  t.after(() => context.close());
  const versions = [];
  let version = cards.version;
  await context.route('**/api/local/auth/security**', route =>
    route.fulfill({ json: { available: true, bound: true, passwordConfirmed: true } }));
  await context.route('**/api/local/staff/finance/cards', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...cards, version } });
    const command = route.request().postDataJSON();
    versions.push(command.version);
    version++;
    return route.fulfill({ json: { saved: true, count: 1, skipped: 0, failedLines: versions.length === 1 ? [3] : [], version } });
  });
  await page.goto(origin + '/#/staff/finance/cards');
  await page.getByRole('button', { name: '导入银行卡', exact: true }).click();
  const drawer = page.locator('#drawer');
  const lines = drawer.locator('#staff-lines');
  const first = '0000000000010044 01/29 000';
  const second = '0000000000010045 01/29 000';
  await lines.fill(first + '\n\n' + second);
  await drawer.getByLabel('Plus', { exact: true }).check();
  const save = drawer.getByRole('button', { name: '保存导入' });
  await save.click();
  await drawer.getByRole('alert').getByText(/失败 1 张（第 3 行/).waitFor();
  assert.equal((await lines.inputValue()) === second, true);
  await save.click();
  await drawer.waitFor({ state: 'hidden' });
  assert.deepEqual(versions, [7, 8]);
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('sign-in waits for a human check and then requests the authenticator code', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 850 } });
  await interceptDesign(context, { localAuthUi: true, skipRechargeAssets: true });
  let passwordChecks = 0, factorChecks = 0;
  await context.route(url => url.origin === origin && url.pathname === '/', async route => {
    const source = await readFile(root + '/frontend/index.html', 'utf8');
    const body = turnstileLoginPage(source, 'fixture-site').replace('<head>', '<head><meta name="id-local-auth" content="required">' +
      '<link rel="stylesheet" href="/local-auth.css">')
      .replace('    <script src="./prototype.js', '    <script src="/local-auth.js" defer></script>\n    <script src="./prototype.js')
      .replace(/^ *<script (?:type="module" )?src="\.\/[^"\n]+"(?: defer)?><\/script>\n/gm, '');
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
  assert(await page.locator('.local-auth-form button[type="submit"]').isDisabled());
  await page.getByRole('button', { name: '完成真人验证' }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('六位动态验证码或恢复码').fill('123456');
  assert.equal(passwordChecks, 1);
  assert(await page.getByLabel('密码', { exact: true }).isHidden());
  await page.getByRole('button', { name: '验证并登录' }).click();
  await page.getByText('已提交设备申请。', { exact: false }).waitFor();
  assert.equal(factorChecks, 1);
  assert.deepEqual(browserErrors, []);
});

test('员工分组随角色切换，只能选择启用的主管，重新打开时按角色恢复', async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const employees = [
    { ...actor('supervisor'), active: true, version: 1 },
    { ...actor('supervisor'), id: 'inactive-lead', name: '已停用主管', active: false, version: 1 },
    { ...actor('finance'), active: true, version: 1 },
    { ...actor('employee'), active: true, teamLeadId: actor('supervisor').id, version: 1 }
  ];
  const { page } = await prepare(browser, 'super', { ...localFixtures, 'auth/employees': { employees } });
  await page.goto(origin + '/#/settings/accounts');
  const edit = role => page.locator(`[data-action="ops-local-staff-edit"][data-id="${actor(role).id}"]`).click();
  const close = () => page.getByRole('button', { name: '关闭抽屉' }).click();
  const role = page.locator('#local-staff-role'), lead = page.locator('#local-staff-team-lead');
  await edit('finance');
  assert(!await lead.isVisible() && await lead.isDisabled());
  await close();
  await edit('employee');
  assert.equal(await lead.inputValue(), actor('supervisor').id);
  assert.deepEqual(await lead.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', actor('supervisor').id]);
  await close();
  await page.getByRole('button', { name: '新增员工', exact: true }).click();
  await lead.selectOption(actor('supervisor').id);
  for (const value of ['admin', 'finance', 'registrar', 'supervisor']) {
    await role.selectOption(value);
    assert(!await lead.isVisible() && await lead.isDisabled(), value);
  }
  await close();
  await page.getByRole('button', { name: '新增员工', exact: true }).click();
  assert.equal(await role.inputValue(), 'supervisor');
  assert(!await lead.isVisible() && await lead.isDisabled());
  await role.selectOption('employee');
  assert(await lead.isVisible() && await lead.isEnabled());
});
