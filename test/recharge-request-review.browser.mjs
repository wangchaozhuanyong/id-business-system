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

test('申请按内容恢复原回执，迟到的批准回执保留新打开的详情', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const stock = Array.from({ length: 6 }, (_, i) => ({ code: 'KC-' + 'Z'.repeat(14) + 'ABCDEF'[i], plan: 'plus' }));
  const workspace = origin + '/#/workspace/recharge-codes';

  async function prepare(t, user, beforeResponse, availableStock = stock) {
    const fixture = setup();
    fixture.transport.listCodeStock = async () => availableStock;
    const handler = fixture.start(), context = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => context.close());
    const requests = await interceptDesign(context, { actor: user, localFixtures: {}, skipRechargeAssets: true });
    await context.route(origin + '/api/local/recharge-codes*', async route => {
      const request = route.request(), input = request.method() === 'POST' ? request.postDataJSON() : undefined;
      const { status, ...json } = await call(handler, input, user, new URL(request.url()).search);
      if (await beforeResponse(input, status)) return route.abort('connectionreset');
      return route.fulfill({ status, json });
    });
    return { fixture, handler, page: await context.newPage(), requests };
  }

  await t.test('不同数量使用新编号，重试原数量取得原回执', async t => {
    const writes = [];
    const { fixture, page, requests } = await prepare(t, actor, (input, status) => {
      if (input?.action !== 'request') return false;
      writes.push({ input, status });
      return writes.length === 1;
    });
    await page.goto(workspace);
    const submit = page.getByRole('button', { name: '提交申请', exact: true });
    await submit.click();
    await page.locator('[data-request-status="pending"]').waitFor();
    const count = page.locator('#recharge-request-count');
    await count.fill('2');
    await submit.click();
    await page.getByRole('status').getByText('申请已提交，等待审核', { exact: true }).first().waitFor();
    await count.fill('1');
    await submit.click();
    await page.waitForFunction(() => !document.querySelector('#recharge-code-request button[type="submit"]').disabled);
    assert.deepEqual(writes.map(row => row.status), [201, 201, 200]);
    assert.notEqual(writes[0].input.requestKey, writes[1].input.requestKey);
    assert.equal(writes[0].input.requestKey, writes[2].input.requestKey);
    assert.equal(fixture.store.load().data.requests.filter(row => row.status === 'pending').length, 2);
    assert.deepEqual(requests.external, []);
  });

  await t.test('库存已发完时仍能核对原编号，其他数量继续校验库存', async t => {
    const writes = [];
    const { fixture, handler, page, requests } = await prepare(t, actor, (input, status) => {
      if (input?.action !== 'request') return false;
      writes.push({ input, status });
      return writes.length === 1;
    }, stock.slice(0, 1));
    await page.goto(workspace);
    const submit = page.getByRole('button', { name: '提交申请', exact: true });
    await submit.click();
    await page.locator('[data-request-status="pending"]').waitFor();
    const pending = fixture.store.load().data.requests.find(row => row.status === 'pending');
    const approved = await call(handler, { action: 'approve', id: pending.id }, { ...actor, role: 'admin' });
    assert.equal(approved.status, 200);
    assert.equal((await call(handler, undefined, actor)).stock.plus, 0);
    await page.getByRole('button', { name: '刷新提取申请', exact: true }).click();
    await page.locator(`[data-request-id="${pending.id}"][data-request-status="issued"]`).waitFor();
    assert(await submit.isEnabled());
    const count = page.locator('#recharge-request-count');
    await count.fill('2');
    assert(await submit.isDisabled());
    await count.fill('1');
    assert(await submit.isEnabled());
    await page.evaluate(() => window.IDDesignAPI.render());
    assert(await submit.isEnabled());
    await submit.click();
    await page.locator('#toast').getByText('已发码', { exact: true }).waitFor();
    assert.deepEqual(writes.map(row => row.status), [201, 200]);
    assert.equal(writes[0].input.requestKey, writes[1].input.requestKey);
    assert.equal(fixture.store.load().data.requests.filter(row => row.id === pending.id).length, 1);
    assert(await submit.isDisabled());
    assert.deepEqual(requests.external, []);
  });

  await t.test('批准响应到达时仅能关闭本次提交的抽屉', async t => {
    const approval = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const { fixture, page, requests } = await prepare(t, { ...actor, role: 'admin' }, async (input, status) => {
      if (input?.action === 'approve') { approval.resolve(status); await release.promise; }
      return false;
    });
    const before = fixture.store.load(), id = randomUUID();
    fixture.store.save(before.version, { ...before.data, requests: [...before.data.requests, {
      id, plan: 'plus', count: 1, status: 'pending', applicantId: actor.id, applicantName: actor.name,
      createdAt: '2026-11-12T12:00:00Z'
    }] }, { action: 'synthetic_seed' });
    await page.goto(workspace);
    const drawer = page.locator('#drawer[open]');
    await page.locator('[data-action="order-code-approve"]').click();
    await drawer.getByRole('button', { name: '批准并发码', exact: true }).click();
    assert.equal(await approval.promise, 200);
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#recharge-codes-region [data-action="order-code-item-detail"]').first().click();
    const detail = drawer.getByRole('heading', { name: '充值码详情', exact: true });
    await detail.waitFor();
    release.resolve();
    await page.locator(`[data-request-id="${id}"][data-request-status="issued"]`).waitFor();
    assert(await detail.isVisible());
    assert.deepEqual(requests.external, []);
  });
});
