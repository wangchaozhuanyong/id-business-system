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
      order('b', 4, { plan: 'Pro 200', paidConfirmed: false, receiptConfirmed: false,
        costConfirmed: false, costBasis: 'actual', actualCostAmount: '110', actualCostCurrency: 'CNY' }),
      order('c', 5, { receiptConfirmed: false, saleAmount: '' }),
      order('unverified', 5, { cardId: 'recharge:2', issueFeeSnapshot: { cardId: 'recharge:2', applied: false, pending: true } }),
      order('legacy', 6, {
        source: '历史入库', cardId: '', paidConfirmed: false, receiptConfirmed: false, fxSnapshot: null,
        refunds: [{ id: 'refund-legacy', amount: '15', currency: 'CNY' }]
      }),
      order('unlinked', 7, {
        source: '历史入库', email: '', cardId: '', paymentId: '',
        issueFeeSnapshot: { cardId: '', applied: false, pending: true }
      }),
      order('claude', 8, {
        product: 'Claude Pro', plan: 'pro', cardTypeId: 'card-type-real', businessType: '首次开通', kyc: 'KYC 认证',
        cardId: '', paymentId: '', issueFeeSnapshot: null,
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

test('订单统计页签共用右侧操作区，切换时表格紧接页签栏', { timeout: 40_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [width, dark, empty] of [[1440, false, false], [901, true, false], [390, true, false], [320, false, true]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const data = fixtures();
      if (empty) data.commerce.data.orders = [];
      const traffic = await interceptDesign(context, { actor: { ...actor, role: 'super' }, localFixtures: data, skipRechargeAssets: true });
      const page = await context.newPage();
      await page.goto(origin + '/#/orders/statistics');
      if (dark) await toggleDesignTheme(page);
      const tabs = page.getByRole('tablist', { name: '订单统计视图' });
      const bar = tabs.locator('..');
      const actions = bar.locator('[data-page-actions]');
      const height = (await bar.boundingBox()).height;
      const sameCenter = (a, b) => Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= 1;
      for (const [tab, title] of [['统计概览', '套餐成本'], ['费用拆分', '费用构成'], ['来源订单', ''],
        ['计算缺项', ''], ['汇率来源', '订单汇率来源']]) {
        const active = tabs.getByRole('tab', { name: tab, exact: true });
        await active.click();
        await settle(page);
        const control = title ? actions.getByLabel(`查看${title}说明`) : actions.getByRole('textbox');
        if (title) await actions.getByRole('heading', { name: title, exact: true }).waitFor();
        const nav = await tabs.boundingBox(), box = await control.boundingBox();
        const selected = await active.boundingBox();
        const settings = await actions.getByRole('button', { name: '费用设置' }).boundingBox();
        const label = `${width}px ${tab}`;
        assert.equal(await active.getAttribute('aria-selected'), 'true', label);
        assert(selected.x >= nav.x - 1 && selected.x + selected.width <= nav.x + nav.width + 1, label);
        assert(sameCenter(box, settings) && box.x + box.width <= settings.x, label);
        if (width >= 901) assert(sameCenter(nav, box) && nav.x + nav.width <= box.x, label);
        else assert(box.height >= 44 && settings.height >= 44, label);
        assert.equal((await bar.boundingBox()).height, height, label);
        assert(await bar.evaluate(el => el.nextElementSibling.matches('.table-viewport, .empty-state')), label);
        const spacing = await spacingSnapshot(page);
        assert.equal(spacing.overflow, false, label);
        assert.deepEqual(spacing.findings, [], label);
      }
      await tabs.getByRole('tab', { name: '统计概览' }).click();
      const help = actions.getByLabel('查看套餐成本说明');
      assert.equal(await actions.locator('details[open]').count(), 0);
      await help.focus();
      await help.press('Enter');
      await actions.getByRole('note').waitFor();
      assert.equal((await bar.boundingBox()).height, height);
      await page.keyboard.press('Escape');
      assert.equal(await actions.locator('details[open]').count(), 0);
      if (!empty) {
        await page.locator('table[data-table="commerce-plan-statistics"] tr[data-row-id="GPT:Plus"]')
          .getByRole('button', { name: '查看订单' }).click();
        assert.equal((await bar.boundingBox()).height, height);
        await actions.getByRole('button', { name: '清除定位' }).click();
        assert.equal(await actions.getByRole('button', { name: '清除定位' }).count(), 0);
      }
      assert.deepEqual(traffic.external, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
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
      assert.equal(await list.locator('tr[data-row-id="unlinked"] [data-column="profit"]').textContent(), '8.24');
      assert.equal(await list.locator('tr[data-row-id="unlinked"] [data-column="email"]').textContent(), '');
      assert.equal(await list.getByText('计算缺项', { exact: true }).count(), 0);

      await page.goto(origin + '/#/orders/statistics');
      await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
      await page.getByRole('tab', { name: '汇率来源' }).click();
      const snapshots = page.locator('table[data-table="commerce-stat-snapshots"] tbody tr[data-row-id]');
      assert.deepEqual((await snapshots.evaluateAll(rows => rows.map(row => row.dataset.rowId))).slice(0, 3),
        ['apple', 'claude', 'unlinked']);
      await page.getByRole('tab', { name: '统计概览' }).click();
      const summary = page.locator('#main .summary-strip');
      const planTable = page.locator('table[data-table="commerce-plan-statistics"]');
      const plus = planTable.locator('tr[data-row-id="GPT:Plus"]');
      const pro200 = planTable.locator('tr[data-row-id="GPT:Pro 200"]');
      const claude = planTable.locator('tr[data-row-id="Claude Pro:Pro"]');
      const apple = planTable.locator('tr[data-row-id="Claude Max:Max 5x"]');
      await apple.getByText('543.40', { exact: true }).waitFor();
      assert.match(await pro200.locator('[data-column="netCost"]').textContent(), /110\.00.*单均 110\.00/s);
      assert.equal(await pro200.locator('[data-column="profit"]').textContent(), '30.00');
      assert.match(await plus.locator('[data-column="netCost"]').textContent(), /518\.6397.*4 笔.*1 笔开卡费未分摊/s);
      assert.equal(await plus.locator('[data-column="profit"]').textContent(), '30.7198');
      assert.match(await claude.locator('[data-column="netCost"]').textContent(), /399\.00/);
      assert.equal(await claude.locator('[data-column="profit"]').textContent(), '51.00');
      assert.equal(await apple.locator('[data-column="profit"]').textContent(), '96.60');
      assert.match(await summary.locator('[data-stat-metric="revenue"]').textContent(), /1775\.00/);
      assert.match(await summary.locator('[data-stat-metric="net-cost"]').textContent(), /1571\.0397/);
      assert.match(await summary.locator('[data-stat-metric="profit"]').textContent(), /208\.3198/);
      assert.match(await summary.locator('[data-stat-metric="pending"] .summary-number').textContent(), /^2/);
      assert.equal(await plus.locator('[data-column="revenue"]').textContent(), '545.00');
      assert.equal(await plus.locator('[data-column="pending"]').textContent(), '2');
      await page.getByText('1 笔订单开卡费未分摊，已知费用单列。', { exact: true }).waitFor();
      await settle(page);
      assert.deepEqual((await spacingSnapshot(page)).findings, []);
      const metric = summary.locator('[data-stat-metric="net-cost"]');
      const help = metric.getByLabel('查看已知净成本说明');
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
      assert.match(await channel.locator('[data-column="netCost"]').textContent(), /518\.6397/);
      await channel.getByRole('button', { name: '查看订单' }).click();
      const sourceTable = page.locator('table[data-table="commerce-stat-detail"]');
      assert.equal(await sourceTable.locator('tr[data-row-id="b"]').count(), 0);
      assert.match(await sourceTable.locator('tr[data-row-id="c"] [data-column="netCost"]').textContent(), /129\.3595/);
      await sourceTable.locator('tr[data-row-id="c"]').getByRole('button', { name: '查看原单' }).click();
      const unreceived = page.locator('#drawer[open]');
      await unreceived.getByText('回款后净成本', { exact: true }).waitFor();
      await unreceived.getByText('129.3595 人民币 CNY', { exact: true }).last().waitFor();
      await unreceived.getByRole('button', { name: '关闭抽屉', exact: true }).click();

      await page.getByRole('tab', { name: '费用拆分' }).click();
      const fees = page.locator('table[data-table="commerce-fee-statistics"]');
      const kyc = fees.locator('tr[data-row-id="kyc"]');
      assert.equal(await kyc.locator('[data-column="actual"]').textContent(), '—');
      assert.match(await kyc.locator('[data-column="reference"]').textContent(), /80\.00 CNY.*50\.00 MYR/);
      assert.equal(await kyc.locator('[data-column="total"]').textContent(), '80.00');
      await kyc.getByLabel('查看KYC 认证成本说明').click();
      await kyc.getByRole('note').filter({ hasText: /有本单 KYC 记录/ }).waitFor();
      await page.keyboard.press('Escape');
      assert.match(await fees.locator('tr[data-row-id="service"] [data-column="reference"]').textContent(), /160\.00 CNY.*100\.00 MYR/);
      assert.match(await fees.locator('tr[data-row-id="card-issue"] [data-column="reference"]').textContent(), /5\.9997 CNY.*0\.8333 USD/);
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
      assert.equal(await unlinked.locator('[data-column="reason"]').textContent(), '参考核算 · 一次性虚拟卡');
      assert.equal(await unlinked.locator('[data-column="amount"]').textContent(), '8.24');
      assert.equal(await unlinked.locator('[data-column="cardIssue"]').textContent(), '3.60');
      await unlinked.getByRole('button', { name: '查看原单', exact: true }).click();
      await drawer.getByText('一次性虚拟卡开卡费', { exact: true }).waitFor();
      await drawer.getByLabel('查看一次性虚拟卡开卡费说明').click();
      await drawer.getByRole('note').filter({ hasText: /按原单冻结的费用规则计一次开卡费 0\.5000 USD/ }).waitFor();
      await page.keyboard.press('Escape');
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.locator('#commerce-search').fill('');
      await page.getByRole('tab', { name: '计算缺项' }).click();
      assert.equal(await page.locator('tr[data-row-id="b"]').count(), 0, '已录入金额的旧单不进入计算缺项');
      assert.equal(await page.locator('tr[data-row-id="unverified"]').count(), 0);
      assert.equal(await page.locator('tr[data-row-id="unlinked"]').count(), 0, '留空邮箱和一次性卡号的订单照常计算');
      assert.match(await page.locator('tr[data-row-id="c"] [data-column="reason"]').textContent(), /缺少已登记的收款金额/);
      const legacyReason = await page.locator('tr[data-row-id="legacy"] [data-column="reason"]').textContent();
      assert.match(legacyReason, /缺少有效汇率快照/);
      assert.doesNotMatch(legacyReason, /缺少已登记的代付金额/);

      await page.getByRole('tab', { name: '统计概览' }).click();
      await page.getByLabel('产品', { exact: true }).selectOption('GPT');
      await page.getByLabel('套餐', { exact: true }).selectOption('GPT:Plus');
      await page.getByLabel('开始日期').fill('2026-11-03');
      await page.getByLabel('结束日期').fill('2026-11-03');
      await page.getByLabel('统计币种').selectOption('MYR');
      assert.match(await plus.locator('[data-column="netCost"]').textContent(), /80\.8502.*单均 80\.8502/s);
      await plus.getByRole('button', { name: '查看订单' }).click();
      assert.deepEqual(await sourceTable.locator('tbody tr[data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId)), ['a']);
      await sourceTable.getByRole('button', { name: '查看原单' }).click();
      await drawer.getByText(/同卡已确认开通 3 单.*本单份额 0\.1667 USD/).waitFor();
      await drawer.getByText('80.8502 马币 MYR', { exact: true }).first().waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await page.getByLabel('结束日期').fill('2026-11-02');
      await page.getByText('开始日期须早于或等于结束日期。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '重置筛选' }).click();
      assert.equal(await page.getByLabel('统计币种').inputValue(), 'CNY');
      await settle(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.goto(origin + '/#/overview');
      const profitMetric = page.locator('[data-overview-metric="profit"]');
      const compactRange = page.getByRole('combobox', { name: '统计时间范围' });
      if (await compactRange.isVisible()) await compactRange.selectOption({ label: '近 30 天' });
      else await page.getByRole('button', { name: '近 30 天', exact: true }).click();
      await profitMetric.getByText(/1 笔开卡费未分摊/).waitFor();
      await profitMetric.getByText(/1 笔按一次性虚拟卡规则计费/).waitFor();
      await profitMetric.getByText(/208\.3198/).waitFor();
      await profitMetric.getByText('已计算 6 笔 · 计算缺项 2 笔', { exact: true }).waitFor();
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
      await page.getByLabel('开始日期').fill('2026-11-10');
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
      await page.getByLabel('开始日期').fill('');
      await page.getByRole('tab', { name: '统计概览' }).click();
      const plan = page.locator('table[data-table="commerce-plan-statistics"] tr[data-row-id="Claude Pro:Pro"]');
      assert.match(await plan.locator('[data-column="netCost"]').textContent(), /249\.375/);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      await saved.getByRole('button', { name: '核对计入', exact: true }).click();
      await drawer.locator('#commerce-expense-mode').selectOption('replace-kyc');
      await drawer.getByRole('button', { name: '确认核算方式', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(operations[1].mode, 'replace-kyc');
      assert.equal(await saved.locator('[data-column="mode"]').textContent(), '用实付替换本单 KYC');
      await page.getByRole('tab', { name: '统计概览' }).click();
      assert.match(await plan.locator('[data-column="netCost"]').textContent(), /219\.45/);
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
      assert.match(await plan.locator('[data-column="netCost"]').textContent(), /249\.375/);
      await page.getByRole('tab', { name: '费用拆分' }).click();
      await settle(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual((await spacingSnapshot(page)).findings, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});

test('Apple 回款读取失败仍展示同币成本利润并注明来源，虚拟卡续费用原单费率', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const data = fixtures();
  const pro = order('virtual-renewal', 8, {
    product: 'Claude Pro', plan: 'Pro', cardTypeId: 'card-type-vccwc999',
    cardId: '', paymentId: '', paidConfirmed: false, paidAmount: '21.13', paidCurrency: 'USD',
    saleAmount: '190', costSettings: { ...rules, version: 2, cardPercent: '0.08' }
  });
  pro.fxSnapshot = createOrderSnapshot({
    source: '隔离结算凭据 QA-V2', at: '2026-11-08T00:00', expiresAt: '2026-11-08T23:59',
    rates: { USD: '6.68605623' }
  }, pro, clock);
  const max = order('apple-actual', 9, {
    product: 'Claude Max', plan: 'Max 20x', cardId: '', paymentId: '', issueFeeSnapshot: null,
    payment: '苹果内购', appleIdId: 'fixture-apple-id', paidAmount: '250', paidCurrency: 'USD',
    saleAmount: '2100', costBasis: 'actual', actualCostAmount: '1550', actualCostCurrency: 'CNY',
    fxSnapshot: null
  });
  data.commerce.data.orders = [pro, max];
  const traffic = await interceptDesign(context, { actor, localFixtures: data, skipRechargeAssets: true });
  let fail = true;
  await context.route(origin + '/api/local/finance/expense-receipts', route => fail
    ? route.fulfill({ status: 503, json: { error: '合成读取失败' } })
    : route.fulfill({ json: { version: 0, items: [] } }));
  await context.route(origin + '/api/local/appleBalance', route => fail
    ? route.fulfill({ status: 503, json: { error: '合成读取失败' } })
    : route.fulfill({ json: data.appleBalance }));
  const page = await context.newPage();
  await page.clock.setFixedTime(clock);
  page.setDefaultTimeout(5500);
  const status = page.getByText('Apple 回款读取失败，利润按现有资料计算。', { exact: true });
  const appleProfit = page.locator('tr[data-row-id="Claude Max:Max 20x"] [data-column="profit"]');
  const proProfit = page.locator('tr[data-row-id="Claude Pro:Pro"] [data-column="profit"]');
  await page.goto(origin + '/#/orders/statistics');
  await status.waitFor();
  assert.equal(await appleProfit.textContent(), '550.00');
  assert.equal(await proProfit.textContent(), '32.0727');
  await page.getByRole('combobox', { name: '统计币种' }).selectOption('MYR');
  assert.equal(await appleProfit.textContent(), '—', '仅切到马币时需要原单汇率');
  assert.equal(await page.locator('[data-stat-metric="count"] .summary-number').textContent(), '2笔');
  assert.equal(await page.locator('[data-stat-metric="profit"] .summary-number').textContent(), '—', '人民币利润不计入马币汇总');
  await page.getByRole('tab', { name: '计算缺项' }).click();
  const appleOrder = page.locator('tr[data-row-id="apple-actual"]');
  assert.equal(await appleOrder.locator('[data-column="amount"]').textContent(), '原币利润 550.00 CNY');
  await appleOrder.getByRole('button', { name: '查看原单' }).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.locator('.property-row').filter({ hasText: '原币利润' })
    .getByText('550.00 人民币 CNY', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭抽屉' }).click();
  await page.goto(origin + '/#/overview');
  const overviewProfit = page.locator('[data-overview-metric="profit"]');
  await overviewProfit.getByText('费用凭据读取失败，金额暂按原单核算。', { exact: true }).waitFor();
  await overviewProfit.getByText('582.0727', { exact: true }).waitFor();
  fail = false;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await overviewProfit.getByText(/费用凭据读取失败/).waitFor({ state: 'hidden' });
  await overviewProfit.getByText('582.0727', { exact: true }).waitFor();
  await page.goto(origin + '/#/orders/statistics');
  await page.reload();
  await appleProfit.getByText('550.00', { exact: true }).waitFor();
  assert.equal(await status.count(), 0);
  assert.deepEqual(traffic.external, []);
});

test('两名管理员的凭据变更推送到同一页面，旧核算草稿必须重新核对', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const record = { id: 'expense-sync', category: 'kyc', chargedOn: '2026-11-10', source: '合成来源',
    reference: 'SYNC-001', amount: '20', currency: 'MYR', recordedAt: new Date(clock).toISOString(), orderId: 'claude', orderNo: 'SYN-CLAUDE' };
  let state = { version: 4, items: [record] }, unavailable = false;
  const commands = [];
  const open = async id => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 850 } });
    const localFixtures = { ...fixtures(), 'recharge-codes': { version: 0, pending: 0 },
      inventory: { version: 0, data: { mailboxes: [], accounts: [], batches: [] } } };
    const traffic = await interceptDesign(context, { actor: { ...actor, id }, localFixtures, changeEvents: true, skipRechargeAssets: true });
    await context.route(origin + '/api/local/finance/expense-receipts', async route => {
      if (route.request().method() === 'GET')
        return unavailable ? route.fulfill({ status: 503, json: { error: '离线测试读取失败' } }) : route.fulfill({ json: state });
      const input = route.request().postDataJSON();
      commands.push({ ...input, operatorId: id });
      if (input.version !== state.version) return route.fulfill({ status: 409, json: { error: '费用凭据已更新' } });
      state = { version: state.version + 1, items: [{ ...record, accountingMode: input.mode }] };
      return route.fulfill({ json: state });
    });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window), path = '/api/local/change-events';
      window.fetch = (input, options) => {
        if (new URL(String(input), location.href).pathname !== path) return original(input, options);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const push = (type, version) => controller.enqueue(new TextEncoder().encode(
            'event: ' + type + '\ndata: ' + JSON.stringify({ schema: 1, versions: { 'order-expense-receipts': version } }) + '\n\n'));
          push('snapshot', '4');
          window.expenseRevision = version => push('change', String(version));
        } }), { headers: { 'content-type': 'text/event-stream' } }));
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.clock.setFixedTime(new Date(clock));
    await page.goto(origin + '/#/orders/statistics');
    await page.getByRole('tab', { name: '费用拆分' }).click();
    const row = page.locator('[data-table="commerce-expense-receipts"] tr[data-row-id="expense-sync"]');
    const editor = () => row.getByRole('button', { name: '核对计入', exact: true }).click();
    await editor();
    await page.waitForFunction(() => window.IDChangeSync?.status().snapshots > 0);
    return { page, row, editor, drawer: page.locator('#drawer[open]'), errors, traffic };
  };
  const first = await open('expense-operator-a'), second = await open('expense-operator-b');
  const choose = (session, value) => session.drawer.locator('#commerce-expense-mode').selectOption(value);
  const submit = session => session.drawer.getByRole('button', { name: '确认核算方式' }).click();
  await choose(first, 'cash');
  await choose(second, 'replace-kyc');
  await submit(second);
  await second.drawer.waitFor({ state: 'hidden' });
  assert.equal(state.version, 5);
  assert.equal(commands.length, 1);
  await submit(first);
  const notice = first.drawer.getByRole('alert');
  await notice.filter({ hasText: /当前输入已保留/ }).waitFor();
  assert.equal(await first.drawer.locator('#commerce-expense-mode').inputValue(), 'cash');
  assert.equal(await first.drawer.locator('[name="commerce-expense-version"]').inputValue(), '4');
  await first.drawer.locator('form').evaluate(form => form.requestSubmit());
  assert.deepEqual(commands.map(command => command.version), [4, 4]);
  assert.equal(state.items[0].accountingMode, 'replace-kyc');
  await first.drawer.getByRole('button', { name: '关闭抽屉' }).click();
  await first.editor();
  await notice.filter({ hasText: /当前输入已保留/ }).waitFor();
  assert.equal(await first.drawer.locator('#commerce-expense-mode').inputValue(), 'cash');
  await first.drawer.getByRole('button', { name: '重新读取并核对' }).click();
  await first.page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await first.page.waitForFunction(() => document.querySelector('[name="commerce-expense-version"]')?.value === '5');
  assert.equal(await first.drawer.locator('#commerce-expense-mode').inputValue(), 'replace-kyc');
  assert.equal(commands.length, 2, '重新读取不会提交');
  await first.drawer.getByRole('button', { name: '关闭抽屉' }).click();

  unavailable = true;
  state = { version: 6, items: [{ ...record, amount: '31' }] };
  await first.page.evaluate(() => window.expenseRevision(6));
  await first.page.getByText(/费用凭据读取失败，保留上次凭据用于核算/).waitFor();
  assert.match(await first.row.locator('[data-column="amount"]').textContent(), /20/);
  unavailable = false;
  state.version = 7;
  await first.page.evaluate(() => window.expenseRevision(7));
  await first.row.getByText('31.00 MYR', { exact: true }).waitFor();
  assert.equal(await first.page.getByText(/费用凭据读取失败/).count(), 0);

  const key = { actor: 'expense-operator-a', role: 'admin', finance: true, apple: true, dateBasis: 'created', currency: 'CNY', rechargeRequests: true };
  const profit = (key) => window.IDLocalData.queries.peek('overview', key)?.data?.['profit:week']?.data?.current?.amount;
  await first.page.evaluate(() => window.IDDesignAPI.go('overview'));
  await first.page.waitForFunction(profit, key);
  const oldProfit = await first.page.evaluate(profit, key);
  state = { version: 8, items: [{ ...record, amount: '31', accountingMode: 'replace-kyc' }] };
  await first.page.evaluate(() => window.expenseRevision(8));
  await first.page.waitForFunction(() => {
    const state = window.IDChangeSync.status();
    return state.changes > 0 && !state.pending;
  });
  const newProfit = await first.page.evaluate(profit, key);
  assert.equal(typeof newProfit, 'string');
  assert.notEqual(newProfit, oldProfit, '费用版本变化推送到总览利润');
  assert.deepEqual(first.errors.concat(second.errors), []);
  assert.deepEqual(first.traffic.external.concat(second.traffic.external), []);
});
