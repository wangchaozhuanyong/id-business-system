import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle, spacingSnapshot } from './helpers/offline-design.mjs';

// All requests are fulfilled with synthetic fixtures; no listening server or database.
test('账号与邮箱提交提取工作台：旧路由、双模块、草稿、批次和提交反馈', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL || undefined }); t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/inventory-workspace-20261110';
  await mkdir(output, { recursive: true });
  const fixture = JSON.parse(await readFile(root + '/docs/audits/2026-11-06-design-review/visual-fixtures.json'));
  const actor = { id: 'workspace-fixture-admin', name: '工作台验收员', role: 'admin' };
  const seed = structuredClone(fixture.inventory.data);
  for (const kind of ['account', 'mail']) {
    for (let i = 0; i < 23; i++) seed.importRecords.push({
      id: `${kind}-import-${i}`, type: kind === 'account' ? 'gpt' : i === 0 ? 'relay' : 'google',
      time: i === 0 ? '2026-11-10T01:59:00.000Z' : `2026-11-${String(10 - Math.floor(i / 8)).padStart(2, '0')} 09:${String(59 - i).padStart(2, '0')}`,
      actor: actor.name, total: 3, success: 3, failed: 0, status: '已导入', results: []
    });
    for (let i = 0; i < 6; i++) {
      const asset = (kind === 'account' ? seed.accounts : seed.mailboxes)[i];
      const id = `${kind}-batch-${i}`, claimId = `${id}-claim`;
      Object.assign(asset, { inventoryState: 'claimed', used: true, claimId, claimBatchId: id });
      seed.batches.push({ id, kind, purpose: i === 0 ? '业务备用与客户资料核对' : '业务备用',
        actorId: actor.id, actorName: actor.name, time: `2026-11-10 09:${String(50 - i).padStart(2, '0')}`,
        items: [{ id: claimId, assetId: asset.id, email: asset.email, type: asset.type, status: 'pending' }]
      });
    }
  }
  let inventory = { version: 1, data: seed }, fail = false;
  const writes = [], errors = [], measurements = [];
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, locale: 'zh-CN', serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: { ...fixture, inventory }, actor });
  await context.route(origin + '/api/local/inventory', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: inventory });
    const command = route.request().postDataJSON(); writes.push(command);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '模拟库存保存失败' } }); }
    inventory = { version: inventory.version + 1, data: structuredClone(command.data) };
    return route.fulfill({ json: inventory });
  });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator('#main[data-layout-route="' + route + '"]').waitFor(); await settle(page);
  };
  const close = async () => { await page.getByRole('button', { name: '关闭抽屉', exact: true }).click(); await settle(page); };
  const measure = async (width, theme, kind, state) => {
    await settle(page);
    const snapshot = await spacingSnapshot(page);
    assert.deepEqual(snapshot.findings, [], `${width}/${theme}/${kind}/${state}: ${JSON.stringify(snapshot.findings)}`);
    const geometry = await page.locator('.inventory-workspace-columns').evaluate(container => {
      const rect = node => node.getBoundingClientRect().toJSON();
      const text = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); };
      const [left, right] = container.children;
      const main = container.closest('main');
      const end = innerHeight - main.nextElementSibling.offsetHeight - parseFloat(getComputedStyle(main).paddingBottom);
      return { container: rect(container), left: rect(left), right: rect(right),
        gap: end - rect(container).bottom - scrollY,
        historyGaps: [left, right].map(panel => rect(panel).bottom - rect(panel.querySelector('.inventory-workspace-history')).bottom),
        leftHeading: rect(left.querySelector('.panel-heading > .section-title-row')),
        rightHeading: rect(right.querySelector('.panel-heading > .section-title-row')),
        leftTitle: text(left.querySelector('h2')), rightTitle: text(right.querySelector('h2')),
        fields: [...right.querySelectorAll('.field')].map(field => ({
          label: rect(field.querySelector('label')), control: rect(field.querySelector('input,select,textarea'))
        })), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert(!geometry.overflow);
    for (const [panel, heading] of [[geometry.left, geometry.leftHeading], [geometry.right, geometry.rightHeading]]) {
      assert(Math.abs(heading.top - panel.top - 13) <= 1, '工作台标题使用紧凑的上内距');
      assert(Math.abs(heading.left - panel.left - 17) <= 1, '工作台标题沿正文对齐线');
    }
    if (geometry.container.width >= 960) {
      assert(Math.abs(geometry.left.top - geometry.right.top) < 1);
      assert(Math.abs(geometry.left.bottom - geometry.right.bottom) < 1);
      assert(geometry.gap <= 2, '宽屏工作台应延伸到页脚上方');
      assert(geometry.historyGaps.every(gap => gap >= 0 && gap <= 2), '两侧记录区应使用面板剩余空间');
      assert(Math.abs(geometry.leftTitle.top - geometry.rightTitle.top) < 1, '实际标题文字对齐');
      assert(geometry.right.left >= geometry.left.right + 19);
    } else assert(geometry.right.top >= geometry.left.bottom + 19);
    for (const { label, control } of geometry.fields) assert(label.right <= control.left + 1, '字段标签保持在左侧');
    const importRows = await page.locator('.inventory-import-records > li').evaluateAll(rows => rows.map(row => {
      const bounds = row.getBoundingClientRect(), action = row.querySelector('button').getBoundingClientRect();
      const fields = [...row.children].map(field => field.getBoundingClientRect());
      return { width: bounds.width, actionRight: action.right, right: bounds.right,
        clipped: [...row.children].some(field => field.scrollWidth > field.clientWidth + 1),
        centers: fields.map(box => box.top + box.height / 2),
        overlapping: fields.slice(0, -1).some(box => box.right > action.left + 1),
        time: row.querySelector('time').textContent };
    }));
    for (const row of importRows) {
      assert(Math.abs(row.right - row.actionRight) <= 1, '近期导入的详情始终靠最右侧');
      assert(!row.clipped && !row.overlapping, `${width}/${theme} 导入记录不截断、不覆盖详情`);
      if (row.width >= 600 && state === 'records')
        assert(Math.max(...row.centers) - Math.min(...row.centers) <= 1, '宽容器的导入记录在同一行垂直居中');
    }
    if (importRows.length && state === 'records') assert.equal(importRows[0].time, '2026-11-10 09:59', 'ISO 时间显示为北京时间');
    const extraction = await page.locator('.inventory-extraction-panel').evaluate(panel => {
      const rect = node => node.getBoundingClientRect().toJSON();
      const summary = panel.querySelector('.inventory-extraction-summary'), actions = summary.querySelector('.inventory-extraction-actions');
      const history = panel.querySelector('.inventory-extraction-history');
      return { summary: rect(summary), stock: rect(summary.querySelector('.inventory-availability')), actions: rect(actions),
        buttons: [...actions.querySelectorAll('button')].map(rect),
        separation: parseFloat(getComputedStyle(history).borderTopWidth),
        historyTop: rect(history).top, headerBackground: getComputedStyle(history.querySelector('.panel-heading')).backgroundColor,
        formBackground: getComputedStyle(panel).backgroundColor,
        rows: [...panel.querySelectorAll('.inventory-extraction-records > li')].map(row => {
          const fields = [...row.children], action = fields.at(-1);
          return { width: rect(row).width, right: rect(row).right, actionRight: rect(action).right,
            centers: fields.map(node => { const r = rect(node); return r.top + r.height / 2; }), columns: fields.map(node => rect(node).left),
            singleLines: fields.filter(node => node.matches('.inventory-extraction-number, .inventory-extraction-purpose, .inventory-extraction-count, .inventory-extraction-actor, .inventory-extraction-time')).every(node => rect(node).height <= parseFloat(getComputedStyle(node).lineHeight) + 1),
            clipped: row.scrollWidth > row.clientWidth + 1 || [...action.querySelectorAll('button')].some(node => node.scrollWidth > node.clientWidth + 1),
            completeLabels: fields.filter(node => node.matches('.inventory-extraction-purpose, .inventory-extraction-actor')).every(node => node.title === node.textContent) };
        }) };
    });
    assert.equal(extraction.buttons.length, 2, '提取与归还、确认提取各保留一个按钮');
    assert(extraction.buttons.every(box => box.left >= extraction.summary.left && box.right <= extraction.summary.right + 1), '提取按钮不裁切');
    assert(Math.abs(extraction.buttons[0].top - extraction.buttons[1].top) <= 1, '两个提取按钮在宽窄屏保持同排');
    if (extraction.summary.width >= 450) {
      assert(Math.abs(extraction.stock.top + extraction.stock.height / 2 - extraction.actions.top - extraction.actions.height / 2) <= 1, '库存与按钮同排居中');
      assert(extraction.stock.right <= extraction.actions.left, '按钮位于库存右侧');
    }
    assert(Math.abs(extraction.actions.right - extraction.summary.right) <= 1, '按钮靠操作行最右侧');
    assert(extraction.separation >= 8 && extraction.headerBackground !== extraction.formBackground && extraction.historyTop >= extraction.summary.bottom, '历史分区有明确间隔及独立标题底色');
    for (const row of extraction.rows) {
      assert(!row.clipped && row.completeLabels, `${width}/${theme} 批次内容可追溯且操作不裁切`);
      assert(Math.abs(row.right - row.actionRight) <= 1, '批次操作位于最右侧');
      if (row.width >= 600) {
        assert(row.singleLines, '批次编号与数据字段在宽容器内不折行');
        assert(Math.max(...row.centers) - Math.min(...row.centers) <= 1, '每个批次在同一行展示');
        assert(row.columns.every((left, index) => Math.abs(left - extraction.rows[0].columns[index]) <= 1), '批次各列跨记录对齐');
      }
    }
    for (const history of await page.locator('.inventory-workspace-history:has(li)').all()) {
      const last = history.locator('li').last().locator('button').last();
      await last.scrollIntoViewIfNeeded();
      const bounds = await history.boundingBox(), action = await last.boundingBox();
      assert(action.y >= bounds.y - 1 && action.y + action.height <= bounds.y + bounds.height + 1, '滚动后最后一条操作必须完整可见');
      await history.evaluate(node => { node.scrollTop = 0; });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    measurements.push({ width, theme, kind, state, geometry, importRows, extraction });
  };
  for (const kind of ['account', 'mail']) {
    await page.goto(origin + '/#/workspace/' + kind + '-submit');
    await page.locator('#inventory-extract-form').waitFor();
    assert.equal(new URL(page.url()).hash, '#/workspace/' + kind + '-extract', '旧书签转到合并入口');
    assert.equal(await page.locator('#sidebar a[href="#/workspace/' + kind + '-submit"]').count(), 0);
    assert.equal(await page.locator('#sidebar a[href="#/workspace/' + kind + '-extract"][aria-current="page"]').count(), 1);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('.inventory-submission-panel [data-action="inventory-add-type"]').count(), kind === 'account' ? 5 : 3);
    assert.equal(await page.locator('.inventory-submission-panel .inventory-workspace-records > li').count(), 5);
    assert.equal(await page.locator('.inventory-extraction-panel .inventory-workspace-records > li').count(), 5);
    for (const width of [1920, 1680, 1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1050 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await measure(width, theme, kind, 'records');
      if ([1680, 390].includes(width)) await page.screenshot({ path: `${output}/${kind}-${width}-${theme}.png`, fullPage: true, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1680, height: 1050 });
    const notes = page.locator('#inventory-extract-notes');
    await notes.fill(kind + ' 的提取草稿');
    await page.locator('#inventory-purpose').selectOption('其他');
    await page.locator('#inventory-purpose-other').fill('完整用途 <script>synthetic</script>');
    const position = await notes.boundingBox();
    await page.locator('.inventory-submission-panel > .panel-heading .title-help summary').click();
    await page.locator('.title-description:popover-open').waitFor();
    assert.deepEqual(await notes.boundingBox(), position, '说明不推动表单');
    await page.keyboard.press('Escape');
    for (const type of kind === 'account' ? ['gpt', 'claude', 'gemini', 'grok', 'apple'] : ['google', 'relay', 'microsoft']) {
      await page.locator(`[data-action="inventory-add-type"][data-type="${type}"]`).click();
      await page.locator('#drawer[open]').waitFor();
      const email = page.locator(type === 'relay' ? '#relay-email' : '#inventory-email');
      await email.fill(`draft-${type}@example.test`); await close();
      await page.locator(`[data-action="inventory-add-type"][data-type="${type}"]`).click();
      assert.equal(await email.inputValue(), `draft-${type}@example.test`); await close();
      assert.equal(await notes.inputValue(), kind + ' 的提取草稿', '提交草稿不覆盖提取草稿');
    }
    await page.locator('[data-action="inventory-entry-imports"]').click();
    const pager = page.locator('#drawer [data-pagination="inventory-entry-imports:' + kind + '"]');
    assert.equal(await pager.getAttribute('data-total'), '23');
    assert.equal(await pager.getAttribute('data-page-size'), '20');
    await pager.getByLabel('每页条数').selectOption('10');
    await pager.locator('[data-pagination-nav="next"]').click();
    await pager.locator('[data-pagination-nav="next"]').click();
    assert.equal(await page.locator('#drawer table tbody tr').count(), 3);
    await close(); await page.locator('[data-action="inventory-entry-imports"]').click();
    assert.equal(await pager.getAttribute('data-page'), '3', '关闭重开保留独立导入分页');
    await close();
    await go('overview'); await go('workspace/' + kind + '-extract');
    assert.equal(await notes.inputValue(), kind + ' 的提取草稿');
    assert.equal(await page.locator('#inventory-purpose-other').inputValue(), '完整用途 <script>synthetic</script>');
  }
  await go('workspace/extractions');
  await page.locator('[data-action="inventory-center-tab"][data-tab="history"]').click();
  const batchTable = page.locator('#main .table-viewport:has(table[data-table="提取批次"])');
  await batchTable.locator('tr[data-row-id]').first().waitFor();
  await settle(page);
  const populatedHeight = (await batchTable.boundingBox()).height;
  await page.locator('#inventory-center-query').fill('无匹配批次的离线关键词');
  await batchTable.getByText('没有符合条件的批次', { exact: true }).waitFor();
  await settle(page);
  assert.equal(await batchTable.getAttribute('data-pagination-layout'), 'fill');
  assert.equal((await batchTable.boundingBox()).height, populatedHeight, '筛选空结果保持列表外框');
  await page.locator('[data-action="inventory-center-tab"][data-tab="returns"]').click();
  const returns = page.locator('#main .table-viewport:has(table[data-table="归还记录"])');
  await returns.waitFor();
  assert.equal(await returns.getAttribute('data-pagination-layout'), 'fill');
  // Failure keeps the form, successful extraction uses the existing batch/detail workflow.
  await go('workspace/account-extract');
  const stock = page.locator('.inventory-availability > span').filter({ hasText: /^GPT 账号/ }).locator('strong');
  const countBefore = Number(await stock.innerText());
  await page.locator('[data-action="inventory-import"][data-type="gpt"]').click();
  await page.locator('#inventory-import-content').fill('邮箱,密码,邮箱类型,2FA密钥,国家地区,地区,注册时间,登录设备,备注1,备注2\nworkspace-new@example.test,Fixture-Only,谷歌邮箱,DEMO-TOTP,美国,纽约,2026-10-01T10:30,测试设备,合并工作台,合成资料');
  await page.locator('button[form="inventory-import-form"][type="submit"]').click();
  fail = true;
  const saveImport = async status => {
    await page.locator('[data-action="inventory-import-confirm"]').click();
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/inventory');
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    assert.equal((await response).status(), status); await settle(page);
  };
  await saveImport(503);
  assert.match(await page.locator('#inventory-import-content').inputValue(), /workspace-new@example.test/);
  assert.equal(Number(await stock.innerText()), countBefore, '失败不更新可用库存');
  await saveImport(200);
  await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
  assert.equal(Number(await stock.innerText()), countBefore + 1, '提交成功后右侧实时更新库存');
  assert.equal(await page.locator('#inventory-extract-notes').inputValue(), 'account 的提取草稿', '左侧保存不清理右侧草稿');
  const writesBeforeExtract = writes.length;
  await page.locator('#inventory-quantity').fill('100');
  await page.locator('#inventory-extract-form [type="submit"]').click();
  assert.match(await page.locator('#inventory-quantity-error').innerText(), /库存不足/);
  assert.equal(writes.length, writesBeforeExtract);
  await page.locator('#inventory-quantity').fill('1');
  fail = true;
  const extract = async status => {
    await page.locator('#inventory-extract-form [type="submit"]').click();
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/inventory');
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    assert.equal((await response).status(), status); await settle(page);
  };
  await extract(503);
  assert.equal(await page.locator('#inventory-extract-notes').inputValue(), 'account 的提取草稿');
  await extract(200);
  await page.locator('#main[data-layout-route^="workspace/extractions/"]').waitFor();
  assert.equal(inventory.data.batches[0].purpose, '完整用途 <script>synthetic</script>');
  await go('workspace/account-extract');
  assert.equal(await page.locator('#inventory-extract-notes').inputValue(), '');
  assert.equal(await page.locator('.inventory-workspace-records script').count(), 0);
  assert.match(await page.locator('.inventory-extraction-panel .inventory-workspace-records').innerText(), /完整用途 <script>synthetic<\/script>/);
  inventory.data.importRecords[0].actor = '很长的录入人员名称'.repeat(24);
  inventory.data.batches[0].purpose = '很长的用途说明'.repeat(40) + '<img src=x onerror=alert(1)>';
  await page.reload(); await page.locator('#inventory-extract-form').waitFor();
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await measure(width, theme, 'account', 'long-records');
    assert.equal(await page.locator('.inventory-workspace-records img').count(), 0);
  }
  // Independently rendered empty states and load failure/retry.
  inventory = { version: inventory.version + 1, data: { ...seed, importRecords: [], batches: [] } };
  await page.reload(); await page.locator('#inventory-extract-form').waitFor();
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const kind of ['account', 'mail']) {
      await go('workspace/' + kind + '-extract');
      await measure(width, theme, kind, 'empty');
      assert.equal(await page.getByText('暂无导入记录', { exact: true }).count(), 1);
      assert.equal(await page.getByText('暂无提取批次', { exact: true }).count(), 1);
    }
  }
  let failRead = true;
  await context.route(origin + '/api/local/inventory', route => {
    if (failRead && route.request().method() === 'GET') {
      failRead = false; return route.fulfill({ status: 503, json: { error: '模拟读取失败' } });
    }
    return route.fallback();
  });
  await page.reload(); await page.locator('[data-action="inventory-reload"]').click();
  await page.locator('#inventory-extract-form').waitFor();
  const employee = await browser.newContext();
  const employeeRequests = await interceptDesign(employee, { localFixtures: fixture, actor: { ...actor, role: 'employee' } });
  const restricted = await employee.newPage();
  for (const kind of ['account', 'mail']) {
    await restricted.goto(origin + '/#/workspace/' + kind + '-submit');
    await restricted.getByText('当前账号无权打开此页面', { exact: true }).waitFor();
    assert.equal(await restricted.locator('.inventory-workspace').count(), 0);
    assert.equal(await restricted.locator('#sidebar a[href="#/workspace/' + kind + '-extract"]').count(), 0);
  }
  assert.deepEqual(employeeRequests.external, []);
  await employee.close();
  assert.deepEqual(errors, []); assert.deepEqual(requests.unavailable, []); assert.deepEqual(requests.external, []);
  await writeFile(output + '/geometry.json', JSON.stringify({ measurements, writes: writes.map(w => w.action), errors }, null, 2));
  await context.close();
});
