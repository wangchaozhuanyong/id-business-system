/* global document */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5397';
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
  {
    cwd: resolve('apps/admin'),
    stdio: 'ignore'
  }
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
try {
  await waitFor(async () => (await fetch(origin).catch(() => null))?.ok);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript((user) => {
      localStorage.setItem('apple_business_access_token', 'browser-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(user));
    }, user);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const items = [];
    let starts = 0;
    let detailSubmissions = 0;
    let confirms = 0;
    let addressUsed = false;
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
    const success = (route, data) =>
      route.fulfill({
        contentType: 'application/json',
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
        return success(route, { items, configured: true });
      if (path.endsWith('/auto-recharge/addresses') && request.method() === 'GET') {
        const requestedStatus = new URL(request.url()).searchParams.get('status');
        const usedAddress = {
          ...address,
          status: 'used',
          usedAt: new Date().toISOString()
        };
        const addresses =
          requestedStatus === 'unused'
            ? addressUsed
              ? []
              : [address]
            : addressUsed
              ? [usedAddress]
              : [address];
        return success(route, {
          items: addresses,
          total: addresses.length,
          page: 1,
          pageSize: 2000,
          totals: { unused: addresses.length, used: addressUsed ? 1 : 0, disabled: 0 }
        });
      }
      if (path.endsWith('/auto-recharge/jobs') && request.method() === 'POST') {
        starts += 1;
        const body = request.postDataJSON();
        assert.equal(body.action, 'flow');
        assert.equal(body.addressId, undefined);
        assert.equal(body.details, undefined);
        const amount = { currency: 'MYR', amount: '92.50', amount_minor: 9250 };
        items.unshift({
          id: body.id,
          plan: body.plan,
          action: body.action,
          state: 'awaiting_details',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: {
            status: 'checkout_ready_for_billing',
            account_matched: true,
            current_plan: 'free',
            checkout_identifier: 'cs_fixture',
            network: { ip: '203.0.113.10', country: 'MY' },
            initial_quote: {
              plan: body.plan,
              today: null,
              tax: null,
              renewal: amount,
              renewal_interval: 'monthly'
            }
          }
        });
        return success(route, { id: body.id });
      }
      if (path.endsWith('/details') && request.method() === 'POST') {
        detailSubmissions += 1;
        const body = request.postDataJSON();
        assert.equal(body.addressId, address.id);
        assert.deepEqual(
          {
            country: body.details.country,
            line1: body.details.line1,
            line2: body.details.line2,
            city: body.details.city,
            state: body.details.state,
            postal_code: body.details.postal_code
          },
          {
            country: 'US',
            line1: address.line1,
            line2: '',
            city: 'Portland',
            state: 'OR',
            postal_code: '97204'
          }
        );
        assert.equal(body.details.email, 'fixture@example.test');
        const amount = { currency: 'MYR', amount: '92.50', amount_minor: 9250 };
        const tax = { currency: 'MYR', amount: '0.00', amount_minor: 0 };
        items[0].state = 'awaiting_confirmation';
        items[0].result = {
          ...items[0].result,
          status: 'awaiting_confirmation',
          stage: 'payment_ready',
          quote: {
            plan: items[0].plan,
            today: amount,
            tax,
            renewal: amount,
            renewal_interval: 'monthly'
          },
          quote_authority: 'official_checkout_response',
          nonce: 'a'.repeat(64),
          card_last4: '4444'
        };
        return success(route, { id: items[0].id });
      }
      if (path.endsWith('/confirm')) {
        confirms += 1;
        items[0].state = 'finished';
        items[0].result.status = 'subscription_activated';
        items[0].result.payment_status = 'paid';
        items[0].result.payment_attempted = true;
        items[0].result.subscription_status = 'plus';
        addressUsed = true;
        return success(route, {});
      }
      if (path.endsWith('/change-versions'))
        return success(route, { generatedAt: new Date().toISOString(), versions: {} });
      if (path.endsWith('/change-events')) return route.abort();
      return success(route, {});
    });
    await page.goto(origin + '/v2/auto-recharge');
    await page
      .getByText('填写开通资料', { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `页面未就绪: ${page.url()}; ${await page.locator('body').innerText()}; ${errors.join(';')}`,
          { cause: error }
        );
      });
    await page.locator('.recharge-plan-row').getByText('ChatGPT Plus', { exact: true }).waitFor();
    await page
      .getByPlaceholder('粘贴完整授权 JSON，将自动载入')
      .fill('{"sessionToken":"synthetic-only","user":{"email":"fixture@example.test"}}');
    await page.getByText('授权已自动载入', { exact: false }).waitFor();
    await page.locator('.recharge-json-row input[type="password"]').blur();
    assert.equal(await page.getByText('请粘贴完整的单账户授权 JSON', { exact: true }).count(), 0);
    assert.equal(starts, 0);
    const fields = page.locator('fieldset input');
    assert.equal(await fields.nth(0).isEnabled(), true);
    const values = ['5555555555554444', 'Fixture Person', '1230', '1234'];
    for (let index = 0; index < values.length; index += 1)
      await fields.nth(index).fill(values[index]);
    assert.equal(await fields.nth(2).inputValue(), '12/30');
    assert.equal(await fields.nth(4).inputValue(), 'fixture@example.test');
    assert.equal(await fields.nth(4).isEditable(), false);
    await page.getByRole('combobox', { name: '选择未使用账单地址' }).click();
    await page.getByRole('option', { name: address.line1, exact: true }).click();
    await page.getByText('国家：United States（US）', { exact: true }).waitFor();
    assert.equal(starts, 0);
    const quoteButton = page.getByRole('button', { name: '获取初始报价' });
    if (width > 640) {
      const alignment = await page.locator('.recharge-plan-row').evaluate((row) => {
        const button = row.querySelector('button');
        return {
          rowRight: row.getBoundingClientRect().right,
          buttonRight: button?.getBoundingClientRect().right ?? 0
        };
      });
      assert.ok(Math.abs(alignment.rowRight - alignment.buttonRight) <= 1);
    }
    await quoteButton.click();
    await page
      .getByText('官网需要账单地址才能确定税费和总额，请填写资料后继续。', { exact: true })
      .waitFor();
    assert.equal(starts, 1);
    assert.equal(detailSubmissions, 0);
    assert.equal(confirms, 0);
    await page.getByRole('button', { name: '填写官网并计算最终金额' }).click();
    await page.locator('.recharge-confirm').waitFor();
    assert.equal(detailSubmissions, 1);
    assert.equal(await fields.nth(0).inputValue(), '');
    assert.equal(await fields.nth(2).inputValue(), '');
    assert.equal(confirms, 0);
    const confirm = page.getByRole('button', { name: '确认充值 · MYR 92.50' });
    assert.equal(await confirm.isEnabled(), true);
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '开通成功' }).waitFor();
    assert.equal(confirms, 1);
    await waitFor(
      async () => (await page.getByText('没有未使用地址', { exact: true }).count()) > 0
    );
    assert.equal(await page.getByRole('combobox', { name: '选择未使用账单地址' }).inputValue(), '');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    assert.equal(overflow, false, `${width}px 页面横向溢出`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(evidence, `${width}.png`), fullPage: true });

    await page.goto(origin + '/v2/auto-recharge/addresses');
    await page
      .locator('.recharge-address-import .v2-section-heading__text')
      .getByText('批量导入', { exact: true })
      .waitFor();
    assert.equal(await page.locator('.recharge-address-import > *').count(), 2);
    assert.equal(await page.locator('.recharge-address-import .el-alert').count(), 0);
    assert.equal(
      await page
        .locator('.recharge-address-import .el-form-item__label')
        .getByText('固定地区', { exact: true })
        .count(),
      0
    );
    const helpButton = page.locator('.recharge-address-import .feature-help');
    await helpButton.click();
    await page
      .getByText('仅支持 TXT 文件，每行填写一个街道地址，每次最多 2000 行。', { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      ),
      false,
      `${width}px 地址管理页面横向溢出`
    );
    await page.screenshot({ path: resolve(evidence, `${width}-addresses.png`), fullPage: true });
    await context.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      viewports: [1440, 768, 390],
      flow: [
        'automatic-local-json',
        'default-plus',
        'early-payment-entry',
        'registered-email',
        'explicit-initial-quote',
        'unused-address-selection',
        'fixed-us-location',
        'explicit-details-and-final-quote',
        'amount-confirmation',
        'subscription-activated',
        'address-consumed',
        'compact-address-import',
        'address-import-help'
      ],
      realPaymentRequests: 0
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
