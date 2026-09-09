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
        assert.equal(new URL(request.url()).searchParams.get('status'), 'unused');
        const addresses = addressUsed ? [] : [address];
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
        if (body.action === 'quote') {
          assert.equal(body.addressId, undefined);
          assert.equal(body.details, undefined);
        } else if (body.action === 'prepare') {
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
        }
        const amount = { currency: 'MYR', amount: '92.50', amount_minor: 9250 };
        items.unshift({
          id: body.id,
          plan: body.plan,
          action: body.action,
          state: body.action === 'prepare' ? 'awaiting_confirmation' : 'finished',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: {
            status: body.action === 'prepare' ? 'awaiting_confirmation' : 'checkout_quote_verified',
            account_matched: true,
            current_plan: 'free',
            checkout_identifier: 'cs_fixture',
            network: { ip: '203.0.113.10', country: 'MY' },
            quote: {
              plan: body.plan,
              today: amount,
              tax: null,
              renewal: amount,
              renewal_interval: 'monthly'
            },
            ...(body.action === 'prepare' ? { nonce: 'a'.repeat(64), card_last4: '4242' } : {})
          }
        });
        return success(route, { id: body.id });
      }
      if (path.endsWith('/confirm')) {
        confirms += 1;
        items[0].state = 'finished';
        items[0].result.status = 'subscription_activated';
        items[0].result.payment_status = 'paid';
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
    await page.getByPlaceholder('粘贴完整的授权 JSON').fill('{"sessionToken":"synthetic-only"}');
    await page.getByText('选择需要开通的套餐', { exact: true }).click();
    await page.getByRole('option', { name: 'ChatGPT Plus', exact: true }).click();
    await page.locator('.recharge-summary dd').filter({ hasText: 'MYR 92.50' }).first().waitFor();
    assert.equal(starts, 1);
    assert.equal(confirms, 0);
    const values = ['5555555555554444', 'Fixture Person', '12/30', '1234', 'fixture@example.test'];
    const fields = page.locator('fieldset input');
    for (let index = 0; index < values.length; index += 1)
      await fields.nth(index).fill(values[index]);
    await page.getByRole('combobox', { name: '选择未使用账单地址' }).click();
    await page.getByRole('option', { name: address.line1, exact: true }).click();
    await page.getByText('国家：United States（US）', { exact: true }).waitFor();
    await page.getByText('开通信息', { exact: true }).click();
    await page.locator('.recharge-confirm').waitFor();
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
    await context.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      viewports: [1440, 768, 390],
      flow: [
        'quote',
        'unused-address-selection',
        'fixed-us-location',
        'prepare',
        'amount-confirmation',
        'subscription-activated',
        'address-consumed'
      ],
      realPaymentRequests: 0
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
