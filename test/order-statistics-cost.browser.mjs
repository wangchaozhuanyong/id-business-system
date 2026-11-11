import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { interceptDesign, origin, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const actor = { id: 'fixture', name: '离线验收管理员', role: 'admin' };
const clock = Date.parse('2026-11-10T08:00:00Z');
const rules = { version: 1, currency: 'CNY', cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5',
  claudeBankFeeMyr: '100', claudeAccountCostMyr: '50', appleDiscount: '0.8' };
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
  if (!Object.hasOwn(item, 'fxSnapshot')) item.fxSnapshot = createOrderSnapshot({
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
      order('a', 3, { costConfirmed: false, issueFeeSnapshot: { cardId, applied: true, amountUsd: '0.5' } }),
      order('b', 4, { plan: 'Pro 200', costConfirmed: false, costBasis: 'actual', actualCostAmount: '110', actualCostCurrency: 'CNY' }),
      order('c', 5, { receiptConfirmed: false, saleAmount: '' }),
      order('unverified', 5, { cardId: 'recharge:2', issueFeeSnapshot: { cardId: 'recharge:2', applied: false, pending: true } }),
      order('legacy', 6, {
        source: '历史入库', cardId: '', paidConfirmed: false, fxSnapshot: null,
        refunds: [{ id: 'refund-legacy', amount: '15', currency: 'CNY' }]
      }),
      order('unlinked', 7, {
        source: '历史入库', cardId: '', paymentId: '',
        issueFeeSnapshot: { cardId: '', applied: false, pending: true }
      }),
      order('claude', 8, {
        product: 'Claude Pro', plan: 'pro', cardId: '', paymentId: '', issueFeeSnapshot: null,
        paidAmount: '20', paidCurrency: 'USD', saleAmount: '450',
        emailCostAmount: '15', emailCostCurrency: 'CNY'
      }),
      order('apple', 9, {
        product: 'Claude Max', plan: 'Max 5x', cardId: '', paymentId: '', issueFeeSnapshot: null,
        payment: '苹果内购', appleIdId: 'fixture-apple-id', appleStoreRegion: 'US',
        paidAmount: '100', paidCurrency: 'USD', saleAmount: '700', emailCostAmount: '25', emailCostCurrency: 'CNY',
        refunds: [{ id: 'apple-customer-refund', amount: '60', currency: 'CNY' }]
      })
    ],
    customers: [{ id: 'fixture-customer', name: '合成客户', active: true }],
    tenants: [], operating: [], rentBatches: [], logs: []
  } },
  appleBalance: { version: 1, data: { wallets: [], refunds: [], movements: [],
    allocations: [{ orderId: 'apple', appleIdId: 'fixture-apple-id', amount: '100', returned: '10' }] } },
  settings: { version: 1, data: { costSettings: rules } }
});

