import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('买家查询码完整显示并可复制，按页读取、失败重试且重置后更新', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async value => { window.copiedBuyerCode = value; } }
  }));
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const seed = fixture.inventory.data.mailboxes.find(row => row.type === 'relay');
  const aliases = Array.from({ length: 11 }, (_, index) => ({ ...seed,
    id: `qa-code-${index}`, email: `code-${index}@example.test`, notes: '',
    health: 'normal', queryCode: 'STALE-INVENTORY-CODE'
  }));
  fixture.inventory.data.mailboxes = aliases;
  const parent = fixture.inventory.data.appleRelay.parents[0];
  parent.note = '';
  const codes = new Map(aliases.map((row, index) => [row.id, `BUYER-${index}-${'Ab9'.repeat(16)}`]));
  await interceptDesign(context, { localFixtures: fixture });
  const reads = [], unexpected = [], errors = [];
  let active = 0, maximum = 0, failOnce = true, resetId = '', held = false, release = () => {}, holdStarted;
  const holdReady = new Promise(resolve => { holdStarted = resolve; });
  t.after(() => release());
  await context.route('**/api/local/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/apple-relay/status')) return route.fulfill({ json: {
      configured: true, parentIds: [parent.id], aliasIds: aliases.slice(0, 10).map(row => row.id)
    } });
    if (path.endsWith('/apple-relay/code-read')) {
      const { id, kind } = request.postDataJSON();
      assert.equal(kind, 'alias');
      reads.push(id);
      active++;
      maximum = Math.max(maximum, active);
      if (held && id === aliases[0].id) await new Promise(resolve => { release = resolve; holdStarted(); });
      await new Promise(resolve => setTimeout(resolve, 35));
      active--;
      if (id === aliases[1].id && failOnce) {
        failOnce = false;
        return route.fulfill({ status: 503, json: { error: '合成读取失败' } });
      }
      return route.fulfill({ json: { email: aliases.find(row => row.id === id).email,
        queryCode: codes.get(id), codeExpiresAt: '2099-01-01T00:00:00Z' } });
    }
    if (path.endsWith('/apple-relay/code-reset-prepare')) {
      resetId = request.postDataJSON().id;
      return route.fulfill({ json: { confirmation: 'synthetic-confirmation',
        email: aliases.find(row => row.id === resetId).email, validityDays: 30 } });
    }
    if (path.endsWith('/apple-relay/code-reset-confirm')) {
      codes.set(resetId, 'RESET-BUYER-CODE-SYNTHETIC');
      return route.fulfill({ json: { email: aliases.find(row => row.id === resetId).email,
        queryCode: codes.get(resetId), codeExpiresAt: '2099-01-01T00:00:00Z' } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      unexpected.push(path);
      return route.fulfill({ status: 503, json: { error: '禁止未预期的业务操作' } });
    }
    return route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/relay');
  const cell = id => page.locator(`[data-relay-buyer-code="${id}"]`);
  const output = id => cell(id).locator('output');
  const ready = () => page.waitForFunction(() =>
    document.querySelector('[data-relay-buyer-code]') &&
    !document.querySelector('[data-relay-buyer-code][aria-busy="true"]') &&
    ![...document.querySelectorAll('[data-relay-buyer-code] output')].some(node => node.textContent.includes('正在')));
  await cell(aliases[0].id).waitFor();
  await ready();
  assert.equal(reads.length, 8, '只读取当前页，不扫描全部隐藏邮箱');
  assert(maximum <= 3, '当前页使用受控并发');
  assert.equal(await output(aliases[0].id).textContent(), codes.get(aliases[0].id));
  assert.equal(await output(aliases[1].id).textContent(), '读取失败');
  assert(await cell(aliases[1].id).getByRole('button', { name: '复制买家查询码', exact: true }).isDisabled());
  await cell(aliases[1].id).getByRole('button', { name: '重试', exact: true }).click();
  await ready();
  assert.equal(await output(aliases[1].id).textContent(), codes.get(aliases[1].id));
  await cell(aliases[0].id).getByRole('button', { name: '复制买家查询码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedBuyerCode), codes.get(aliases[0].id));
  await page.locator(`[data-action="relay-alias-more"][data-id="${aliases[0].id}"]`).click();
  await page.getByRole('menuitem', { name: '重置查询码', exact: true }).click();
  await page.locator('button[form="relay-live-code-form"]').click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '确认重置', exact: true }).click();
  await page.locator('#relay-code-result').waitFor();
  await ready();
  assert.equal(await output(aliases[0].id).textContent(), codes.get(aliases[0].id), '重置后立即更新列表');
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
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
    }), '横向滚动到查询码列后，完整内容能在表格视口内显示');
    if (width <= 900) assert((await copy.boundingBox()).height >= 44);
    if (process.env.ID_LAYOUT_QA_OUTPUT && !dark && width !== 320) {
      await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
      await page.screenshot({ path: `${process.env.ID_LAYOUT_QA_OUTPUT}/buyer-code-${width}.png` });
    }
  }
  await cell(aliases[0].id).getByRole('button', { name: '复制买家查询码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedBuyerCode), codes.get(aliases[0].id));
  await page.locator('#main .pagination button[data-page="2"]:not([aria-label])').click();
  await ready();
  assert.equal(await output(aliases[10].id).textContent(), '未接入收件服务');
  assert(await cell(aliases[10].id).getByRole('button', { name: '复制买家查询码', exact: true }).isDisabled());
  assert(!reads.includes(aliases[10].id));
  assert.equal(reads.filter(id => [aliases[8].id, aliases[9].id].includes(id)).length, 2);
  await page.locator('#main .pagination button[data-page="1"]:not([aria-label])').click();
  await ready();
  assert.equal(reads.filter(id => id === aliases[0].id).length, 1, '重置结果直接更新缓存，不重复读取');
  const before = reads.length;
  await page.locator('#main .pagination button[data-page="2"]:not([aria-label])').click();
  await ready();
  await page.locator('#main .pagination button[data-page="1"]:not([aria-label])').click();
  await ready();
  assert.equal(reads.length, before, '数据未失效时，切换分页复用已成功结果');
  assert(await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('BUYER-')), '查询码不写入浏览器持久存储');
  held = true;
  const delayed = page.waitForResponse(response => response.url().endsWith('/code-read') && response.request().postDataJSON().id === 'qa-code-0');
  await page.evaluate(() => { window.IDLocalData.queries.invalidate('apple-relay'); window.IDDesignAPI.render(); });
  await holdReady;
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  release();
  await delayed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#main[data-layout-route="customers/list"]').count(), 1);
  assert.equal(await page.locator('#main [data-relay-buyer-code]').count(), 0, '迟到读取不污染其他页面');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
});
