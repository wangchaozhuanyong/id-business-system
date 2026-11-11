import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import path from 'node:path';
import { setup, call, actor } from './helpers/recharge-return-fixture.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('充值码归还复用真实服务规则，状态变化重新确认，失败恢复，复制和归还记录一致', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const f = setup(), handler = f.start();
  f.blocked.set(f.codes[4], '存在历史充值任务，请管理员核对；' + '当前操作保留原任务和领用记录。'.repeat(6));
  const traffic = [];
  const requests = await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
  await context.route(origin + '/api/local/recharge-codes*', async route => {
    const request = route.request();
    const result = await call(handler, request.method() === 'POST' ? request.postDataJSON() : undefined, actor, new URL(request.url()).search);
    traffic.push({ method: request.method(), action: request.method() === 'POST' ? request.postDataJSON().action : '', status: result.status });
    const { status, ...body } = result; return route.fulfill({ status, json: body });
  });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  const output = process.env.ID_LAYOUT_QA_OUTPUT || fileURLToPath(new URL('../.runtime/recharge-return-layout/', import.meta.url)); await mkdir(output, { recursive: true });
  await page.goto(origin + '/#/workspace/recharge-codes');
  await page.getByRole('button', { name: '归还（2）', exact: true }).waitFor();
  await page.locator('[data-action="order-code-batch-return"]').click();
  const drawer = page.locator('#drawer[open]'), form = drawer.locator('#code-return-form');
  await form.waitFor();
  assert.equal(await form.locator('.recharge-return-card').count(), 7);
  assert.equal(await form.locator('table').count(), 0);
  assert.equal(await form.locator('#code-return-selection').innerText(), '已选 2 / 共 7 条');
  assert.equal(await form.locator('.recharge-return-heading strong').first().innerText(), 'PO000001-01');
  assert(!(await form.innerText()).includes(f.items[0]));
  for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
    const geometry = await form.evaluate(form => {
      const body = form.closest('.drawer-body'), bounds = body.getBoundingClientRect();
      return { horizontal: body.scrollWidth > body.clientWidth + 1,
        clipped: [...form.querySelectorAll('.recharge-return-card, .recharge-return-heading strong, .recharge-return-meta dd, .recharge-return-result p, input')].some(node => {
          const box = node.getBoundingClientRect();
          return box.left < bounds.left || box.right > bounds.right || node.scrollWidth > node.clientWidth + 1;
        }), labelHeights: [...form.querySelectorAll('.recharge-return-heading label')].map(node => node.getBoundingClientRect().height) };
    });
    assert.equal(geometry.horizontal, false, `${width} ${theme} 归还抽屉不横向滚动`);
    assert.equal(geometry.clipped, false, `${width} ${theme} 编号、核对结果和控件完整显示`);
    assert(geometry.labelHeights.every(height => height >= 44), '勾选区保持触控尺寸');
    if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, `return-drawer-${width}-${theme}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.locator(`[data-action="order-code-return"][data-id="${f.items[0]}"]`).click();
  await form.waitFor();
  assert.equal(await form.locator('.recharge-return-card').count(), 1);
  await drawer.screenshot({ path: path.join(output, 'return-drawer-single-light.png') });
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.locator('[data-action="order-code-batch-detail"]').click();
  await drawer.locator('.recharge-batch-detail').waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await settle(page);
    assert(await drawer.locator('.recharge-batch-detail').evaluate(node => {
      const body = node.closest('.drawer-body'), bounds = body.getBoundingClientRect();
      return body.scrollWidth <= body.clientWidth + 1 && [...node.querySelectorAll('td, button')].filter(control => control.checkVisibility()).every(control => {
        const box = control.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right + 1 && control.scrollWidth <= control.clientWidth + 1;
      });
    }), `${width} 批次明细在窄抽屉完整显示`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.locator('[data-action="order-code-batch-return"]').click(); await form.waitFor();
  assert.equal(await form.locator('input[type="checkbox"]:not(:disabled)').count(), 2);
  await form.locator('#code-return-note').fill('合成未用归还备注');
  const first = form.locator(`input[name="return-code-${f.items[0]}"]`), second = form.locator(`input[name="return-code-${f.items[1]}"]`);
  await second.uncheck();
  assert.equal(await form.locator('#code-return-selection').innerText(), '已选 1 / 共 7 条');
  await first.uncheck();
  assert(await page.locator('button[form="code-return-form"][type="submit"]').isDisabled());
  await first.check();
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.locator('[data-action="order-code-batch-return"]').click(); await form.waitFor();
  assert.equal(await form.locator('#code-return-note').inputValue(), '合成未用归还备注'); assert(!(await second.isChecked()));
  f.native.get(f.codes[0]).status = 'used';
  await page.locator('button[form="code-return-form"][type="submit"]').click();
  await first.waitFor({ state: 'attached' }); await page.waitForFunction(id => document.querySelector(`input[name="return-code-${id}"]`)?.disabled, f.items[0]);
  assert.equal(f.commands.length, 0, '状态变化后不会静默归还第二条');
  assert(!(await second.isChecked()), '重核对保留原来的明确选择');
  f.native.get(f.codes[0]).status = 'unused';
  await drawer.locator('[data-action="order-code-return-refresh"]').click();
  await page.waitForFunction(id => document.querySelector(`input[name="return-code-${id}"]`)?.disabled === false, f.items[0]); await first.check();
  f.failNextSave();
  await page.locator('button[form="code-return-form"][type="submit"]').click();
  await drawer.getByText('原操作已登记，落账结果待核对，请核对并继续', { exact: true }).waitFor();
  assert.equal(f.commands.length, 1);
  await drawer.locator('[data-action="order-code-return-resume"]').click();
  await page.waitForFunction(id => document.querySelector(`input[name="return-code-${id}"]`)?.disabled === false, f.items[0]); await first.check();
  await page.locator('button[form="code-return-form"][type="submit"]').click();
  await drawer.getByText('已归还，原码已永久失效', { exact: true }).waitFor();
  assert.equal(f.commands.length, 1, '落账恢复只回读原回执');
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.goto(origin + '/#/workspace/my-recharge-codes');
  await page.locator('#code-list-query').fill('po000001-02');
  await settle(page);
  assert.equal(await page.locator('#recharge-code-list tbody tr[data-row-id]').count(), 1);
  assert.equal(await page.locator('#recharge-code-list tbody tr[data-row-id]').getAttribute('data-row-id'), f.items[1]);
  await page.locator('#code-list-query').fill('po000001');
  await settle(page);
  assert.equal(await page.locator('#recharge-code-list tbody tr[data-row-id]').count(), 3);
  await page.locator('#code-list-query').fill('');
  await page.locator('[data-action="order-code-tab"][data-id="returned"]').click();
  await page.locator('table[data-table="my-recharge-codes"] tbody tr').waitFor();
  assert.equal(await page.getByText(f.codes[0], { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-action="order-code-copy"]').count(), 0);
  await page.locator('[data-action="order-code-tab"][data-id="returns"]').click();
  await page.locator('[data-action="order-code-item-detail"]').click();
  await page.getByText('合成未用归还备注', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${theme} 整页不能溢出`);
    const controls = await page.locator('#main .toolbar input,#main .toolbar select,#main .toolbar button').evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect().toJSON()));
    assert(controls.every(box => box.x >= 0 && box.right <= width + 1), `${width} 工具区控件被裁切`);
    if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, `code-return-history-${width}-${theme}.png`) });
  }
  await page.goto(origin + '/#/workspace/recharge-codes');
  await page.getByRole('button', { name: '归还（1）', exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(requests.unavailable, []); assert.deepEqual(requests.external, []);
});
