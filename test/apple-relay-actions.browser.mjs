import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('隐藏邮箱的未登记计数、筛选与显示一致，健康状态独立', { timeout: 20_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const parent = fixture.inventory.data.appleRelay.parents[0];
  const base = { type: 'relay', relayStatus: 'ACTIVE', parentMailboxId: parent.id };
  fixture.inventory.data.mailboxes = [
    { ...base, id: 'alias-unknown', email: 'unknown@example.test', status: '正常' },
    { ...base, id: 'alias-available', email: 'available@example.test', status: '正常', inventoryState: 'available' },
    { ...base, id: 'alias-used', email: 'used@example.test', status: '封控中', inventoryState: 'used' }
  ];
  const traffic = await interceptDesign(context, { localFixtures: fixture, skipRechargeAssets: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin + '/#/mailboxes/relay');
  const main = page.locator('#main');
  await main.getByRole('tab', { name: '隐藏邮箱管理', exact: true }).click();
  const usage = main.getByRole('group', { name: '使用状态', exact: true });
  const health = main.getByRole('group', { name: '资料状态', exact: true });
  const rows = main.locator('table[data-table="relay-aliases"] tbody tr[data-row-id]');
  const ids = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.rowId));
  await usage.getByRole('button', { name: '未登记 1', exact: true }).click();
  assert.deepEqual(await ids(), ['alias-unknown']);
  await usage.getByRole('button', { name: '未使用 1', exact: true }).click();
  assert.deepEqual(await ids(), ['alias-available']);
  await usage.getByRole('button', { name: '全部 3', exact: true }).click();
  await health.getByRole('button', { name: '封控中 1', exact: true }).click();
  assert.deepEqual(await ids(), ['alias-used']);
  assert(await usage.getByRole('button', { name: '已使用 1', exact: true }).isVisible());
  assert.deepEqual(traffic.external, []);
});

