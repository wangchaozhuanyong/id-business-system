import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('快捷隐藏邮箱单条、批量和失败重试复用正式登记，保留主邮箱和结果', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.inventory.data.mailboxes = [];
  const parent = fixture.inventory.data.appleRelay.parents[0]; parent.hasCredential = true;
  fixture.inventory.data.appleRelay.parents = [parent];
  const batchId = 'relay-import-12345678-0000-4000-8000-0dfa65632365';
  const batchCode = 'dfa65632365';
  const registrationTime = '2026-11-08 12:00';
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'admin', name: '合成管理员', role: 'admin' } });
  await context.route(origin + '/api/local/apple-relay/status', route => route.fulfill({ json: { configured: true, parentIds: [parent.id], aliasIds: [] } }));
  const writes = [], errors = []; let fail = true;
  await context.route(origin + '/api/local/apple-relay/alias-register', route => {
    const command = route.request().postDataJSON(); writes.push(command);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '合成登记失败，请重试' } }); }
    const rows = command.rows.map((row, i) => ({ id: `relay-${writes.length}-${i}`, type: 'relay', email: row.email, notes: row.note, parentMailboxId: parent.id,
      relayStatus: 'ACTIVE', health: 'normal', status: '正常', inventoryState: 'available', usageLinks: [], inventoryHistory: [], version: 1,
      createdAt: registrationTime, createdById: 'admin', importId: command.batch ? batchId : '' }));
    if (command.batch) {
      fixture.inventory.data.appleRelay.imports.push({
        id: batchId, type: 'relay', types: ['relay'], parentId: parent.id, time: registrationTime,
        actor: '合成管理员', total: rows.length, success: rows.length, failed: 0, status: '已登记',
        results: rows.map((row, index) => ({ id: row.id, line: index + 1, email: row.email, assetId: row.id, note: row.notes }))
      });
    }
    fixture.inventory.data.mailboxes.push(...rows); fixture.inventory.version++;
    return route.fulfill({ json: { inventory: fixture.inventory, registered: rows.length } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/workspace/mail-submit');
  await page.locator('#inventory-extract-notes').fill('登记时保留右侧提取草稿');
  await page.locator('[data-action="inventory-add-type"][data-type="relay"]').click();
  const drawer = page.locator('#drawer[open]');
  assert.equal(await drawer.locator('#relay-parentId').inputValue(), parent.id, '只有一个可用主邮箱时自动选中');
  assert.equal(await drawer.locator('#relay-password').count(), 0);
  await drawer.locator('#relay-email').fill('single@example.test');
  await drawer.locator('#relay-note').fill('快捷单条合成资料');
  await drawer.locator('[data-action="relay-parent-options-refresh"]').click();
  assert.equal(await drawer.locator('#relay-email').inputValue(), 'single@example.test');
  async function save() {
    await page.locator('button[form="relay-alias-form"][type="submit"]').click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  }
  await save(); await page.getByText('合成登记失败，请重试', { exact: true }).waitFor();
  assert.equal(await drawer.locator('#relay-note').inputValue(), '快捷单条合成资料');
  await save(); await page.locator('table[data-table="快捷隐藏邮箱录入结果"]').waitFor();
  assert.equal(await page.locator('#inventory-extract-notes').inputValue(), '登记时保留右侧提取草稿');
  assert.equal(writes[1].parentId, parent.id); assert.equal(writes[1].batch, false);
  assert.equal(await page.locator('table[data-table="快捷隐藏邮箱录入结果"] tbody tr').count(), 1);
  await page.locator('[data-action="inventory-import"][data-type="relay"]').click();
  await drawer.locator('#relay-content').fill('batch@example.test,合成批次\ninvalid');
  await drawer.locator('[data-action="relay-import-preview"]').click();
  await drawer.getByText('邮箱格式无效', { exact: true }).waitFor();
  await page.locator('button[form="relay-import-form"][type="submit"]').click();
  assert.equal(writes.length, 2, '整批错误不会写入');
  await drawer.locator('#relay-content').fill('batch@example.test,合成批次');
  await drawer.locator('[data-action="relay-import-preview"]').click();
  await page.locator('button[form="relay-import-form"][type="submit"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.locator('table[data-table="快捷隐藏邮箱录入结果"] tbody tr').nth(1).waitFor();
  assert.equal(writes[2].batch, true);
  assert.equal(writes[2].rows.length, 1);
  assert.equal(await page.locator('#main [data-action="relay-primary-manage"]').count(), 0, '快捷入口不增加主邮箱管理功能');
  const close = () => drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await page.getByRole('button', { name: '全部导入', exact: true }).click();
  const importRow = drawer.locator(`tr[data-row-id="${batchId}"]`);
  assert.equal(await importRow.locator('td[data-column="id"]').innerText(), batchCode);
  await importRow.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByText(batchCode, { exact: true }).waitFor();
  await drawer.getByText('batch@example.test', { exact: true }).waitFor();
  await close();

  await page.evaluate(() => window.IDDesignAPI.go('mailboxes/relay'));
  const table = page.locator('table[data-table="relay-aliases"]');
  const aliasRow = table.locator('tbody tr').filter({ hasText: 'batch@example.test' });
  const source = aliasRow.locator('td[data-column="importId"]');
  assert.equal(await source.innerText(), batchCode);
  assert.equal(await table.locator('tbody tr').filter({ hasText: 'single@example.test' })
    .locator('td[data-column="importId"]').innerText(), '单条登记');
  const search = page.locator('#relay-search');
  for (const number of [batchCode, batchId]) {
    await search.fill(number);
    await search.press('Enter');
    assert.equal(await table.locator('tbody tr[data-row-id]').count(), 1);
    assert.equal(await aliasRow.count(), 1);
  }
  await source.getByRole('button', { name: '查看来源导入批次完整内容' }).click();
  assert.equal(await drawer.locator('#table-cell-full-value').inputValue(), batchId);
  await close();
  await aliasRow.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByText(batchCode, { exact: true }).waitFor();
  await close();
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await source.locator('.table-value-ellipsis').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  }
  await page.getByRole('tab', { name: '导入记录', exact: true }).click();
  const imports = page.locator('table[data-table="relay-imports"]');
  assert.equal(await imports.locator('td[data-column="id"]').innerText(), batchCode);
  await imports.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByText(batchCode, { exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});
