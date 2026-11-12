import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('买家查询码按页读取，切页复用成功结果，重置或失效后重新核对', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async value => { window.copiedBuyerCode = value; } }
  }));
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const seed = fixture.inventory.data.mailboxes.find(row => row.type === 'relay');
  const aliases = Array.from({ length: 21 }, (_, index) => ({ ...seed,
    id: `qa-code-${index}`, email: `code-${index}@example.test`, notes: '',
    createdAt: new Date(Date.UTC(2026, 10, 10, 10, 0, 60 - index)).toISOString(),
    health: 'normal', queryCode: 'STALE-INVENTORY-CODE', codeResetIntervalDays: 30,
    queryExpiry: index === 20 ? '' : '2026-11-15 00:45'
  }));
  aliases[1].queryExpiry = '2026-11-12 11:59';
  fixture.inventory.data.mailboxes = aliases;
  const parent = fixture.inventory.data.appleRelay.parents[0];
  parent.note = '';
  const codes = new Map(aliases.map((row, index) => [row.id, `BUYER-${index}-${'Ab9'.repeat(16)}`]));
  const startedAt = Date.parse('2026-11-11T04:00:00Z');
  const expiringId = aliases[2].id;
  const expirations = new Map([
    [aliases[0].id, '2026-11-14T16:45:00Z'],
    [aliases[1].id, null],
    [expiringId, new Date(startedAt + 60_000).toISOString()]
  ]);
  await interceptDesign(context, { localFixtures: fixture, skipRechargeAssets: true });
  const reads = [], pageReads = [], unexpected = [], errors = [];
  const metadataReads = [];
  let active = 0, maximum = 0, failOnce = true, resetId = '', held = false, release = () => {}, holdStarted;
  const holdReady = new Promise(resolve => { holdStarted = resolve; });
  t.after(() => release());
  await context.route('**/api/local/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/apple-relay/status')) return route.fulfill({ json: {
      configured: true, parentIds: [parent.id], aliasIds: aliases.slice(0, 20).map(row => row.id)
    } });
    if (path.endsWith('/apple-relay/code-read')) {
      const { id, ids, kind, includeCode } = request.postDataJSON();
      assert.equal(kind, 'alias');
      if (includeCode === false) {
        metadataReads.push(ids);
        return route.fulfill({ json: { items: ids.map(id => ({
          id, email: aliases.find(row => row.id === id).email, mailCount: 9
        })) } });
      }
      const requested = ids || [id];
      pageReads.push(requested);
      reads.push(...requested);
      active++;
      maximum = Math.max(maximum, active);
      if (held && requested.includes(aliases[0].id)) await new Promise(resolve => { release = resolve; holdStarted(); });
      await new Promise(resolve => setTimeout(resolve, 35));
      active--;
      const items = requested.map(id => {
        if (id === aliases[1].id && failOnce) {
          failOnce = false;
          return { id, status: 503, error: '合成读取失败' };
        }
        return { id, email: aliases.find(row => row.id === id).email, mailCount: id === aliases[0].id ? 8 : 0,
          lastMailReceivedAt: id === aliases[0].id ? '2026-11-11T03:20:00Z' : null,
          queryCode: codes.get(id), codeExpiresAt: expirations.has(id) ? expirations.get(id) : '2099-01-01T00:00:00Z' };
      });
      return route.fulfill({ status: ids ? 200 : items[0].status || 200,
        json: ids ? { items } : items[0] });
    }
    if (path.endsWith('/apple-relay/code-reset-prepare')) {
      resetId = request.postDataJSON().id;
      return route.fulfill({ json: { confirmation: 'synthetic-confirmation',
        email: aliases.find(row => row.id === resetId).email, validityDays: 30 } });
    }
    if (path.endsWith('/apple-relay/code-reset-confirm')) {
      codes.set(resetId, 'RESET-BUYER-CODE-SYNTHETIC');
      expirations.set(resetId, new Date(startedAt + 30 * 86400000).toISOString());
      return route.fulfill({ json: { email: aliases.find(row => row.id === resetId).email,
        queryCode: codes.get(resetId), codeExpiresAt: expirations.get(resetId) } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      unexpected.push(path);
      return route.fulfill({ status: 503, json: { error: '禁止未预期的业务操作' } });
    }
    return route.fallback();
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(startedAt) });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/relay');
  const cell = id => page.locator(`[data-relay-buyer-code="${id}"]`);
  const output = id => cell(id).locator('output');
  const field = (id, column) => page.locator(`tr[data-row-id="${id}"] [data-column="${column}"] .mobile-record-value`);
  const remaining = id => field(id, 'codeResetIntervalDays');
  async function revealCode(id) {
    if (await cell(id).isVisible()) return;
    const card = page.locator('tr[data-row-id]').filter({ has: cell(id) });
    await card.getByRole('button', { name: '更多资料', exact: true }).click();
  }
  const ready = () => page.waitForFunction(() =>
    document.querySelector('[data-relay-buyer-code]') &&
    !document.querySelector('[data-relay-buyer-code][aria-busy="true"]') &&
    ![...document.querySelectorAll('[data-relay-buyer-code] output')].some(node => node.textContent.includes('正在')));
  await cell(aliases[0].id).waitFor();
  await ready();
  assert.equal(reads.length, 20, '只读取当前页，不扫描全部隐藏邮箱');
  assert.equal(pageReads.length, 1, '20 行查询码必须只发送一次按页请求，不能分轮逐条读取');
  assert.equal(maximum, 1);
  assert.equal(await output(aliases[0].id).textContent(), codes.get(aliases[0].id));
  assert.equal(await field(aliases[0].id, 'mailCount').textContent(), '8');
  assert.equal(await field(aliases[0].id, 'lastMailReceivedAt').textContent(), '2026-11-11 11:20');
  assert.equal(await page.getByRole('columnheader', { name: '剩余有效天数', exact: true }).count(), 1);
  assert.equal(await remaining(aliases[0].id).textContent(), '4 天');
  assert.equal(await remaining(expiringId).textContent(), '1 天');
  assert.equal(await output(aliases[1].id).textContent(), '读取失败');
  assert.equal(await field(aliases[1].id, 'mailCount').textContent(), '—');
  assert.equal(await remaining(aliases[1].id).textContent(), '1 天', '历史时间按北京时间计算');
  assert(await cell(aliases[1].id).getByRole('button', { name: '复制买家查询码', exact: true }).isDisabled());
  await cell(aliases[1].id).getByRole('button', { name: '重试', exact: true }).click();
  await ready();
  assert.equal(await output(aliases[1].id).textContent(), codes.get(aliases[1].id));
  assert.equal(await field(aliases[1].id, 'mailCount').textContent(), '0');
  assert.equal(await remaining(aliases[1].id).textContent(), '长期有效');
  await cell(aliases[0].id).getByRole('button', { name: '复制买家查询码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedBuyerCode), codes.get(aliases[0].id));
  const beforeReturn = reads.length;
  const restoredImmediately = await page.evaluate(() => {
    document.querySelector('[data-action="relay-tab"][data-tab="parents"]').click();
    document.querySelector('[data-action="relay-tab"][data-tab="aliases"]').click();
    const cells = [...document.querySelectorAll('#main [data-relay-buyer-code]')];
    return cells.length > 0 && cells.every(cell => !cell.querySelector('button').disabled);
  });
  await ready();
  assert.equal(reads.length, beforeReturn, '同一会话切回隐藏邮箱页签不重复读取已成功的查询码');
  assert(restoredImmediately, '已读取的查询码在切回时立即可见、可复制');
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  await page.locator('#main[data-layout-route="customers/list"]').waitFor();
  await page.evaluate(() => window.IDDesignAPI.go('mailboxes/relay'));
  await ready();
  assert.equal(reads.length, beforeReturn, '从其他页面回来时也复用同一会话的查询码');
  await page.locator(`[data-action="relay-alias-more"][data-id="${aliases[0].id}"]`).click();
  await page.getByRole('menuitem', { name: '重置查询码', exact: true }).click();
  await page.locator('button[form="relay-live-code-form"]').click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '确认重置', exact: true }).click();
  await page.locator('#relay-code-result').waitFor();
  await ready();
  assert.equal(await output(aliases[0].id).textContent(), codes.get(aliases[0].id), '重置后立即更新列表');
  assert.equal(await field(aliases[0].id, 'queryExpiry').textContent(), '2026-12-11 12:00');
  assert.equal(await remaining(aliases[0].id).textContent(), '30 天');
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await page.locator(`[data-action="relay-alias-detail"][data-id="${aliases[0].id}"]`).click();
  assert.equal(await page.locator('#drawer .property-row').filter({ hasText: '剩余有效天数' }).locator('strong').textContent(), '30 天');
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await revealCode(aliases[1].id);
    const copy = cell(aliases[1].id).getByRole('button', { name: '复制买家查询码', exact: true });
    await cell(aliases[1].id).scrollIntoViewIfNeeded();
    await copy.click();
    assert.equal(await page.evaluate(() => window.copiedBuyerCode), codes.get(aliases[1].id));
    assert.equal(await output(aliases[1].id).textContent(), codes.get(aliases[1].id));
    assert.equal(await cell(aliases[1].id).locator('.table-value-button').count(), 0);
    assert(await output(aliases[1].id).evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1), '完整查询码可换行，不裁切或省略');
    assert(await cell(aliases[1].id).evaluate(node => {
      const value = node.querySelector('output').getBoundingClientRect();
      const viewport = node.closest('.table-viewport').getBoundingClientRect();
      return value.left >= viewport.left && value.right <= viewport.right;
    }), `${width}px ${dark ? '深色' : '浅色'}：横向滚动到查询码列后，完整内容能在表格视口内显示`);
    const days = remaining(aliases[1].id);
    assert(await days.isVisible());
    assert.equal(await days.textContent(), '长期有效');
    if (width <= 900) assert((await copy.boundingBox()).height >= 44);
    if (process.env.ID_LAYOUT_QA_OUTPUT && !dark && width !== 320) {
      await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
      await page.screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/buyer-code-${width}.png` });
    }
  }
  await revealCode(aliases[0].id);
  await cell(aliases[0].id).getByRole('button', { name: '复制买家查询码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedBuyerCode), codes.get(aliases[0].id));
  await page.locator('#main .pagination').getByRole('button', { name: '下一页' }).click();
  await ready();
  assert.equal(await output(aliases[20].id).textContent(), '未接入收件服务');
  assert.equal(await remaining(aliases[20].id).textContent(), '—');
  await revealCode(aliases[20].id);
  assert(await cell(aliases[20].id).getByRole('button', { name: '复制买家查询码', exact: true }).isDisabled());
  assert(!reads.includes(aliases[20].id));
  assert.equal(reads.filter(id => [aliases[18].id, aliases[19].id].includes(id)).length, 2);
  await page.locator('#main .pagination').getByRole('button', { name: '上一页' }).click();
  await ready();
  assert.equal(reads.filter(id => id === aliases[0].id).length, 1, '重置结果直接更新缓存，不重复读取');
  const before = reads.length;
  await page.locator('#main .pagination').getByRole('button', { name: '下一页' }).click();
  await ready();
  await page.locator('#main .pagination').getByRole('button', { name: '上一页' }).click();
  await ready();
  assert.equal(reads.length, before, '数据未失效时，切换分页复用已成功结果');
  assert(await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('BUYER-')), '查询码不写入浏览器持久存储');
  const beforeExpiry = reads.length;
  codes.set(expiringId, 'RENEWED-BUYER-CODE-SYNTHETIC');
  await page.clock.fastForward(61_000);
  const stillReady = await page.evaluate(id => {
    window.IDDesignAPI.render();
    return !document.querySelector(`[data-relay-buyer-code="${id}"] button`).disabled;
  }, aliases[3].id);
  assert(stillReady, '单条到期重新核对时，其他已读查询码立即可复制');
  await ready();
  assert.deepEqual(reads.slice(beforeExpiry), [expiringId], '只重新读取已跨过有效期的查询码');
  assert.equal(await output(expiringId).textContent(), codes.get(expiringId));
  assert.equal(await remaining(expiringId).textContent(), '0 天');
  const beforeTimeout = reads.length;
  await page.clock.fastForward(301_000);
  await page.evaluate(() => window.IDDesignAPI.render());
  await ready();
  assert.equal(reads.length - beforeTimeout, 20, '复用时间到后重新核对当前页');
  held = true;
  const delayed = page.waitForResponse(response => response.url().endsWith('/code-read') &&
    (response.request().postDataJSON().ids || []).includes('qa-code-0'));
  await page.evaluate(() => { window.IDLocalData.queries.invalidate('apple-relay'); window.IDDesignAPI.render(); });
  await holdReady;
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  release();
  await delayed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#main[data-layout-route="customers/list"]').count(), 1);
  assert.equal(await page.locator('#main [data-relay-buyer-code]').count(), 0, '迟到读取不污染其他页面');
  held = false;
  const beforeClear = reads.length;
  await page.evaluate(() => {
    window.IDDesignAPI.clearPageRegions();
    window.IDDesignAPI.go('mailboxes/relay');
  });
  await ready();
  assert.equal(reads.length - beforeClear, 20, '会话清理后需要重新授权读取');
  const beforeHide = reads.length;
  await page.evaluate(() => {
    window.IDDesignAPI.state.columns.set('relay-aliases', new Set(['queryCode']));
    window.IDDesignAPI.render();
  });
  await field(aliases[0].id, 'mailCount').filter({ hasText: /^9$/ }).waitFor({ state: 'attached' });
  assert.equal(await cell(aliases[0].id).count(), 0);
  assert.equal(metadataReads.length, 1);
  assert.equal(metadataReads[0].length, 20);
  assert.equal(reads.length, beforeHide);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
});

test('整页取码合并重复绘制，支持 50 条、空列表、整批失败与迟到响应隔离', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const seed = fixture.inventory.data.mailboxes.find(row => row.type === 'relay');
  const aliases = Array.from({ length: 51 }, (_, index) => ({ ...seed, id: `page-${index}`,
    email: `page-${index}@example.test`, health: 'normal', notes: '',
    createdAt: new Date(Date.UTC(2026, 10, 10, 10, 0, 60 - index)).toISOString() }));
  fixture.inventory.data.mailboxes = aliases;
  const parent = fixture.inventory.data.appleRelay.parents[0];
  const intercepted = await interceptDesign(context, { localFixtures: fixture, skipRechargeAssets: true });
  let held = true, marker = 'FIRST', failure = false, malformed = false;
  let heldReady = Promise.withResolvers();
  const reads = [], releases = [], errors = [];
  t.after(() => releases.forEach(release => release()));
  await context.route('**/api/local/apple-relay/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/status'))
      return route.fulfill({ json: { configured: true, parentIds: [parent.id], aliasIds: aliases.map(row => row.id) } });
    assert(route.request().url().endsWith('/code-read'), '本场景只允许查询码读取');
    const { kind, ids } = route.request().postDataJSON();
    assert.equal(kind, 'alias');
    assert(Array.isArray(ids) && ids.length <= 50);
    reads.push(ids);
    const version = marker;
    if (held) await new Promise(resolve => { releases.push(resolve); heldReady.resolve(); });
    if (failure) return route.fulfill({ status: 503, json: { error: '合成整批失败' } });
    const items = [...ids].reverse().map(id => ({ id, email: aliases.find(row => row.id === id).email,
      queryCode: `${version}-${id}`, codeExpiresAt: '2099-01-01T00:00:00Z' }));
    if (malformed) items[1] = items[0];
    return route.fulfill({ json: { items } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  const ready = () => page.waitForFunction(() =>
    document.querySelector('[data-relay-buyer-code]') &&
    ![...document.querySelectorAll('[data-relay-buyer-code] output')].some(node => node.textContent.includes('正在')));
  const cell = id => page.locator(`[data-relay-buyer-code="${id}"]`);
  await page.goto(origin + '/#/mailboxes/relay');
  await cell('page-0').waitFor();
  // Wait for a concrete held batch rather than a timing-based performance assertion.
  await heldReady.promise;
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.IDDesignAPI.render();
    window.pageCodeFrames = [];
    window.capturePageCodeFrames = true;
    const sample = () => {
      window.pageCodeFrames.push([...document.querySelectorAll('[data-relay-buyer-code] output')]
        .filter(node => node.textContent.startsWith('FIRST-')).length);
      if (window.capturePageCodeFrames) requestAnimationFrame(sample);
    };
    sample();
  });
  assert.equal(reads.length, 1, '读取中连续重绘复用同一批请求');
  held = false;
  releases.shift()();
  await ready();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    window.capturePageCodeFrames = false; resolve();
  })));
  const frames = await page.evaluate(() => window.pageCodeFrames);
  assert(frames.includes(0) && frames.includes(20));
  assert(frames.every(count => count === 0 || count === 20), '同一页一次呈现，不出现分轮补齐的中间帧');
  assert.equal(await cell('page-0').locator('output').textContent(), 'FIRST-page-0', '乱序响应按资料编号关联');
  await page.locator('#main [data-pagination-size]').selectOption('50');
  await ready();
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1], aliases.slice(20, 50).map(row => row.id), '50 条分页只补读尚未缓存的 30 条');
  await page.locator('#main .pagination').getByRole('button', { name: '下一页' }).click();
  await ready();
  assert.deepEqual(reads.at(-1), ['page-50']);
  await page.locator('#main .pagination').getByRole('button', { name: '上一页' }).click();
  await ready();
  const beforeEmpty = reads.length;
  await page.locator('#main input[placeholder="搜索邮箱、编号或备注"]').fill('no-synthetic-match');
  await page.waitForFunction(() => !document.querySelector('[data-relay-buyer-code]'));
  assert.equal(reads.length, beforeEmpty, '空结果不读取查询码');
  await page.locator('#main input[placeholder="搜索邮箱、编号或备注"]').fill('');
  await ready();
  assert.equal(reads.length, beforeEmpty);

  for (const mode of ['failure', 'malformed']) {
    failure = mode === 'failure'; malformed = mode === 'malformed';
    await page.evaluate(() => { window.IDLocalData.queries.invalidate('apple-relay'); window.IDDesignAPI.render(); });
    await ready();
    assert.equal(await cell('page-0').locator('output').textContent(), '读取失败');
    assert(await cell('page-0').getByRole('button', { name: '复制买家查询码', exact: true }).isDisabled());
    assert(await cell('page-0').getByRole('button', { name: '重试', exact: true }).isVisible());
  }
  failure = false; malformed = false; held = true; marker = 'OLD';
  heldReady = Promise.withResolvers();
  await page.evaluate(() => { window.IDLocalData.queries.invalidate('apple-relay'); window.IDDesignAPI.render(); });
  await heldReady.promise;
  assert.equal(reads.at(-1).length, 50, '失效后的 50 行仍只有一批');
  marker = 'CURRENT'; held = false;
  await page.evaluate(() => { window.IDLocalData.queries.clear(); window.IDDesignAPI.render(); });
  await ready();
  assert.equal(await cell('page-0').locator('output').textContent(), 'CURRENT-page-0');
  const late = page.waitForResponse(response => response.url().endsWith('/code-read'));
  releases.shift()();
  await late;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await cell('page-0').locator('output').textContent(), 'CURRENT-page-0', '已清理代次的迟到结果不得回写');
  await page.evaluate(() => window.IDDesignAPI.render());
  await ready();
  assert.equal(await cell('page-0').locator('output').textContent(), 'CURRENT-page-0', '缓存也只保留新代次');
  assert.deepEqual(intercepted.external, []);
  assert.deepEqual(intercepted.unavailable, []);
  assert.deepEqual(errors, []);
});
