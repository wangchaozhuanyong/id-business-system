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
    let failNext = false;
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
      if (path.endsWith('/auto-recharge/jobs') && request.method() === 'POST') {
        starts += 1;
        const body = request.postDataJSON();
        if (failNext) {
          failNext = false;
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              message: '已有原单，请先复查',
              retryable: false
            })
          });
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
            status:
              body.action === 'check'
                ? 'session_verified'
                : body.action === 'prepare'
                  ? 'awaiting_confirmation'
                  : 'checkout_quote_verified',
            account_matched: true,
            current_plan: 'free',
            checkout_identifier: 'cs_fixture',
            network: { ip: '203.0.113.10', country: 'MY' },
            quote:
              body.action === 'check'
                ? undefined
                : {
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
        items[0].result.status = 'payment_result_unknown';
        items[0].result.payment_status = 'unknown';
        return success(route, {});
      }
      if (path.endsWith('/change-versions'))
        return success(route, { generatedAt: new Date().toISOString(), versions: {} });
      if (path.endsWith('/change-events')) return route.abort();
      return success(route, {});
    });
    await page.goto(origin + '/v2/auto-recharge');
    await page
      .getByText('账户与付款资料', { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `页面未就绪: ${page.url()}; ${await page.locator('body').innerText()}; ${errors.join(';')}`,
          { cause: error }
        );
      });
    await page.getByText('尚无执行记录。输入 JSON 后点击“开始检查”。').waitFor();
    await page
      .getByPlaceholder('粘贴完整 JSON，载入后清空输入框')
      .fill('{"sessionToken":"synthetic-only"}');
    await page.getByRole('button', { name: '开始检查', exact: true }).click();
    await page.locator('.recharge-status').filter({ hasText: '账户核对通过' }).waitFor();
    assert.equal(starts, 1);
    assert.equal(await page.getByPlaceholder('粘贴完整 JSON，载入后清空输入框').inputValue(), '');
    await page.getByRole('button', { name: '获取官方报价', exact: true }).click();
    await page.locator('.recharge-summary dd').filter({ hasText: 'MYR 92.50' }).first().waitFor();
    assert.equal(confirms, 0);
    const values = [
      '4242424242424242',
      '12/30',
      '123',
      'Fixture Person',
      'fixture@example.test',
      'MY',
      'Fixture Road',
      '',
      'Fixture City',
      '',
      '12345'
    ];
    const fields = page.locator('fieldset input');
    for (let index = 0; index < values.length; index += 1)
      await fields.nth(index).fill(values[index]);
    await page.getByRole('button', { name: '填入官网并重新核价' }).click();
    await page.locator('.recharge-confirm').waitFor();
    assert.equal(await fields.nth(0).inputValue(), '');
    assert.equal(await fields.nth(2).inputValue(), '');
    assert.equal(confirms, 0);
    const confirm = page.getByRole('button', { name: '确认开通 · MYR 92.50' });
    assert.equal(await confirm.isEnabled(), false);
    await page
      .getByText('我已核对今日应付、账单资料及按月续费，授权本次付款。', { exact: true })
      .click();
    assert.equal(await page.getByRole('checkbox').isChecked(), true);
    await confirm.click();
    await page.locator('.recharge-status').filter({ hasText: '付款结果待核验' }).waitFor();
    assert.equal(confirms, 1);
    failNext = true;
    await page.getByRole('button', { name: '复查所选套餐原付款' }).click();
    await page.getByText('已有原单，请先复查', { exact: true }).waitFor();
    assert.equal(confirms, 1);
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
        'empty',
        'account-check',
        'quote',
        'prepare',
        'amount-confirmation',
        'unknown-result',
        'error'
      ],
      realPaymentRequests: 0
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
