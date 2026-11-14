import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { checkFinanceSnapshots, historicalFeeAction } from '../server/finance/snapshot-integrity.mjs';
import { historicalGptCardBackfillError } from '../server/order-policy.mjs';
import { checkInventoryRenewals } from '../server/account-lifecycle.mjs';
import { stageAppleOrderFunding } from '../server/apple-funding.mjs';
import { checkAppleLedger } from '../server/local-business-integrity.mjs';

const actor = { id: 'admin', name: '合成管理员', role: 'admin' };
const rules = { version: 3, currency: 'CNY', claudeBankFeeMyr: '100', claudeAccountCostMyr: '50',
  gmailCostCny: '15', appleCostCny: '25', microsoftCostCny: '5', appleDiscount: '0.8',
  cardIssueUsd: '0.5', cardPercent: '0.008', cardPerPaymentUsd: '0.3' };
const card = { id: 'recharge:fixture-card', active: true, last4: '1234', usageCount: 3, status: '正常' };

async function checkLayout(page, form) {
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const boxes = await page.locator(`${form} input, ${form} textarea, ${form} select`)
      .evaluateAll(nodes => nodes.filter(node => node.type !== 'hidden').map(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right };
      }));
    assert(boxes.every(box => box.left >= 0 && box.right <= width + 1), `${width} ${theme} 表单不应横向溢出`);
  }
}

