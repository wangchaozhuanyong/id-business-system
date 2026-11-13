import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { checkFinanceSnapshots, historicalFeeAction } from '../server/finance/snapshot-integrity.mjs';
import { historicalGptCardBackfillError } from '../server/order-policy.mjs';

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
  await f.page.locator('#commerce-fee-reason').fill('根据原付款记录逐单核对');
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  assert.equal(f.writes.length, 0);
  await f.page.locator('#commerce-fee-verified').check();
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  const saved = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
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
  await f.page.locator('#commerce-fee-verified').check();
  f.externalVersionChange();
  await f.page.locator('button[form="commerce-fee-correction-form"]').click();
  const rejected = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
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
  await f.page.locator('#commerce-backfill-reason').fill('根据原付款记录核对');
  await f.page.locator('button[form="commerce-card-backfill-form"]').click();
  assert.equal(f.writes.length, 0);
  await f.page.locator('#commerce-backfill-verified').check();
  await f.page.locator('button[form="commerce-card-backfill-form"]').click();
  const saved = f.page.waitForResponse(response => response.url() === origin + '/api/local/commerce' &&
    response.request().method() === 'PUT');
  await f.page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
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
