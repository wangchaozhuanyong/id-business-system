import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

test('bulk IP detection spans filters/pages, remains sequential, stops safely and preserves results', { timeout: 180000 }, async t => {
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (module.default || module).chromium.launch(); t.after(() => browser.close());
  const output = new URL('../.runtime/bit-proxy-bulk/', import.meta.url); await mkdir(output, { recursive: true });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(7000);
    const origin = 'https://bit-proxy-bulk.test', errors = [], writes = [], external = [];
    let items = Array.from({ length: 6 }, (_, n) => ({ id: String(n + 1), name: `示例 ${n + 1}`, countryCode: 'PH', kind: 'mobile', mode: n === 5 ? 'dynamic' : 'static', protocol: 'socks5', endpoint: n === 5 ? 'extract.example.test' : `proxy-${n + 1}.example.test:1080` }));
    let reads = [], calls = [], extractionCalls = 0, active = 0, maxActive = 0, holdNative = false, holdRead = false, heldNative, heldRead, nativeArrival, readArrival, conflict = false, extractionMode = 'provider-failure';
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify(body) });
      if (url.origin === 'http://127.0.0.1:54345' && path === '/checkagent') {
        const body = req.postDataJSON(); calls.push(body.host); active++; maxActive = Math.max(maxActive, active);
        try {
          if (holdNative) { holdNative = false; await new Promise(resolve => { heldNative = resolve; nativeArrival?.(); }); }
          await json({ success: true, data: body.host === 'proxy-2.example.test' ? { success: false } : { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } }).catch(() => {});
        } finally { active--; }
        return;
      }
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (path === '/api/local/bitbrowser-proxies') {
        if (req.method() === 'GET') return json({ version: 7, items });
        if (req.method() !== 'POST') { writes.push(req.method()); return route.abort(); }
        const body = req.postDataJSON(); reads.push(body); assert.equal(body.version, 7);
        if (holdRead) { holdRead = false; await new Promise(resolve => { heldRead = resolve; readArrival?.(); }); }
        if (conflict) return json({ error: 'IP 列表已更新，请刷新后重新选择' }, 409).catch(() => {});
        const item = items.find(x => x.id === body.id);
        return json({ ...item, link: item.mode === 'dynamic' ? 'https://extract.example.test/api?key=synthetic' : `socks5://user:synthetic-pass@${item.endpoint}` }).catch(() => {});
      }
      if (path === '/api/local/bitbrowser-proxies/extract') {
        extractionCalls++;
        if (extractionMode === 'limited') return json({ reason: 'extraction', error: '代理提取检测过于频繁，请稍后重试。' }, 429);
        if (extractionMode === 'provider-failure') return json({ reason: 'extraction', error: '供应商白名单限制，未完成检测。' }, 422);
        return json({ link: 'socks5://user:synthetic-pass@proxy-api.example.test:1080', automaticProtocol: false });
      }
      let file;
      if (path === '/') file = '../frontend/bitbrowser-local.html';
      else if (path === '/assets/bitbrowser/proxies.mjs') file = '../frontend/bitbrowser-proxies.mjs';
      else if (path.startsWith('/assets/bitbrowser/')) file = '../modules/recharge/bitbrowser/' + path.slice('/assets/bitbrowser/'.length);
      else if (['/prototype.css', '/recharge-integration.css', '/title-help.css', '/title-help.js'].includes(path)) file = '../frontend/' + path.slice(1);
      if (!file) { external.push(path); return route.abort(); }
      let body = await readFile(new URL(file, import.meta.url), 'utf8');
      if (path === '/') body = body.replace('<script type="module" src="/assets/bitbrowser/local.mjs"></script>', `<script type="module">
        import {initializeExecutionProxies} from '/assets/bitbrowser/proxies.mjs';
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        document.getElementById('bit-local-token').value='synthetic-key';
        window.proxies=initializeExecutionProxies({get:id=>document.getElementById(id),onChange(){},locked:()=>false,
          connection:()=>({url:'http://127.0.0.1:54345',token:document.getElementById('bit-local-token').value})});
        document.getElementById('bit-login-panel').hidden=true; document.getElementById('bit-library-panel').hidden=false;
        await window.proxies.refresh();
      </script>`);
      return route.fulfill({ contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', body });
    });
    await page.goto(origin); await page.waitForFunction(() => !document.querySelector('#bit-test-all-proxies').disabled);
    await page.locator('#bit-execution-proxy').evaluate(e => { e.value='1'; e.dispatchEvent(new Event('change',{bubbles:true})); });
    assert.equal(await page.evaluate(() => window.proxies.ready()), true);
    await page.locator('#bit-ip-search').fill('示例 1'); // All six must run even while only one is visible.
    await page.locator('#bit-test-all-proxies').click();
    await page.locator('#bit-library-result').filter({ hasText: '检测全部完成' }).waitFor();
    assert.match(await page.locator('#bit-library-result').innerText(), /已完成 6\/6，可用 4，未通过 1，未完成 1/);
    assert.equal(new Set(reads.map(x => x.id)).size, 6); assert.equal(calls.length, 5); assert.equal(maxActive, 1);
    assert.equal(await page.locator('#bit-ip-search').inputValue(), '示例 1');
    await page.locator('#bit-ip-search').fill('');
    assert.match(await page.locator('#bit-ip-rows tr').filter({ hasText: '示例 2' }).innerText(), /检测未通过/);
    assert.match(await page.locator('#bit-ip-rows tr').filter({ hasText: '示例 6' }).innerText(), /未完成检测/);
    await page.locator('#bit-ip-next').click(); assert.match(await page.locator('#bit-ip-page-info').innerText(), /2 \/ 2/);
    assert.match(await page.locator('#bit-ip-rows tr').innerText(), /可用/);
    const idleBounds = await page.locator('#bit-test-all-proxies').boundingBox();
    reads = []; calls = []; holdNative = true;
    let nativeWaiting = new Promise(resolve => nativeArrival = resolve);
    await page.locator('#bit-test-all-proxies').click();
    await nativeWaiting;
    await page.waitForFunction(() => document.querySelector('#bit-ip-rows').textContent.includes('检测中'));
    assert.equal(await page.evaluate(() => window.proxies.ready()), false, '批量检测中不能开始登录');
    assert.equal(await page.locator('#bit-refresh-proxies').isDisabled(), true);
    assert.equal(await page.locator('#bit-library-add').isDisabled(), true);
    assert.equal(await page.locator('#bit-test-all-proxies').innerText(), '停止检测');
    assert.equal((await page.locator('#bit-test-all-proxies').boundingBox()).width, idleBounds.width, '切换按钮状态不改变宽度');
    await page.screenshot({ path: fileURLToPath(new URL(`${width}-${theme}-running.png`, output)), fullPage: true });
    await page.locator('#bit-test-all-proxies').click();
    await page.locator('#bit-library-result').filter({ hasText: '已手动停止' }).waitFor();
    assert.equal(reads.length, 1); assert.equal(calls.length, 1);
    heldNative(); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.locator('#bit-test-all-proxies').innerText(), '检测全部');
    assert.equal(await page.evaluate(() => window.proxies.ready()), true);
    // Stop while the encrypted-link read is still pending; never launch a native check afterwards.
    reads = []; calls = []; holdRead = true;
    const readWaiting = new Promise(resolve => readArrival = resolve);
    await page.locator('#bit-test-all-proxies').click();
    await readWaiting;
    await page.locator('#bit-test-all-proxies').filter({ hasText: '停止检测' }).waitFor();
    await page.locator('#bit-test-all-proxies').click();
    await page.locator('#bit-library-result').filter({ hasText: '已手动停止' }).waitFor();
    heldRead?.(); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(calls.length, 0);
    reads = []; calls = []; conflict = true;
    await page.locator('#bit-test-all-proxies').click(); await page.locator('#bit-library-result').filter({ hasText: 'IP 列表已更新' }).waitFor();
    assert.equal(reads.length, 1); assert.equal(calls.length, 0); conflict = false;
    // Changing connection cancels an in-flight probe, not just the next item.
    calls = []; holdNative = true;
    nativeWaiting = new Promise(resolve => nativeArrival = resolve);
    await page.locator('#bit-test-all-proxies').click();
    await page.waitForFunction(() => document.querySelector('#bit-ip-rows').textContent.includes('检测中'));
    await nativeWaiting;
    await page.locator('#bit-local-token').evaluate(e => { e.value='synthetic-new-key'; e.dispatchEvent(new Event('input',{bubbles:true})); });
    await page.locator('#bit-library-result').filter({ hasText: '比特连接已变化' }).waitFor();
    heldNative(); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); assert.equal(calls.length, 1);
    if (width === 1440 && theme === 'light') {
      items = [{ ...items[5] }, { ...items[0], mode: 'dynamic', endpoint: 'extract.example.test' }]; extractionMode = 'success'; extractionCalls = 0;
      await page.locator('#bit-refresh-proxies').click(); await page.locator('#bit-test-all-proxies').click();
      await page.locator('#bit-library-result').filter({ hasText: '等待提取间隔' }).waitFor();
      await page.locator('#bit-test-all-proxies').click(); await page.locator('#bit-library-result').filter({ hasText: '已手动停止' }).waitFor();
      assert.equal(extractionCalls, 1, '提取间隔可取消，不继续请求');
    }
    items = [{ ...items[0], mode: 'dynamic', endpoint: 'extract.example.test' }, ...items.slice(1)]; extractionMode = 'limited'; reads = [];
    await page.locator('#bit-refresh-proxies').click(); await page.locator('#bit-test-all-proxies').click();
    await page.locator('#bit-library-result').filter({ hasText: '过于频繁' }).waitFor(); assert.equal(reads.length, 1);
    items = []; await page.locator('#bit-refresh-proxies').click(); await page.waitForFunction(() => document.querySelector('#bit-ip-count').textContent === '0');
    assert.equal(await page.locator('#bit-test-all-proxies').isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const controls = await page.locator('#bit-library-panel > .panel-heading button').evaluateAll(nodes => nodes.map(e => { const r=e.getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth; })); assert(controls.every(Boolean));
    assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
    await page.close();
  });
});