test('按套餐独立汇总实收、成本、分摊及费用来源，并用原单汇率复算', { timeout: 80_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [390, true]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async (t) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor, localFixtures: fixtures(), skipRechargeAssets: true });
      const page = await context.newPage();
      await page.clock.install({ time: new Date(clock) });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(5500);
      await page.goto(origin + '/#/orders/gpt');
      if (dark) await toggleDesignTheme(page);
      const list = page.locator('table[data-table="commerce-orders-GPT"]');
      assert.equal(await list.locator('tr[data-row-id="b"] [data-column="profit"]').textContent(), '30.00');
      assert.equal(await list.locator('tr[data-row-id="c"] [data-column="profit"]').textContent(), '—');
      assert.equal(await list.locator('tr[data-row-id="unlinked"] [data-column="profit"]').textContent(), '11.84');
      assert.equal(await list.getByText('待核算', { exact: true }).count(), 0);

      await page.goto(origin + '/#/orders/statistics');
      await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
      const summary = page.locator('#main .summary-strip');
      const planTable = page.locator('table[data-table="commerce-plan-statistics"]');
      const plus = planTable.locator('tr[data-row-id="GPT:Plus"]');
      const pro200 = planTable.locator('tr[data-row-id="GPT:Pro 200"]');
      const claude = planTable.locator('tr[data-row-id="Claude Pro:Pro"]');
      const apple = planTable.locator('tr[data-row-id="Claude Max:Max 5x"]');
      await apple.getByText('净成本 543.40', { exact: true }).waitFor();
      assert.match(await pro200.locator('[data-column="actual"]').textContent(), /净成本 110\.00.*单均 110\.00.*利润 30\.00/);
      assert.match(await plus.locator('[data-column="reference"]').textContent(), /净成本 258\.7197.*单均 129\.3599.*利润 10\.6398.*2 笔成本.*1 笔利润/);
      assert.match(await claude.locator('[data-column="reference"]').textContent(), /净成本 399\.00.*单均 399\.00.*利润 51\.00/);
      assert.match(await apple.locator('[data-column="reference"]').textContent(), /净成本 543\.40.*单均 543\.40.*利润 96\.60/);
      assert.match(await summary.locator('[data-stat-metric="revenue"]').textContent(), /1775\.00/);
      assert.match(await summary.locator('[data-stat-metric="actual-profit"]').textContent(), /30\.00/);
      assert.match(await summary.locator('[data-stat-metric="reference-profit"]').textContent(), /158\.2398/);
      assert.equal(await plus.locator('[data-column="revenue"]').textContent(), '545.00');
      assert.equal(await plus.locator('[data-column="pending"]').textContent(), '4');
      await page.getByText('1 笔订单开卡费未分摊，已知费用单列。', { exact: true }).waitFor();
      await settle(page);
      assert.deepEqual((await spacingSnapshot(page)).findings, []);
      const metric = summary.locator('[data-stat-metric="reference-cost"]');
      const help = metric.getByLabel('查看参考净成本说明');
      await help.scrollIntoViewIfNeeded();
      const before = await metric.boundingBox();
      const target = await help.boundingBox();
      const label = await metric.locator('.summary-label span').first().boundingBox();
      assert.ok(target.x > label.x && target.width >= (width < 900 ? 44 : 36));
      assert.equal(await metric.locator('details[open]').count(), 0);
      await help.click();
      await metric.getByRole('note').filter({ hasText: /逐笔使用原单冻结汇率/ }).waitFor();
      assert.equal((await metric.boundingBox()).height, before.height);
      await page.keyboard.press('Escape');
      assert.equal(await metric.locator('details[open]').count(), 0);

      await plus.getByRole('button', { name: '展开渠道' }).click();
      const channel = planTable.locator('tr[data-row-id="GPT:Plus:银行卡 · PHP"]');
      assert.match(await channel.locator('[data-column="reference"]').textContent(), /129\.3599/);
      await channel.getByRole('button', { name: '查看订单' }).click();
      const sourceTable = page.locator('table[data-table="commerce-stat-detail"]');
      assert.equal(await sourceTable.locator('tr[data-row-id="b"]').count(), 0);
      assert.match(await sourceTable.locator('tr[data-row-id="c"] [data-column="netCost"]').textContent(), /129\.3595/);

      await page.getByRole('tab', { name: '费用拆分' }).click();
      const fees = page.locator('table[data-table="commerce-fee-statistics"]');
      const kyc = fees.locator('tr[data-row-id="kyc"]');
      assert.equal(await kyc.locator('[data-column="actual"]').textContent(), '—');
      assert.match(await kyc.locator('[data-column="reference"]').textContent(), /80\.00 CNY.*50\.00 MYR/);
      assert.match(await fees.locator('tr[data-row-id="service"] [data-column="reference"]').textContent(), /160\.00 CNY.*100\.00 MYR/);
      assert.match(await fees.locator('tr[data-row-id="card-issue"] [data-column="reference"]').textContent(), /2\.3997 CNY.*0\.3333 USD/);
      assert.match(await fees.locator('tr[data-row-id="actual-total"] [data-column="actual"]').textContent(), /110\.00 CNY/);
      assert.match(await fees.locator('tr[data-row-id="recovery"] [data-column="reference"]').textContent(), /-57\.60 CNY.*-8\.00 USD/);
      await kyc.getByRole('button', { name: '查看参考KYC 认证成本订单' }).click();
      assert.deepEqual(await sourceTable.locator('tbody tr[data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId)), ['claude']);
      assert.equal(await sourceTable.locator('tr[data-row-id="claude"] [data-column="feeAmount"]').textContent(), '80.00');
      const drawer = page.locator('#drawer[open]');
      await sourceTable.getByRole('button', { name: '查看原单', exact: true }).click();
      assert.equal(await drawer.getByRole('tab', { name: '成本与汇率' }).getAttribute('aria-selected'), 'true');
      await drawer.getByText(/50\.0000 MYR · 折合 80\.00 人民币/).waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();

      await page.getByRole('tab', { name: '来源订单' }).click();
      await page.locator('#commerce-search').fill('SYN-A');
      const source = page.locator('tr[data-row-id="a"]');
      assert.equal(await source.locator('[data-column="reason"]').textContent(), '参考核算');
      await source.getByRole('button', { name: '查看原单', exact: true }).click();
      await drawer.getByText(/同卡已确认开通 3 单.*本单份额 0\.1667 USD/).waitFor();
      await drawer.getByText(/^8\.0000 PHP · 折合/).waitFor();
      await drawer.getByText(/^0\.3000 USD · 折合/).waitFor();
      await drawer.getByText(/10\.6398 人民币/).waitFor();
      await drawer.getByText('历史市场参考报价', { exact: true }).waitFor();
      await drawer.getByLabel('查看开卡成本分摊说明').click();
      await drawer.getByRole('note').filter({ hasText: /0\.5000 USD ÷ 同卡成功开通 3 单/ }).waitFor();
      await page.keyboard.press('Escape');
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.locator('#commerce-search').fill('SYN-UNLINKED');
      const unlinked = page.locator('tr[data-row-id="unlinked"]');
      assert.match(await unlinked.locator('[data-column="reason"]').textContent(), /开卡费未分摊/);
      assert.equal(await unlinked.locator('[data-column="amount"]').textContent(), '11.84 · 参考');
      await unlinked.getByRole('button', { name: '查看原单', exact: true }).click();
      await drawer.getByText('原付款卡未记录，开卡费未分摊', { exact: true }).waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.locator('#commerce-search').fill('');
      await page.getByRole('tab', { name: '待核算' }).click();
      assert.match(await page.locator('tr[data-row-id="unverified"] [data-column="reason"]').textContent(), /同卡开卡费凭据缺失/);
      assert.match(await page.locator('tr[data-row-id="c"] [data-column="reason"]').textContent(), /实收待确认/);
      assert.match(await page.locator('tr[data-row-id="legacy"] [data-column="reason"]').textContent(), /缺少有效汇率快照.*缺少原付款银行卡/);

      await page.getByRole('tab', { name: '统计概览' }).click();
      await page.getByLabel('产品', { exact: true }).selectOption('GPT');
      await page.getByLabel('套餐', { exact: true }).selectOption('GPT:Plus');
      await page.getByLabel('开通起日').fill('2026-11-03');
      await page.getByLabel('开通止日').fill('2026-11-03');
      await page.getByLabel('统计币种').selectOption('MYR');
      assert.match(await plus.locator('[data-column="reference"]').textContent(), /净成本 80\.8502.*单均 80\.8502/);
      await plus.getByRole('button', { name: '查看订单' }).click();
      assert.deepEqual(await sourceTable.locator('tbody tr[data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId)), ['a']);
      await sourceTable.getByRole('button', { name: '查看原单' }).click();
      await drawer.getByText(/同卡已确认开通 3 单.*本单份额 0\.1667 USD/).waitFor();
      await drawer.getByText('80.8502 马币 MYR', { exact: true }).first().waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.getByLabel('开通止日').fill('2026-11-02');
      await page.getByText('开通起日须早于或等于止日。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '重置筛选' }).click();
      assert.equal(await page.getByLabel('统计币种').inputValue(), 'CNY');
      await settle(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.goto(origin + '/#/overview');
      const profitMetric = page.locator('[data-overview-metric="profit"]');
      await profitMetric.getByText(/1 笔开卡费未分摊/).waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});

test('实付凭据按扣款日和原币汇总，登记及作废后可逐单核对', { timeout: 65_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    await t.test(width + 'px', async t => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor, localFixtures: fixtures(), skipRechargeAssets: true });
      const endpoint = origin + '/api/local/finance/expense-receipts';
      const recordedAt = '2026-11-10T08:00:00Z';
      const operations = [];
      let receiptState = { version: 4, items: [
        { id: 'card-fee', category: 'card-issue', chargedOn: '2026-11-08', source: '合成卡商', reference: 'CARD-001',
          amount: '0.5', currency: 'USD', recordedAt },
        { id: 'fx-fee', category: 'fx-fee', chargedOn: '2026-11-09', source: '合成银行', reference: 'FX-001',
          amount: '4.15', currency: 'CNY', orderId: 'claude', orderNo: 'SYN-CLAUDE', recordedAt }
      ] };
      await context.route(endpoint, async route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: receiptState });
        const input = route.request().postDataJSON();
        operations.push(input);
        assert.equal(input.version, receiptState.version);
        if (input.action === 'record') {
          receiptState = { version: receiptState.version + 1, items: [
            { ...input.entry, id: 'new-kyc', orderId: 'claude', recordedAt }, ...receiptState.items
          ] };
        } else if (input.action === 'account') {
          receiptState = { version: receiptState.version + 1, items: receiptState.items.map(row => row.id === input.id
            ? { ...row, accountingMode: input.mode } : row) };
        } else {
          receiptState = { version: receiptState.version + 1, items: receiptState.items.map(row => row.id === input.id
            ? { ...row, voidedAt: recordedAt, voidReason: input.reason } : row) };
        }
        return route.fulfill({ json: receiptState });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5500);
      await page.clock.install({ time: new Date(clock) });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#/orders/statistics');
      if (width === 390) await toggleDesignTheme(page);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      const summary = page.locator('table[data-table="commerce-expense-summary"]');
      const receiptTable = page.locator('table[data-table="commerce-expense-receipts"]');
      const cell = (id, column) => summary.locator(`tr[data-row-id="${id}"] [data-column="${column}"]`);
      await summary.waitFor();
      assert.equal(await cell('card-issue', 'original').textContent(), '0.50 USD');
      assert.equal(await cell('card-issue', 'converted').textContent(), '—');
      assert.equal(await cell('card-issue', 'pending').textContent(), '1');
      assert.equal(await cell('fx-fee', 'converted').textContent(), '4.15');
      await page.getByLabel('开通起日').fill('2026-11-10');
      assert.equal(await cell('card-issue', 'count').textContent(), '1');
      await page.getByLabel('扣款起日').fill('2026-11-09');
      assert.equal(await cell('card-issue', 'count').textContent(), '0');
      await page.getByLabel('扣款止日').fill('2026-11-08');
      await page.getByRole('alert').filter({ hasText: '扣款起日须早于或等于止日' }).waitFor();
      await page.getByLabel('扣款止日').fill('');
      const help = page.getByLabel('查看实付凭据说明');
      await help.click();
      await page.getByRole('note').filter({ hasText: '原币按币种分别加总' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('note').filter({ hasText: '原币按币种分别加总' }).isVisible(), false);

      await page.getByRole('button', { name: '登记实付凭据' }).click();
      const drawer = page.locator('#drawer[open]');
      for (const [field, value] of Object.entries({ chargedOn: '2026-11-10', source: '合成机构', reference: 'KYC-001',
        amount: '20', settlementAmount: '32.12', orderNo: 'SYN-CLAUDE' })) {
        await drawer.locator('#commerce-expense-' + field).fill(value);
      }
      await drawer.locator('#commerce-expense-currency').selectOption('MYR');
      await drawer.locator('#commerce-expense-settlementCurrency').selectOption('CNY');
      await drawer.getByRole('button', { name: '确认登记', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(operations[0].entry.orderNo, 'SYN-CLAUDE');
      assert.equal(await cell('kyc', 'original').textContent(), '20.00 MYR');
      assert.equal(await cell('kyc', 'converted').textContent(), '32.12');
      await page.getByLabel('统计币种').selectOption('MYR');
      assert.equal(await cell('kyc', 'converted').textContent(), '20.00');
      assert.equal(await cell('fx-fee', 'pending').textContent(), '1');
      await page.getByLabel('产品', { exact: true }).selectOption('Claude');
      await page.getByLabel('套餐', { exact: true }).selectOption('Claude Pro:Pro');
      assert.equal(await cell('kyc', 'count').textContent(), '1');
      const saved = receiptTable.locator('tr[data-row-id="new-kyc"]');
      await page.getByLabel('开通起日').fill('');
      await page.getByRole('tab', { name: '统计概览' }).click();
      const plan = page.locator('table[data-table="commerce-plan-statistics"] tr[data-row-id="Claude Pro:Pro"]');
      assert.match(await plan.locator('[data-column="reference"]').textContent(), /净成本 249\.375/);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      await saved.getByRole('button', { name: '核对计入', exact: true }).click();
      await drawer.locator('#commerce-expense-mode').selectOption('replace-kyc');
      await drawer.getByRole('button', { name: '确认核算方式', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(operations[1].mode, 'replace-kyc');
      assert.equal(await saved.locator('[data-column="mode"]').textContent(), '用实付替换本单 KYC');
      await page.getByRole('tab', { name: '统计概览' }).click();
      assert.match(await plan.locator('[data-column="reference"]').textContent(), /净成本 219\.45/);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      await saved.getByRole('button', { name: '查看原单', exact: true }).click();
      assert.equal(await drawer.getByRole('tab', { name: '成本与汇率' }).getAttribute('aria-selected'), 'true');
      await drawer.getByLabel('查看KYC 认证实付说明').click();
      await drawer.getByRole('note').filter({ hasText: 'KYC-001' }).waitFor();
      await page.keyboard.press('Escape');
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await saved.getByRole('button', { name: '作废凭据', exact: true }).click();
      await drawer.locator('#commerce-expense-reason').fill('合成凭据录入更正');
      await drawer.getByRole('button', { name: '确认作废', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(operations[2].action, 'void');
      assert.equal(await cell('kyc', 'count').textContent(), '0');
      assert.match(await saved.locator('[data-column="status"]').textContent(), /已作废.*合成凭据录入更正/s);
      await page.getByRole('tab', { name: '统计概览' }).click();
      assert.match(await plan.locator('[data-column="reference"]').textContent(), /净成本 249\.375/);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      await settle(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual((await spacingSnapshot(page)).findings, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});
