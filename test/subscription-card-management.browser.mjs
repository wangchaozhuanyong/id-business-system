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
    product: 'GPT', plan: 'Plus', source: '管理员手工', paidConfirmed: true, receiptConfirmed: true,
    entitlementStatus: 'active', paidAmount: '10000', paidCurrency: 'PHP',
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
    ...Array.from({ length: 18 }, (_, i) => row('active-' + i, customers[0].id, 'active-' + i + '@example.test', -500, 260 + i, 'recharge:' + (100 + i))));
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
        if (width <= 900) for (const row of [expired, upcoming, list.locator('[data-row-id="switch-old"]'),
          list.locator('[data-row-id="switch-new"]')]) await row.getByRole('button', { name: '更多资料' }).click();
        await expired.getByText('175.92 USD').waitFor();
        assert.equal(await expired.getByText('已过期', { exact: true }).count(), 1);
        assert.equal(await upcoming.getByText('即将到期', { exact: true }).count(), 1);
        assert.equal(await list.locator('[data-row-id="switch-old"]').getByText('历史用卡').count(), 1);
        assert.equal(await list.locator('[data-row-id="switch-new"]').getByText('使用中').count(), 1);
        assert.equal(await list.getByText('no-card@example.test').count(), 0);
        assert.ok(!(await list.innerText()).includes(pan));
        assert.equal(await rows.count(), 20);
        const amountHeading = list.locator('thead th[aria-label="预计金额"]');
        const amountHelp = amountHeading.getByLabel('查看预计金额说明');
        const amountNote = amountHeading.locator('.title-description');
        if (width > 900) {
        await amountHelp.scrollIntoViewIfNeeded();
        assert.equal(await amountNote.isVisible(), false);
        const triggerLayout = await amountHelp.evaluate(node => {
          const trigger = node.getBoundingClientRect();
          const label = node.closest('.title-with-help').firstElementChild.getBoundingClientRect();
          return {
            width: trigger.width, height: trigger.height, gap: trigger.left - label.right,
            centerOffset: Math.abs((trigger.top + trigger.bottom - label.top - label.bottom) / 2)
          };
        });
        assert.ok(triggerLayout.gap > 0 && triggerLayout.centerOffset <= 1);
        const targetSize = width <= 900 ? 44 : 28;
        assert.ok(triggerLayout.width >= targetSize && triggerLayout.height >= targetSize);
        const tableHeight = (await list.boundingBox()).height;
        await amountHelp.click();
        await amountHeading.locator('.title-description:popover-open').waitFor();
        assert.match(await amountNote.innerText(), /通用付款固定费用 \+ 2 美元备用金。.*向上取整到美分/u);
        const noteBounds = await amountNote.boundingBox();
        assert.ok(noteBounds.x >= 0 && noteBounds.x + noteBounds.width <= width);
        assert.ok(noteBounds.y >= 0 && noteBounds.y + noteBounds.height <= 900);
        assert.equal(await amountNote.evaluate(note => note.scrollWidth <= note.clientWidth + 1), true);
        assert.equal((await list.boundingBox()).height, tableHeight);
        await amountHelp.press('Escape');
        await amountNote.waitFor({ state: 'hidden' });
        assert.equal(await amountHelp.evaluate(node => document.activeElement === node), true);
        await amountHelp.press('Enter');
        await amountHeading.locator('.title-description:popover-open').waitFor();
        await page.getByLabel('搜索当前列表').click();
        await amountNote.waitFor({ state: 'hidden' });
        } else {
          assert.equal(await expired.getByText('175.92 USD').isVisible(), true);
          assert.equal(await amountHeading.isVisible(), false, '移动端金额随展开的记录显示');
        }
        const copyButton = expired.getByRole('button', { name: '复制', exact: true });
        await copyButton.scrollIntoViewIfNeeded();
        assert.equal(await copyButton.evaluate(button => {
          const rect = button.getBoundingClientRect();
          const table = button.closest('.table-viewport').getBoundingClientRect();
          return rect.left >= table.left - 1 && rect.right <= Math.min(innerWidth, table.right) + 1;
        }), true);
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await rows.count(), 2);
        assert.equal(await amountHelp.count(), 1);
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
        assert.equal(await amountHelp.count(), 1);
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

