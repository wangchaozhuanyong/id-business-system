import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, interceptRenewalWorktable, origin, settle } from './helpers/offline-design.mjs';

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
    paymentId: numbers[id]?.slice(-4) || (id === noCard ? '5678' : ''), saleAmount: '180', saleCurrency: 'CNY',
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
      canReveal: Boolean(row.cardId), ...(numbers[row.id] && { number: numbers[row.id] }),
      estimate: { amount: '20', currency: 'USD', fixedFee: '0.30', bufferUsd: '2.00', usd: '22.30' },
      balance: row.id === renewed ? { amount: '78.20', currency: 'USD', updatedAt: now } : null,
      paid: { amount: '20', currency: 'USD' }
    }
  };
}

test('续费银行卡抽屉直接显示原单与续费单完整卡号', { timeout: 65_000 }, async (t) => {
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
        await interceptRenewalWorktable(context, { localFixtures: fixtures, actor, clock: () => Date.parse(now) });
        await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async (value) => { window.qaCopied = value; } }
        }));
        const details = [];
        const copies = [];
        let pendingDetails;
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
        const list = page.locator('[data-renewal-list]');
        const row = (id) => list.locator('tr[data-row-id="' + id + '"]');
        const period = page.locator('#renewal-handoff-period');
        const search = page.locator('#renewal-handoff-search');
        const product = page.locator('#renewal-handoff-product');
        const drawer = page.locator('#drawer[open]');
        const panel = drawer.locator('#commerce-renewal-card-panel');
        const section = (kind) => panel.locator('[data-renewal-card-kind="' + kind + '"]');
        const openCard = async (id) => {
          await row(id).getByRole('button', { name: '更多操作', exact: true }).click();
          await page.getByRole('menuitem', { name: '用卡详情', exact: true }).click();
        };
        const cardNumber = (kind) => section(kind).locator('[data-renewal-card-number]');
        const close = async () => {
          await drawer.getByRole('button', { name: '关闭抽屉' }).click();
          await drawer.waitFor({ state: 'hidden' });
        };
        const startHeld = (id) => ({
          id, started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers()
        });

        await period.selectOption('renewed');
        await product.selectOption('GPT');
        await search.fill('QA-' + original);
        await row(original).waitFor();
        await openCard(original);
        await section('order').getByText('QA-' + original, { exact: true }).waitFor();
        await section('renewal').getByText('QA-' + renewed, { exact: true }).waitFor();
        assert.deepEqual(details.at(-1), { orderId: original, renewalOrderId: renewed });
        assert.equal(await section('order').getByText('原单合成类型', { exact: true }).count(), 1);
        assert.equal(await section('renewal').getByText('续费合成类型', { exact: true }).count(), 1);
        assert(!/余额|78\.20 USD/.test(await panel.innerText()), '即使旧接口带余额，也不展示银行卡余额');
        assert.equal(await section('renewal').getByText('22.30 USD', { exact: true }).count(), 1);
        assert.equal(await panel.getByText('QA-synthetic-other-customer', { exact: true }).count(), 0);
        assert.equal(await cardNumber('order').textContent(), numbers[original]);
        assert.equal(await cardNumber('renewal').textContent(), numbers[renewed]);
        assert.equal(await panel.getByRole('button', { name: '显示完整卡号' }).count(), 0);
        assert.equal(await cardNumber('renewal').isVisible(), true);
        assert.equal(page.url(), origin + entry);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

        await section('renewal').locator('[data-action="commerce-copy-subscription-card"]').click();
        await page.waitForFunction((text) => window.qaCopied === text, '合成卡片资料 / ' + numbers[renewed]);
        assert.deepEqual(copies.at(-1), {
          orderId: renewed, cardId: 'recharge:8', context: 'renewal', version: find(renewed).version
        });
        const exposed = await cardNumber('renewal').elementHandle();
        await close();
        await page.waitForFunction((node) => !node.textContent, exposed);
        await exposed.dispose();
        assert.equal(await search.inputValue(), 'QA-' + original);
        assert.equal(await product.inputValue(), 'GPT');
        assert.equal(await period.inputValue(), 'renewed');
        assert.equal(page.url(), origin + entry);

        if (width === 1440) {
          await search.fill('');
          await period.selectOption('expired');
          await openCard(noCard);
          await section('order').getByText('QA-' + noCard, { exact: true }).waitFor();
          assert.deepEqual(details.at(-1), { orderId: noCard });
          assert.equal(await cardNumber('order').textContent(), '完整卡号待核对');
          assert.equal(await section('order').getByText('5678', { exact: true }).count(), 0);
          assert.equal(await section('renewal').count(), 0);
          await close();

          await period.selectOption('renewed');
          pendingDetails = startHeld(original);
          try {
            await openCard(original);
            await pendingDetails.started.promise;
            await close();
            await period.selectOption('upcoming');
            await openCard(upcoming);
            await section('order').getByText('QA-' + upcoming, { exact: true }).waitFor();
            assert.deepEqual(details.at(-1), { orderId: upcoming });
            pendingDetails.release.resolve();
            await pendingDetails.finished.promise;
            await settle(page);
            assert.equal(await section('order').getByText('QA-' + original, { exact: true }).count(), 0);
            assert.equal(await section('renewal').count(), 0);
            assert.equal(await cardNumber('order').textContent(), numbers[upcoming]);
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
