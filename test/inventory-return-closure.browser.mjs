import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('批次显示归还资格，同邮箱产品需明确选择；核对使用最新快照且保留逐行问题', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/inventory-return-closure.json', import.meta.url)));
  for (const width of [1440, 390]) for (const fixture of fixtures) {
    const data = structuredClone(fixture.inventory);
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const requests = await interceptDesign(context, { localFixtures: { inventory: { version: 1, data } }, actor: { id: 'actor-1', name: '演示测试员', role: 'admin' } });
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    const mutations = []; page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) mutations.push(new URL(r.url()).pathname); });
    await page.goto(origin + '/#/' + fixture.route);
    if (fixture.name === 'all-used') {
      const action = page.locator('[data-action="inventory-batch-return"]').first();
      await action.waitFor(); assert(await action.isDisabled()); assert.match(await action.innerText(), /无可归还项/);
      assert((await page.locator('th').allTextContents()).includes('可归还'));
      await page.locator('[data-action="inventory-batch"]').first().click();
      await page.getByText('归还资格', { exact: true }).waitFor();
      assert.equal(await page.getByText('本次领用已实际使用', { exact: true }).count(), 10);
    } else {
      await page.locator('[data-action="inventory-center-tab"][data-tab="quick"]').click();
      await page.locator('#inventory-quick-text').fill(fixture.query);
      await page.locator('#inventory-quick-kind').selectOption('account');
      await page.getByRole('button', { name: '查找并核对', exact: true }).click();
      const drawer = page.locator('#drawer[open]'); await drawer.waitFor(); await settle(page);
      assert.equal(await drawer.locator('input[data-return-claim]:checked').count(), 0, '有产品歧义时不默认全选');
      assert((await drawer.locator('th').allTextContents()).includes('资料类型'));
      assert(await page.locator('button[form="inventory-return-form"][type="submit"]').isDisabled());
      await page.evaluate(() => window.IDDesignAPI.closeDrawer());
      await page.locator('#inventory-quick-type').selectOption('gpt');
      await page.getByRole('button', { name: '查找并核对', exact: true }).click();
      await drawer.waitFor();
      assert.equal(await drawer.locator('input[data-return-claim]:checked').count(), 1, '选择 GPT 只核对本产品');
      await page.evaluate(() => window.IDDesignAPI.closeDrawer());
      let reads = 0;
      await context.route(origin + '/api/local/inventory', route => {
        reads++;
        const fresh = structuredClone(data), asset = fresh.accounts.find(row => row.type === 'gpt');
        asset.inventoryState = 'used'; asset.actualUsedAt = '2026-11-08 12:00';
        fresh.batches.flatMap(batch => batch.items).find(item => item.assetId === asset.id).status = 'used';
        return route.fulfill({ json: { version: 2, data: fresh } });
      });
      await page.locator('#inventory-quick-text').fill(fixture.query + '\n' + fixture.query.toUpperCase() + '\ninvalid\nmissing@example.test');
      await page.getByRole('button', { name: '查找并核对', exact: true }).click();
      await drawer.waitFor(); assert.equal(reads, 1);
      assert.equal(await drawer.locator('input[data-return-claim]:checked').count(), 0, '最新已使用项不可归还');
      assert.match(await drawer.innerText(), /本次领用已实际使用/);
      assert.match(await drawer.innerText(), /重复/); assert.match(await drawer.innerText(), /格式/); assert.match(await drawer.innerText(), /未找到/);
    }
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
    await context.close();
  }
});
