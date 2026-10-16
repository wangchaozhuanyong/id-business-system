#!/usr/bin/env node
/* global document */
// Built static fixture only. No website service, database, live API or user data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(root, process.argv[2] ?? '.runtime/workspace-copy-drag-20261016/browser');
assert.ok(output.startsWith(root + sep));
mkdirSync(output, { recursive: true });
const dist = resolve(output, 'static');
await build({
  root: resolve(root, 'apps/admin'),
  configFile: resolve(root, 'apps/admin/vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir: dist,
    rolldownOptions: { input: resolve(root, 'apps/admin/workspace-design-fixture.html') }
  }
});
const server = createServer((request, response) => {
  const path = resolve(dist, '.' + new URL(request.url, 'http://fixture').pathname);
  if (!path.startsWith(dist + sep) || !existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader(
    'Content-Type',
    { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[
      extname(path)
    ] ?? 'application/octet-stream'
  );
  response.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const checks = [],
  errors = [],
  blocked = [];
const rows = (page) => page.locator('.v2-quick-actions-panel__item');
const titles = (page) => rows(page).locator('.v2-quick-actions-panel__title').allTextContents();
async function open(page, options = '') {
  await page.goto(`${base}/workspace-design-fixture.html?count=4&${options}`);
  const expand = page.getByRole('button', { name: '展开工作区', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('tab', { name: '话术文案', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.v2-quick-actions-panel__item.is-draggable').length === 4
  );
}
async function bounds(page) {
  return rows(page).evaluateAll((es) =>
    es.map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    })
  );
}
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
async function saved(page) {
  const toast = page.getByRole('alert').filter({ hasText: '顺序已保存到当前账号' });
  await toast.waitFor();
  await toast.locator('.el-message__closeBtn').click();
  await toast.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => !document.querySelector('.v2-quick-actions-panel')?.textContent.includes('正在保存顺序')
  );
}
try {
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 1024, 901, 900, 768, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        permissions: ['clipboard-read', 'clipboard-write']
      });
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== base || u.pathname.startsWith('/api/')) {
          blocked.push(u.pathname);
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await open(page, `theme=${theme}`);
      const before = await titles(page),
        b = await bounds(page);
      const list = await page.locator('.v2-quick-actions-panel__list').boundingBox();
      await drag(
        page,
        { x: b[0].left + 3, y: b[0].top + 20 },
        { x: b[0].left + 3, y: Math.min(list.y + list.height - 20, b[3].bottom + 70) }
      );
      await saved(page);
      assert.deepEqual(await titles(page), [...before.slice(1), before[0]]);
      await page.getByRole('tab', { name: '个人工具', exact: true }).click();
      if (width > 900) await page.getByRole('link', { name: 'ID 管理', exact: true }).click();
      else {
        await page.getByRole('button', { name: '收起工作区', exact: true }).click();
        await page.getByRole('button', { name: '展开工作区', exact: true }).click();
      }
      await page.getByRole('tab', { name: '话术文案', exact: true }).click();
      assert.deepEqual(await titles(page), [...before.slice(1), before[0]]);
      const next = await bounds(page);
      await drag(
        page,
        { x: next[3].left + 3, y: next[3].top + 20 },
        { x: next[0].left + 3, y: (next[1].bottom + next[2].top) / 2 }
      );
      await saved(page);
      assert.deepEqual(await titles(page), [before[1], before[2], before[0], before[3]]);
      await rows(page).first().getByRole('button', { name: '复制文案', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '第 2 条回复内容');
      assert.equal(await rows(page).filter({ hasText: '正在保存顺序' }).count(), 0);
      await rows(page)
        .first()
        .getByRole('button', { name: /^更多：/ })
        .click();
      await page.getByRole('menuitem', { name: '查看全文', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.deepEqual(await titles(page), [before[1], before[2], before[0], before[3]]);
      const geometry = await rows(page).evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            width: r.width,
            scrollWidth: e.scrollWidth,
            clientWidth: e.clientWidth
          };
        })
      );
      assert.ok(
        geometry.every(
          (g) => g.left >= 0 && g.right <= width + 1 && g.scrollWidth <= g.clientWidth + 1
        )
      );
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      checks.push({
        theme,
        width,
        cardWhitespaceDrag: true,
        gapAndEndDrop: true,
        routeRetention: width > 900 ? 'PASS' : 'NOT_RUN',
        reopenRetention: true,
        copyAndMenu: true,
        noOverflow: true
      });
      await context.close();
    }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    hasTouch: true
  });
  await context.route('**/*', (r) =>
    new URL(r.request().url()).origin === base ? r.continue() : r.abort()
  );
  const page = await context.newPage();
  await open(page, 'order=fail-once');
  const initial = await titles(page);
  let b = await bounds(page);
  await drag(
    page,
    { x: b[0].left + 3, y: b[0].top + 20 },
    { x: b[3].left + 3, y: b[3].bottom - 5 }
  );
  await page.getByText('验收模拟顺序保存失败，请重新拖动重试', { exact: true }).waitFor();
  assert.deepEqual(await titles(page), initial);
  await drag(
    page,
    { x: b[0].left + 3, y: b[0].top + 20 },
    { x: b[3].left + 3, y: b[3].bottom - 5 }
  );
  await saved(page);
  assert.deepEqual(await titles(page), [...initial.slice(1), initial[0]]);
  await open(page);
  b = await bounds(page);
  await page.mouse.move(b[0].left + 3, b[0].top + 20);
  await page.mouse.down();
  await page.mouse.move(b[3].left + 3, b[3].bottom - 5, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await titles(page), initial);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: b[0].left + 3, y: b[0].top + 20 }]
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: b[3].left + 3, y: b[3].bottom - 5 }]
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await saved(page);
  assert.deepEqual(await titles(page), [...initial.slice(1), initial[0]]);
  checks.push({ failureRollbackAndRetry: true, escapeCancel: true, touchCardDrag: true });
  await context.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  writeFileSync(
    resolve(output, 'result.json'),
    JSON.stringify({ ok: true, scope: 'STATIC_SYNTHETIC_ONLY', checks, errors, blocked }, null, 2)
  );
  console.log(JSON.stringify({ ok: true, cases: checks.length, scope: 'STATIC_SYNTHETIC_ONLY' }));
} catch (error) {
  writeFileSync(
    resolve(output, 'result.json'),
    JSON.stringify({ ok: false, error: String(error), checks, errors, blocked }, null, 2)
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