test('冻结银行卡后两个续费账号都收到提示并可选择新卡', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const localFixtures = await fixture();
  localFixtures['auth/order-owners'] = { items: [actor] };
  const mock = await interceptDesign(context, { localFixtures, actor, skipRechargeAssets: true });
  const shared = localFixtures.commerce.data.orders.filter(row => row.cardId === 'recharge:7');
  const counts = { GPT: 3 };
  const frozen = { id: 'frozen-card', orderId: 'upcoming', typeName: 'wise潘', last4: '4242',
    counts, frozenAt: new Date().toISOString(), frozenBy: actor.name, reason: '冻结测试', poolState: 'pending' };
  let isFrozen = false, submitted;
  await context.route('**/api/local/subscription-card-status*', route => {
    const orderId = new URL(route.request().url()).searchParams.get('orderId');
    if (orderId) {
      const order = localFixtures.commerce.data.orders.find(row => row.id === orderId);
      return route.fulfill({ json: { order: { id: order.id, version: order.version, card: {
        typeName: 'wise潘', last4: '4242', availability: isFrozen ? 'frozen' : 'normal'
      } } } });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: {
      items: shared.map(row => ({ id: row.id, cardKey: 'shared-card', last4: '4242', counts,
        state: isFrozen ? 'frozen' : 'normal', canFreeze: !isFrozen })),
      frozen: isFrozen ? [frozen] : []
    } });
    const body = route.request().postDataJSON();
    if (body.action === 'accounts') return route.fulfill({ json: { accounts: [
      { product: 'GPT', account: 'upcoming@example.test', orders: [{ id: 'upcoming', orderNo: 'QA-upcoming',
        plan: 'Plus', start: shared.find(row => row.id === 'upcoming').start, refunds: 1, bankReturns: 0 }] }
    ] } });
    assert.deepEqual(body, { action: 'freeze', orderId: 'upcoming', version: 1, reason: '冻结测试' });
    isFrozen = true;
    return route.fulfill({ json: { card: frozen } });
  });
  await context.route('**/api/local/order-cards', route => route.fulfill({ json: { items: [
    { id: 'recharge:7', last4: '4242', active: !isFrozen, frozen: isFrozen },
    { id: 'recharge:9', last4: '0009', active: true }
  ] } }));
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: localFixtures.commerce });
    const { data, version } = route.request().postDataJSON();
    submitted = data.orders.find(row => !localFixtures.commerce.data.orders.some(old => row.id === old.id));
    localFixtures.commerce = { data, version: version + 1 };
    return route.fulfill({ json: localFixtures.commerce });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6500);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/data-management/bank-cards');
  const row = page.locator('table[data-table="commerce-subscription-cards"] [data-row-id="upcoming"]');
  await row.getByText('正常', { exact: true }).waitFor();
  await row.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByRole('menuitem', { name: '标记为冻结' }).click();
  const drawer = page.locator('#drawer');
  await drawer.getByLabel('冻结原因（选填）').fill('冻结测试');
  await drawer.getByRole('button', { name: '确认冻结', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '冻结银行卡' }).click();
  const frozenTable = page.locator('table[data-table="commerce-frozen-cards"]');
  await frozenTable.getByText('卡池待停用').waitFor();
  await frozenTable.getByRole('button', { name: '查看银行卡关联账号' }).click();
  await drawer.getByText('GPT · upcoming@example.test · 1 笔订单').click();
  await drawer.getByText('QA-upcoming', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-customerId').evaluate((select, id) => {
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, shared.find(row => row.id === 'upcoming').customerId);
  const email = page.locator('#commerce-email');
  await email.fill('upcoming@example.test');
  await email.blur();
  await page.locator('[data-order-renewal-card]').getByText('已冻结', { exact: true }).waitFor();
  for (const id of ['expired', 'upcoming']) {
    await page.goto(origin + '/#/workspace/order/renew/' + id);
    const hint = page.locator('[data-order-renewal-card]');
    await hint.getByText('已冻结', { exact: true }).waitFor();
    assert.match(await hint.innerText(), /4242/);
    assert.equal(await page.locator('#commerce-cardId option[value="recharge:7"]').count(), 0);
  }
  const picker = page.locator('#commerce-cardId-picker');
  await page.getByRole('button', { name: '换用银行卡', exact: true }).click();
  assert.equal(await picker.evaluate(node => document.activeElement === node), true);
  await picker.click();
  await page.locator('#commerce-cardId-options').getByRole('option', { name: /0009/ }).click();
  await page.locator('#commerce-paidAmount').fill('20');
  await page.locator('#commerce-saleAmount').fill('120');
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  assert.equal(submitted.cardId, 'recharge:9');
  assert.equal(submitted.previousOrderId, 'upcoming');
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
});
