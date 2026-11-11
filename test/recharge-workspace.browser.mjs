import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setup, call, actor } from './helpers/recharge-return-fixture.mjs';
import { createRechargeCodeHandler } from '../server/recharge-code-requests.mjs';
import { interceptDesign, origin, root, settle, spacingSnapshot } from './helpers/offline-design.mjs';

// Real request/return rules, synthetic in-memory store and transport. No server or database.
test('充值码合并工作台独立刷新分页、保留草稿、审批后定位新批次并完整显示', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/recharge-workspace-20261110'; await mkdir(output, { recursive: true });
  const f = setup(), admin = { ...actor, name: '工作台验收员', role: 'admin' };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = i => 'KC-' + 'A'.repeat(13) + alphabet[Math.floor(i / alphabet.length)] + alphabet[i % alphabet.length];
  const document = f.store.load();
  document.data.requests[0].createdAt = '2026-11-08T01:00:00Z';
  for (let i = 0; i < 25; i++) {
    const value = code(i);
    f.native.set(value, { code: value, plan_type: 'plus', type: '自助', status: 'unused', shipped: false });
    document.data.requests[0].codes.push(value); document.data.requests[0].count++;
  }
  for (let i = 0; i < 23; i++) document.data.requests.push({ id: randomUUID(), status: 'pending', count: 1, plan: 'plus',
    applicantId: i === 0 ? 'other' : admin.id, applicantName: i === 0 ? '其他员工' : admin.name,
    createdAt: `2026-11-10T01:${String(59-i).padStart(2,'0')}:00Z` });
  f.store.save(document.version, document.data, { action: 'synthetic_seed' });
  for (let i = 40; i < 65; i++) {
    const value = code(i); f.native.set(value, { code: value, plan_type: i < 60 ? 'plus' : 'pro100', type: '自助', status: 'unused', shipped: false });
  }
  f.transport.listCodeStock = async () => [...f.native.values()].filter(row => row.code.length === 18 && row.status === 'unused' && !row.shipped)
    .map(row => ({ code: row.code, plan: row.plan_type }));
  const handler = createRechargeCodeHandler({ store: f.store, transport: f.transport, publicOrigin: 'https://return.invalid', clock: () => Date.parse('2026-11-10T04:30:00Z') });
  const fixture = JSON.parse(await readFile(root + '/docs/audits/2026-11-06-design-review/visual-fixtures.json'));
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, serviceWorkers: 'block', locale: 'zh-CN' });
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: admin });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedCode = value; } } }); });
  const traffic = [], fail = { codes: false, requests: false, write: false }, gates = {};
  await context.route(origin + '/api/local/recharge-codes*', async route => {
    const request = route.request(), body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    const key = body ? 'write' : new URL(request.url()).searchParams.get('view') === 'codes' ? 'codes' : 'requests';
    traffic.push({ key, action: body?.action });
    if (gates[key]) { const gate = gates[key]; delete gates[key]; await gate; }
    if (fail[key]) { fail[key] = false; return route.fulfill({ status: 503, json: { error: '合成读取或保存失败，请重试' } }); }
    const { status, ...result } = await call(handler, body, admin, new URL(request.url()).search);
    return route.fulfill({ status, json: result });
  });
  const page = await context.newPage(), errors = [], measurements = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6500);
  const go = async route => { await page.evaluate(route => window.IDDesignAPI.go(route), route); await page.locator('#main[data-layout-route="' + route + '"]').waitFor(); await settle(page); };
  await page.goto(origin + '/#/workspace/my-recharge-codes');
  await page.locator('#recharge-request-stock').getByText(/剩余可提取 20 个/).waitFor();
  await page.locator('#recharge-code-list tbody tr[data-row-id]').first().waitFor();
  assert.equal(new URL(page.url()).hash, '#/workspace/recharge-codes');
  assert.equal(await page.locator('#sidebar a[href="#/workspace/my-recharge-codes"]').count(), 0);
  assert.equal(await page.locator('#sidebar a[href="#/workspace/recharge-codes"][aria-current="page"]').count(), 1);
  const left = page.locator('#recharge-request-region'), right = page.locator('#recharge-codes-region');
  const leftPager = left.locator('[data-pagination="recharge-request-view"]'), rightPager = right.locator('[data-pagination="recharge-code-view"]');
  const measure = async (width, theme, state) => {
    await settle(page);
    const snapshot = await spacingSnapshot(page); assert.deepEqual(snapshot.findings, [], `${width}/${theme}/${state}: ${JSON.stringify(snapshot.findings)}`);
    const geometry = await page.locator('.recharge-workspace-columns').evaluate(container => {
      const rect = node => node.getBoundingClientRect().toJSON();
      const text = node => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect().toJSON(); };
      const [left, right] = container.children;
      const toolbar = right.querySelector('.recharge-code-toolbar');
      const tabs = toolbar.querySelector('.recharge-code-tabs');
      const controls = ['#code-list-query', '#code-list-plan', '[data-action="order-code-return-selected"]']
        .map(selector => rect(toolbar.querySelector(selector)));
      return { container: rect(container), left: rect(left), right: rect(right), lt: text(left.querySelector('h2')), rt: text(right.querySelector('h2')),
        fields: [...left.querySelectorAll('.field')].map(field => ({ label: rect(field.querySelector('label')), control: rect(field.querySelector('input,select')) })),
        toolbar: { bounds: rect(toolbar), tabs: rect(tabs), tabText: text(tabs.querySelector('.active')), controls,
          scrolling: tabs.scrollWidth > tabs.clientWidth + 1, border: getComputedStyle(toolbar).borderBottomWidth,
          tabBorder: getComputedStyle(tabs).borderBottomWidth },
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert(!geometry.overflow);
    if (geometry.container.width >= 1100) {
      assert(Math.abs(geometry.left.top - geometry.right.top) < 1 && Math.abs(geometry.lt.top - geometry.rt.top) < 1, '外框与实际标题文字同排');
      assert(geometry.right.width / geometry.left.width > 1.8 && geometry.right.width / geometry.left.width < 2.1, '约一比二布局');
      assert(Math.abs(geometry.fields[0].control.top - geometry.fields[1].control.top) < 1, '套餐与数量同排');
    } else assert(geometry.right.top >= geometry.left.bottom + 19);
    for (const field of geometry.fields) assert(field.label.right <= field.control.left + 1);
    const { bounds, tabs, tabText, controls, scrolling, border, tabBorder } = geometry.toolbar;
    assert.equal(border, '1px');
    assert.equal(tabBorder, '0px');
    assert(controls.every(control => control.left >= bounds.left && control.right <= bounds.right + 1), '筛选与归还按钮完整可见');
    if (geometry.right.width >= 900) {
      const centerY = rect => (rect.top + rect.bottom) / 2;
      assert(!scrolling && tabs.right <= controls[0].left, '宽面板完整显示五个页签，右侧同排');
      assert(controls.every(control => Math.abs(centerY(tabs) - centerY(control)) <= 1), '页签与筛选控件同排居中');
      assert(Math.abs(centerY(tabs) - centerY(tabText)) <= 2, '页签文字垂直居中');
      if (width === 1680) assert(controls[0].width >= 180 && controls[0].width < 280, '先收窄搜索框，筛选组保持同排');
    }
    if (width <= 390) {
      assert(scrolling && controls[0].top >= tabs.bottom, '窄面板页签横滑，筛选组整体换行');
    }
    const codeBounds = await page.locator('#recharge-code-list .recharge-code-text').evaluateAll(nodes => nodes.map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })));
    assert(codeBounds.every(value => value.scroll <= value.width + 1), '充值码完整换行');
    const list = left.locator('.recharge-request-list');
    if (await list.count()) {
      const last = list.locator('li').last().locator('button').last();
      await last.scrollIntoViewIfNeeded();
      const viewport = await list.boundingBox(), action = await last.boundingBox();
      assert(action.y >= viewport.y - 1 && action.y + action.height <= viewport.y + viewport.height + 1, '最近申请最后一条操作可滚动到完整可见');
      await list.evaluate(node => { node.scrollTop = 0; });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    measurements.push({ width, theme, state, geometry });
  };
  for (const width of [2480, 1920, 1680, 1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await measure(width, theme, 'first-page');
    if ([1680, 390].includes(width))
      await right.locator('.recharge-code-toolbar').screenshot({ path: `${output}/codes-toolbar-${width}-${theme}.png`, animations: 'disabled' });
    if ([1680, 390].includes(width)) await page.screenshot({ path: `${output}/workspace-${width}-${theme}.png`, fullPage: width === 1680, animations: 'disabled' });
    if (width === 390) {
      await right.evaluate(node => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').getBoundingClientRect().height - 16));
      await page.screenshot({ path: `${output}/workspace-codes-390-${theme}.png`, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1680, height: 1050 });
  const titlePosition = await left.boundingBox();
  await left.getByLabel('查看提取申请说明', { exact: true }).click();
  await page.locator('.title-description:popover-open').waitFor();
  assert.deepEqual(await left.boundingBox(), titlePosition, '说明开关不推动模块');
  await page.keyboard.press('Escape');
  await page.locator('#recharge-request-count').fill('7');
  await page.evaluate(() => { window.requestFormNode = document.querySelector('#recharge-code-request'); });
  const requestFormRetained = () => page.evaluate(() => window.requestFormNode === document.querySelector('#recharge-code-request'));
  await settle(page);
  const firstFrames = await page.locator('[data-code-frame]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.equal(await rightPager.getAttribute('data-page-size'), '20');
  assert.equal(await leftPager.getAttribute('data-page-size'), '20');
  await rightPager.locator('[data-pagination-nav="next"]').click();
  assert.equal(await rightPager.getAttribute('data-page'), '2'); assert.equal(await leftPager.getAttribute('data-page'), '1');
  await leftPager.locator('[data-pagination-nav="next"]').click();
  assert.equal(await leftPager.getAttribute('data-page'), '2'); assert.equal(await rightPager.getAttribute('data-page'), '2');
  const lastFrames = await page.locator('[data-code-frame]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert(lastFrames.every((height, i) => height >= firstFrames[i] - 1), '末页不缩小已显示的列表框架');
  assert(await requestFormRetained());
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1050 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await measure(width, theme, 'last-page');
  }
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.locator('#code-list-query').fill('KC-');
  assert.equal(await rightPager.getAttribute('data-page'), '1'); assert.equal(await leftPager.getAttribute('data-page'), '2');
  await go('overview'); await go('workspace/recharge-codes');
  assert.equal(await page.locator('#recharge-request-count').inputValue(), '7');
  assert.equal(await page.locator('#code-list-query').inputValue(), 'KC-');
  assert.equal(await leftPager.getAttribute('data-page'), '2');
  await page.evaluate(() => { window.requestFormNode = document.querySelector('#recharge-code-request'); });
  let release; gates.codes = new Promise(resolve => { release = resolve; }); fail.codes = true;
  const original = await right.locator('tbody').innerText(), height = (await right.boundingBox()).height;
  await right.getByRole('button', { name: '刷新我的充值码', exact: true }).click();
  await right.locator('[data-code-progress]:not([hidden])').waitFor();
  assert.equal((await right.boundingBox()).height, height, '刷新进度不撑高框架');
  await page.locator('#recharge-request-count').fill('9'); release();
  await right.locator('[data-code-error]:not([hidden])').waitFor();
  assert.equal(await right.locator('tbody').innerText(), original, '读取失败保留最后成功列表');
  assert(await requestFormRetained()); assert.equal(await page.locator('#recharge-request-count').inputValue(), '9');
  await right.getByRole('button', { name: '刷新我的充值码', exact: true }).click();
  await right.locator('[data-code-error][hidden]').waitFor({ state: 'attached' });
  fail.requests = true;
  await left.getByRole('button', { name: '刷新提取申请', exact: true }).click();
  await left.locator('[data-code-error]:not([hidden])').waitFor();
  assert(await left.getByRole('button', { name: '提交申请', exact: true }).isDisabled());
  assert.equal(await right.locator('tbody').innerText(), original);
  await left.getByRole('button', { name: '刷新提取申请', exact: true }).click();
  await left.locator('[data-code-error][hidden]').waitFor({ state: 'attached' });
  // Request is pending until approved; a late successful request must retain newer edits.
  await page.locator('#recharge-request-count').fill('1');
  gates.write = new Promise(resolve => { release = resolve; });
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'request');
  await left.getByRole('button', { name: '提交申请', exact: true }).click();
  await page.locator('#recharge-request-count').fill('2'); release(); assert.equal((await response).status(), 201);
  await page.waitForFunction(() => document.querySelector('[data-pagination="recharge-request-view"]')?.dataset.page === '1');
  assert.equal(await page.locator('#recharge-request-count').inputValue(), '2');
  const pending = f.store.load().data.requests.find(row => row.createdAt === '2026-11-10T04:30:00.000Z');
  assert.equal(pending.status, 'pending'); assert.equal(pending.codes, undefined);
  assert.equal(await page.locator('#recharge-code-new-batch').isVisible(), false);
  await page.locator(`[data-request-id="${pending.id}"] [data-action="order-code-approve"]`).click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.locator('#recharge-code-new-batch:not([hidden])').waitFor();
  assert.match(await page.locator('#recharge-code-new-batch').innerText(), new RegExp(f.store.load().data.requests.find(row => row.id === pending.id).batchNo));
  assert(!(await page.locator('#recharge-code-new-batch').innerText()).includes(pending.id));
  assert.equal(await page.locator('#recharge-code-list tbody tr[data-row-id]').count(), 1);
  assert.equal(await page.locator('#recharge-request-count').inputValue(), '2');
  assert.equal(await page.locator('#code-list-query').inputValue(), '');
  await right.locator('[data-action="order-code-copy"]').click();
  const assigned = f.store.load().data.requests.find(row => row.id === pending.id).codes[0];
  assert.equal(await page.evaluate(() => window.copiedCode), assigned, '复制完整值');
  await right.locator('[data-action="order-code-item-detail"]').click();
  await page.locator('#drawer').getByText(assigned, { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  const returnSelected = right.locator('[data-action="order-code-return-selected"]');
  const returnPosition = () => returnSelected.evaluate(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    const toolbar = node.closest('.recharge-code-toolbar').getBoundingClientRect();
    return { x: x - toolbar.x, y: y - toolbar.y, width, height };
  });
  const unselected = await returnPosition();
  await right.locator('[data-select="recharge-code-items"]').check();
  assert.deepEqual(await returnPosition(), unselected, '显示已选数量后，归还按钮保持原位置和宽度');
  await right.getByRole('button', { name: '归还所选（1）', exact: true }).click();
  await page.locator('#code-return-form').waitFor();
  assert.equal(await page.locator('#code-return-form input[type="checkbox"]:checked').count(), 1);
  assert.equal(f.commands.length, 0, '批量归还入口先核对，不直接执行');
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await page.locator(`[data-request-id="${pending.id}"] [data-action="order-code-request-detail"]`).click();
  await page.locator('#drawer').getByText('可归还', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await page.locator('[data-action="order-code-clear-batch"]').click();
  // Fresh codes for another employee never focus a private batch or disclose full values.
  const foreign = f.store.load().data.requests.find(row => row.applicantId === 'other');
  assert.equal((await call(handler, { action: 'approve', id: foreign.id }, admin)).status, 200);
  await page.evaluate(() => window.IDDesignModules.find(m => m.id === 'order-operations').onDataChanges(['recharge-codes']));
  assert(await page.locator('#recharge-code-new-batch').isHidden());
  const foreignCode = f.store.load().data.requests.find(row => row.id === foreign.id).codes[0];
  assert(!(await right.innerText()).includes(foreignCode));
  // An issuance made elsewhere uses the existing data-change hook and focuses only the new own batch.
  const anotherOwn = f.store.load().data.requests.find(row => row.applicantId === admin.id && row.status === 'pending');
  await page.setViewportSize({ width: 390, height: 1050 });
  await right.locator('[data-action="order-code-tab"][data-id="returns"]').click();
  assert.equal((await call(handler, { action: 'approve', id: anotherOwn.id }, admin)).status, 200);
  await page.evaluate(() => window.IDDesignModules.find(m => m.id === 'order-operations').onDataChanges(['recharge-codes']));
  assert.match(await page.locator('#recharge-code-new-batch').innerText(), new RegExp(f.store.load().data.requests.find(row => row.id === anotherOwn.id).batchNo));
  assert.equal(await right.locator('[data-action="order-code-tab"][data-id="unused"]').getAttribute('aria-selected'), 'true');
  const activeTab = await right.locator('[data-action="order-code-tab"][data-id="unused"]').boundingBox(), strip = await right.locator('.recharge-code-tabs').boundingBox();
  assert(activeTab.x >= strip.x - 1 && activeTab.x + activeTab.width <= strip.x + strip.width + 1, '新批次的选中页签在手机完整可见');
  await page.locator('[data-action="order-code-clear-batch"]').click();
  await page.locator('#code-list-query').fill('不存在的充值码');
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1050 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await measure(width, theme, 'empty-filter');
  }
  assert(await requestFormRetained()); assert.equal(await page.locator('#recharge-request-count').inputValue(), '2');
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
  await writeFile(output + '/geometry.json', JSON.stringify({ measurements, traffic, errors }, null, 2));
  await context.close();
});