async function setup(t, kind) {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const seed = fixture.commerce.data.orders.find(row => row.product === 'GPT');
  fixture.commerce.data.orders = [{ ...seed, id: 'historical-fixture', orderNo: 'QA-HISTORY',
    email: 'fixture@example.test', owner: actor.name, ownerId: actor.id, createdById: actor.id, createdBy: actor.name,
    paidAmount: '983', paidCurrency: 'PHP', saleAmount: '130', saleCurrency: 'CNY',
    costSettings: { ...rules, version: 2, cardPercent: '0.08' },
    cardId: '', paymentId: '', costConfirmed: false, bankReturns: [],
    issueFeeSnapshot: { cardId: '', applied: false, pending: true },
    financialEvidence: [{ kind: 'payment', payment: '银行卡', amount: '983', currency: 'PHP', cardId: '', at: '2026-10-01' }],
    notes: '', taskId: '', taskEvidenceId: '', corrections: [], source: '管理员手工' }];
  fixture.commerce.data.renewalWarningHours = 72;
  fixture.settings.data = { ...fixture.settings.data, mailboxTypes: [], costSettings: rules };
  const requests = await interceptDesign(context, { localFixtures: fixture, actor });
  await context.route('**/api/local/order-cards', route => route.fulfill({ json: { items: [card] } }));
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  let stored = structuredClone(fixture.commerce);
  const writes = [], rejected = [];
  await context.route(origin + '/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: stored });
    const command = route.request().postDataJSON();
    writes.push(command);
    if (command.version !== stored.version) return route.fulfill({ status: 409, json: { error: '版本已变化' } });
    const next = command.data.orders[0], prior = stored.data.orders[0];
    let issue;
    if (kind === 'fee') {
      issue = checkFinanceSnapshots(stored.data, command.data, { action: command.action, currentCostSettings: rules, actor });
    } else if (next.cardBackfillConfirmed) {
      issue = historicalGptCardBackfillError(prior, next, { action: command.action, card,
        changedOrderCount: 1, previousLogs: stored.data.logs, nextLogs: command.data.logs, actor });
      if (!issue) {
        delete next.cardBackfillConfirmed;
        issue = checkFinanceSnapshots(stored.data, command.data, { action: command.action, actor,
          verifiedCardBackfillId: next.id });
      }
    } else {
      next.issueFeeSnapshot = structuredClone(prior.issueFeeSnapshot);
      issue = checkFinanceSnapshots(stored.data, command.data, { action: command.action, actor });
    }
    if (issue) {
      rejected.push({ issue, changed: [...new Set([...Object.keys(prior), ...Object.keys(next)])]
        .filter(key => JSON.stringify(prior[key]) !== JSON.stringify(next[key])),
      paymentId: next.paymentId, cardId: next.cardId });
      return route.fulfill({ status: 409, json: { error: issue } });
    }
    stored = { version: stored.version + 1, data: structuredClone(command.data) };
    return route.fulfill({ json: stored });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/orders/gpt');
  await page.locator('[data-action="commerce-order-detail"][data-id="historical-fixture"]').first().waitFor();
  return { page, requests, writes, rejected, errors, get stored() { return structuredClone(stored); },
    externalVersionChange() { stored.version += 1; } };
}

test('离线页面逐单核对费率后保存并保留原规则', { timeout: 30000 }, async t => {
  const f = await setup(t, 'fee');
  await f.page.locator('[data-action="commerce-order-detail"][data-id="historical-fixture"]').first().click();
  await f.page.getByRole('tab', { name: '成本与汇率' }).click();
  await f.page.getByRole('button', { name: '更正历史付款费率', exact: true }).click();
  await f.page.locator('#commerce-fee-correction-form').waitFor();
  await checkLayout(f.page, '#commerce-fee-correction-form');
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  assert.equal(f.writes.length, 0);
  await f.page.locator('#commerce-fee-reason').fill('根据原付款记录逐单核对');
  const saved = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  assert.equal(await f.page.locator('#confirm-dialog[open]').count(), 0);
  assert.equal((await saved).status(), 200, JSON.stringify(f.rejected));
  await f.page.getByText('8% → 0.8% · 原 V2 规则已保留', { exact: true }).waitFor();
  const order = f.stored.data.orders[0];
  assert.equal(order.costSettings.cardPercent, '0.008');
  assert.equal(order.corrections[0].previous.costSettings.cardPercent, '0.08');
  assert.equal(order.corrections[0].verified, true);
  assert.equal(order.issueFeeSnapshot.pending, true);
  assert.deepEqual(f.rejected, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
});

test('历史费率更正遇到订单并发变更时保留输入并拒绝保存', { timeout: 30000 }, async t => {
  const f = await setup(t, 'fee');
  await f.page.locator('[data-action="commerce-order-detail"][data-id="historical-fixture"]').first().click();
  await f.page.getByRole('tab', { name: '成本与汇率' }).click();
  await f.page.getByRole('button', { name: '更正历史付款费率', exact: true }).click();
  await f.page.locator('#commerce-fee-reason').fill('核对依据待重试');
  f.externalVersionChange();
  const rejected = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  assert.equal((await rejected).status(), 409);
  await f.page.getByText(/本次未保存，请重新打开并核对当前数据/).waitFor();
  assert.equal(await f.page.locator('#commerce-fee-reason').inputValue(), '核对依据待重试');
  assert.equal(f.stored.data.orders[0].costSettings.cardPercent, '0.08');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
});

test('离线页面只在明确核对后补原付款卡，保留已有付款证据', { timeout: 30000 }, async t => {
  const f = await setup(t, 'card');
  const original = f.stored.data.orders[0];
  await f.page.locator('[data-action="commerce-order-detail"][data-id="historical-fixture"]').first().click();
  await f.page.getByRole('button', { name: '补录原付款卡', exact: true }).click();
  await checkLayout(f.page, '#commerce-card-backfill-form');
  await f.page.locator('#commerce-backfill-card').selectOption(card.id);
  await f.page.locator('button[form="commerce-card-backfill-form"]').click();
  assert.equal(f.writes.length, 0);
  await f.page.locator('#commerce-backfill-reason').fill('根据原付款记录核对');
  const saved = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('button[form="commerce-card-backfill-form"]').click();
  assert.equal(await f.page.locator('#confirm-dialog[open]').count(), 0);
  assert.equal((await saved).status(), 200, JSON.stringify(f.rejected));
  const order = f.stored.data.orders[0];
  assert.equal(order.cardId, card.id);
  assert.equal(order.paymentId, card.last4);
  assert.deepEqual(order.financialEvidence, original.financialEvidence);
  assert.deepEqual(order.issueFeeSnapshot, original.issueFeeSnapshot);
  assert.equal(Object.hasOwn(order, 'cardBackfillConfirmed'), false);
  await f.page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await f.page.locator('#commerce-notes').fill('合成备注更新');
  await f.page.locator('#commerce-correctionReason').fill('合成备注更正');
  const edited = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('button[form="commerce-order-form"][type="submit"]').click();
  assert.equal((await edited).status(), 200, JSON.stringify(f.rejected));
  assert.equal(f.stored.data.orders[0].notes, '合成备注更新');
  const payments = f.stored.data.orders[0].financialEvidence.filter(item => item.kind === 'payment');
  assert.equal(payments.length, 1, '后续编辑不能因补卡重复生成付款');
  assert.equal(payments[0].cardId, '');
  assert.deepEqual(f.rejected, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
});

test('补登记历史 Claude 客户时沿用原 Apple 付款记录', { timeout: 35000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [width, bound] of [[1440, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
      const prior = {
        id: 'legacy-apple-order', orderNo: 'QA-HISTORICAL-APPLE', source: '历史入库',
        product: 'Claude Max', plan: 'Max 20x', businessType: '成品交付', accountId: 'legacy-stock',
        email: 'historical-stock@example.test', start: '2026-10-16T14:12', expiry: '2026-11-13T14:12',
        payment: '苹果内购', paidConfirmed: bound, paidAmount: bound ? '250' : '', paidCurrency: bound ? 'USD' : '',
        ...(bound && { appleIdId: 'original-apple', appleStoreRegion: 'US', paymentId: 'original-apple@example.test',
          appleFunding: { region: 'US', expected: '250', bound: true } }),
        saleAmount: '2100', saleCurrency: 'CNY', receiptConfirmed: true, costSettings: rules,
        subscriptionEnded: true, entitlementStatus: 'active', ownerId: actor.id, owner: actor.name,
        createdById: actor.id, createdBy: actor.name, version: 1,
        corrections: [], refunds: [], bankReturns: [], cancellationEvents: [], compensations: []
      };
      const ledger = {
        wallets: ['original-apple', 'draft-apple'].map(id => ({
          id, currency: 'USD', balance: '250', version: bound && id === 'original-apple' ? 3 : 2
        })),
        allocations: bound ? [{ orderId: prior.id, appleIdId: 'original-apple', amount: '250', returned: '0' }] : [],
        movements: [
          { id: 'original-opening', kind: 'opening', appleIdId: 'original-apple', reason: '合成期初余额',
            amount: bound ? '500' : '250', before: '0', after: bound ? '500' : '250', versionAfter: 2 },
          { id: 'draft-opening', kind: 'opening', appleIdId: 'draft-apple', reason: '合成期初余额',
            amount: '250', before: '0', after: '250', versionAfter: 2 },
          ...(bound ? [{ id: 'original-debit', kind: 'order-charge', appleIdId: 'original-apple', orderId: prior.id,
            amount: '-250', before: '500', after: '250', versionAfter: 3 }] : [])
        ], refunds: []
      };
      fixture.appleBalance = { version: 1, data: ledger };
      fixture.inventory.data = { ...fixture.inventory.data,
        accounts: [{ id: prior.accountId, email: prior.email, type: 'claude', source: '历史入库',
          health: 'dead', inventoryState: 'used', claudeHistory: { phase: 'dead', plan: prior.plan } }],
        mailboxes: ledger.wallets.map(({ id }) => ({
          id, email: id + '@example.test', type: 'apple', status: '正常', health: 'normal', appStoreRegion: 'US'
        })), batches: [], registrationRecords: [] };
      fixture.settings.data.applePaidPrices = { 'Claude Max': { 'Max 20x': { US: '250' } } };
      fixture.commerce.data = { orders: [prior], tenants: [], customers: [{ id: 'legacy-buyer', name: '合成原买家', active: true }],
        operating: [], rentBatches: [], logs: [] };
      let stored = structuredClone(fixture.commerce);
      const writes = [], otherWrites = [], rejects = [], errors = [];
      const requests = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
      if (process.env.ID_HISTORICAL_ORDER_BROWSER_ASSET) {
        const body = await readFile(process.env.ID_HISTORICAL_ORDER_BROWSER_ASSET);
        await context.route(url => url.origin === origin && url.pathname === '/commerce-prototype.js', route =>
          route.fulfill({ body, contentType: 'text/javascript' }));
      }
      await context.route(origin + '/api/local/**', route => {
        const request = route.request();
        if (request.method() === 'GET') return request.url().endsWith('/api/local/commerce')
          ? route.fulfill({ json: stored }) : route.fallback();
        if (request.method() !== 'PUT' || !request.url().endsWith('/api/local/commerce')) {
          otherWrites.push(new URL(request.url()).pathname);
          return route.fulfill({ status: 400, json: { error: '只接受原订单更正' } });
        }
        const command = request.postDataJSON();
        writes.push(command);
        const verifiedBuyers = new Set();
        const error = command.version !== stored.version ? '版本已变化' :
          checkInventoryRenewals(stored.data, command.data, fixture.inventory.data,
            { action: command.action, actor, completedCustomerOrders: verifiedBuyers }) ||
          stageAppleOrderFunding(stored.data.orders, command.data.orders, ledger, fixture.inventory.data,
            fixture.settings.data, command.action, command.data.customers, verifiedBuyers) ||
          checkAppleLedger(ledger, ledger, fixture.inventory.data, command.data, stored.data);
        if (error) {
          rejects.push(error);
          return route.fulfill({ status: 409, json: { error } });
        }
        stored = { version: stored.version + 1, data: structuredClone(command.data) };
        return route.fulfill({ json: stored });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      page.on('pageerror', error => errors.push(error.message));
      const open = async () => {
        await page.locator('[data-action="commerce-order-detail"][data-id="legacy-apple-order"]').first().click();
        await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      };
      await page.goto(origin + '/#/orders/claude');
      await page.locator('[data-action="commerce-order-detail"][data-id="legacy-apple-order"]').first().waitFor();
      await page.evaluate(() => window.IDDesignAPI.state.drafts.set('commerce-order:legacy-apple-order', {
        'commerce-appleIdId': 'draft-apple', 'commerce-appleStoreRegion': 'US',
        'commerce-paidAmount': '249', 'commerce-paidCurrency': 'USD', 'commerce-notes': '保留未提交备注'
      }));
      await open();
      const form = page.locator('#commerce-order-form');
      const apple = form.locator('#commerce-appleIdId');
      assert.equal(await apple.inputValue(), prior.appleIdId || '', '旧草稿不能覆盖原付款账号');
      assert.equal(await apple.isDisabled(), true);
      assert.equal(await form.locator('#commerce-paidAmount').inputValue(), prior.paidAmount);
      assert.equal(await form.locator('#commerce-notes').inputValue(), '保留未提交备注');
      const formBox = await form.boundingBox(), footerBox = await page.getByRole('button', { name: '保存修改' }).boundingBox();
      assert(formBox.x + formBox.width <= width + 1 && footerBox.x + footerBox.width <= width + 1);
      await form.getByRole('combobox', { name: '客户', exact: true }).click();
      await form.getByRole('option', { name: '合成原买家', exact: true }).click();
      await form.locator('#commerce-notes').fill('补登记买家并保存备注');
      const response = page.waitForResponse(res => res.url() === origin + '/api/local/commerce' &&
        res.request().method() === 'PUT');
      await page.getByRole('button', { name: '保存修改', exact: true }).click();
      assert.equal((await response).status(), 200, JSON.stringify(rejects));
      await page.getByText('订单修改成功', { exact: true }).waitFor();
      assert.equal(writes.length, 1);
      const [saved] = stored.data.orders;
      assert.equal(saved.customerId, 'legacy-buyer');
      assert.equal(saved.notes, '补登记买家并保存备注');
      for (const field of ['orderNo', 'accountId', 'subscriptionEnded', 'payment', 'appleIdId', 'appleStoreRegion',
        'paidConfirmed', 'paidAmount', 'paidCurrency', 'appleFunding', 'saleAmount', 'saleCurrency', 'receiptConfirmed'])
        assert.deepEqual(saved[field], prior[field], field);
      assert.equal(saved.corrections.at(-1).previous.customerId, undefined);
      await page.reload();
      await open();
      assert.equal(await page.locator('#commerce-customerId').inputValue(), 'legacy-buyer');
      assert.equal(await page.locator('#commerce-notes').inputValue(), saved.notes);
      assert.deepEqual(otherWrites, [], '保存补充资料不能请求扣款或改库存');
      assert.deepEqual(errors, []);
      assert.deepEqual(requests.external, []);
    } finally {
      await context.close();
    }
  }
});
