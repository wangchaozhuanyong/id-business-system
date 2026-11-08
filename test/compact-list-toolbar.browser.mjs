import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
test('常规列表页签、搜索与操作共享紧凑工具区，窄屏自然换行且控件不裁切', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'admin', name: '合成管理员', role: 'super' } });
  await context.route(origin + '/api/local/auth/employees', route => route.fulfill({ json: { employees: [] } }));
  const page = await context.newPage(), errors = [], measurements = [];
  let authLoaded = false;
  page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  const output = new URL('../.runtime/follow-through-20261108/', import.meta.url); await mkdir(output, { recursive: true });
  for (const route of ['workspace/customer-loss', 'workspace/renewals', 'workspace/extractions', 'customers/list', 'customers/tenants', 'orders/gpt', 'orders/pro', 'orders/exclusive', 'settings/accounts']) {
    await page.goto(origin + '/#/' + route);
    if (!authLoaded) { await page.addScriptTag({ url: origin + '/local-auth.js' }); await page.addStyleTag({ url: origin + '/local-auth.css' }); authLoaded = true; }
    const controls = page.locator('#main .list-controls').first(); await controls.waitFor().catch(error => { throw new Error(route + ': ' + error.message); });
    for (const width of [1440, 1024, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
      const layout = await controls.evaluate(node => {
        const rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const rangeRect = n => { const range = document.createRange(); range.selectNodeContents(n); return rect({ getBoundingClientRect: () => range.getBoundingClientRect() }); };
        const elements = [...node.querySelectorAll('.toolbar input,.toolbar select,.toolbar button,.tabs .tab.active')].filter(n => n.checkVisibility());
        return { frame: rect(node), tabs: rect(node.querySelector('.tabs')), toolbar: rect(node.querySelector('.toolbar')), controls: elements.map(n => ({ box: rect(n), text: n.tagName === 'BUTTON' ? rangeRect(n) : null })), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(!layout.overflow, JSON.stringify({ route, width, theme, layout }));
      for (const control of layout.controls) {
        assert(control.box.x >= layout.frame.x - 1 && control.box.right <= layout.frame.right + 1, `${route} ${width} clipped control`);
        if (control.text) assert(control.text.x >= control.box.x - 1 && control.text.right <= control.box.right + 1, `${route} ${width} clipped text`);
      }
      if (width === 1440) assert(Math.min(layout.tabs.bottom, layout.toolbar.bottom) > Math.max(layout.tabs.y, layout.toolbar.y), `${route} 宽屏不应提前换行`);
      if (route === 'workspace/customer-loss' && width === 1024) assert(Math.abs(layout.tabs.y - layout.toolbar.y) < 15, '客户流失在 1024px 仍可同排');
      if (['workspace/customer-loss', 'orders/gpt'].includes(route) && [1440, 390].includes(width))
        await page.screenshot({ path: fileURLToPath(new URL(`compact-${route.replaceAll('/', '-')}-${width}-${theme}.png`, output)) });
      measurements.push({ route, width, theme, layout });
    }
  }
  await writeFile(new URL('compact-geometry.json', output), JSON.stringify(measurements));
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});
