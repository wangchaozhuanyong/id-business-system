/* global document */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5397';
const connectorOrigin = 'http://127.0.0.1:55321';
const server = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5397',
    '--strictPort'
  ],
  { cwd: resolve('apps/admin'), stdio: 'ignore' }
);
let browser;
const evidence = resolve('.deploy/auto-recharge-browser');
mkdirSync(evidence, { recursive: true });
const waitFor = async (predicate, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('验收条件超时');
};
const user = {
  id: 'browser-fixture',
  username: 'test-admin',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const address = {
  id: '22222222-2222-4222-8222-222222222222',
  line1: '1221 SW Fourth Avenue',
  country: 'US',
  city: 'Portland',
  state: 'OR',
  postalCode: '97204',
  status: 'unused',
  usedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const settings = {
  connectorUrl: connectorOrigin,
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenConfigured: true,
  localApiTokenMask: '已保存 ···1234',
  connectorTokenConfigured: true,
  connectorTokenMask: '已保存 ···5678',
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  proxyType: 'http',
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: 'https://proxy.example/…（已加密）',
  updatedAt: null
};

try {
  await waitFor(async () => (await fetch(origin).catch(() => null))?.ok);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript((currentUser) => {
      localStorage.setItem('apple_business_access_token', 'browser-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(currentUser));
    }, user);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const jobs = [];
    let apiStarts = 0;
    let connectorStarts = 0;
    let connectorResumes = 0;
    let addressUsed = false;
    let serverStartBody;
    let connectorStartBody;
    let currentSettings = { ...settings };
    let settingsSaves = 0;
    let catalogReads = 0;
    let blockHealth = false;
    let savedDynamicProxyUrl = 'https://proxy.example/secret';
    let savedStaticCredentials;
    page.on('pageerror', (error) => errors.push(error.message));

    const success = (route, data, headers = {}) =>
      route.fulfill({
        contentType: 'application/json',
        headers,
        body: JSON.stringify({ success: true, data })
      });
    await page.route(origin + '/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/me') return success(route, user);
      if (path === '/api/auth/session')
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '请登录' })
        });
      if (path.endsWith('/auto-recharge/jobs') && request.method() === 'GET')
        return success(route, { items: jobs, configured: true });
      if (path.endsWith('/auto-recharge/bitbrowser-settings') && request.method() === 'GET')
        return success(route, currentSettings);
      if (path.endsWith('/auto-recharge/bitbrowser-catalog-access'))
        return success(route, {
          connectorUrl: connectorOrigin,
          connectorToken: 'c'.repeat(64),
          localApiUrl: settings.localApiUrl,
          localApiToken: 'b'.repeat(32)
        });
      if (path.endsWith('/auto-recharge/bitbrowser-settings') && request.method() === 'PUT') {
        settingsSaves += 1;
        const input = request.postDataJSON();
        assert.equal(input.localApiToken, undefined);
        assert.equal(input.connectorToken, undefined);
        if (settingsSaves === 1)
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, message: '模拟设置保存失败，请重试' })
          });
        savedDynamicProxyUrl = input.dynamicProxyUrl || savedDynamicProxyUrl;
        if (input.clearStaticProxyCredentials) savedStaticCredentials = undefined;
        else if (input.staticProxyCredentials)
          savedStaticCredentials = input.staticProxyCredentials;
        currentSettings = {
          ...currentSettings,
          groupName: input.groupName,
          tagName: input.tagName,
          proxyType: input.proxyType,
          browserOptions: input.browserOptions,
          staticProxyCredentialsConfigured: Boolean(savedStaticCredentials),
          dynamicProxyUrlMask: 'https://new-proxy.example/…（已加密）'
        };
        return success(route, currentSettings);
      }
      if (path.endsWith('/auto-recharge/addresses') && request.method() === 'GET') {
        const items = addressUsed ? [] : [address];
        return success(route, {
          items,
          total: items.length,
          page: 1,
          pageSize: 2000,
          totals: { unused: items.length, used: addressUsed ? 1 : 0, disabled: 0 }
        });
      }
      if (path.endsWith('/auto-recharge/jobs/bitbrowser') && request.method() === 'POST') {
        apiStarts += 1;
        serverStartBody = request.postDataJSON();
        assert.equal(serverStartBody.plan, 'plus');
        assert.equal(serverStartBody.addressId, address.id);
        assert.equal(serverStartBody.lockedCurrency, 'PHP');
        assert.equal(serverStartBody.maxAmount, '30.00');
        assert.equal(serverStartBody.authorizeSinglePayment, true);
        assert.equal(JSON.stringify(serverStartBody).includes('5555555555554444'), false);
        assert.equal(JSON.stringify(serverStartBody).includes('fixture@example.test'), false);
        jobs.unshift({
          id: serverStartBody.id,
          plan: serverStartBody.plan,
          action: 'bitbrowser',
          state: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: {
            status: 'waiting_local_connector',
            stage: 'connector_dispatch',
            addressId: address.id,
            window_name: serverStartBody.windowName,
            locked_currency: 'PHP',
            max_amount: '30.00',
            payment_requests_sent: 0
          }
        });
        return success(route, {
          id: serverStartBody.id,
          mode: 'payment',
          connectorUrl: connectorOrigin,
          connectorToken: 'c'.repeat(64),
          agentToken: 'a'.repeat(64),
          bitBrowser: {
            localApiUrl: settings.localApiUrl,
            localApiToken: 'b'.repeat(32),
            groupName: currentSettings.groupName,
            tagName: currentSettings.tagName,
            proxyType: currentSettings.proxyType,
            dynamicProxyUrl:
              currentSettings.browserOptions.proxyMode === 'dynamic' ? savedDynamicProxyUrl : '',
            browserOptions: currentSettings.browserOptions,
            staticProxyCredentials:
              currentSettings.browserOptions.proxyMode === 'static'
                ? savedStaticCredentials
                : undefined
          },
          address,
          safety: {
            lockedCurrency: 'PHP',
            maxAmount: '30.00',
            maxAmountMinor: 3000,
            authorizeSinglePayment: true
          }
        });
      }
      if (path.endsWith('/bitbrowser-access') && request.method() === 'POST')
        return success(route, {
          connectorUrl: connectorOrigin,
          connectorToken: 'c'.repeat(64)
        });
      if (path.endsWith('/change-versions'))
        return success(route, { generatedAt: new Date().toISOString(), versions: {} });
      if (path.endsWith('/change-events')) return route.abort();
      return success(route, {});
    });

    await page.route(connectorOrigin + '/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Private-Network': 'true'
      };
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...headers,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Auto-Recharge-Connector'
          }
        });
      if (url.pathname === '/health' && blockHealth) return route.abort('blockedbyclient');
      if (url.pathname === '/health')
        return route.fulfill({
          contentType: 'application/json',
          headers,
          body: JSON.stringify({
            ok: true,
            version: 2,
            busy: false,
            originAllowed: true,
            service: 'id-business-v2-auto-recharge-connector',
            capabilities: ['browser-catalog', 'browser-options']
          })
        });
      if (url.pathname === '/browser/catalog') {
        catalogReads += 1;
        assert.equal(request.headers()['x-auto-recharge-connector'], 'c'.repeat(64));
        assert.deepEqual(request.postDataJSON(), {
          localApiUrl: settings.localApiUrl,
          localApiToken: 'b'.repeat(32)
        });
        return route.fulfill({
          status: catalogReads === 1 ? 409 : 200,
          contentType: 'application/json',
          headers,
          body: JSON.stringify(
            catalogReads === 1
              ? { ok: false }
              : {
                  ok: true,
                  groups:
                    catalogReads === 2
                      ? []
                      : [
                          { id: '1'.repeat(32), name: 'gpt账号注册' },
                          { id: '2'.repeat(32), name: '测试代理分组' }
                        ],
                  tags:
                    catalogReads === 2
                      ? []
                      : [
                          { id: '3'.repeat(32), name: '申请gpt' },
                          { id: '4'.repeat(32), name: '续费账号' }
                        ]
                }
          )
        });
      }
      if (url.pathname === '/jobs') {
        connectorStarts += 1;
        connectorStartBody = request.postDataJSON();
        assert.equal(request.headers()['x-auto-recharge-connector'], 'c'.repeat(64));
        assert.equal(connectorStartBody.details.number, '5555555555554444');
        assert.equal(connectorStartBody.details.expiry, '12/30');
        assert.equal(connectorStartBody.details.cvc, '123');
        assert.equal(connectorStartBody.details.email, 'fixture@example.test');
        assert.equal(connectorStartBody.sessionJson.includes('fixture@example.test'), true);
        assert.equal(connectorStartBody.bitBrowser.groupName, '测试代理分组');
        assert.equal(connectorStartBody.bitBrowser.tagName, '续费账号');
        assert.equal(
          connectorStartBody.bitBrowser.dynamicProxyUrl,
          width === 1440 ? 'https://new-proxy.example/extract' : ''
        );
        assert.deepEqual(
          connectorStartBody.bitBrowser.browserOptions,
          currentSettings.browserOptions
        );
        assert.equal(connectorStartBody.bitBrowser.staticProxyCredentials, undefined);
        assert.equal(connectorStartBody.address.city, 'Portland');
        assert.equal(connectorStartBody.address.state, 'OR');
        assert.equal(connectorStartBody.address.postalCode, '97204');
        jobs[0].state = 'awaiting_human_verification';
        jobs[0].result = {
          ...jobs[0].result,
          status: 'awaiting_human_verification',
          stage: 'verification_required',
          browser_profile_id: 'profile_fixture',
          user_action_required: true,
          payment_attempted: false,
          payment_requests_sent: 0
        };
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          headers,
          body: JSON.stringify({ ok: true, id: jobs[0].id, accepted: true })
        });
      }
      if (url.pathname.endsWith('/resume')) {
        connectorResumes += 1;
        const money = { currency: 'PHP', amount: '20.00', amount_minor: 2000 };
        jobs[0].state = 'finished';
        jobs[0].result = {
          ...jobs[0].result,
          status: 'subscription_activated',
          stage: 'subscription_activated',
          account_matched: true,
          current_plan: 'free',
          quote: {
            plan: 'plus',
            today: money,
            tax: { currency: 'PHP', amount: '0.00', amount_minor: 0 },
            renewal: money,
            renewal_interval: 'monthly'
          },
          quote_authority: 'official_checkout_response',
          checkout_identifier: 'cs_fixture',
          network: { ip: '203.0.113.10', country: 'US', observedAt: new Date().toISOString() },
          payment_status: 'paid',
          payment_attempted: true,
          payment_requests_sent: 1,
          subscription_status: 'plus'
        };
        addressUsed = true;
        return route.fulfill({
          contentType: 'application/json',
          headers,
          body: JSON.stringify({ ok: true })
        });
      }
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers,
        body: JSON.stringify({ ok: false })
      });
    });

    await page.goto(origin + '/v2/auto-recharge');
    await page.getByText('一键开通资料', { exact: true }).waitFor();
    await page.getByRole('button', { name: '修改代理 IP 与窗口设置', exact: true }).click();
    const settingsDrawer = page
      .locator('.v2-form-drawer')
      .filter({ has: page.locator('.recharge-settings-form') });
    await settingsDrawer.getByText('本机连接器拒绝了请求', { exact: false }).waitFor();
    await settingsDrawer.getByRole('button', { name: '刷新分组与标签', exact: true }).click();
    await settingsDrawer.getByText('比特浏览器中暂无可选分组或标签，请添加后刷新。').waitFor();
    await settingsDrawer.getByRole('button', { name: '刷新分组与标签', exact: true }).click();
    const groupSelect = settingsDrawer.getByRole('combobox', { name: '选择窗口分组', exact: true });
    const tagSelect = settingsDrawer.getByRole('combobox', { name: '选择窗口标签', exact: true });
    await groupSelect.click();
    await page.getByRole('option', { name: '测试代理分组', exact: true }).click();
    await tagSelect.click();
    await page.getByRole('option', { name: '续费账号', exact: true }).click();
    await settingsDrawer
      .getByLabel('动态 IP 提取链接', { exact: true })
      .fill('https://new-proxy.example/extract');
    await settingsDrawer
      .locator('.el-select')
      .filter({ has: page.getByRole('combobox', { name: '选择操作系统', exact: true }) })
      .click();
    await page.getByRole('option', { name: 'Windows 电脑', exact: true }).click();
    await settingsDrawer
      .locator('.el-select')
      .filter({ has: page.getByRole('combobox', { name: '选择浏览器语言', exact: true }) })
      .click();
    await page.getByRole('option', { name: '英语（美国）', exact: true }).click();
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: '界面语言跟随 IP', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: '时区跟随 IP', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: '定位跟随 IP', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer.getByRole('spinbutton', { name: '定位纬度', exact: true }).fill('3.1');
    await settingsDrawer.getByRole('spinbutton', { name: '定位经度', exact: true }).fill('101.7');
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: '标签页同步', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: 'Cookie 同步', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer
      .locator('.el-switch')
      .filter({ has: page.getByRole('switch', { name: '本地存储同步', exact: true }) })
      .locator('.el-switch__core')
      .click();
    await settingsDrawer.screenshot({ path: resolve(evidence, `window-options-${width}.png`) });
    await settingsDrawer.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await settingsDrawer.getByText('测试代理分组', { exact: true }).isVisible(), true);
    assert.equal(await settingsDrawer.getByText('续费账号', { exact: true }).isVisible(), true);
    await settingsDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
    await settingsDrawer.getByRole('alert').filter({ hasText: '模拟设置保存失败' }).waitFor();
    assert.equal(
      await settingsDrawer.getByLabel('动态 IP 提取链接', { exact: true }).inputValue(),
      'https://new-proxy.example/extract'
    );
    await settingsDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
    await settingsDrawer.waitFor({ state: 'hidden' });
    assert.equal(settingsSaves, 2);
    assert.equal(currentSettings.browserOptions.os, 'Win32');
    assert.equal(currentSettings.browserOptions.language, 'en-US');
    assert.equal(currentSettings.browserOptions.displayLanguageFromIp, true);
    assert.equal(currentSettings.browserOptions.timezoneFromIp, false);
    assert.equal(currentSettings.browserOptions.positionFromIp, false);
    assert.equal(currentSettings.browserOptions.latitude, 3.1);
    assert.equal(currentSettings.browserOptions.longitude, 101.7);
    assert.equal(currentSettings.browserOptions.syncCookies, false);
    await page.getByRole('button', { name: '修改代理 IP 与窗口设置', exact: true }).click();
    await settingsDrawer.getByText('测试代理分组', { exact: true }).waitFor();
    assert.equal(
      await settingsDrawer.getByLabel('动态 IP 提取链接', { exact: true }).inputValue(),
      ''
    );
    assert.equal(await settingsDrawer.getByText('Windows 电脑', { exact: true }).isVisible(), true);
    if (width !== 1440) {
      await settingsDrawer
        .locator('.el-select')
        .filter({ has: page.getByRole('combobox', { name: '选择代理模式', exact: true }) })
        .click();
      await page.getByRole('option', { name: '固定代理', exact: true }).click();
      await settingsDrawer.getByLabel('固定代理主机', { exact: true }).fill('203.0.113.10');
      await settingsDrawer
        .getByRole('spinbutton', { name: '固定代理端口', exact: true })
        .fill('1080');
      await settingsDrawer.getByLabel('代理账号', { exact: true }).fill('fixture-proxy-user');
      await settingsDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
      await settingsDrawer.getByText('代理账号和密码请一起填写，或一起留空').first().waitFor();
      assert.equal(settingsSaves, 2);
      await settingsDrawer.getByLabel('代理密码', { exact: true }).fill('fixture-proxy-password');
      await settingsDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
      await settingsDrawer.waitFor({ state: 'hidden' });
      await page.getByText('固定代理 · HTTP · 203.0.113.10:1080', { exact: true }).waitFor();
      await page.getByRole('button', { name: '修改代理 IP 与窗口设置', exact: true }).click();
      await settingsDrawer
        .getByRole('switch', { name: '清除代理凭据', exact: true })
        .waitFor({ state: 'attached' });
      assert.equal(await settingsDrawer.getByLabel('代理密码', { exact: true }).inputValue(), '');
      assert.equal(
        await settingsDrawer.getByLabel('固定代理主机', { exact: true }).inputValue(),
        '203.0.113.10'
      );
      await settingsDrawer
        .locator('.el-switch')
        .filter({ has: page.getByRole('switch', { name: '清除代理凭据', exact: true }) })
        .locator('.el-switch__core')
        .click();
      await settingsDrawer.getByRole('button', { name: '保存设置', exact: true }).click();
      await settingsDrawer.waitFor({ state: 'hidden' });
      assert.equal(currentSettings.staticProxyCredentialsConfigured, false);
      await page.getByRole('button', { name: '修改代理 IP 与窗口设置', exact: true }).click();
      await settingsDrawer.getByLabel('固定代理主机', { exact: true }).waitFor();
    }
    await settingsDrawer
      .getByRole('combobox', { name: '选择代理模式', exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(await settingsDrawer.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await settingsDrawer.screenshot({ path: resolve(evidence, `settings-${width}.png`) });
    await settingsDrawer.getByRole('button', { name: '取消', exact: true }).click();
    await settingsDrawer.waitFor({ state: 'hidden' });
    const billingEmail = page.locator('.el-form-item').filter({
      has: page.locator('.el-form-item__label', { hasText: '账单邮箱' })
    });
    assert.equal(await billingEmail.locator('input').count(), 0);
    assert.equal(
      await billingEmail.evaluate((element) => element.classList.contains('is-required')),
      false
    );
    assert.equal(
      (await billingEmail.locator('.recharge-account-email').innerText()).trim(),
      '载入授权 JSON 后自动使用账号邮箱'
    );
    await page
      .getByPlaceholder('粘贴完整授权 JSON，将自动载入')
      .fill('{"sessionToken":"synthetic-only","user":{"email":"fixture@example.test"}}');
    await page.getByText('授权已自动载入', { exact: false }).waitFor();
    assert.equal(apiStarts, 0);
    assert.equal(connectorStarts, 0);

    await page.getByRole('textbox', { name: '窗口名称' }).fill('申请gpt-验收');
    await page.getByLabel('银行卡号').fill('5555555555554444');
    await page.getByLabel('持卡人姓名').fill('Fixture Person');
    await page.getByLabel('有效期').fill('1230');
    await page.getByLabel('安全码').fill('123');
    assert.equal(await page.getByLabel('有效期').inputValue(), '12/30');
    assert.equal(
      (await billingEmail.locator('.recharge-account-email').innerText()).trim(),
      'fixture@example.test'
    );
    await page.getByRole('combobox', { name: '选择未使用账单地址' }).click();
    await page.getByRole('option', { name: address.line1, exact: true }).click();
    await page.getByText('我已核对锁定币种和最高付款金额', { exact: false }).click();
    const startButton = page.getByRole('button', { name: '连接比特浏览器并执行本次充值' });
    assert.equal(await startButton.isEnabled(), true);
    blockHealth = true;
    await startButton.click();
    await page.locator('.recharge-error').filter({ hasText: '网页无法访问本机连接器' }).waitFor();
    assert.equal(apiStarts, 0);
    assert.equal(connectorStarts, 0);
    assert.equal(await page.getByLabel('银行卡号').inputValue(), '5555555555554444');
    blockHealth = false;
    await startButton.click();

    await page.getByRole('button', { name: '我已完成验证，继续原任务' }).waitFor();
    assert.equal(apiStarts, 1);
    assert.equal(connectorStarts, 1);
    assert.equal(await page.getByLabel('银行卡号').inputValue(), '5555555555554444');
    await page.getByRole('button', { name: '我已完成验证，继续原任务' }).click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(connectorResumes, 1);
    assert.equal(await page.getByLabel('银行卡号').inputValue(), '');
    assert.equal(serverStartBody.id, connectorStartBody.id);
    assert.equal(connectorStartBody.authorizeSinglePayment, true);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    assert.equal(overflow, false, `${width}px 页面横向溢出`);
    assert.deepEqual(errors, []);
    await billingEmail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidence, `${width}.png`), fullPage: true });
    await context.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      viewports: [1440, 768, 390],
      flow: [
        'automatic-local-json',
        'registered-email',
        'proxy-settings-save-retry',
        'settings-unsaved-close-guard',
        'saved-proxy-used-by-next-job',
        'existing-group-and-tag-dropdowns',
        'window-options-save-readback-and-launch',
        'static-proxy-credential-validation-and-clear',
        'catalog-failure-empty-retry',
        'blocked-connection-does-not-create-job',
        'default-plus',
        'unused-fixed-address',
        'currency-and-amount-lock',
        'server-metadata-only',
        'local-secrets-only',
        'human-verification-resume',
        'single-payment-attempt',
        'clear-card-after-attempt'
      ],
      realPaymentRequests: 0
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
