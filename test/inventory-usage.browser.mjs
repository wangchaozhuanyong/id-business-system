import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('库存使用状态、归还核对和成品选单使用同一份本机资料', { timeout: 45_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  t.after(() => new Promise((resolve) => { host.server.close(resolve); host.server.closeAllConnections(); }));
  const origin = new URL(host.url).origin;
  async function save(domain, version, data, action) {
    const response = await fetch(host.url + 'api/local/' + domain, {
      method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, data, action })
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result.error));
    return result;
  }
  const mailbox = (id, type = 'google') => ({
    id, type, email: id + '@example.test', status: '正常', health: 'normal',
    inventoryState: 'available', usageLinks: [], version: 1
  });
  const used = { ...mailbox('used-mail'), health: 'dead' };
  const unused = mailbox('unused-mail');
  const relay = { ...mailbox('hidden-mail', 'relay'), parentMailboxId: 'parent-1', relayStatus: 'ACTIVE' };
  const stock = { ...mailbox('claimed-account', 'gpt'), emailType: 'google' };
  function batch(id, kind, purpose, rows) {
    return { id, kind, purpose, actorId: 'local-operator', actorName: '本机操作员',
      time: '2026-01-01 10:30', items: rows.map((row) => {
        const item = { id: 'claim-' + row.id, assetId: row.id, email: row.email, type: row.type,
          status: 'pending', claimedAt: '2026-01-01 10:30' };
        Object.assign(row, { inventoryState: 'claimed', used: true, claimId: item.id, claimBatchId: id });
        return item;
      })
    };
  }
  const initial = {
    mailboxes: [used, unused, relay], accounts: [stock],
    batches: [batch('mail-batch', 'mail', '注册 GPT', [used, unused]),
      batch('account-batch', 'account', '客户交付', [stock])],
    returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [],
    appleRelay: { parents: [{ id: 'parent-1', email: 'parent@example.test', status: 'ACTIVE' }], events: [], imports: [] }
  };
  await save('inventory', 0, initial, 'inventory_extract');
  initial.accounts.push(...[used, relay].map((row) => ({
    ...mailbox('registered-' + row.id, 'gpt'), email: row.email, emailType: row.type,
    registered: '2026-01-01 11:30', createdById: 'local-operator'
  })));
  await save('inventory', 1, initial, 'inventory_import');
  await save('commerce', 0, {
    orders: [], customers: [{ id: 'customer-1', name: '测试客户', phone: '00000000', active: true }],
    tenants: [], operating: [], rentBatches: [], logs: []
  }, '新增资料');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(7000);
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  await page.goto(host.url + '#/mailboxes/relay');
  await page.getByRole('button', { name: '已提取 0', exact: true }).waitFor();
  await page.getByRole('button', { name: '已使用 1', exact: true }).click();
  await page.getByText(relay.email, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(host.url + '#/mailboxes/google');
  await page.getByRole('tab', { name: /已使用/ }).click();
  const usedRow = page.getByRole('row').filter({ hasText: used.email });
  await usedRow.waitFor();
  assert.match(await usedRow.innerText(), /死号/);

  await page.goto(host.url + '#/workspace/extractions/mail-batch');
  const pending = page.getByRole('row').filter({ hasText: unused.email });
  await pending.getByRole('button', { name: '归还', exact: true }).click();
  await page.locator('#drawer[open] #inventory-return-form').waitFor();
  await page.getByRole('button', { name: '确认归还', exact: true }).click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: /确认/ }).click();
  await pending.getByText('已归还', { exact: true }).waitFor();
  await page.getByRole('row').filter({ hasText: used.email }).getByText('已使用', { exact: true }).waitFor();
  const data = await fetch(host.url + 'api/local/inventory').then((response) => response.json());
  assert.deepEqual(data.data.batches[0].items.map((item) => item.status), ['used', 'returned']);

  await page.goto(host.url + '#/workspace/order');
  await page.locator('#commerce-product').selectOption('GPT');
  await page.locator('#commerce-businessType').selectOption({ label: '成品交付' });
  await page.locator('#commerce-emailHistory-picker').click();
  await page.getByRole('searchbox', { name: '搜索可用账号' }).fill('claimed-account');
  const stockOption = page.locator('#commerce-emailHistory-options [role="option"]').filter({ hasText: '已提取' });
  assert.equal(await stockOption.getAttribute('data-value'), stock.email);
  await stockOption.click();
  await page.locator('#commerce-customerId-picker').click();
  await page.locator('#commerce-customerId-options [data-value="customer-1"]').click();
  await page.locator('#commerce-payment').selectOption({ label: '银行卡' });
  await page.locator('#commerce-cardId').fill('card-test');
  await page.locator('#commerce-paymentId').fill('000001');
  await page.locator('#commerce-paidAmount').fill('20');
  await page.locator('#commerce-saleAmount').fill('100');
  await page.locator('#commerce-start').fill('2026-01-01T11:30');
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForURL('**/#/orders/gpt');
  const delivered = await fetch(host.url + 'api/local/inventory').then((response) => response.json());
  const order = await fetch(host.url + 'api/local/commerce').then((response) => response.json());
  assert.equal(delivered.data.batches[1].items[0].status, 'used');
  assert.equal(delivered.data.batches[1].items[0].orderId, order.data.orders[0].id);
  assert.equal(order.data.orders[0].accountId, stock.id);

  async function correct(row) {
    await row.getByRole('button', { name: '详情', exact: true }).click();
    await page.getByRole('button', { name: '更正关联', exact: true }).click();
    await page.locator('#inventory-usage-correction-reason').fill('核对后确认该资料与此使用记录无关');
    await page.getByRole('button', { name: '核对更正', exact: true }).click();
    await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认更正', exact: true }).click();
    await page.locator('#drawer[open]').getByText(/^已更正 · 账号登记/).waitFor();
  }
  await page.goto(host.url + '#/mailboxes/relay');
  await page.getByRole('button', { name: '已使用 1', exact: true }).click();
  await correct(page.getByRole('row').filter({ hasText: relay.email }));
  await page.locator('#drawer[open]').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '库存 1', exact: true }).click();
  await page.getByRole('cell', { name: relay.email, exact: true }).waitFor();

  await page.goto(host.url + '#/mailboxes/google');
  await page.getByRole('tab', { name: /已使用/ }).click();
  await correct(page.getByRole('row').filter({ hasText: used.email }));
  await page.locator('#drawer[open]').getByRole('button', { name: '查看原提取批次', exact: true }).click();
  await page.getByRole('row').filter({ hasText: used.email }).getByText('原使用关联已更正', { exact: true }).waitFor();
  const final = await fetch(host.url + 'api/local/inventory').then((response) => response.json());
  assert.equal(final.data.batches[0].items[0].status, 'pending');
  assert.equal(final.data.batches[0].items[1].status, 'returned');
  assert.equal(final.data.batches[1].items[0].status, 'used');
});
