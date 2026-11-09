import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { interceptDesign, origin } from './helpers/offline-design.mjs';

const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'qa-card-admin', name: '合成管理员', role: 'admin' };
const pan = '4242424242424242';
const hour = 3_600_000;
const instant = (at, hours) => new Date(at + hours * hour).toISOString();

async function fixture() {
  const data = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { orders, customers } = data.commerce.data;
  const original = { ...orders[0], cardId: 'recharge:7', payment: '银行卡', paymentId: '4242',
    product: 'GPT', plan: 'Plus', source: '手工录单', paidConfirmed: true, paidAmount: '10000', paidCurrency: 'PHP',
    businessType: '续费', accountSource: '客户自有', accountId: '', version: 1, cancelled: false,
    corrections: [], financialEvidence: [] };
  const at = Date.now();
  const row = (id, customerId, email, start, expiry, cardId = 'recharge:7') => ({
    ...original, id, orderNo: 'QA-' + id, customerId, email, start: instant(at, start), expiry: instant(at, expiry), cardId
  });
  orders.splice(0, orders.length,
    row('expired', customers[0].id, 'expired@example.test', -720, -6),
    row('switch-old', customers[0].id, 'switch@example.test', -720, 5),
    row('switch-new', customers[0].id, 'switch@example.test', -5, 240, 'recharge:8'),
    row('upcoming', customers[1].id, 'upcoming@example.test', -720, 48),
    row('history', customers[1].id, 'upcoming@example.test', -1450, -721),
    row('no-card', customers[0].id, 'no-card@example.test', -4, 40, ''),
    ...Array.from({ length: 8 }, (_, i) => row('active-' + i, customers[0].id, 'active-' + i + '@example.test', -500, 260 + i, 'recharge:' + (100 + i))));
  data['card-types'] = { version: 1, items: [{ id: 'a', name: 'wise潘', active: true }],
    assignments: { 'recharge:7': 'a' } };
  data['subscription-card-estimates'] = { items: orders.filter(order => order.cardId).map(order => ({
    id: order.id, version: order.version, amount: '10000', currency: 'PHP', usd: '175.92', source: 'ExchangeRate-API',
    quotedAt: instant(at, -1), expiresAt: instant(at, 12), fixedFee: '0.30', bufferUsd: '2.00'
  })) };
  return data;
}

