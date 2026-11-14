import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const fixtureReference = '11111111-1111-4111-8111-111111111111';
const fixtureTicket = 'a'.repeat(43);

test('partner admin issues and copies only the scoped key and codes with the shared navigation and mobile layout',
  { timeout: 30_000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const actor = { id: 'fixture-super', role: 'super', name: '管理员', email: 'admin@example.test' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const access = await interceptDesign(context, { actor, localFixtures: {}, rechargePartnerApi: true, skipRechargeAssets: true });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.fixtureCopied = value; } } });
    });
    const source = { apiOrigin: origin, apiBase: origin + '/api/recharge/v1', partners: [], batches: [], page: 1, pages: 1 };
    const key = 'synthetic-api-key-only';
    const code = 'RA-' + 'A'.repeat(32);
    const partner = { id: 'rp_' + 'b'.repeat(24), name: '测试合作方', createdAt: '2026-11-14T12:00:00Z' };
    const actions = [];
    await context.route('**/api/local/recharge-partners*', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: source });
      const input = route.request().postDataJSON();
      actions.push(input);
      if (input.action === 'create') {
        source.partners.push(partner);
        return route.fulfill({ status: 201, json: { partner, apiKey: key } });
      }
      const batch = { id: 'synthetic-batch', partnerId: partner.id, plan: 'plus', batchNo: 'PO000001', codes: [code] };
      source.batches.push(batch);
      return route.fulfill({ status: 201, json: { batch } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/online-recharge/partners');
    await page.getByLabel('合作方名称', { exact: true }).fill(partner.name);
    await page.getByRole('button', { name: '创建合作方', exact: true }).click();
    await page.getByRole('button', { name: '复制接入资料', exact: true }).click();
    await page.waitForFunction(value => window.fixtureCopied?.includes(value), key);
    assert(!(await page.locator('body').innerText()).includes(key));
    await page.locator('[data-action="recharge-partner-close"]').click();
    assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
    await page.getByLabel('合作方', { exact: true }).selectOption(partner.id);
    await page.getByRole('button', { name: '发放兑换码', exact: true }).click();
    await page.getByRole('button', { name: '复制兑换码', exact: true }).click();
    await page.waitForFunction(value => window.fixtureCopied === value, code);
    assert.deepEqual(actions.map(input => input.action), ['create', 'issue']);
    assert(actions.every(input => Boolean(input.operationId)));
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.getByRole('button', { name: '复制兑换码', exact: true }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.deepEqual(access.external, []);
  });

test('ID authorization page shows the account locally, posts consent once, and clears the form on an uncertain result',
  { timeout: 30_000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const html = await readFile(new URL('../frontend/recharge-partner-authorize.html', import.meta.url));
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 850 } });
      const source = await interceptDesign(context, { skipRechargeAssets: true });
      await context.route('**/recharge/authorize', route => route.fulfill({ body: html, contentType: 'text/html' }));
      let writes = 0, status = 'awaiting_authorization';
      await context.route('**/recharge/authorize/request', route => {
        const input = route.request().postDataJSON();
        assert.equal(input.id, fixtureReference);
        assert.equal(input.ticket, fixtureTicket);
        if (input.session) {
          writes++;
          status = 'queued';
          return route.fulfill({ status: 503, json: {} });
        }
        return route.fulfill({ json: { id: fixtureReference, partner: '测试合作方', plan: 'plus', status } });
      });
      const page = await context.newPage();
      await page.goto(origin + '/recharge/authorize#' + fixtureReference + '.' + fixtureTicket);
      const form = page.locator('#authorization-form');
      const textarea = page.getByLabel('目标 ChatGPT 账号授权资料');
      await textarea.fill(JSON.stringify({ user: { id: 'synthetic', email: 'local@example.test' },
        accessToken: 'only-for-offline-browser-test' }));
      assert.equal(await page.locator('#authorization-account').textContent(), '目标账号 l***@example.test');
      await page.getByRole('button', { name: '授权并提交充值' }).click();
      assert.equal(writes, 0);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '授权并提交充值' }).click();
      await page.getByText('无法确认提交结果，请查询原请求。').waitFor();
      assert(!(await form.isVisible()));
      assert.equal(await textarea.inputValue(), '');
      await page.getByRole('button', { name: '查询进度' }).click();
      await page.getByText('已受理，等待执行。').waitFor();
      assert.equal(writes, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(source.external, []);
      await context.close();
    }
  });
