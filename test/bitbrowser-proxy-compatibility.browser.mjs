import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('successive proxy additions, extraction statuses and late edit reads stay independent', { timeout: 30000 }, async t => {
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (module.default || module).chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); const origin = 'https://bit-proxies.test';
  const errors = [], unexpected = []; page.on('pageerror', e => errors.push(e.message));
  let version = 0, items = [], stored = new Map(), extractionFailure = true, nativeFailure = false, delayedRead, extractionCalls = 0, nativeCalls = 0;
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify(body) });
    if (url.origin === 'http://127.0.0.1:54345' && path === '/checkagent') {
      nativeCalls++; return json({ success: true, data: nativeFailure ? { success: false } : { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } });
    }
    if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
    if (path === '/api/local/bitbrowser-proxies/extract') {
      extractionCalls++; assert.equal(req.method(), 'POST');
      return extractionFailure ? json({ reason: 'extraction', error: '提取服务限制访问来源或白名单，未完成检测。' }, 422) : json({ link: 'socks5://user:synthetic-pass@proxy.example.test:1080', automaticProtocol: false });
    }
    if (path === '/api/local/bitbrowser-proxies') {
      if (req.method() === 'GET') return json({ version, items });
      const body = req.postDataJSON();
      if (req.method() === 'POST') {
        if (delayedRead) { const wait = delayedRead; delayedRead = null; wait.started(); await wait.promise; }
        return json({ ...items.find(item => item.id === body.id), link: stored.get(body.id) });
      }
      assert.equal(body.version, version); version++;
      const id = body.id || String(version), endpoint = new URL(body.link).host;
      const item = { ...body, id, endpoint }; delete item.link; stored.set(id, body.link);
      items = [...items.filter(row => row.id !== id), item];
      return json({ version, items, savedId: id });
    }
    let file;
    if (path === '/') file = '../frontend/bitbrowser-local.html';
    else if (path === '/assets/bitbrowser/proxies.mjs') file = '../frontend/bitbrowser-proxies.mjs';
    else if (path.startsWith('/assets/bitbrowser/')) file = '../modules/recharge/bitbrowser/' + path.slice('/assets/bitbrowser/'.length);
    else if (['/prototype.css', '/design-tokens.css', '/tabs.css', '/recharge-integration.css', '/title-help.css', '/title-help.js', '/pagination.css', '/pagination.js'].includes(path)) file = '../frontend/' + path.slice(1);
    if (!file) { unexpected.push(path); return route.abort(); }
    let body = await readFile(new URL(file, import.meta.url), 'utf8');
    if (path === '/') body = body.replace('<script type="module" src="/assets/bitbrowser/local.mjs"></script>', `<script type="module">
      import {initializeExecutionProxies} from '/assets/bitbrowser/proxies.mjs';
      let draft={}; window.testDraft=()=>draft;
      window.proxies=initializeExecutionProxies({get:id=>document.getElementById(id),drafts:{read:()=>({...draft}),write:(_,value)=>draft={...value}},onChange(){},locked:()=>false,connection:()=>({url:'http://127.0.0.1:54345',token:'synthetic-key'})});
      document.getElementById('bit-login-panel').hidden=true; document.getElementById('bit-library-panel').hidden=false;
      await window.proxies.refresh();
    </script>`);
    return route.fulfill({ contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', body });
  });
  await page.goto(origin); await page.locator('#bit-ip-count').filter({ hasText: '0' }).waitFor();
  for (const [name, link] of [['第一个', 'socks5://user:synthetic-pass@proxy.example.test:1080'], ['第二个', 'http://user:synthetic-pass@proxy.example.test:8080'], ['第三个', 'https://extract.example.test/api?protocol=socks5&key=synthetic']]) {
    await page.locator('#bit-library-add').click(); await page.locator('#bit-ip-name').fill(name); await page.locator('#bit-ip-link').fill(link);
    await page.locator('#bit-ip-save').click(); await page.locator('#bit-proxy-editor').waitFor({ state: 'hidden' });
  }
  assert.equal(items.length, 3); assert.equal(extractionCalls, 0, '保存提取链接不必先检测');
  const row = page.locator('#bit-ip-rows tr').filter({ hasText: '第三个' });
  assert.match(await row.innerText(), /SOCKS5 · API 提取/);
  await row.getByRole('button', { name: '测试', exact: true }).click();
  await page.locator('#bit-library-result').filter({ hasText: '白名单' }).waitFor();
  assert.match(await row.innerText(), /未完成检测/); assert.equal(nativeCalls, 0);
  extractionFailure = false;
  await row.getByRole('button', { name: '测试', exact: true }).click();
  await page.locator('#bit-library-result').filter({ hasText: '代理可用' }).waitFor(); assert.match(await row.innerText(), /可用 ·/);
  nativeFailure = true;
  await row.getByRole('button', { name: '测试', exact: true }).click();
  await page.locator('#bit-library-result').filter({ hasText: '代理检测未通过' }).waitFor(); assert.match(await row.innerText(), /检测未通过/);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#bit-ip-link').value.includes('extract.example.test'));
  assert.equal(await page.locator('#bit-ip-link').getAttribute('type'), 'text');
  assert(!JSON.stringify(await page.evaluate(() => window.testDraft())).includes('synthetic'));
  await page.locator('#bit-ip-close').click();
  nativeFailure = false;
  await page.locator('#bit-library-add').click();
  await page.locator('#bit-ip-name').fill('第四个未注明协议的 API');
  await page.locator('#bit-ip-advanced > summary').click();
  await page.locator('#bit-ip-country').fill('埃及');
  await page.locator('#bit-ip-link').fill('https://extract.example.test/api?key=synthetic');
  await page.locator('#bit-ip-save').click();
  await page.locator('#bit-proxy-editor').waitFor({ state: 'hidden' });
  assert.equal(items.length, 4);
  assert.equal(items.find(item => item.name.startsWith('第四个')).countryCode, 'EG', '检测到的国家不能覆盖手填标记');
  assert.equal(items.find(item => item.name.startsWith('第四个')).protocol, 'socks5', '未注明协议的 API 保存检测确认的协议，不能默认为 HTTP');
  let release, started; const waiting = new Promise(r => started = r), promise = new Promise(r => release = r);
  delayedRead = { promise, started };
  await row.getByRole('button', { name: '编辑', exact: true }).click(); await waiting;
  await page.locator('#bit-ip-close').click(); await page.locator('#bit-library-add').click(); release();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await page.locator('#bit-ip-link').inputValue(), '', '关闭后的迟到读取不能回填其他资料');
  assert.equal(await page.locator('#bit-ip-save').isDisabled(), false);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
