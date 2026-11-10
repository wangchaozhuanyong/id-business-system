import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { interceptDesign, origin, settle, spacingSnapshot } from './helpers/offline-design.mjs';

const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const actor = { id: 'fixture', name: '离线验收管理员', role: 'admin' };
const clock = Date.parse('2026-11-10T08:00:00Z');
const rules = { version: 1, currency: 'CNY', cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' };
const cardId = 'recharge:1';
function order(id, day, fields) {
  const date = '2026-11-0' + day;
  const item = {
    id, orderNo: 'SYN-' + id.toUpperCase(), email: id + '@example.test', customerId: 'fixture-customer',
    product: 'GPT', plan: 'Plus', businessType: '续费', source: '管理员手工', cardId, paymentId: '1234',
    start: date + 'T12:00', expiry: '2026-12-03T12:00', createdAt: date + 'T12:00',
    payment: '银行卡', paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '140', saleCurrency: 'CNY',
    paidConfirmed: true, receiptConfirmed: true, costConfirmed: true, costBasis: 'standard',
    costSettings: { ...rules }, issueFeeSnapshot: { cardId, applied: false }, version: 1,
    refunds: [], bankReturns: [], corrections: [], ...fields
  };
  item.fxSnapshot = createOrderSnapshot({
    source: '隔离结算凭据 QA-' + id,
    basis: item.costBasis === 'actual' ? 'settlement' : 'reference',
    at: date + 'T00:00', expiresAt: date + 'T23:59',
    rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' }
  }, item, clock);
  return item;
}
const fixtures = () => ({
  commerce: { version: 1, data: {
    orders: [
      order('a', 3, { issueFeeSnapshot: { cardId, applied: true, amountUsd: '0.5' } }),
      order('b', 4, { costBasis: 'actual', actualCostAmount: '110', actualCostCurrency: 'CNY' }),
      order('c', 5, { receiptConfirmed: false }),
      order('unverified', 5, { cardId: 'recharge:2', issueFeeSnapshot: { cardId: 'recharge:2', applied: false, pending: true } })
    ],
    customers: [{ id: 'fixture-customer', name: '合成客户', active: true }],
    tenants: [], operating: [], rentBatches: [], logs: []
  } },
  settings: { version: 1, data: { costSettings: rules } }
});

test('订单统计汇总与原单分摊一致，来源筛选不改变同卡开通笔数', { timeout: 25_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [390, true]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async (t) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor, localFixtures: fixtures() });
      const page = await context.newPage();
      await page.clock.install({ time: new Date(clock) });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(5500);
      await page.goto(origin + '/#/orders/statistics');
      if (dark) await page.locator('#theme-toggle').click();
      await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
      const summary = page.locator('#main .summary-strip');
      const product = page.locator('table[data-table="commerce-product-statistics"] tbody tr[data-row-id="GPT"]');
      await product.locator('[data-column="actual"]').getByText('30.00', { exact: true }).waitFor();
      await product.locator('[data-column="reference"]').getByText('10.6398', { exact: true }).waitFor();
      assert.match(await summary.textContent(), /40\.6398/);
      assert.equal(await product.locator('[data-column="pending"]').textContent(), '2');
      await settle(page);
      assert.deepEqual((await spacingSnapshot(page)).findings, []);

      await page.getByRole('tab', { name: '来源订单' }).click();
      await page.locator('#commerce-search').fill('SYN-A');
      await page.getByText('参考核算', { exact: true }).waitFor();
      const source = page.locator('tr[data-row-id="a"]');
      await source.getByRole('button', { name: '查看原单', exact: true }).click();
      const drawer = page.locator('#drawer[open]');
      await drawer.getByRole('tab', { name: '成本与汇率' }).click();
      await drawer.getByText(/同卡已确认开通 3 单.*本单份额 0\.1667 USD/).waitFor();
      await drawer.getByText(/8\.0000 PHP.*折合/).waitFor();
      await drawer.getByText(/0\.3000 USD.*折合/).waitFor();
      await drawer.getByText(/10\.6398 人民币/).waitFor();
      await drawer.getByText('历史市场参考报价', { exact: true }).waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.locator('#commerce-search').fill('');
      await page.getByRole('tab', { name: '待核算' }).click();
      await page.getByText('同卡开卡费凭据缺失', { exact: false }).waitFor();
      await page.getByText('实收待确认', { exact: false }).waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});