test('银行卡管理与续费共用复制、筛选、分组和预计金额', { timeout: 75_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [1440, true], [390, false], [390, true]]) {
    await t.test(width + (dark ? ' 深色' : ' 浅色'), async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
      try {
        const localFixtures = await fixture();
        const mock = await interceptDesign(context, { localFixtures, actor });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', { value: {
            async writeText(text) {
              if (window.qaRejectClipboard) throw new Error('合成剪贴板权限拒绝');
              window.qaCopied = text;
              window.qaCopies = (window.qaCopies || 0) + 1;
            }
          } });
        });
        let failEstimates = true;
        await context.route('**/api/local/subscription-card-estimates', route => failEstimates
          ? route.fulfill({ status: 503, json: { error: '合成读取失败' } }) : route.fallback());
        await context.route('**/api/local/subscription-card-details', route => {
          const { orderId } = route.request().postDataJSON();
          const order = localFixtures.commerce.data.orders.find(row => row.id === orderId);
          const estimate = localFixtures['subscription-card-estimates'].items.find(row => row.id === orderId);
          return route.fulfill({ json: { order: { id: order.id, version: order.version, orderNo: order.orderNo, payment: order.payment,
            account: { email: order.email, source: '客户自有', status: '由客户管理' },
            card: { source: '充值卡池', typeName: 'wise潘', last4: '4242', status: '可用',
              canReveal: true, estimate, balance: null } }, renewal: null } });
        });
        const copied = [];
        await context.route('**/api/local/subscription-card-copy', route => {
          const command = route.request().postDataJSON();
          copied.push(command);
          return route.fulfill({ json: { text: 'wise潘 / ' + pan + ' / GPT Plus / 175.92 USD' } });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5500);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/data-management/bank-cards');
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, dark ? 'dark' : 'light');
        await page.getByRole('heading', { name: '银行卡管理', exact: true }).waitFor();
        assert.equal(await page.locator('.nav-child[href="#/data-management/bank-cards"]').count(), 1);
        assert.equal(await page.locator('.nav-heading[title="数据管理"]').count(), 1);
        await page.getByText('部分银行卡类型或预计金额暂时无法读取').waitFor();
        failEstimates = false;
        await page.getByRole('button', { name: '重试', exact: true }).click();
        const list = page.locator('table[data-table="commerce-subscription-cards"]');
        const rows = list.locator('tbody tr[data-row-id]');
        const expired = list.locator('[data-row-id="expired"]');
        const upcoming = list.locator('[data-row-id="upcoming"]');
        await expired.getByText('175.92 USD').waitFor();
        assert.equal(await expired.getByText('已过期', { exact: true }).count(), 1);
        assert.equal(await upcoming.getByText('即将到期', { exact: true }).count(), 1);
        assert.equal(await list.locator('[data-row-id="switch-old"]').getByText('历史用卡').count(), 1);
        assert.equal(await list.locator('[data-row-id="switch-new"]').getByText('使用中').count(), 1);
        assert.equal(await list.getByText('no-card@example.test').count(), 0);
        assert.ok(!(await list.innerText()).includes(pan));
        assert.equal(await rows.count(), 8);
        const copyButton = expired.getByRole('button', { name: '复制', exact: true });
        await copyButton.scrollIntoViewIfNeeded();
        assert.equal(await copyButton.evaluate(button => {
          const rect = button.getBoundingClientRect();
          const table = button.closest('.table-viewport').getBoundingClientRect();
          return rect.left >= table.left - 1 && rect.right <= Math.min(innerWidth, table.right) + 1;
        }), true);
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await rows.count(), 4);
        assert.ok(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
        await page.getByLabel('使用状态', { exact: true }).selectOption('upcoming');
        assert.equal(await rows.count(), 1);
        await upcoming.getByRole('button', { name: '详情', exact: true }).click();
        const drawer = page.locator('#drawer');
        await drawer.getByText('银行卡详情', { exact: true }).waitFor();
        assert.equal(await drawer.getByText('QA-history', { exact: true }).count(), 1);
        assert.equal(await drawer.getByText('10000 PHP', { exact: true }).count(), 1);
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await upcoming.getByRole('button', { name: '复制', exact: true }).click();
        await page.waitForFunction(value => window.qaCopied === value, 'wise潘 / ' + pan + ' / GPT Plus / 175.92 USD');
        assert.deepEqual(copied[0], { orderId: 'upcoming', cardId: 'recharge:7' });
        await page.getByLabel('搜索当前列表').fill('不匹配的检索词');
        await page.getByText('暂无符合条件的记录').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        await page.goto(origin + '/#/workspace/renewals');
        const renewalRow = page.locator('table[data-table="commerce-renewals"] [data-row-id="upcoming"]');
        await renewalRow.getByRole('button', { name: '银行卡', exact: true }).click();
        await drawer.getByRole('button', { name: '复制账号', exact: true }).click();
        await page.waitForFunction(() => window.qaCopied === 'upcoming@example.test');
        const renewalCopy = drawer.getByRole('button', { name: '复制银行卡资料', exact: true });
        await renewalCopy.click();
        await page.waitForFunction(() => window.qaCopies === 3);
        assert.equal(copied[1].orderId, copied[0].orderId);
        assert.equal(copied[1].context, 'renewal');
        assert.equal(copied[1].version, 1);
        if (width === 1440 && !dark) {
          await page.evaluate(() => { window.qaRejectClipboard = true; });
          await renewalCopy.click();
          const fallback = drawer.getByLabel('待复制内容');
          await fallback.waitFor();
          assert.ok((await fallback.inputValue()).includes(pan));
          await drawer.getByRole('button', { name: '关闭', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('#drawer textarea.copy-block')?.textContent);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(mock.external, []);
      } finally { await context.close(); }
    });
  }
});
