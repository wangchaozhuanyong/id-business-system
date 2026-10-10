/* global document, window, getComputedStyle */
// Synthetic fixtures only. Every business/connector/BitBrowser request is intercepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { resolveViteCli } from './lib/vite-cli.mjs';

const port = Number(
  process.argv.find((arg) => arg.startsWith('--port='))?.slice('--port='.length) ?? '5397'
);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, '验收端口必须有效');
const origin = `http://127.0.0.1:${port}`,
  connector = 'http://127.0.0.1:55322';
const evidence = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    '.runtime/bitbrowser-recharge-rebuild-20261009/browser'
);
mkdirSync(evidence, { recursive: true });
const server = spawn(
  process.execPath,
  [
    resolveViteCli(),
    ...(process.argv.includes('--built') ? ['preview'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort'
  ],
  { cwd: resolve('apps/admin'), stdio: 'ignore' }
);
const waitFor = async (check) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('验收条件超时');
};
const id = {
  account: '11111111-1111-4111-8111-111111111111',
  address: '22222222-2222-4222-8222-222222222222',
  proxy: '88888888-8888-4888-8888-888888888888'
};
const timestamp = new Date().toISOString();
const user = {
  id: 'browser-fixture',
  username: 'test-admin',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const address = {
  id: id.address,
  line1: 'Fixture Billing Street',
  country: 'US',
  city: 'Seattle',
  state: 'WA',
  postalCode: '98101',
  status: 'used',
  usedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const settings = {
  connectorUrl: connector,
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenConfigured: true,
  localApiTokenMask: '已配置',
  connectorTokenConfigured: true,
  connectorTokenMask: '已配置',
  groupName: '充值验收',
  tagName: '充值',
  proxyType: 'http',
  proxyId: id.proxy,
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: '合成配置',
  updatedAt: timestamp
};
const account = {
  id: id.account,
  emailMasked: 'fixture@example.test',
  registrationCountryCode: 'PH',
  status: 'active',
  subscriptionState: 'never_subscribed',
  currentPlan: null,
  dueAt: null,
  hasPassword: true,
  hasTotp: false,
  remark: null,
  firstLoginNetwork: null,
  lastLoginNetwork: null,
  createdAt: timestamp,
  updatedAt: timestamp
};
const quoted = (plan) => ({
  plan,
  today: { amount: '1100.00', amount_minor: 110000, currency: 'PHP' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'PHP' },
  renewal: { amount: '1100.00', amount_minor: 110000, currency: 'PHP' },
  renewal_interval: 'monthly'
});
const report = {
  scope: 'OFFLINE_SYNTHETIC_ONLY',
  builtPreview: process.argv.includes('--built'),
  realPayment: 'NOT_MEASURED',
  cases: []
};
let browser;
let lastPage;
try {
  await waitFor(async () => (await fetch(origin).catch(() => null))?.ok);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } });
    await context.addInitScript((fixture) => {
      localStorage.setItem('apple_business_access_token', 'browser-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
    }, user);
    const page = await context.newPage();
    lastPage = page;
    page.setDefaultTimeout(12_000);
    const errors = [],
      forbidden = [],
      jobs = [],
      local = new Map();
    let version = 4,
      apiStarts = 0,
      starts = 0,
      confirmations = 0,
      slowRefresh = false,
      refreshSeen = false;
    page.on('pageerror', (error) => errors.push(error.message));
    const success = (route, data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data })
      });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (url.origin === origin && !path.startsWith('/api/')) return route.continue();
      if (url.origin === origin) {
        if (path === '/api/auth/me') return success(route, user);
        if (path === '/api/auth/session')
          return success(route, { accessToken: 'browser-fixture', user });
        if (path.endsWith('/change-events')) return route.abort();
        if (path.endsWith('/change-versions'))
          return success(route, { generatedAt: timestamp, versions: {} });
        if (path.endsWith('/auto-recharge/jobs') && request.method() === 'GET') {
          if (slowRefresh) {
            refreshSeen = true;
            await new Promise((done) => setTimeout(done, 700));
          }
          return success(route, { items: jobs, configured: true });
        }
        if (/\/auto-recharge\/jobs\/[^/]+$/.test(path) && request.method() === 'GET')
          return success(
            route,
            jobs.find((job) => job.id === path.split('/').at(-1))
          );
        if (path.endsWith('/bank-recharge/accounts'))
          return success(route, { items: [account], total: 1 });
        if (path.endsWith('/bank-recharge/currencies'))
          return success(route, {
            items: [{ code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true }]
          });
        if (path.endsWith('/bank-recharge/cards') || path.endsWith('/workspace-totp-accounts'))
          return success(route, { items: [] });
        if (path.endsWith(`/bank-recharge/accounts/${id.account}/identity`))
          return success(route, { id: id.account, email: 'fixture@example.test' });
        if (path.endsWith('/login-credential'))
          return success(route, {
            email: 'fixture@example.test',
            password: 'synthetic-password-only'
          });
        if (path.endsWith('/auto-recharge/names/match'))
          return success(route, {
            name: 'Fixture Person',
            confirmed: false,
            cardId: null,
            billingAddressId: null
          });
        if (path.endsWith('/cards/management/availability'))
          return success(route, { available: true });
        if (path.endsWith('/auto-recharge/names/payment-card'))
          return success(route, { cardId: '44444444-4444-4444-8444-444444444444' });
        if (path.endsWith('/auto-recharge/payment-caps'))
          throw new Error('已移除的付款上限不应继续请求');
        if (path.endsWith('/auto-recharge/proxies/countries'))
          return success(route, { items: ['PH'] });
        if (path.endsWith('/auto-recharge/proxies'))
          return success(route, {
            items: [
              {
                id: id.proxy,
                countryCode: 'PH',
                kind: 'mobile',
                status: 'active',
                linkMask: '合成代理',
                remark1: '离线验收',
                remark2: '',
                connectionMode: 'extraction',
                protocol: 'http',
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ],
            total: 1
          });
        if (path.endsWith('/auto-recharge/addresses'))
          return success(route, {
            items: [address],
            total: 1,
            page: 1,
            pageSize: 2000,
            totals: { unused: 0, used: 1, disabled: 0 }
          });
        if (path.endsWith('/auto-recharge/bitbrowser-settings')) return success(route, settings);
        if (path.endsWith('/auto-recharge/bitbrowser-catalog-access'))
          return success(route, {
            connectorUrl: connector,
            connectorToken: 'c'.repeat(64),
            localApiUrl: settings.localApiUrl,
            localApiToken: 'b'.repeat(32)
          });
        if (path.endsWith('/bitbrowser-access'))
          return success(route, {
            connectorUrl: connector,
            connectorToken: 'c'.repeat(64)
          });
        if (path.endsWith('/auto-recharge/jobs/bitbrowser') && request.method() === 'POST') {
          const input = request.postDataJSON();
          assert.equal(JSON.stringify(input).includes('5555555555554444'), false);
          assert.equal(input.manualPaymentConfirmation, true);
          assert.equal(input.authorizeSinglePayment, true);
          assert.equal(Object.hasOwn(input, 'maxAmount'), false);
          assert.equal(input.addressId, id.address);
          const upgrading = ++apiStarts > 1;
          const job = {
            id: input.id,
            chatgptAccountId: id.account,
            plan: input.plan,
            action: 'bitbrowser',
            state: 'running',
            createdAt: timestamp,
            updatedAt: timestamp,
            result: {
              status: 'waiting_local_connector',
              locked_currency: 'PHP'
            }
          };
          jobs.unshift(job);
          local.set(job.id, {
            job,
            nonce: 'n'.repeat(64),
            digest: 'd'.repeat(64),
            used: false,
            upgrading
          });
          return success(route, {
            id: input.id,
            mode: 'payment',
            connectorUrl: connector,
            connectorToken: 'c'.repeat(64),
            agentToken: 'a'.repeat(64),
            ...(input.useSavedCredentials
              ? {
                  savedLogin: {
                    email: 'fixture@example.test',
                    password: 'synthetic-password-only'
                  }
                }
              : {}),
            bitBrowser: {
              localApiUrl: settings.localApiUrl,
              localApiToken: 'b'.repeat(32),
              groupName: settings.groupName,
              tagName: settings.tagName,
              proxyType: 'http',
              dynamicProxyUrl: 'https://proxy.example.invalid/never-called'
            },
            address,
            safety: {
              lockedCurrency: 'PHP',
              authorizeSinglePayment: true,
              manualPaymentConfirmation: true
            }
          });
        }
        if (request.method() !== 'GET') {
          forbidden.push(path);
          return route.abort();
        }
        return success(route, {});
      }
      if (url.origin === connector) {
        const headers = {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Private-Network': 'true'
        };
        const reply = (data, status = 200) =>
          route.fulfill({
            status,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, ...data })
          });
        if (request.method() === 'OPTIONS')
          return route.fulfill({
            status: 204,
            headers: {
              ...headers,
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, X-Auto-Recharge-Connector'
            }
          });
        if (path === '/health')
          return reply({
            service: 'id-business-v2-auto-recharge-connector',
            version,
            role: 'recharge',
            originAllowed: true,
            busy: false,
            capabilities: [
              'browser-catalog',
              'browser-options',
              'browser-profile-v2',
              'session-load-retry',
              'same-window-page-refresh',
              'payment-unknown-resolution',
              'prepayment-page-recovery',
              'stale-owned-profile-cleanup',
              'same-profile-proxy-recovery',
              'json-page-ready',
              'password-login',
              'login-code',
              'manual-payment-confirmation',
              'recharge-process-isolation'
            ]
          });
        if (path === '/browser/catalog')
          return reply({
            groups: [{ id: '1', name: settings.groupName }],
            tags: [{ id: '2', name: settings.tagName }],
            coreVersions: ['124']
          });
        if (path === '/jobs' && request.method() === 'POST') {
          const input = request.postDataJSON(),
            entry = local.get(input.id);
          assert.equal(input.details.number, '5555555555554444');
          assert.equal(input.details.cvc, '123');
          assert.equal(input.safety.manualPaymentConfirmation, true);
          assert.equal(Object.hasOwn(input.safety, 'maxAmount'), false);
          assert.equal(Object.hasOwn(input.safety, 'maxAmountMinor'), false);
          starts++;
          entry.job.state = 'awaiting_confirmation';
          entry.job.result = {
            status: 'awaiting_confirmation',
            stage: 'payment_confirmation',
            account_matched: true,
            current_plan: entry.upgrading ? 'go' : 'free',
            quote: quoted(input.plan),
            quote_digest: entry.digest,
            quote_authority: entry.upgrading
              ? 'official_upgrade_preview'
              : 'official_checkout_response',
            ...(entry.upgrading
              ? {
                  operation: 'subscription_upgrade',
                  current_plan_before: 'go',
                  target_plan: 'plus',
                  upgrade_identifier: 'upg_' + 'e'.repeat(32)
                }
              : {}),
            confirmation_expires_at: new Date(Date.now() + 300000).toISOString(),
            manual_payment_confirmation: true,
            payment_requests_sent: 0,
            payment_attempted: false,
            locked_currency: 'PHP',
            window_name: input.windowName
          };
          return reply({ id: input.id, accepted: true }, 202);
        }
        const match = path.match(/^\/jobs\/([^/]+)(?:\/(confirm))?$/);
        if (match) {
          const entry = local.get(match[1]);
          assert.ok(entry);
          if (!match[2])
            return reply({
              done: entry.used,
              waitingForUser: false,
              status: entry.used ? 'finished' : 'awaiting_confirmation',
              waitingForConfirmation: !entry.used,
              result: {
                ...entry.job.result,
                nonce: entry.used ? undefined : entry.nonce
              }
            });
          const input = request.postDataJSON();
          assert.equal(input.nonce, entry.nonce);
          assert.equal(input.quoteDigest, entry.digest);
          assert.equal(entry.used, false, '同一报价只能确认一次');
          entry.used = true;
          confirmations++;
          entry.job.state = 'finished';
          entry.job.result = {
            ...entry.job.result,
            status: 'subscription_activated',
            payment_status: 'paid',
            payment_outcome: 'subscription_activated',
            subscription_status: 'active',
            current_plan: entry.job.plan,
            payment_requests_sent: 1,
            payment_attempted: true
          };
          return reply({ accepted: true });
        }
      }
      forbidden.push(url.origin + path);
      return route.abort();
    });
    await page.goto(origin + '/v2/auto-recharge');
    const form = page.locator('.recharge-entry-panel');
    await form.waitFor();
    assert.equal(await page.getByRole('radio', { name: '服务器充值', exact: true }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: '已保存账号', exact: true }).count(), 0);
    await page.getByText('账号密码', { exact: true }).click();
    await page
      .getByRole('combobox', { name: /ChatGPT 账号/ })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: /fixture@example.test/ }).click();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).count(), 0);
    const jsonInput = page.getByPlaceholder(/粘贴完整授权 JSON|授权已自动载入，可粘贴新 JSON 替换/);
    const loadJson = async (email = 'fixture@example.test', token = 'synthetic-only') => {
      await page
        .getByRole('radio', { name: '授权 JSON', exact: true })
        .locator('xpath=ancestor::label')
        .click();
      await jsonInput.fill(JSON.stringify({ sessionToken: token, user: { email } }));
      await page.getByText('授权已自动载入', { exact: false }).waitFor();
    };
    await loadJson();
    await loadJson('replacement@example.test', 'replacement-synthetic-only');
    await form.getByText('replacement@example.test', { exact: true }).waitFor();
    assert.equal(await jsonInput.inputValue(), '', '第二份授权载入后清空粘贴框');
    await jsonInput.fill('{"sessionToken":');
    await page.getByText('请提供有效的单账户 JSON（不超过 65 KB）', { exact: true }).waitFor();
    assert.equal(
      await form.getByText('replacement@example.test', { exact: true }).count(),
      0,
      '错误授权不能保留旧账号'
    );
    await loadJson();
    assert.equal(await jsonInput.getAttribute('type'), 'text');
    assert.equal(
      await jsonInput.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'disc'
    );
    await form.getByLabel('窗口名称', { exact: true }).fill('充值离线验收');
    assert.equal(await form.getByLabel('最高付款', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/付款安全上限|付款上限设置/).count(), 0);
    await page
      .getByRole('combobox', { name: '选择真实账单地址' })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: address.line1, exact: true }).click();
    const proxyCountry = page.getByRole('combobox', { name: '选择代理国家', exact: true });
    assert.equal(await proxyCountry.getAttribute('readonly'), '', '国家选择不触发地址文本输入');
    await proxyCountry
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: '菲律宾', exact: true }).click();
    await page
      .getByRole('combobox', { name: '选择代理 IP', exact: true })
      .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
      .click();
    await page.getByRole('option', { name: /离线验收/ }).click();
    const fillPayment = async () => {
      await form.getByLabel('银行卡号', { exact: true }).fill('5555555555554444');
      await form.getByLabel('持卡人姓名', { exact: true }).fill('Fixture Person');
      await form.getByLabel('有效期', { exact: true }).fill('1230');
      await form.getByLabel('安全码', { exact: true }).fill('123');
      const authorization = form.getByRole('checkbox', { name: /我已核对银行卡/ });
      if (!(await authorization.isChecked()))
        await authorization.locator('xpath=ancestor::label').click();
    };
    const choosePlan = async (label) => {
      await form
        .getByRole('combobox', { name: /开通套餐|目标套餐/ })
        .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
        .click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    await choosePlan('ChatGPT Go');
    await fillPayment();
    const cardNumber = form.getByLabel('银行卡号', { exact: true });
    const cvc = form.getByLabel('安全码', { exact: true });
    for (const input of [cardNumber, cvc]) {
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(
        await input.evaluate((node) => getComputedStyle(node).webkitTextSecurity),
        'disc'
      );
    }
    const cardField = form.locator('.recharge-card-number');
    await cardField.getByRole('button', { name: '显示内容', exact: true }).click();
    assert.equal(
      await cardNumber.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'none'
    );
    assert.equal(await cardNumber.inputValue(), '5555555555554444', '切换遮蔽不修改银行卡输入');
    await cardField.getByRole('button', { name: '隐藏内容', exact: true }).press('Space');
    assert.equal(
      await cardNumber.evaluate((input) => getComputedStyle(input).webkitTextSecurity),
      'disc'
    );
    assert.equal(
      await form.locator('input[type="password"]').count(),
      0,
      '充值资料不构成本站密码表单'
    );
    await cardNumber.focus();
    await page.screenshot({
      path: resolve(evidence, `masked-inputs-${width}.png`),
      fullPage: true
    });
    const start = page.getByRole('button', { name: '在比特浏览器执行', exact: true });
    assert.equal(await start.isEnabled(), true);
    version = 3;
    await start.click();
    await page
      .getByText(/版本过旧/)
      .first()
      .waitFor();
    assert.equal(apiStarts, 0);
    assert.equal(starts, 0);
    version = 4;
    await start.click();
    const confirm = page.getByRole('button', { name: /确认.*付款|确认.*扣款/ });
    await confirm.waitFor();
    assert.equal(confirmations, 0);
    assert.equal(jobs[0].result.nonce, undefined, '后端不得持久化付款授权');
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(confirmations, 1);
    assert.equal(await form.getByLabel('安全码', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: /继续.*账号.*升级/ }).click();
    await loadJson();
    await choosePlan('ChatGPT Plus');
    await fillPayment();
    await start.click();
    await confirm.waitFor();
    await page
      .getByText(/Go.*Plus|Go → Plus/)
      .first()
      .waitFor();
    assert.equal(confirmations, 1);
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(confirmations, 2);
    await page.waitForFunction(
      () => document.querySelectorAll('.recharge-entry-panel .el-form-item__error').length === 0
    );
    assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0].id, jobs[1].id);
    assert.ok(jobs.every((job) => job.chatgptAccountId === id.account));
    slowRefresh = true;
    await page.getByRole('button', { name: '刷新原任务状态', exact: true }).click();
    await waitFor(() => refreshSeen);
    assert.equal(
      await page.locator('.recharge-status').filter({ hasText: '开通成功' }).isVisible(),
      true
    );
    assert.equal(await page.locator('.el-loading-mask').count(), 0);
    assert.equal(
      await page.locator('.recharge-page > .v2-async-region').getAttribute('data-v2-query-phase'),
      'refreshing'
    );
    slowRefresh = false;
    await page.getByRole('button', { name: '刷新原任务状态', exact: true }).waitFor();
    await waitFor(() =>
      page.getByRole('button', { name: '刷新原任务状态', exact: true }).isEnabled()
    );
    for (const theme of ['light', 'dark']) {
      // Theme controls are desktop shell controls; keep narrow acceptance on the same live page.
      if (width < 900) await page.setViewportSize({ width: 1440, height: 1100 });
      await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
      if (width < 900) await page.setViewportSize({ width, height: 1100 });
      // Wait for the existing navigation transition before measuring the narrow page.
      if (width < 900) {
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.querySelector('.v2-sidebar').getBoundingClientRect().right <= 0
        );
      }
      // Element Plus controls animate theme changes; verify the settled shared surface.
      await page.waitForFunction(() => {
        const element = document.querySelector('.recharge-entry-panel .el-select__wrapper');
        const style = getComputedStyle(element);
        const normalized = document.createElement('span');
        normalized.style.backgroundColor = style.getPropertyValue('--v3-surface').trim();
        return style.backgroundColor === normalized.style.backgroundColor;
      });
      await page.screenshot({
        path: resolve(evidence, theme + '-' + width + '.png'),
        fullPage: true
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
        false
      );
      const alignment = await form.locator('.el-form-item:visible').evaluateAll((elements) =>
        elements.every((element) => {
          const label = element.querySelector('.el-form-item__label');
          const content = element.querySelector('.el-form-item__content');
          if (!label || !content) return true;
          const a = label.getBoundingClientRect(),
            b = content.getBoundingClientRect();
          return a.left <= b.left && Math.abs(a.top - b.top) < 8;
        })
      );
      assert.equal(alignment, true, '标签须在控件左侧并对齐首行');
      report.skin ??= [];
      report.skin.push(
        await form
          .locator('.el-select__wrapper')
          .first()
          .evaluate((element, theme) => {
            const style = getComputedStyle(element);
            const root = getComputedStyle(document.documentElement);
            return {
              theme,
              background: style.backgroundColor,
              fill: style.getPropertyValue('--el-fill-color-blank'),
              rootFill: root.getPropertyValue('--el-fill-color-blank'),
              surface: style.getPropertyValue('--v3-surface'),
              color: style.color
            };
          }, theme)
      );
      if (width < 900) {
        await page.locator('.recharge-status-panel').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(evidence, theme + '-' + width + '-result.png') });
        await form.scrollIntoViewIfNeeded();
      }
    }
    // A real route transition must retain the non-sensitive draft but clear one-time secrets.
    await page.getByRole('button', { name: /继续.*账号.*升级/ }).click();
    await page
      .getByRole('radio', { name: '账号密码', exact: true })
      .locator('xpath=ancestor::label')
      .click();
    await form.getByLabel('窗口名称', { exact: true }).fill('升级草稿保留验收');
    await fillPayment();
    await form.getByRole('link', { name: 'ChatGPT 账号', exact: true }).click();
    await page.waitForURL('**/v2/auto-recharge/chatgpt-accounts');
    await page.goBack();
    await form.waitFor();
    assert.equal(
      await form.getByLabel('窗口名称', { exact: true }).inputValue(),
      '升级草稿保留验收'
    );
    assert.equal(await form.getByLabel('安全码', { exact: true }).inputValue(), '');
    assert.equal(await form.getByRole('checkbox', { name: /我已核对银行卡/ }).isChecked(), false);
    assert.equal(await form.getByRole('combobox', { name: /ChatGPT 账号/ }).inputValue(), '');
    assert.match(await form.locator('.el-select').first().innerText(), /fixture@example.test/);
    assert.ok(await form.getByText(address.line1, { exact: true }).count());
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    report.cases.push({
      width,
      apiStarts,
      starts,
      confirmations,
      themes: ['light', 'dark'],
      draftRouteRetention: 'PASS',
      oneTimeSecretsClearedOnRoute: 'PASS',
      refreshRetainsSuccess: 'PASS',
      consecutiveJsonReplacement: 'PASS',
      invalidJsonClearsOldSession: 'PASS',
      sensitiveInputMaskAndReveal: 'PASS',
      countrySelectionReadonly: 'PASS',
      result: 'PASS'
    });
    await context.close();
  }
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true });
    writeFileSync(resolve(evidence, 'failure.txt'), await lastPage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
