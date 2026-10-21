/* global document, window, getComputedStyle */
// Browser-only acceptance of the actual compiled app. All HTTP and WS traffic is intercepted.
// Does not create a local server, database, real session, payment or notification.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(root, '.runtime/online-recharge/billing-ui');
mkdirSync(evidence, { recursive: true });
const dist = resolve(root, 'apps/admin/dist');
const origin = 'https://billing-fixture.example.invalid';
const report = {
  scope: 'ACTUAL_BUILT_APP_OFFLINE_SYNTHETIC_API',
  localServerStarted: false,
  databaseConnected: false,
  realSessionUsed: false,
  realPayment: false,
  cases: [],
  consoleErrors: []
};
const missingAssets = [];
function serveStatic(route, url) {
  const candidate = resolve(dist, '.' + url.pathname);
  const inDist = !relative(dist, candidate).startsWith('..');
  const target =
    inDist && existsSync(candidate) && extname(candidate)
      ? candidate
      : url.pathname.startsWith('/assets/')
        ? null
        : resolve(dist, 'index.html');
  if (!target) {
    missingAssets.push(url.pathname);
    return route.abort();
  }
  const mime =
    {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.png': 'image/png',
      '.json': 'application/json'
    }[extname(target)] ?? 'application/octet-stream';
  return route.fulfill({ status: 200, contentType: mime, body: readFileSync(target) });
}
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
const settings = {
  version: 0,
  maxConcurrent: 1,
  maintenance: false,
  paymentRegion: 'PH',
  proxyCountryCode: 'CL',
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
    if (url.origin === origin && !path.startsWith('/api/')) return serveStatic(route, url);
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
    if (path.endsWith('/proxy-pool/countries')) return ok({ items: ['CL', 'PH', 'US'] });
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

const summary = [
  {
    cardLast4: '0001',
    currency: 'USD',
    amount: null,
    knownAmount: '20.1234',
    count: 2,
    knownAmountCount: 1,
    unknownAmountCount: 1,
    isComplete: false
  },
  {
    cardLast4: '0001',
    currency: 'CNY',
    amount: '0',
    knownAmount: '0',
    count: 1,
    knownAmountCount: 1,
    unknownAmountCount: 0,
    isComplete: true
  }
];
const detail = {
  id: taskId,
  taskId,
  cardLast4: '0001',
  amount: '20.1234',
  currency: 'USD',
  status: 'failed',
  amountMeaning: '结账应付金额，未确认扣款',
  createdAt: date
};
let browser, lastPage;
async function ready(page) {
  await page.locator('.online-page').waitFor();
  await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(window.requestAnimationFrame));
}
async function inspect(page, theme, width, name, shot = false) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' &&
          animation.effect?.getComputedTiming().endTime !== Infinity
      );
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
  const m = await measure(page);
  assert.equal(m.viewport, width, 'actual viewport');
  assert.ok(
    m.documentWidth <= width + 1,
    `${theme}/${width}/${name} document overflow ${m.documentWidth}`
  );
  assert.deepEqual(m.overlaps, [], `${name} metric text alignment`);
  for (const p of m.panels)
    assert.ok(p.left >= -1 && p.right <= width + 2, `${name} panel outside viewport`);
  const extra = await page.evaluate(() => {
    const visible = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const boxes = [];
    for (const e of document.querySelectorAll(
      '.el-dialog,.v2-page-context button,.el-dialog__footer button'
    )) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      boxes.push({
        text: e.textContent.trim().slice(0, 25),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom
      });
    }
    return { height: window.innerHeight, theme: document.documentElement.dataset.v2Theme, boxes };
  });
  assert.equal(extra.theme, theme, 'actual theme');
  for (const b of extra.boxes)
    assert.ok(b.left >= -1 && b.right <= width + 2, `${name} clipped button/dialog ${b.text}`);
  report.cases.push({ theme, width, name, measurements: m, extra, result: 'PASS' });
  if (shot)
    await page.screenshot({
      path: resolve(evidence, `${theme}-${width}-${name}.png`),
      fullPage: true,
      animations: 'disabled'
    });
  return m;
}
async function openSummary(page) {
  await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '卡片消费汇总', exact: true }).click();
  const d = page.getByRole('dialog', { name: '操作结果', exact: true });
  await d.waitFor();
  return d;
}
async function closeResult(page, d) {
  await d.getByRole('button', { name: '关闭', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await ready(page);
}
try {
  browser = await chromium.launch({ headless: true });
  for (const width of process.argv.includes('--smoke')
    ? [1440]
    : [1440, 1024, 901, 900, 768, 390]) {
    for (const theme of process.argv.includes('--smoke') ? ['light'] : ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        serviceWorkers: 'block'
      });
      await context.addInitScript(
        ({ theme, user }) => {
          localStorage.setItem('apple_business_access_token', 'synthetic-access');
          localStorage.setItem('apple_business_current_user', JSON.stringify(user));
          localStorage.setItem('id-business-v2-theme', theme);
        },
        { theme, user: administrator }
      );
      const state = {
        actor: administrator,
        empty: false,
        summaryEmpty: false,
        refreshFail: false,
        holdRead: false
      };
      const network = await fixture(context, state);
      const requests = [];
      await context.route('**/api/id-business-v2/online-recharge/admin/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        const endpoint = url.pathname.split('/online-recharge/admin/')[1];
        const ok = (data) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data })
          });
        if (endpoint === 'overview')
          return ok({
            tasks: [{ status: 'succeeded', _count: 2 }],
            cards: [],
            codes: [],
            config: settings,
            runtime: {
              cpuCores: 4,
              totalMemory: 8 * 1024 ** 3,
              freeMemory: 4 * 1024 ** 3,
              diskTotal: 100 * 1024 ** 3,
              diskFree: 40 * 1024 ** 3,
              uptime: 3600
            },
            billing: state.summaryEmpty ? [] : summary
          });
        if (!endpoint.startsWith('billing')) return route.fallback();
        requests.push({
          method: req.method(),
          endpoint,
          body: req.method() === 'POST' ? req.postDataJSON() : undefined
        });
        if (endpoint === 'billing') {
          if (state.holdRead)
            await new Promise((done) => {
              state.release = done;
            });
          if (state.refreshFail)
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成刷新失败' })
            });
          const pageNumber = Number(url.searchParams.get('page') ?? 1),
            empty = state.empty;
          const count = empty ? 0 : pageNumber === 3 ? 1 : 20;
          return ok({
            items: Array.from({ length: count }, (_, n) => ({
              ...rows.billing[0],
              id: `bill-${pageNumber}-${n}`,
              taskId: `task-${pageNumber}-${n}`,
              cardLast4: '0001',
              amount: n === 1 ? null : '20.1234',
              status: n === 0 ? 'failed' : 'success',
              email:
                pageNumber === 1
                  ? 'synthetic-long-billing-account@example.test'
                  : 's***@example.test'
            })),
            total: empty ? 0 : 41,
            page: pageNumber,
            pageSize: 20
          });
        }
        if (endpoint === 'billing/summary') return ok(state.summaryEmpty ? [] : summary);
        if (endpoint === 'billing/detail') return ok(detail);
        if (endpoint === 'billing/export')
          return ok({
            content:
              '记录时间,卡尾号,结账金额,币种,套餐,结果,金额说明\r\n合成时间,0001,20.1234,USD,Plus,失败,未确认扣款',
            filename: '合成账单.csv'
          });
        if (endpoint === 'billing/delete')
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              message: '成功或待核对账单必须保留，只允许清理明确失败的账单'
            })
          });
        throw new Error('Unexpected billing endpoint');
      });
      const page = await context.newPage();
      lastPage = page;
      page.setDefaultTimeout(12000);
      page.on('pageerror', (e) => report.consoleErrors.push(e.message));
      await page.goto(origin + '/v2/online-recharge/overview');
      await ready(page);
      await page
        .getByText('已知金额小计 20.1234；1 笔金额待核对（共 2 笔）', { exact: true })
        .waitFor();
      await page.getByText('0（1 笔，金额完整）', { exact: true }).waitFor();
      await inspect(page, theme, width, 'overview', width === 1440 || width === 390);
      await navigate(page, '/v2/online-recharge/billing');
      await ready(page);
      await page.getByRole('columnheader', { name: '结账金额', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('columnheader', { name: '实际金额', exact: true }).count(),
        0
      );
      await inspect(page, theme, width, 'first-page', width === 390);
      const firstBox = await page.locator('.v2-records-list').boundingBox();
      await page.locator('.el-pager li').filter({ hasText: /^3$/ }).click();
      await page.waitForFunction(
        () => document.querySelector('.el-pager .is-active')?.textContent === '3'
      );
      await ready(page);
      await inspect(page, theme, width, 'last-page');
      const lastBox = await page.locator('.v2-records-list').boundingBox();
      assert.ok(
        Math.abs(firstBox.height - lastBox.height) < 4,
        `first/last frame changed ${firstBox.height}/${lastBox.height}`
      );
      state.empty = true;
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('暂无记录', { exact: true }).waitFor();
      await ready(page);
      await inspect(page, theme, width, 'empty-page');
      const emptyBox = await page.locator('.v2-records-list').boundingBox();
      assert.ok(
        Math.abs(firstBox.height - emptyBox.height) < 4,
        `first/empty frame changed ${firstBox.height}/${emptyBox.height}`
      );
      state.empty = false;
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await ready(page);
      await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
      let dialog = page.getByRole('dialog', { name: '操作结果', exact: true });
      await dialog.getByText('结账应付金额，未确认扣款', { exact: true }).waitFor();
      await inspect(page, theme, width, 'failed-detail');
      await closeResult(page, dialog);
      dialog = await openSummary(page);
      await dialog.getByText(/已知金额小计：20.1234/).waitFor();
      assert.ok((await dialog.innerText()).includes('币种：USD'));
      assert.ok((await dialog.innerText()).includes('币种：CNY'));
      assert.ok((await dialog.innerText()).includes('金额待核对笔数：1'));
      assert.ok((await dialog.innerText()).includes('金额是否完整：否'));
      await inspect(page, theme, width, 'mixed-summary', width === 1440 || width === 390);
      await closeResult(page, dialog);
      state.summaryEmpty = true;
      dialog = await openSummary(page);
      await dialog.getByText('当前没有已确认成功的账单', { exact: true }).waitFor();
      await inspect(page, theme, width, 'empty-summary');
      await closeResult(page, dialog);
      state.summaryEmpty = false;
      // Browser-only refresh/draft lifecycle checks on the changed billing route.
      if (width === 1440 || width === 390) {
        state.holdRead = true;
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.locator('.v2-async-region[aria-busy="true"]').first().waitFor();
        await page.getByRole('button', { name: '查看详情', exact: true }).first().waitFor();
        await inspect(page, theme, width, 'refresh-keeps-content');
        state.holdRead = false;
        state.release();
        await ready(page);
        state.refreshFail = true;
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.getByText('更新失败', { exact: true }).waitFor();
        await page.getByRole('button', { name: '查看详情', exact: true }).first().waitFor();
        await inspect(page, theme, width, 'failure-keeps-content');
        state.refreshFail = false;
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await ready(page);
        const search = page.getByRole('textbox', { name: '搜索当前清单', exact: true });
        await search.fill('合成搜索保留');
        await search.press('Enter');
        await ready(page);
        await navigate(page, '/v2/online-recharge/overview');
        await ready(page);
        await navigate(page, '/v2/online-recharge/billing');
        await ready(page);
        assert.equal(await search.inputValue(), '合成搜索保留');
        await inspect(page, theme, width, 'route-draft-restored');
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '导出账单', exact: true }).click();
        const download = await downloadPromise;
        await download.saveAs(resolve(evidence, `${theme}-${width}-synthetic.csv`));
        assert.ok(
          readFileSync(resolve(evidence, `${theme}-${width}-synthetic.csv`), 'utf8').includes(
            '结账金额'
          )
        );
        report.cases.push({ theme, width, name: 'csv-download', result: 'PASS' });
      }
      assert.deepEqual(network.unexpected, [], 'External request escaped block');
      assert.deepEqual(missingAssets, [], 'Compiled asset missing');
      assert.equal(
        requests.filter(
          (r) =>
            !['billing', 'billing/summary', 'billing/detail', 'billing/export'].includes(r.endpoint)
        ).length,
        0,
        'Unexpected mutation'
      );
      report.cases.push({
        theme,
        width,
        name: 'network-boundary',
        externalAttempts: network.unexpected.length,
        localOnlyRequests: requests.length,
        result: 'PASS'
      });
      await context.close();
      console.log(JSON.stringify({ width, theme, completed: report.cases.length }));
    }
  }
  assert.deepEqual(report.consoleErrors, [], 'Browser runtime errors');
  report.status = 'PASS';
} catch (e) {
  report.status = 'FAIL';
  report.error = { name: e.name, message: e.message };
  process.exitCode = 1;
  if (lastPage && !lastPage.isClosed())
    await lastPage
      .screenshot({
        path: resolve(evidence, 'failure.png'),
        fullPage: true,
        animations: 'disabled'
      })
      .catch(() => {});
} finally {
  await browser?.close();
  writeFileSync(
    resolve(evidence, process.argv.includes('--smoke') ? 'smoke.json' : 'result.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error })
  );
}
