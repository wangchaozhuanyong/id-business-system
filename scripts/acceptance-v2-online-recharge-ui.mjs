/* global document, window, getComputedStyle */
// 完全合成夹具；禁止连接真实服务、账号、供应商或支付页面。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = resolve(root, '.runtime/online-recharge/ui');
mkdirSync(evidence, { recursive: true });
const origin = 'http://127.0.0.1:5409';
const server = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5409',
    '--strictPort'
  ],
  { cwd: resolve(root, 'apps/admin'), stdio: 'ignore' }
);
const sections = process.argv.includes('--affected')
  ? ['config', 'addresses', 'cdks']
  : [
      'overview',
      'jobs',
      'automation',
      'runtime-logs',
      'billing',
      'cards',
      'proxies',
      'addresses',
      'browser-pool',
      'cdks',
      'sessions',
      'renewal',
      'checkout-debug',
      'config',
      'login-logs'
    ];
const widths = process.argv.includes('--lifecycle')
  ? []
  : process.argv.includes('--quick')
    ? [1440]
    : [1440, 1024, 901, 900, 768, 390];
const date = '2026-10-09T04:00:00.000Z';
const taskId = '11111111-1111-4111-8111-111111111111';
const administrator = {
  id: 'online-fixture-admin',
  username: 'fixture-admin',
  displayName: '合成管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const employee = {
  ...administrator,
  id: 'online-fixture-employee',
  username: 'fixture-employee',
  displayName: '合成员工',
  roles: ['employee']
};
const reader = {
  ...employee,
  id: 'online-fixture-reader',
  permissions: ['id_business_v2.online_recharge.read']
};
const settings = {
  version: 0,
  maxConcurrent: 1,
  maintenance: false,
  paymentRegion: 'PH',
  browserMode: 'standalone',
  cardMaxSubscriptionCount: 2,
  cardMaxDeclineCount: 3,
  gptApiEnabled: false,
  telegramEnabled: false,
  telegramAdminEnabled: false,
  telegramGroupEnabled: false,
  hcaptchaEnabled: true,
  hcaptchaDisableVlm: false,
  captchaPlatformBaseUrl: 'https://captcha.example.invalid',
  captchaPlatformTimeoutMs: 180000,
  vlmBaseUrl: 'https://vlm.example.invalid',
  vlmModel: 'fixture-model',
  vlmTimeoutMs: 45000,
  hcaptchaSolverTimeoutMs: 240000,
  cdpPort: 9222,
  planNamePlus: 'chatgptplusplan',
  planNamePro5x: 'chatgptprolite',
  planNamePro20x: 'chatgptpro',
  secretStatus: { gptApiKey: true, telegramBotToken: true }
};
const common = { id: taskId, createdAt: date, updatedAt: date, status: 'active' };
const task = {
  ...common,
  status: 'succeeded',
  plan: 'plus',
  provider: 'local',
  progress: 100,
  stage: 'completed',
  message: '合成任务已完成',
  email: 'f***@example.test',
  cardLast4: '1111',
  hasSession: true,
  result: {
    ok: true,
    data: {
      plan: 'Plus',
      hasActiveSubscription: true,
      expiresAt: '2026-11-09T04:00:00Z',
      autoRenew: '否',
      remainingDaysDisplay: '31天',
      billingPageUrl: 'https://chatgpt.com/account/manage'
    }
  }
};
const rows = {
  cards: [
    {
      ...common,
      last4: '1111',
      expiryMonth: 12,
      expiryYear: 2029,
      holderName: '合成持卡人',
      successCount: 1,
      declineCount: 0,
      addressId: taskId,
      hasCvc: false
    }
  ],
  proxies: [
    {
      ...common,
      displayHost: 'proxy.example.test:8080',
      protocol: 'http',
      exitIp: '192.0.2.1',
      latencyMs: 42,
      testMessage: '合成检测通过',
      testedAt: date
    }
  ],
  addresses: [
    {
      ...common,
      firstName: '合成',
      lastName: '客户',
      country: 'US',
      street: '合成街道：用于较长地址与窄屏测量，禁止用于真实付款',
      city: 'Portland',
      state: 'OR',
      postalCode: '97201',
      successCount: 0
    }
  ],
  cdks: [{ ...common, code: '····TEST', plan: 'plus', status: 'available', dispatched: false }],
  jobs: [task],
  automation: [task],
  sessions: [{ ...task, sessionMasked: '合成会话已保存' }],
  renewal: [{ ...task, subscriptionStatus: 'active', autoRenew: false, expiresAt: date }],
  billing: [
    {
      ...common,
      status: 'success',
      taskId,
      cardLast4: '1111',
      email: 'f***@example.test',
      plan: 'plus',
      amount: '20.00',
      currency: 'USD'
    }
  ],
  'browser-pool': [{ ...common, status: 'idle', mode: 'standalone', taskId: null }],
  'runtime-logs': [
    {
      ...common,
      taskId,
      level: 'info',
      stage: 'completed',
      message: '合成运行消息：用于验证日志长文案换行，不含任何账号凭据'
    }
  ],
  'login-logs': [
    {
      ...common,
      userName: '合成管理员',
      event: '权限检查成功',
      ipMasked: '192.0.2.*',
      status: 'success'
    }
  ]
};
const report = {
  scope: 'OFFLINE_SYNTHETIC_ONLY',
  realPayment: 'NOT_MEASURED',
  realSession: 'NOT_USED',
  externalRequests: 'BLOCKED',
  cases: [],
  lifecycle: []
};
let browser, lastPage;
const wait = async (check) => {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('本地预览未就绪');
};
const navigate = async (page, path) => {
  await page.evaluate((target) => {
    void document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target);
  }, path);
  await page.waitForURL(origin + path);
  await page.locator('.online-page,.online-public').first().waitFor();
  await page
    .locator('.v2-async-region[data-v2-query-phase="ready"]')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => undefined);
};
async function measure(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      };
    };
    const panels = [
      ...document.querySelectorAll(
        '.online-panel,.v2-page-context,.v2-records-list,.v2-page-overview'
      )
    ].map(rect);
    const text = [];
    for (const element of document.querySelectorAll(
      '.v2-overview-metric__label,.v2-overview-metric__value,.online-status-grid dt,.online-status-grid dd,.el-form-item__label'
    )) {
      if (!element.getClientRects().length) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = range.getBoundingClientRect();
      text.push({
        content: element.textContent.slice(0, 45),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        lineHeight: getComputedStyle(element).lineHeight,
        fontSize: getComputedStyle(element).fontSize
      });
    }
    const overlaps = [];
    for (const pair of document.querySelectorAll('.v2-overview-metric')) {
      const label = pair.querySelector('.v2-overview-metric__label');
      const value = pair.querySelector('.v2-overview-metric__value');
      const a = rect(label),
        b = rect(value);
      if (Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 2)
        overlaps.push('指标文字中心不对齐');
    }
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panels,
      text,
      overlaps
    };
  });
}
async function fixture(context, state) {
  const unexpected = [];
  const publicHeaders = [];
  const writes = [];
  const rechecks = [];
  const configTargets = [];
  await context.routeWebSocket('**/*', (ws) => ws.close());
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const ok = (data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data })
      });
    if (url.origin === origin && !path.startsWith('/api/')) return route.continue();
    if (url.origin !== origin) {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (path === '/api/auth/me') return ok(state.actor);
    if (path === '/api/auth/login')
      return ok({ accessToken: 'synthetic-access', user: state.actor });
    if (path === '/api/auth/logout') return ok({});
    if (path.endsWith('/change-events')) return route.abort();
    if (path.endsWith('/change-versions')) return ok({ generatedAt: date, versions: {} });
    if (path === '/api/id-business-v2/dashboard/overview')
      return ok({
        generatedAt: date,
        businessDate: '2026-10-09',
        timezone: 'Asia/Shanghai',
        warningDays: 7,
        access: Object.fromEntries(
          [
            'orders',
            'activations',
            'renewals',
            'accounts',
            'balances',
            'exchangeRates',
            'finance',
            'audit'
          ].map((key) => [key, false])
        ),
        business: {
          todayOrders: null,
          todayCompletedOrders: null,
          todayActivations: null,
          todayTopups: null,
          todayTopupCostCny: null,
          todayRevenueCny: null,
          todayProfitCny: null
        },
        risks: {
          pendingOrders: null,
          failedOrders: null,
          overdueRenewals: null,
          dueSoonRenewals: null,
          lowBalanceAccounts: null,
          failedExchangeRuns: null
        },
        assets: {
          totalAccounts: null,
          availableAccounts: null,
          inventoryBookValueCny: null,
          financeHistoryStatus: null
        },
        recentOrders: [],
        upcomingRenewals: [],
        recentAudits: []
      });
    if (!path.includes('/online-recharge/')) return ok({ items: [], preferences: [], total: 0 });
    const base = '/api/id-business-v2/online-recharge/';
    const endpoint = path.slice(base.length);
    if (endpoint.startsWith('public/')) {
      publicHeaders.push(req.headers().authorization ?? null);
      const method = endpoint.split('/')[1];
      if (method === 'config')
        return ok({ maintenance: false, maxConcurrent: 1, active: 0, paymentRegion: 'PH' });
      if (method === 'verify') return ok({ valid: true, plan: 'plus', status: 'available' });
      if (method === 'redeem' || method === 'subscription')
        return ok({ ...task, status: 'queued', progress: 0, taskToken: 'synthetic-capability' });
      if (method === 'query') return ok({ task, taskToken: 'synthetic-capability' });
      if (method === 'task') return ok(task);
      if (method === 'subscribe')
        return ok({ ticket: 'synthetic-ticket', wsPath: '/api/id-business-v2/online-recharge/ws' });
      throw new Error('未登记公开接口 ' + method);
    }
    const [kind, section, action] = endpoint.split('/');
    if (kind !== 'admin') throw new Error('禁止访问执行器接口');
    if (section === 'overview')
      return ok({
        tasks: [
          { status: 'succeeded', _count: 3 },
          { status: 'awaiting_review', _count: 1 }
        ],
        cards: [{ status: 'active', _count: 2 }],
        codes: [{ status: 'available', _count: 10 }],
        billing: [{ currency: 'USD', amount: '60.00', count: 3 }],
        config: settings,
        runtime: {
          cpuCores: 4,
          totalMemory: 8 * 1024 ** 3,
          freeMemory: 4 * 1024 ** 3,
          diskTotal: 100 * 1024 ** 3,
          diskFree: 40 * 1024 ** 3,
          uptime: 3600
        }
      });
    if (section === 'config' && req.method() === 'GET') return ok(settings);
    if (section === 'config' && req.method() === 'PATCH') {
      writes.push('config');
      if (state.saveDelay) await new Promise((done) => setTimeout(done, state.saveDelayMs ?? 500));
      state.configCompleted = Number(state.configCompleted ?? 0) + 1;
      if (state.saveFail)
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '合成保存失败，输入已保留' })
        });
      return ok({ ...settings, version: 1 });
    }
    if (!action) {
      if (state.refreshFail && section === 'jobs')
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '合成刷新失败' })
        });
      const pageNumber = Number(url.searchParams.get('page') ?? 1);
      const empty = state.empty;
      return ok({
        items: empty
          ? []
          : (rows[section] ?? []).map((row) => ({
              ...row,
              ...(section === 'jobs' && state.awaitingReview
                ? { status: 'awaiting_review', progress: 95, message: '合成原单待核对' }
                : {}),
              ...(pageNumber > 1 ? { id: '22222222-2222-4222-8222-222222222222' } : {})
            })),
        total: empty ? 0 : 41,
        page: pageNumber,
        pageSize: 20
      });
    }
    writes.push(`${section}/${action}`);
    if (section === 'jobs' && action === 'recheck') {
      rechecks.push(req.postDataJSON());
      return ok({
        ...task,
        id: '33333333-3333-4333-8333-333333333333',
        status: 'queued',
        progress: 0,
        message: '合成原单核对排队',
        result: undefined
      });
    }
    if (section === 'config' && action === 'test') {
      const body = req.postDataJSON();
      configTargets.push(body.target);
      state.configTarget = body.target;
      return ok({ ...task, status: 'queued', progress: 0, result: undefined });
    }
    if (action === 'subscribe')
      return ok({ ticket: 'synthetic-ticket', wsPath: '/api/id-business-v2/online-recharge/ws' });
    if (action === 'detail')
      return ok({
        ...task,
        result: state.configTarget
          ? {
              ok: true,
              ready: true,
              model: 'fixture-model',
              latency_ms: 35,
              http_status: 200,
              message: '合成检测已完成'
            }
          : task.result,
        events: [{ message: '合成事件' }]
      });
    if (action === 'start') return ok({ ...task, status: 'queued' });
    if (action === 'reveal') return ok({ number: '4111111111111111' });
    if (['import', 'update', 'create'].includes(action)) {
      if (state.saveDelay) await new Promise((done) => setTimeout(done, state.saveDelayMs ?? 500));
      if (state.saveFail)
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '合成保存失败，输入已保留' })
        });
      return ok({ success: true, inserted: 1 });
    }
    return ok({ success: true, message: '合成操作完成' });
  });
  return { unexpected, publicHeaders, writes, configTargets, rechecks };
}
try {
  await wait(async () => (await fetch(origin).catch(() => null))?.ok);
  browser = await chromium.launch({ headless: true });
  for (const width of widths) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1100 } });
      await context.addInitScript(
        ({ theme, user }) => {
          localStorage.setItem('apple_business_access_token', 'synthetic-access');
          localStorage.setItem('apple_business_current_user', JSON.stringify(user));
          localStorage.setItem('id-business-v2-theme', theme);
        },
        { theme, user: administrator }
      );
      const page = await context.newPage();
      lastPage = page;
      const state = {
        actor: administrator,
        empty: false,
        refreshFail: false,
        saveFail: false,
        saveDelay: false
      };
      const network = await fixture(context, state);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const section of sections) {
        await page.goto(`${origin}/v2/online-recharge/${section}`);
        await page.locator('.online-page').waitFor();
        await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
        if (process.argv.includes('--affected') && section === 'config') {
          await page.getByRole('button', { name: '检测视觉模型', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: '操作结果', exact: true });
          await dialog.getByRole('button', { name: '刷新结果', exact: true }).click();
          await dialog.getByText('合成检测已完成', { exact: true }).first().waitFor();
          assert.ok(await dialog.getByText(/耗时（毫秒）：35/).count(), '原检测耗时未显示');
          await dialog.getByRole('button', { name: '关闭', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
        }
        const measured = await measure(page);
        assert.ok(measured.documentWidth <= width + 1, `${theme} ${width} ${section}页面横向溢出`);
        assert.deepEqual(measured.overlaps, [], `${section}实际指标文字未对齐`);
        for (const panel of measured.panels)
          assert.ok(panel.right <= width + 2 && panel.left >= -1, `${section}模块外框超出页面`);
        if (width === 390 || section === 'overview')
          await page.screenshot({
            path: resolve(evidence, `${theme}-${width}-${section}.png`),
            fullPage: true
          });
        report.cases.push({ theme, width, section, measurements: measured, result: 'PASS' });
      }
      for (const path of ['/online-recharge', '/online-recharge/subscription']) {
        await page.goto(origin + path);
        await page.locator('.online-public').waitFor();
        if (process.argv.includes('--affected')) {
          if (path.endsWith('/subscription')) {
            await page
              .locator('textarea')
              .fill(JSON.stringify({ accessToken: 'synthetic-private-session' }));
            await page.getByRole('button', { name: '查询订阅', exact: true }).click();
            await page.getByRole('button', { name: '刷新结果', exact: true }).click();
          } else {
            await page.getByPlaceholder('输入兑换码').fill('SYNTHETIC-CODE');
            await page.getByRole('button', { name: '查询兑换结果', exact: true }).click();
          }
          await page.getByText('31天', { exact: true }).waitFor();
          assert.equal(
            await page
              .getByRole('link', { name: '打开账单管理', exact: true })
              .getAttribute('href'),
            'https://chatgpt.com/account/manage'
          );
        }
        const measured = await measure(page);
        assert.ok(measured.documentWidth <= width + 1, `${path}页面横向溢出`);
        const label = await page.locator('.el-form-item__label').first().boundingBox(),
          control = await page
            .locator('.el-form-item .el-input,.el-form-item .el-textarea')
            .first()
            .boundingBox();
        assert.ok(label.x + label.width <= control.x + 2, '公开表单标签必须位于左侧');
        report.cases.push({ theme, width, path, measurements: measured, result: 'PASS' });
      }
      assert.ok(
        network.publicHeaders.every((value) => value === null),
        '客户接口附带后台身份'
      );
      assert.deepEqual(network.unexpected, [], '出现未拦截外部请求');
      assert.deepEqual(errors, [], '页面运行异常');
      await context.close();
    }
  }
  // 生命周期采用同一个标签页内的真实路由切换，整页加载不代替草稿恢复验收。
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript((user) => {
    localStorage.setItem('apple_business_access_token', 'synthetic-access');
    localStorage.setItem('apple_business_current_user', JSON.stringify(user));
  }, administrator);
  const page = await context.newPage();
  lastPage = page;
  const state = {
    actor: administrator,
    empty: false,
    refreshFail: false,
    saveFail: false,
    saveDelay: false
  };
  const network = await fixture(context, state);
  await page.goto(origin + '/v2/online-recharge/addresses');
  await page.locator('.online-page').waitFor();
  await page.locator('.el-pagination').waitFor();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/admin/addresses?') &&
        new URL(response.url()).searchParams.get('page') === '2'
    ),
    page.locator('.el-pagination .btn-next').click()
  ]);
  await page.waitForFunction(
    () => document.querySelector('.el-pager .is-active')?.textContent === '2'
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/admin/addresses?') &&
        new URL(response.url()).searchParams.get('page') === '3'
    ),
    page.locator('.el-pager li').filter({ hasText: '3' }).first().click()
  ]);
  await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
  await page.waitForTimeout(150);
  const lastPageBox = await page.locator('.v2-records-list').boundingBox();
  state.empty = true;
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/admin/addresses?')),
    page.getByRole('button', { name: '刷新', exact: true }).click()
  ]);
  await page.getByText('暂无记录', { exact: true }).waitFor();
  await page.waitForTimeout(150);
  const emptyBox = await page.locator('.v2-records-list').boundingBox();
  assert.ok(
    Math.abs(lastPageBox.height - emptyBox.height) < 4,
    `空状态列表框架变化：${lastPageBox.height} → ${emptyBox.height}`
  );
  report.lifecycle.push({ case: 'first-last-empty-pagination', result: 'PASS' });
  state.empty = false;
  await navigate(page, '/v2/online-recharge/jobs');
  await page
    .getByText('合成任务已完成', { exact: true })
    .count()
    .catch(() => 0);
  state.refreshFail = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page
    .getByText(/更新失败/)
    .first()
    .waitFor({ timeout: 20000 });
  assert.ok(await page.getByText(taskId, { exact: true }).count(), '刷新失败丢失已有任务');
  report.lifecycle.push({ case: 'refresh-failure-keeps-content', result: 'PASS' });
  state.refreshFail = false;
  await navigate(page, '/v2/online-recharge/addresses');
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '新增地址', exact: true })
    .click();
  const drawer = page.locator('.v2-form-drawer');
  const street = drawer
    .locator('.el-form-item')
    .filter({ has: page.getByText('街道', { exact: true }) })
    .locator('input');
  await street.fill('合成关闭保留');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '新增地址', exact: true })
    .click();
  assert.equal(await street.inputValue(), '合成关闭保留');
  await navigate(page, '/v2/online-recharge/cards');
  await navigate(page, '/v2/online-recharge/addresses');
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '新增地址', exact: true })
    .click();
  assert.equal(await street.inputValue(), '合成关闭保留');
  for (const [label, value] of [
    ['城市', 'Portland'],
    ['州／省', 'OR'],
    ['邮编', '97201']
  ])
    await drawer
      .locator('.el-form-item')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('input')
      .fill(value);
  state.saveFail = true;
  await drawer.getByRole('button', { name: '新增地址', exact: true }).click();
  await drawer.getByText('合成保存失败，输入已保留').waitFor();
  assert.equal(await street.inputValue(), '合成关闭保留');
  state.saveFail = false;
  state.saveDelay = true;
  await drawer.getByRole('button', { name: '新增地址', exact: true }).click();
  await street.fill('合成迟到编辑');
  await drawer.waitFor({ state: 'hidden' });
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '新增地址', exact: true })
    .click();
  assert.equal(await street.inputValue(), '合成迟到编辑', '迟到保存清除了后续输入');
  report.lifecycle.push({ case: 'drawer-close-route-failure-late-save-retention', result: 'PASS' });
  state.saveDelay = false;
  await drawer.getByRole('button', { name: '新增地址', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '新增地址', exact: true })
    .click();
  assert.equal(await street.inputValue(), '', '保存成功未清理已提交草稿');
  report.lifecycle.push({ case: 'successful-save-clears-only-submitted-snapshot', result: 'PASS' });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(page, '/v2/online-recharge/cards');
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '导入银行卡', exact: true })
    .click();
  const raw = drawer.locator('textarea');
  await raw.fill('4111111111111111|12/29|123|SYNTHETIC');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '导入银行卡', exact: true })
    .click();
  assert.equal(await raw.inputValue(), '', '卡片安全码间接进入了关闭草稿');
  await raw.fill('4111111111111111|12/29|123|SYNTHETIC');
  await navigate(page, '/v2/online-recharge/addresses');
  await navigate(page, '/v2/online-recharge/cards');
  await page
    .locator('.v2-page-context')
    .getByRole('button', { name: '导入银行卡', exact: true })
    .click();
  assert.equal(await raw.inputValue(), '', '卡片安全码间接进入了切页草稿');
  report.lifecycle.push({ case: 'card-import-cvc-volatile', result: 'PASS' });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(page, '/v2/online-recharge/config');
  for (const label of [
    '检测求解器',
    '检测视觉模型',
    '检测打码平台',
    '检测供应商连接',
    '查询余额与套餐',
    '发送测试通知',
    '查看求解器日志'
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const resultDialog = page.getByRole('dialog', { name: '操作结果', exact: true });
    await resultDialog.getByText('等待执行', { exact: true }).first().waitFor();
    await resultDialog.getByRole('button', { name: '刷新结果', exact: true }).click();
    await resultDialog.getByText('成功', { exact: true }).first().waitFor();
    await resultDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await resultDialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(network.configTargets, [
    'solver',
    'vlm',
    'captcha_platform',
    'gpt_api',
    'gpt_status',
    'telegram',
    'solver_logs'
  ]);
  report.lifecycle.push({
    case: 'configuration-targets-queued-progress-completed',
    result: 'PASS'
  });
  const configInput = (label) =>
    page
      .locator('.el-form-item')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('input')
      .first();
  const concurrency = configInput('最大并发激活数');
  const providerSecret = configInput('供应商密钥');
  await concurrency.fill('7');
  await providerSecret.fill('synthetic-config-original');
  state.saveFail = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('合成保存失败，输入已保留', { exact: true }).waitFor();
  assert.equal(await concurrency.inputValue(), '7');
  assert.equal(await providerSecret.inputValue(), 'synthetic-config-original');
  state.saveFail = false;
  state.saveDelay = true;
  state.saveDelayMs = 800;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await concurrency.fill('8');
  await providerSecret.fill('synthetic-config-later');
  await page.getByText('配置已保存', { exact: true }).waitFor();
  assert.equal(await concurrency.inputValue(), '8', '配置迟到保存清除了后续输入');
  assert.equal(
    await providerSecret.inputValue(),
    'synthetic-config-later',
    '配置迟到保存清除了后续密钥'
  );
  report.lifecycle.push({ case: 'config-failed-save-and-late-edits-retained', result: 'PASS' });
  state.saveDelay = false;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.waitForFunction(() => {
    const item = [...document.querySelectorAll('.el-form-item')].find(
      (node) => node.querySelector('label')?.textContent === '供应商密钥'
    );
    return item?.querySelector('input')?.value === '';
  });
  await navigate(page, '/v2/online-recharge/jobs');
  await navigate(page, '/v2/online-recharge/config');
  assert.equal(await concurrency.inputValue(), '1', '配置成功保存仍恢复旧提交草稿');
  assert.equal(await providerSecret.inputValue(), '', '配置密钥进入切页草稿');
  report.lifecycle.push({
    case: 'config-success-clears-submitted-draft-and-volatile-secrets',
    result: 'PASS'
  });
  state.awaitingReview = true;
  state.configTarget = undefined;
  await navigate(page, '/v2/online-recharge/jobs');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('.el-table').getByText('待核对', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '核对原单', exact: true }).click();
  const recheckDialog = page.getByRole('dialog', { name: '核对原单', exact: true });
  await recheckDialog
    .getByText(
      '仅查询原订单和同账号订阅，不会再次提交付款；不能确认时仍保持待核对。确认核对原单？',
      {
        exact: true
      }
    )
    .waitFor();
  await recheckDialog.getByRole('button', { name: '确认', exact: true }).click();
  const recheckResult = page.getByRole('dialog', { name: '操作结果', exact: true });
  await recheckResult.getByText('等待执行', { exact: true }).first().waitFor();
  await recheckResult
    .getByText('33333333-3333-4333-8333-333333333333', { exact: true })
    .first()
    .waitFor();
  assert.deepEqual(network.rechecks, [{ id: taskId }], '原单核对请求包含了重新付款的参数');
  assert.equal(
    network.writes.filter((item) => item === 'jobs/start').length,
    0,
    '原单核对重建了充值任务'
  );
  await recheckResult.getByRole('button', { name: '刷新结果', exact: true }).click();
  await recheckResult.getByText('成功', { exact: true }).first().waitFor();
  await recheckResult.getByRole('button', { name: '关闭', exact: true }).click();
  report.lifecycle.push({
    case: 'awaiting-review-recheck-original-task-without-payment',
    result: 'PASS'
  });
  state.awaitingReview = false;
  await navigate(page, '/v2/online-recharge/config');
  await providerSecret.fill('synthetic-config-before-identity');
  state.saveDelay = true;
  state.saveDelayMs = 1800;
  const configCompletedBeforeIdentity = Number(state.configCompleted ?? 0);
  await Promise.all([
    page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/admin/config')
    ),
    page.getByRole('button', { name: '保存配置', exact: true }).click()
  ]);
  state.actor = {
    ...administrator,
    id: 'online-fixture-admin-second',
    username: 'fixture-admin-second'
  };
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    await sessionCoordinator.login('fixture', 'synthetic');
  });
  await navigate(page, '/v2/online-recharge/config');
  assert.equal(await providerSecret.inputValue(), '', '身份变化未清空配置密钥');
  await providerSecret.fill('synthetic-config-new-identity');
  await wait(async () => state.configCompleted > configCompletedBeforeIdentity);
  await page.waitForTimeout(150);
  assert.equal(
    await providerSecret.inputValue(),
    'synthetic-config-new-identity',
    '旧身份保存响应清除了新身份密钥'
  );
  assert.equal(
    await page.getByText('配置已保存', { exact: true }).count(),
    0,
    '旧身份保存响应显示了新身份成功状态'
  );
  report.lifecycle.push({
    case: 'config-identity-cancelled-save-preserves-new-input',
    result: 'PASS'
  });
  state.saveDelay = false;
  state.actor = administrator;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    await sessionCoordinator.login('fixture', 'synthetic');
  });
  await navigate(page, '/online-recharge');
  const privateSession = JSON.stringify({ accessToken: 'synthetic-private-session' });
  await page.getByPlaceholder('输入兑换码').fill('SYNTHETIC-CODE');
  await page.locator('textarea').fill(privateSession);
  await navigate(page, '/online-recharge/subscription');
  assert.equal(await page.locator('textarea').inputValue(), '');
  await page.locator('textarea').fill(privateSession);
  await navigate(page, '/online-recharge');
  assert.equal(await page.locator('textarea').inputValue(), '');
  await page.getByRole('button', { name: '验证兑换码', exact: true }).click();
  await page.getByText(/兑换码验证成功/).waitFor();
  await page.locator('textarea').fill(privateSession);
  await page.getByRole('button', { name: '提交充值', exact: true }).click();
  await page.getByText(taskId, { exact: true }).waitFor();
  assert.equal(await page.locator('textarea').inputValue(), '');
  const stored = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
  );
  assert.ok(
    !stored.includes('synthetic-private-session') && !stored.includes('synthetic-capability'),
    '公开凭据进入浏览器存储'
  );
  assert.ok(
    network.publicHeaders.every((value) => value === null),
    '公开提交附带后台身份'
  );
  report.lifecycle.push({
    case: 'public-session-volatile-capability-no-browser-storage-no-admin-header',
    result: 'PASS'
  });
  await page.locator('textarea').fill(privateSession);
  state.actor = reader;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    window.__onlineFixtureLogin = sessionCoordinator.login('fixture', 'synthetic');
    await window.__onlineFixtureLogin;
  });
  assert.equal(await page.locator('textarea').inputValue(), '', '同页身份变化未清 Session');
  assert.equal(
    await page.getByPlaceholder('输入兑换码').inputValue(),
    '',
    '同页身份变化未清兑换凭证'
  );
  assert.equal(
    await page.getByText(taskId, { exact: true }).count(),
    0,
    '同页身份变化留下旧客户任务'
  );
  report.lifecycle.push({
    case: 'public-same-page-identity-clears-session-task-capability',
    result: 'PASS'
  });
  state.actor = administrator;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    window.__onlineFixtureLogin = sessionCoordinator.login('fixture', 'synthetic');
    await window.__onlineFixtureLogin;
  });
  await navigate(page, '/v2/online-recharge/addresses');
  await page.getByPlaceholder('搜索当前清单').fill('身份草稿');
  state.actor = employee;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    window.__onlineFixtureLogin = sessionCoordinator.login('fixture', 'synthetic');
    await window.__onlineFixtureLogin;
  });
  await page.evaluate(async () => {
    await document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$router.push('/v2/online-recharge/addresses');
  });
  await page.waitForTimeout(100);
  assert.ok(!(await page.locator('.online-page').count()), '无权限员工访问线上代充');
  await page.evaluate(async () => {
    const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router;
    await router.push('/v2/dashboard');
    await router.push('/v2/online-recharge/cards');
  });
  assert.ok(!page.url().includes('/v2/online-recharge/cards'), '导航权限守卫未拦截员工');
  state.actor = administrator;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    window.__onlineFixtureLogin = sessionCoordinator.login('fixture', 'synthetic');
    await window.__onlineFixtureLogin;
  });
  await navigate(page, '/v2/online-recharge/addresses');
  assert.equal(await page.getByPlaceholder('搜索当前清单').inputValue(), '', '身份变更未清除草稿');
  report.lifecycle.push({
    case: 'ordinary-employee-denied-identity-clears-drafts',
    result: 'PASS'
  });
  state.actor = reader;
  await page.evaluate(async () => {
    const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
    sessionCoordinator.clearLocalSession();
    window.__onlineFixtureLogin = sessionCoordinator.login('fixture', 'synthetic');
    await window.__onlineFixtureLogin;
  });
  await navigate(page, '/v2/online-recharge/jobs');
  assert.equal(await page.getByRole('button', { name: '管理员代提交', exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: '核对原单', exact: true }).count(), 0);
  await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
  await page.getByRole('dialog', { name: '操作结果', exact: true }).waitFor();
  await page
    .getByRole('dialog', { name: '操作结果', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await navigate(page, '/v2/online-recharge/cards');
  assert.equal(await page.getByRole('button', { name: '查看卡号', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '导入银行卡', exact: true }).count(), 0);
  report.lifecycle.push({
    case: 'reader-details-without-manage-or-sensitive-actions',
    result: 'PASS'
  });
  assert.deepEqual(network.unexpected, []);
  await context.close();
  writeFileSync(
    resolve(
      evidence,
      process.argv.includes('--lifecycle')
        ? 'lifecycle-result.json'
        : process.argv.includes('--affected')
          ? 'affected-result.json'
          : 'result.json'
    ),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      ok: true,
      cases: report.cases.length,
      lifecycle: report.lifecycle.length,
      evidence,
      scope: report.scope
    })
  );
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await lastPage
      .screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true })
      .catch(() => {});
  }
  writeFileSync(
    resolve(evidence, 'failure.json'),
    JSON.stringify(
      { message: error.message, cases: report.cases.length, lifecycle: report.lifecycle },
      null,
      2
    )
  );
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
