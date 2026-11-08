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
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'admin', name: '合成管理员', role: 'admin' } });
  await context.route(origin + '/api/local/apple-relay/status', route => route.fulfill({ json: { configured: true, parentIds: [parent.id], aliasIds: [] } }));
  const writes = [], errors = []; let fail = true;
  await context.route(origin + '/api/local/apple-relay/alias-register', route => {
    const command = route.request().postDataJSON(); writes.push(command);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '合成登记失败，请重试' } }); }
    const rows = command.rows.map((row, i) => ({ id: `relay-${writes.length}-${i}`, type: 'relay', email: row.email, notes: row.note, parentMailboxId: parent.id,
      relayStatus: 'ACTIVE', health: 'normal', status: '正常', inventoryState: 'available', usageLinks: [], inventoryHistory: [], version: 1, createdAt: '2026-11-08 12:00' }));
    fixture.inventory.data.mailboxes.push(...rows); fixture.inventory.version++;
    return route.fulfill({ json: { inventory: fixture.inventory, registered: rows.length } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/workspace/mail-submit');
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
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});
