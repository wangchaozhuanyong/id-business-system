import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('embedded IP editor uses the host viewport and retains its original controls and lifecycle', { timeout: 180_000 }, async t => {
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (module.default || module).chromium.launch();
  t.after(() => browser.close());
  const output = new URL('../.runtime/bit-embedded-drawer/', import.meta.url);
  await mkdir(output, { recursive: true });
  const actor = { id: '11111111-1111-4111-8111-111111111111', name: '离线验收管理员', role: 'super' };
  const profile = { id: '11111111-1111-4111-8111-111111111111', name: '合成电脑', accountName: 'fixture-account', url: 'http://127.0.0.1:54345', groupName: '合成分组', tagName: '合成标签', coreVersion: '152', proxyMode: 'dynamic', proxyType: 'http', expectedCountryCode: '', staticHost: '', staticPort: 8080, sessionWaitMinutes: 2, sessionRetryLimit: 9, hasInterfaceToken: true };
  const results = [];
  for (const width of [1440, 1024, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    if (process.env.ID_BIT_DRAWER_QA_CASE && process.env.ID_BIT_DRAWER_QA_CASE !== `${width}-${theme}`) continue;
    await t.test(`${width}px ${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await interceptDesign(context, { actor, localFixtures: { 'auth/session': { configured: true, actor } } });
      await page.addInitScript(() => { window.IDLocalAuth = { getState: () => ({ status: 'signed-in' }), lock() {} }; });
      let version = 0, saves = 0, reads = 0, items = [];
      await page.route('**/integrations/bitbrowser/local-login', async route => {
        const html = await readFile(new URL('../frontend/bitbrowser-local.html', import.meta.url), 'utf8');
        await route.fulfill({ contentType: 'text/html', body: html.replace('<body class="bit-local">', '<body class="bit-local" data-connection-profiles>') });
      });
      await page.route('**/api/local/bitbrowser-connections', route => route.fulfill({ json: route.request().method() === 'POST' ? { interfaceToken: 'synthetic-interface-key' } : { version: 1, profiles: [profile] }, headers: { 'X-ID-BitBrowser-Token-Storage': 'enabled' } }));
      await page.route('http://127.0.0.1:54345/**', route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ headers: { 'access-control-allow-origin': origin }, json: { success: true, data: path === '/group/list' ? { list: [{ id: 'fixture-group', groupName: '合成分组' }] } : path === '/browserTag/list' ? [{ id: 'fixture-tag', tagName: '合成标签' }] : { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } } });
      });
      await page.route('**/api/local/bitbrowser-proxies', route => {
        if (route.request().method() === 'GET') { reads++; return route.fulfill({ json: { version, items } }); }
        if (route.request().method() === 'PUT') {
          saves++;
          if (saves === 1) return route.fulfill({ status: 503, json: { error: '合成保存失败，输入已保留' } });
          const body = route.request().postDataJSON();
          assert.equal(body.name, '合成代理'); assert.equal(body.countryCode, 'PH');
          items = [{ id: '22222222-2222-4222-8222-222222222222', name: body.name, countryCode: body.countryCode, kind: body.kind, mode: body.mode, protocol: body.protocol, endpoint: '192.0.2.8:8080' }];
          return route.fulfill({ json: { version: ++version, items, savedId: items[0].id } });
        }
        return route.fulfill({ status: 400, json: { error: '不应读取真实代理' } });
      });
      try {
        await page.goto(origin + '/#/recharge/start');
        const bit = page.frameLocator('.recharge-integration__frame--bit-local');
        await bit.locator('#bit-connection-profile').selectOption(profile.id);
        await bit.locator('#bit-local-group option[value="fixture-group"]').waitFor({ state: 'attached' });
        if (theme === 'dark') await page.locator('#theme-toggle').click();
        await bit.locator('#bit-tab-library').click();
        await bit.locator('#bit-library-add').click();
        const modal = page.locator('#bit-proxy-editor[open]');
        await modal.waitFor();
        assert.equal(await bit.locator('#bit-proxy-editor').count(), 0, '打开时抽屉由宿主承载');
        assert(await modal.evaluate(d => d.matches(':modal')), '宿主必须拥有原生模态状态');
        const measure = () => modal.evaluate(d => {
          const rect = n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
          return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(d), header: rect(d.querySelector('header')), body: rect(d.querySelector('.bit-local__drawer-body')), footer: rect(d.querySelector('footer')), name: rect(d.querySelector('#bit-ip-name')), theme: document.documentElement.dataset.theme };
        });
        const check = value => {
          assert(Math.abs(value.dialog.top) <= 1 && Math.abs(value.dialog.bottom - value.viewport.height) <= 1, JSON.stringify(value));
          assert(value.dialog.left >= -1 && value.dialog.right <= value.viewport.width + 1, '抽屉横向越界');
          assert(value.body.top >= value.header.bottom - 1 && value.body.bottom <= value.footer.top + 1, '正文与固定首尾重叠');
        };
        const initial = await measure(); check(initial); assert.equal(initial.theme, theme);
        assert(initial.name.top >= initial.header.bottom + 16, '首行控件必须完整显示在标题下方');
        await modal.locator('#bit-ip-name').fill('合成代理');
        await modal.locator('#bit-ip-link').fill('socks5://synthetic-user:synthetic-pass@192.0.2.8:8080');
        await modal.locator('#bit-ip-advanced > summary').click();
        await modal.locator('#bit-ip-country').fill('菲律宾');
        await modal.locator('#bit-ip-test').click();
        await modal.locator('#bit-ip-probe-result').filter({ hasText: '8.8.8.8' }).waitFor();
        await page.setViewportSize({ width, height: 480 });
        const resized = await measure(); check(resized);
        await modal.locator('#bit-ip-name').focus();
        assert((await measure()).name.top >= resized.header.bottom - 1, '聚焦首行时不能被标题遮住');
        const beforeReads = reads;
        await page.locator('.recharge-integration__frame--bit-local').evaluate(f => f.contentWindow.postMessage({ source: 'id-recharge-shell', type: 'data-change', scopes: ['bitbrowser-proxies'] }, location.origin));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(reads, beforeReads, '编辑期间不刷新并替换原始版本');
        await modal.locator('#bit-ip-save').click();
        await modal.locator('#bit-ip-save-result').filter({ hasText: '合成保存失败' }).waitFor();
        assert.match(await modal.locator('#bit-ip-link').inputValue(), /^socks5:/);
        await page.screenshot({ path: fileURLToPath(new URL(`${width}-${theme}-short.png`, output)), fullPage: true });
        await modal.locator('#bit-ip-save').click();
        await page.locator('body > #bit-proxy-editor').waitFor({ state: 'detached' });
        await bit.locator('#bit-proxy-editor:not([open])').waitFor({ state: 'attached' });
        await page.waitForFunction(() => document.querySelector('.recharge-integration__frame--bit-local').contentDocument.querySelector('#bit-execution-proxy').value === '22222222-2222-4222-8222-222222222222');
        await bit.locator('#bit-tab-library').click();
        await bit.locator('#bit-library-add').click();
        await modal.locator('#bit-ip-name').fill('保留的普通草稿');
        await modal.locator('#bit-ip-link').fill('socks5://temporary-secret@192.0.2.8:8080');
        await modal.locator('#bit-ip-close').click();
        await bit.locator('#bit-library-add').click();
        assert.equal(await modal.locator('#bit-ip-name').inputValue(), '保留的普通草稿');
        assert.equal(await modal.locator('#bit-ip-link').inputValue(), '', '关闭时清除代理凭据');
        assert((await measure()).name.top >= (await measure()).header.bottom + 16, '重开后首行不得沿用滚动偏移');
        await page.keyboard.press('Escape');
        await page.locator('body > #bit-proxy-editor').waitFor({ state: 'detached' });
        await bit.locator('#bit-library-add').click();
        await page.locator('.recharge-integration__frame--bit-local').evaluate(f => f.contentWindow.postMessage({ source: 'id-recharge-shell', type: 'visibility', visible: false }, location.origin));
        await page.locator('body > #bit-proxy-editor').waitFor({ state: 'detached' });
        assert.equal(await bit.locator('#bit-ip-link').inputValue(), '');
        await page.locator('.recharge-integration__frame--bit-local').evaluate(f => f.contentWindow.postMessage({ source: 'id-recharge-shell', type: 'visibility', visible: true }, location.origin));
        await bit.locator('#bit-library-add').click();
        await modal.locator('#bit-ip-link').fill('socks5://temporary-secret@192.0.2.8:8080');
        await bit.locator('html').evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        await page.locator('body > #bit-proxy-editor').waitFor({ state: 'detached' });
        assert.equal(await bit.locator('#bit-ip-link').inputValue(), '', '页面离开不能留下宿主弹层或代理凭据');
        assert.deepEqual(errors, []);
        results.push({ width, theme, initial, resized, saves, errors });
      } catch (error) {
        console.error(`${width}px ${theme}: ${error.message}`);
        throw error;
      } finally { await context.close(); }
    });
  }
  await writeFile(new URL('geometry.json', output), JSON.stringify(results, null, 2));
});
