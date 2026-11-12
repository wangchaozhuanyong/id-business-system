import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const entry = '/#/workspace/renewals';
const api = '/api/local/subscription-card-';
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'synthetic-renewal-admin', name: '合成管理员', role: 'admin' };
const now = '2026-11-06T08:00:00Z';
const original = 'synthetic-original';
const renewed = 'synthetic-renewed';
const noCard = 'synthetic-no-card';
const upcoming = 'synthetic-upcoming';
const familyEmail = 'renewal-family@example.test';
const numbers = {
  [original]: '4242424242424242',
  [renewed]: '4000000000000002',
  [upcoming]: '5555555555554444'
};

function order(id, customerId, email, start, expiry, cardId = '') {
  return {
    id, orderNo: 'QA-' + id, customerId, email, start, expiry, cardId,
    product: 'GPT', plan: 'Plus', businessType: '续费', accountSource: '客户自有',
    source: '管理员手工', paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
    payment: '银行卡', paidAmount: '20', paidCurrency: 'USD',
    paymentId: numbers[id]?.slice(-4) || '', saleAmount: '180', saleCurrency: 'CNY',
    version: 1, corrections: [], financialEvidence: []
  };
}

function syntheticOrders() {
  return [
    order(original, 'customer-family', familyEmail, '2026-10-05T08:00:00Z', '2026-11-05T08:00:00Z', 'recharge:7'),
    order(renewed, 'customer-family', familyEmail, '2026-11-05T09:00:00Z', '2026-12-05T09:00:00Z', 'recharge:8'),
    order('synthetic-other-customer', 'customer-other', familyEmail, '2026-11-05T10:00:00Z', '2026-12-20T10:00:00Z', 'recharge:9'),
    order(noCard, 'customer-no-card', 'no-card@example.test', '2026-10-04T08:00:00Z', '2026-11-04T08:00:00Z'),
    order(upcoming, 'customer-upcoming', 'upcoming@example.test', '2026-10-07T04:00:00Z', '2026-11-07T04:00:00Z', 'recharge:10')
  ];
}

async function localFixtures() {
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  fixtures.commerce = {
    version: 1,
    data: {
      customers: [
        { id: 'customer-family', name: '合成续费客户', active: true },
        { id: 'customer-other', name: '合成同邮箱其他客户', active: true },
        { id: 'customer-no-card', name: '合成无卡客户', active: true },
        { id: 'customer-upcoming', name: '合成即将到期客户', active: true }
      ],
      orders: syntheticOrders(),
      tenants: [], operating: [], rentBatches: [], logs: [],
      renewalWarningDays: 1, renewalWarningHours: 24
    }
  };
  fixtures['subscription-card-estimates'] = { items: [] };
  return fixtures;
}

function detail(row) {
  return {
    id: row.id, version: row.version, orderNo: row.orderNo, payment: row.payment,
    account: { email: row.email, source: '客户自有', status: '未关联库存' },
    card: {
      source: row.cardId ? '充值卡池' : '未登记银行卡',
      typeName: row.id === original ? '原单合成类型' : row.id === renewed ? '续费合成类型'
        : row.id === upcoming ? '即将到期合成类型' : '未设置',
      last4: row.paymentId, status: row.cardId ? '可用' : '无卡资料',
      canReveal: Boolean(row.cardId),
      estimate: { amount: '20', currency: 'USD', fixedFee: '0.30', bufferUsd: '2.00', usd: '22.30' },
      balance: row.id === renewed ? { amount: '78.20', currency: 'USD', updatedAt: now } : null,
      paid: { amount: '20', currency: 'USD' }
    }
  };
}

