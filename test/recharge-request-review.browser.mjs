import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setup, call, actor } from './helpers/recharge-return-fixture.mjs';
import { interceptDesign, origin, root, settle, spacingSnapshot } from './helpers/offline-design.mjs';

test('申请审批模块按角色展示，状态筛选与草稿独立，宽窄屏操作完整可见', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/recharge-request-review';
  await mkdir(output, { recursive: true });
  const f = setup(), issued = f.store.load().data.requests[0];
  const pending = { id: randomUUID(), plan: 'plus', count: 1, status: 'pending', applicantId: actor.id,
    applicantName: '验收管理员', createdAt: '2026-11-11T11:31:12Z' };
  const saveRows = rows => { const doc = f.store.load(); f.store.save(doc.version, { ...doc.data, requests: rows }, { action: 'synthetic_seed' }); };
  saveRows([pending]);
  const stock = Array.from({ length: 6 }, (_, i) => ({ code: 'KC-' + 'Z'.repeat(14) + 'ABCDEF'[i], plan: 'plus' }));
  f.transport.listCodeStock = async () => stock;
  const handler = f.start(), geometry = [];
  for (const role of ['admin', 'super', 'employee']) {
    const user = { ...actor, name: '验收管理员', role };
    const context = await browser.newContext({ viewport: { width: 2480, height: 1100 } });
    const traffic = await interceptDesign(context, { localFixtures: {}, actor: user, skipRechargeAssets: true });
    let failRead = false, reads = 0;
    const writes = [], errors = [];
    await context.route(origin + '/api/local/recharge-codes*', async route => {
      const request = route.request(), query = new URL(request.url()).search;
      if (request.method() !== 'GET') { writes.push(request.postDataJSON()); return route.abort(); }
      reads++;
      if (failRead && !query.includes('view=codes')) return route.fulfill({ status: 503, json: { error: '合成库存读取失败' } });
      const { status, ...json } = await call(handler, undefined, user, query);
      return route.fulfill({ status, json });
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/workspace/recharge-codes');
    const left = page.locator('#recharge-request-region'), history = left.locator('#recharge-request-history');
    const filter = key => history.locator(`[data-action="order-request-filter"][data-id="${key}"]`);
    await left.locator('[data-request-id]').first().waitFor();
    assert.equal(await history.locator('h3').innerText(), role === 'employee' ? '我的申请' : '申请审批');
    if (role === 'employee') assert.equal(await left.locator('[data-action="order-code-approve"], [data-action="order-code-reject"], [data-action="order-code-reconcile"]').count(), 0);
    else assert.equal(await left.locator('[data-action="order-code-approve"]').count(), 1);
    if (role === 'admin') for (const width of [2480, 1920, 1440, 1024, 900, 414, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
      assert.deepEqual((await spacingSnapshot(page)).findings, [], `${width} ${theme} 分隔线留白`);
      const layout = await left.evaluate(node => {
        const rect = node => node.getBoundingClientRect().toJSON();
        const record = node.querySelector('[data-request-id]');
        const select = node.querySelector('#recharge-request-plan'), style = getComputedStyle(select);
        const canvas = document.createElement('canvas').getContext('2d'); canvas.font = style.font;
        const requiredSelectWidth = Math.max(...[...select.options].map(option => canvas.measureText(option.textContent).width)) +
          parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 20;
        return { panel: rect(node), form: rect(node.querySelector('.recharge-request-form')), review: rect(node.querySelector('.recharge-request-review')),
          record: rect(record), heading: rect(record.querySelector('.recharge-request-heading')),
          select: rect(select), requiredSelectWidth,
          actions: [...record.querySelectorAll('button')].map(rect),
          filters: [...node.querySelectorAll('[data-action="order-request-filter"]')].map(rect),
          overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert(!layout.overflow);
      assert(layout.select.width >= layout.requiredSelectWidth, `${width} ${theme} 所有套餐选项文字完整可见`);
      assert(layout.review.top >= layout.form.bottom - 1);
      assert(layout.actions.every(box => box.left >= layout.record.left + 8 && box.right <= layout.record.right - 8 && box.bottom <= layout.record.bottom - 8));
      assert(layout.actions.every(box => box.height >= (width <= 900 ? 44 : 36)));
      assert(layout.filters.every(box => box.left >= layout.panel.left && box.right <= layout.panel.right));
      assert(Math.abs(layout.filters[0].top - layout.filters[2].top) <= 1, '申请状态切换始终同排');
      const beforeHelp = await left.boundingBox();
      await history.getByLabel('查看申请审批说明', { exact: true }).click();
      await page.locator('.title-description:popover-open').waitFor();
      assert.deepEqual(await left.boundingBox(), beforeHelp, '说明不撑动模块');
      await page.keyboard.press('Escape');
      await history.locator('h3').click();
      if ([2480, 390].includes(width)) {
        await page.evaluate(() => scrollTo(0, 0));
        await left.screenshot({ path: `${output}/after-${width}-${theme}.png` });
      }
      geometry.push({ width, theme, ...layout });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    saveRows([pending, { ...pending, id: randomUUID(), status: 'issuing', codes: [] },
      { ...pending, id: randomUUID(), applicantId: 'other', applicantName: '另一员工' },
      { ...pending, id: randomUUID(), status: 'rejected', reason: '合成驳回原因' }, issued]);
    await left.getByRole('button', { name: '刷新提取申请', exact: true }).click();
    await page.waitForFunction(total => document.querySelectorAll('#recharge-request-history [data-request-id]').length === total, role === 'employee' ? 4 : 5);
    const expectedPending = role === 'employee' ? '2' : '3';
    assert.equal(await filter('pending').locator('span').innerText(), expectedPending);
    assert.equal(await filter('processed').locator('span').innerText(), '2');
    await page.locator('#recharge-request-count').fill('3');
    await page.locator('#code-list-query').fill('不应被左侧筛选清除');
    await page.evaluate(() => { window.originalRequestForm = document.querySelector('#recharge-code-request'); });
    const beforeFilters = reads;
    await filter('processed').click();
    assert.equal(await history.locator('[data-request-id]').count(), 2);
    assert.equal(await history.locator('[data-action="order-code-approve"], [data-action="order-code-reject"]').count(), 0);
    await filter('pending').click();
    assert.equal(await history.locator('[data-request-id]').count(), Number(expectedPending));
    assert.equal(await page.locator('#recharge-request-count').inputValue(), '3');
    assert.equal(await page.locator('#code-list-query').inputValue(), '不应被左侧筛选清除');
    assert(await page.evaluate(() => window.originalRequestForm === document.querySelector('#recharge-code-request')));
    assert.equal(reads, beforeFilters, '本地状态筛选不重复读取或写入');
    failRead = true;
    await left.getByRole('button', { name: '刷新提取申请', exact: true }).click();
    await left.locator('[data-code-error]:not([hidden])').waitFor();
    assert(await left.getByRole('button', { name: '提交申请', exact: true }).isDisabled());
    for (const button of await history.locator('[data-action="order-code-approve"]').all()) assert(await button.isDisabled());
    assert.equal(await history.locator('[data-request-id]').count(), Number(expectedPending), '读取失败保留已知申请');
    failRead = false; saveRows([issued]);
    await left.getByRole('button', { name: '刷新提取申请', exact: true }).click();
    await history.getByRole('heading', { name: '暂无待处理申请' }).waitFor();
    assert.equal(await filter('pending').locator('span').innerText(), '0');
    await filter('processed').click();
    assert.equal(await history.locator('[data-request-id]').count(), 1);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
    await context.close(); saveRows([pending]);
  }
  await writeFile(output + '/review-geometry.json', JSON.stringify(geometry, null, 2));
});
