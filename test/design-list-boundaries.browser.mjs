import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';

test('dense lists retain pagination and drawer controls within their visible boundaries', { timeout: 120_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url), 'utf8'));
  const customers = fixture.commerce.data.customers;
  for (let i = customers.length; i < 257; i++) customers.push({ ...customers[0], id: `visual-dense-${i}`, name: `隔离长名单客户 ${i}`, phone: '', wechat: `visual-${i}` });
  const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
  const host = offline ? { url: offlineOrigin + '/' } : await startCodexdaichongDemoSite(0);
  if (!offline) t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const origin = new URL(host.url).origin;
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  const routes = ['customers/list', 'customers/tenants', 'mailboxes/google', 'accounts/gpt', 'accounts/claude', 'accounts/apple-balances', 'orders/gpt', 'orders/pro', 'orders/exclusive'];
  for (const width of [1440, 768, 390, 320]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      if (offline) await interceptDesign(page.context(), { localFixtures: fixture });
      page.setDefaultTimeout(6000);
      await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
        const data = url.pathname.startsWith('/api/local/') && fixture[url.pathname.slice('/api/local/'.length)];
        return data ? route.fulfill({ json: data }) : (offline ? route.fallback() : route.continue());
      });
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const inspect = () => page.locator('#main .pagination').evaluate(n => {
        const outer = n.getBoundingClientRect();
        const controls = n.querySelector('.pagination-controls');
        const bounds = controls.getBoundingClientRect();
        const strip = n.querySelector('.pagination-pages')?.getBoundingClientRect();
        const active = n.querySelector('[aria-current="page"]')?.getBoundingClientRect();
        const outside = [...controls.querySelectorAll('select, button[aria-label], button.active')].filter(x => {
          const r = x.getBoundingClientRect(); return r.left < outer.left || r.right > outer.right;
        }).map(x => x.getAttribute('aria-label') || x.textContent.trim());
        return { outerWidth: outer.width, controlsWidth: bounds.width, controlsOutside: bounds.left < outer.left || bounds.right > outer.right,
          outside, page: Number(n.querySelector('[aria-current="page"]')?.dataset.page),
          activeClipped: !!strip && (active.left < strip.left - 1 || active.right > strip.right + 1),
          pages: [...n.querySelectorAll('button[data-page]:not([aria-label])')].length,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          tableHeight: document.querySelector('#main .table-viewport')?.getBoundingClientRect().height };
      });
      try {
        await page.goto(origin + '/#/customers/list');
        if (dark) await page.locator('#theme-toggle').click();
        for (const route of routes) {
          await page.evaluate(route => { location.hash = '#/' + route; }, route);
          await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
          await page.locator('#main tr[data-row-id]').first().waitFor();
          await settle();
          if (route === 'customers/list') {
            const title = await page.locator('.topbar-page-title h1').evaluate(n => ({ height: n.getBoundingClientRect().height, line: parseFloat(getComputedStyle(n).lineHeight) }));
            assert(title.height <= title.line + 1, '短页面标题不应被右侧按钮挤成两行');
          }
          const first = await inspect();
          if (first.controlsOutside || first.outside.length) {
            if (output) await page.screenshot({ path: join(output, `pagination-before-${width}-${dark ? 'dark' : 'light'}.png`) });
          }
          assert(!first.pageOverflow && !first.controlsOutside && !first.outside.length && !first.activeClipped, `${route}: ${JSON.stringify(first)}`);
          const lastPage = first.pages;
          await page.locator(`#main .pagination button[data-page="${lastPage}"]:not([aria-label])`).click();
          await settle();
          const last = await inspect();
          assert.equal(last.page, lastPage);
          assert(!last.controlsOutside && !last.outside.length && !last.pageOverflow && !last.activeClipped, `${route}: ${JSON.stringify(last)}`);
          assert(Math.abs(last.tableHeight - first.tableHeight) <= 1, `${route}: 末页表格突然缩小`);
          if (route === 'customers/list') {
            await page.locator('#main .pagination button[aria-label="上一页"]').press('Enter');
            await settle();
            const previous = await inspect();
            assert.equal(previous.page, lastPage - 1);
            assert(!previous.activeClipped && !previous.outside.length);
            await page.locator('#main .pagination button[aria-label="下一页"]').press('Enter');
            await settle();
            assert.equal((await inspect()).page, lastPage);
          }
          if (output && route === 'customers/list') await page.screenshot({ path: join(output, `pagination-after-${width}-${dark ? 'dark' : 'light'}.png`) });
          const detail = page.locator('#main tbody tr').first().getByRole('button', { name: /^(详情|记录)$/ });
          if (await detail.count()) {
            await detail.first().click();
            await page.locator('#drawer[open]').waitFor();
            const drawer = await page.locator('#drawer').evaluate(n => ({
              overflow: n.scrollWidth > n.clientWidth,
              width: n.getBoundingClientRect().width,
              footer: n.querySelector('.drawer-footer')?.getBoundingClientRect().bottom,
              outside: [...n.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(x => x.getClientRects().length).filter(x => {
                const r = x.getBoundingClientRect();return r.left < 0 || r.right > innerWidth + 1;
              }).map(x => x.id)
            }));
            assert(!drawer.overflow && !drawer.outside.length && drawer.footer <= 901, `${route}: ${JSON.stringify(drawer)}`);
            await page.locator('#drawer button[data-action="drawer-close"]').last().click();
          }
          const search = page.locator('#main .search-field input').first();
          let empty = null;
          if (await search.count()) {
            await search.fill('layout-no-match-190736');
            await page.locator('#main tr[data-row-id]').first().waitFor({ state: 'detached' });
            await settle();
            if (await page.locator('#main .pagination').count()) {
              empty = await inspect();
              assert(!empty.controlsOutside && !empty.outside.length && !empty.pageOverflow && !empty.activeClipped);
              assert.equal(empty.page, 1);
              assert(await page.locator('#main .pagination button[aria-label="上一页"]').isDisabled());
              assert(await page.locator('#main .pagination button[aria-label="下一页"]').isDisabled());
            }
            await search.fill('');
            await page.locator('#main tr[data-row-id]').first().waitFor();
          }
          results.push({ route, width, theme: dark ? 'dark' : 'light', first, last, empty });
        }
        if (output) await page.screenshot({ path: join(output, `dense-lists-${width}-${dark ? 'dark' : 'light'}.png`) });
      } finally { await page.close(); }
    });
  }
  if (output) await writeFile(join(output, 'dense-list-results.json'), JSON.stringify(results, null, 2));
});