test('续费银行卡抽屉按点击订单独立读取并保护卡号', { timeout: 65_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const module = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const { chromium } = module.default || module;
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    await t.test(width + 'px ' + theme, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
      try {
        const fixtures = await localFixtures();
        const mock = await interceptDesign(context, { localFixtures: fixtures, actor });
        await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async (value) => { window.qaCopied = value; } }
        }));
        const details = [];
        const reveals = [];
        const copies = [];
        let pendingReveal;
        let pendingDetails;
        let wrongCardNumber = false;
        const find = (id) => fixtures.commerce.data.orders.find((row) => row.id === id);
        const commandOf = (route) => {
          assert.equal(route.request().method(), 'POST');
          return route.request().postDataJSON();
        };
        await context.route(origin + api + 'details', async (route) => {
          const command = commandOf(route);
          details.push(command);
          const row = find(command.orderId);
          assert.ok(row);
          const response = { order: detail(row), renewal: command.renewalOrderId ? detail(find(command.renewalOrderId)) : null };
          if (pendingDetails && command.orderId === pendingDetails.id) {
            const request = pendingDetails;
            request.started.resolve();
            await request.release.promise;
            await route.fulfill({ json: response }).catch(() => {});
            request.finished.resolve();
            return;
          }
          return route.fulfill({ json: response });
        });
        await context.route(origin + api + 'reveal', async (route) => {
          const command = commandOf(route);
          reveals.push(command);
          const number = wrongCardNumber ? numbers[original] : numbers[command.orderId];
          assert.ok(number);
          if (pendingReveal && command.orderId === pendingReveal.id) {
            const request = pendingReveal;
            request.started.resolve();
            await request.release.promise;
            await route.fulfill({ json: { number } }).catch(() => {});
            request.finished.resolve();
            return;
          }
          return route.fulfill({ json: { number } });
        });
        await context.route(origin + api + 'copy', (route) => {
          const command = commandOf(route);
          copies.push(command);
          return route.fulfill({ json: { text: '合成卡片资料 / ' + numbers[command.orderId] } });
        });

        const page = await context.newPage();
        page.setDefaultTimeout(6500);
        await page.clock.setFixedTime(new Date(now));
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin + entry);
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const list = page.locator('[data-renewal-scroll]');
        const row = (id) => list.locator('button[data-id="' + id + '"]');
        const tab = (label) => page.getByRole('tab', { name: label });
        const search = page.locator('#commerce-search');
        const product = page.locator('#commerce-renewal-product');
        const drawer = page.locator('#drawer[open]');
        const panel = drawer.locator('#commerce-renewal-card-panel');
        const section = (kind) => panel.locator('[data-renewal-card-kind="' + kind + '"]');
        const openCard = async (id) => {
          const action = page.locator(`[data-action="commerce-renewal-card-open"][data-id="${id}"]`);
          if (!(await action.isVisible())) await row(id).click();
          await action.click();
        };
        const reveal = (kind) => section(kind).locator('[data-action="commerce-renewal-card-reveal"]');
        const revealed = (kind) => section(kind).locator('[data-renewal-card-number]');
        const close = async () => {
          await drawer.getByRole('button', { name: '关闭抽屉' }).click();
          await drawer.waitFor({ state: 'hidden' });
        };
        const waitForNumber = (kind, number) =>
          page.waitForFunction(({ kind, number }) => document.querySelector(
            '#drawer[open] [data-renewal-card-kind="' + kind + '"] [data-renewal-card-number]'
          )?.value === number, { kind, number });
        const startHeld = (id) => ({
          id, started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers()
        });

        await tab(/^已处理/).click();
        await product.selectOption('GPT');
        await search.fill('QA-' + original);
        await row(original).getByText('已续费', { exact: true }).waitFor();
        await openCard(original);
        await section('order').getByText('QA-' + original, { exact: true }).waitFor();
        await section('renewal').getByText('QA-' + renewed, { exact: true }).waitFor();
        assert.deepEqual(details.at(-1), { orderId: original, renewalOrderId: renewed });
        assert.equal(await section('order').getByText('原单合成类型', { exact: true }).count(), 1);
        assert.equal(await section('renewal').getByText('续费合成类型', { exact: true }).count(), 1);
        assert(!/余额|78\.20 USD/.test(await panel.innerText()), '即使旧接口带余额，也不展示银行卡余额');
        assert.equal(await section('renewal').getByText('22.30 USD', { exact: true }).count(), 1);
        assert.equal(await panel.getByText('QA-synthetic-other-customer', { exact: true }).count(), 0);
        assert.equal(await panel.evaluate((element) =>
          [...element.querySelectorAll('input')].some((input) => /\d{16}/.test(input.value))
        ), false, '读取详情不预加载完整卡号');
        assert.equal(reveals.length, 0);
        assert.equal(page.url(), origin + entry);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

        if (width === 1440) {
          wrongCardNumber = true;
          await reveal('renewal').click();
          await page.locator('#toast[data-kind="error"]:not([hidden])').waitFor();
          assert.equal(await revealed('renewal').inputValue(), '', '尾号不一致的返回值不显示');
          assert.equal(await revealed('renewal').isVisible(), false);
          wrongCardNumber = false;
        }
        await reveal('renewal').click();
        await waitForNumber('renewal', numbers[renewed]);
        assert.deepEqual(reveals.at(-1), { orderId: renewed, version: find(renewed).version });
        assert.equal(await revealed('order').inputValue(), '');
        assert.equal(await revealed('order').isVisible(), false);
        await section('renewal').locator('[data-action="commerce-copy-subscription-card"]').click();
        await page.waitForFunction((text) => window.qaCopied === text, '合成卡片资料 / ' + numbers[renewed]);
        assert.deepEqual(copies.at(-1), {
          orderId: renewed, cardId: 'recharge:8', context: 'renewal', version: find(renewed).version
        });
        const exposed = await revealed('renewal').elementHandle();
        await close();
        await page.waitForFunction((input) => !input.value && !input.getAttribute('value'), exposed);
        await exposed.dispose();
        assert.equal(await search.inputValue(), 'QA-' + original);
        assert.equal(await product.inputValue(), 'GPT');
        assert.equal(await tab(/^已处理/).getAttribute('aria-selected'), 'true');
        assert.equal(page.url(), origin + entry);

        if (width === 1440) {
          await openCard(original);
          await section('order').getByText('QA-' + original, { exact: true }).waitFor();
          pendingReveal = startHeld(original);
          try {
            await reveal('order').click();
            await pendingReveal.started.promise;
            await close();
            await search.fill('');
            await tab(/^已到期/).click();
            await openCard(noCard);
            await section('order').getByText('QA-' + noCard, { exact: true }).waitFor();
            assert.deepEqual(details.at(-1), { orderId: noCard });
            assert.equal(await reveal('order').count(), 0, '无银行卡资料时没有完整卡号入口');
            assert.equal(await section('renewal').count(), 0);
            pendingReveal.release.resolve();
            await pendingReveal.finished.promise;
            await settle(page);
            assert.equal(await revealed('order').count(), 0, '旧单迟到的卡号不能出现在新抽屉');
            assert.ok(!(await panel.innerText()).includes(numbers[original]));
          } finally {
            pendingReveal.release.resolve();
          }
          await close();

          await tab(/^已处理/).click();
          pendingDetails = startHeld(original);
          try {
            await openCard(original);
            await pendingDetails.started.promise;
            await close();
            await tab(/^即将到期/).click();
            await openCard(upcoming);
            await section('order').getByText('QA-' + upcoming, { exact: true }).waitFor();
            assert.deepEqual(details.at(-1), { orderId: upcoming });
            pendingDetails.release.resolve();
            await pendingDetails.finished.promise;
            await settle(page);
            assert.equal(await section('order').getByText('QA-' + original, { exact: true }).count(), 0);
            assert.equal(await section('renewal').count(), 0);
            assert.equal(page.url(), origin + entry);
          } finally {
            pendingDetails.release.resolve();
          }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(mock.external, []);
      } finally {
        await context.close();
      }
    });
  }
});