test('收件首屏先展示已入库摘要，正文按需读取且部分失败保留旧记录', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const parents = ['one', 'two'].map(id => ({ id, email: id + '@example.test', status: 'ACTIVE' }));
  fixture.inventory.data.appleRelay.parents = parents;
  fixture.inventory.data.mailboxes = [];
  await interceptDesign(context, { localFixtures: fixture, skipRechargeAssets: true });
  await context.route('**/api/local/apple-relay/status', route => route.fulfill({
    json: { configured: true, parentIds: parents.map(row => row.id), aliasIds: [] }
  }));
  const mail = (id, parentId, subject) => ({
    id, parentId, aliasId: '', subject, from: 'fixture@example.test', receivedAt: '2026-11-11 12:00'
  });
  const stored = [mail('old-one', 'one', '主邮箱一的已入库邮件'), mail('old-two', 'two', '主邮箱二的已入库邮件')];
  const syncedAt = '2026-11-11T04:00:00Z';
  const mailbox = parentId => ({ parentId, read: true, syncFailed: false, lastSyncedAt: syncedAt });
  const releaseRead = Promise.withResolvers(), releaseSync = Promise.withResolvers();
  t.after(() => { releaseRead.resolve(); releaseSync.resolve(); });
  let syncs = 0, detailReads = 0;
  await context.route('**/api/local/apple-relay/mails', async route => {
    if (!route.request().postDataJSON().refresh) {
      await releaseRead.promise;
      return route.fulfill({ json: { items: stored, mailboxes: parents.map(row => mailbox(row.id)) } });
    }
    if (++syncs > 1) return route.fulfill({ status: 503, json: { error: '隔离刷新失败' } });
    await releaseSync.promise;
    return route.fulfill({ json: {
      items: [mail('new-one', 'one', '主邮箱一的新邮件')],
      mailboxes: [mailbox('one'), { parentId: 'two', read: false, syncFailed: true, keepPrevious: true }]
    } });
  });
  await context.route('**/api/local/apple-relay/mail-detail', route => {
    detailReads++;
    assert.deepEqual(route.request().postDataJSON(), { parentId: 'one', mailId: 'old-one', aliasId: '' });
    return route.fulfill({ json: { ...stored[0], body: '隔离邮件正文' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const statusRead = page.waitForResponse(response => response.url().endsWith('/apple-relay/status'));
  await page.goto(origin + '/#/mailboxes/relay');
  await statusRead;
  await page.getByRole('tab', { name: '收件记录' }).click();
  const main = page.locator('#main');
  await main.getByText('正在读取收件记录…', { exact: true }).waitFor();
  assert.equal(await main.getByText('暂无符合条件的记录').count(), 0);
  const syncStarted = page.waitForRequest(request => request.url().endsWith('/apple-relay/mails') &&
    request.postDataJSON().refresh);
  releaseRead.resolve();
  await syncStarted;
  await main.getByText('主邮箱一的已入库邮件', { exact: true }).waitFor();
  assert.equal(detailReads, 0);
  assert.match(await main.locator('.inline-notice[role="status"]').innerText(), /最近同步 2026-11-11 12:00.*正在同步/);
  await main.locator('tr[data-row-id="old-one"]').getByRole('button', { name: '查看正文' }).click();
  await page.locator('#drawer').getByText('隔离邮件正文', { exact: true }).waitFor();
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  assert.equal(detailReads, 1);
  releaseSync.resolve();
  await main.getByText('主邮箱一的新邮件', { exact: true }).waitFor();
  assert(await main.getByText('主邮箱二的已入库邮件', { exact: true }).isVisible());
  assert.match(await main.locator('.inline-notice[role="status"]').innerText(), /two@example\.test.*保留上次结果/);
  await main.getByRole('button', { name: '同步并刷新邮件', exact: true }).click();
  await main.getByText(/隔离刷新失败.*当前显示上次成功结果/).waitFor();
  assert(await main.getByText('主邮箱一的新邮件', { exact: true }).isVisible());
});

test('邮箱更多操作直接下拉，保留确认、查询重试及迟到响应保护', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const aliases = fixture.inventory.data.mailboxes.filter(row => row.type === 'relay').slice(0, 2);
  fixture.inventory.data.mailboxes = aliases;
  aliases.forEach((row, index) => { row.email = `alias-${index}@example.test`; row.notes = ''; });
  const parent = fixture.inventory.data.appleRelay.parents[0];
  parent.note = '';
  parent.hasCredential = true;
  await interceptDesign(context, { localFixtures: fixture });
  const writes = [], errors = [];
  let failNextRead = false, held = false, release = () => {};
  let holdStarted;
  const holdReady = new Promise(resolve => { holdStarted = resolve; });
  t.after(() => release());
  await context.route('**/api/local/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/apple-relay/status')) return route.fulfill({ json: {
      configured: true, parentIds: [parent.id], aliasIds: aliases.map(row => row.id)
    } });
    if (path.endsWith('/apple-relay/code-read')) {
      const { id, ids } = request.postDataJSON();
      const code = (target) => ({ email: target?.email || parent.email, queryCode: 'SYNTHETIC-QUERY-CODE', codeExpiresAt: '2099-01-01T00:00:00Z' });
      if (ids) return route.fulfill({ json: { items: ids.map(id => ({
        id, ...code(aliases.find(row => row.id === id))
      })) } });
      if (held) await new Promise(resolve => { release = resolve; holdStarted(); });
      if (failNextRead) {
        failNextRead = false;
        return route.fulfill({ status: 503, json: { error: '合成读取失败，请重试' } });
      }
      return route.fulfill({ json: code(aliases.find(row => row.id === id)) });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(path);
      return route.fulfill({ status: 503, json: { error: '禁止真实业务写入' } });
    }
    return route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  const statusRead = page.waitForResponse(response => response.url().endsWith('/apple-relay/status'));
  await page.goto(origin + '/#/mailboxes/relay');
  await statusRead;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const more = page.locator(`[data-action="relay-alias-more"][data-id="${aliases[0].id}"]`);
  const menu = page.locator('.row-action-menu:popover-open');
  const closeDrawer = () => page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await more.waitFor();
  // Wait for the service binding read, which deliberately rerenders this table.
  await page.waitForFunction(() => !document.querySelector('#main [aria-busy="true"]'));
  for (const width of [1440, 768, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await more.click();
    await menu.waitFor();
    assert.equal(await page.locator('#drawer').isVisible(), false, '不显示操作中转抽屉');
    const items = menu.getByRole('menuitem');
    assert(await items.filter({ hasText: '编辑资料' }).isVisible());
    assert(await items.filter({ hasText: '查看查询码' }).isVisible());
    assert(await items.filter({ hasText: '移入死号' }).isVisible());
    const bounds = await menu.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900);
    if (width <= 900) assert((await items.first().boundingBox()).height >= 44);
    await page.keyboard.press('ArrowDown');
    assert(await items.nth(1).evaluate(node => document.activeElement === node));
    await page.keyboard.press('Home');
    assert(await items.first().evaluate(node => document.activeElement === node));
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert(await more.evaluate(node => document.activeElement === node));
    await more.click();
    await more.click();
    assert.equal(await menu.count(), 0, '再次点击更多操作关闭菜单');
    await more.press('Enter');
    await menu.waitFor();
    await page.locator('.topbar-page-title h1').click();
    assert.equal(await menu.count(), 0, '点击菜单外部关闭');
    await more.click();
    await items.filter({ hasText: '编辑资料' }).click();
    await page.locator('#drawer[open] form').waitFor();
    assert.doesNotMatch(await page.locator('#drawer-title').innerText(), /邮箱操作/);
    await closeDrawer();
    await more.click();
    await items.filter({ hasText: '移入死号' }).click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
    await more.click();
    await items.filter({ hasText: '重置查询码' }).click();
    await page.locator('#confirm-dialog[open]').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('[data-action="relay-tab"][data-tab="parents"]').click();
    await page.locator(`[data-action="relay-parent-more"][data-id="${parent.id}"]`).click();
    assert(await menu.getByRole('menuitem', { name: '测试连接', exact: true }).isVisible());
    assert.equal(await page.locator('#drawer').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="relay-tab"][data-tab="aliases"]').click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.evaluate(() => scrollX), 0, `菜单操作不能横向滚动整页：${width}px`);
  }
  await page.locator('[data-relay-buyer-code] output').getByText('SYNTHETIC-QUERY-CODE', { exact: true }).first().waitFor({ state: 'attached' });
  failNextRead = true;
  await more.click();
  await menu.getByRole('menuitem', { name: '查看查询码', exact: true }).click();
  await page.locator('#relay-code-loading').getByText('合成读取失败，请重试').waitFor();
  await page.locator('#relay-code-loading').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('#relay-code-result').waitFor();
  assert.equal(await page.locator('#relay-code-result').textContent(), 'SYNTHETIC-QUERY-CODE');
  await closeDrawer();
  await page.waitForFunction(() => document.getElementById('relay-code-result')?.textContent === '');
  assert.equal(await page.locator('#relay-code-result').textContent(), '', '关闭后清除查询码正文');
  held = true;
  const delayedRead = page.waitForResponse(response => response.url().endsWith('/apple-relay/code-read'));
  await more.click();
  await menu.getByRole('menuitem', { name: '查看查询码', exact: true }).click();
  await page.locator('#relay-code-loading').waitFor();
  await holdReady;
  await closeDrawer();
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  release();
  await delayedRead;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('#main[data-layout-route="customers/list"]').waitFor();
  assert.equal(await page.locator('#drawer').isVisible(), false, '迟到查询不重开抽屉');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  if (process.env.ID_LAYOUT_QA_OUTPUT) {
    await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
    await page.evaluate(() => window.IDDesignAPI.go('mailboxes/relay'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await more.click();
    await menu.waitFor();
    await page.screenshot({ path: process.env.ID_LAYOUT_QA_OUTPUT + '/relay-actions-desktop.png' });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 900 });
    await more.click();
    await menu.waitFor();
    await page.screenshot({ path: process.env.ID_LAYOUT_QA_OUTPUT + '/relay-actions-mobile.png' });
  }
});
