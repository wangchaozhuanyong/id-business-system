import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('account connection and IP stay separate; proxy creation, retries, saved key eye and narrow themes', { timeout: 180_000 }, async t => {
  const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (playwright.default || playwright).chromium.launch(); t.after(() => browser.close());
  const origin = 'https://bit-account-ip.test';
  const output = new URL('../.runtime/bit-account-ip-release/', import.meta.url); await mkdir(output, { recursive: true });
  const profile = { id: '11111111-1111-4111-8111-111111111111', name: '办公室电脑', accountName: 'fixture-account', url: 'http://127.0.0.1:54345', groupName: '合成分组', tagName: '合成标签', coreVersion: '152', proxyMode: 'dynamic', proxyType: 'http', expectedCountryCode: '', staticHost: '', staticPort: 8080, sessionWaitMinutes: 2, sessionRetryLimit: 9, hasInterfaceToken: true };
  for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 900, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } }); const page = await context.newPage(); page.setDefaultTimeout(6000);
    const errors = [], unexpected = []; let version = 0, items = [], attempts = 0, probeAttempts = 0, selectedBody;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const json = (data, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(data) });
      if (url.hostname === '127.0.0.1' && path === '/checkagent') return json({ success: true, data: ++probeAttempts <= 2 ? { success: false } : { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } }, 200, { 'access-control-allow-origin': origin });
      if (url.hostname === '127.0.0.1') return json({ success: true, data: path === '/group/list' ? { list: [{ id: 'fixture-group', groupName: '合成分组' }] } : path === '/browserTag/list' ? [{ id: 'fixture-tag', tagName: '合成标签' }] : {} }, 200, { 'access-control-allow-origin': origin });
      if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
      if (path === '/api/local/bitbrowser-connections') {
        if (request.method() === 'POST') return json({ interfaceToken: 'synthetic-interface-key' });
        return json({ version: 1, profiles: [profile] }, 200, { 'X-ID-BitBrowser-Token-Storage': 'enabled' });
      }
      if (path === '/api/local/bitbrowser-proxies') {
        if (request.method() === 'GET') return json({ version, items });
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); attempts++;
          if (attempts === 1) return json({ error: '合成保存失败，请重试' }, 503);
          assert.equal(body.countryCode, 'PH'); assert.equal(body.kind, 'dynamic_residential'); assert.equal(body.protocol, 'socks5'); assert.match(body.link || 'socks5://retained', /^socks5:/);
          version++;
          const saved = { id: body.id || '22222222-2222-4222-8222-222222222222', name: body.name, countryCode: body.countryCode, kind: body.kind, mode: body.mode, protocol: body.protocol, endpoint: '192.0.2.8:8080' };
          items = body.id ? items.map(item => item.id === body.id ? saved : item) : [saved];
          return json({ version, items, savedId: saved.id });
        }
        selectedBody = request.postDataJSON(); return json({ ...items[0], link: 'socks5://synthetic-user:synthetic-pass@192.0.2.8:8080' });
      }
      if (path === '/assets/bitbrowser/login/index.mjs') return route.fulfill({ contentType: 'text/javascript', body: `export { V2_RECHARGE_BROWSER_DEFAULTS as BIT_BROWSER_LOGIN_DEFAULTS } from './browser-options.mjs'; export class BitBrowserLoginError extends Error {} export async function runBitBrowserJsonLogin(input) { const email=JSON.parse(input.sessionJson).user.email; window.fixtureLaunch={country:input.expectedCountryCode,protocol:input.proxyType,host:input.browserOptions.staticHost,port:input.browserOptions.staticPort,email}; return {email}; }` });
      let file;
      if (path === '/') file = '../frontend/bitbrowser-local.html';
      else if (['/prototype.css', '/recharge-integration.css', '/title-help.css', '/title-help.js'].includes(path)) file = '../frontend/' + path.slice(1);
      else if (path === '/assets/bitbrowser/local.mjs') file = '../frontend/bitbrowser-local.mjs';
      else if (path === '/assets/bitbrowser/proxies.mjs') file = '../frontend/bitbrowser-proxies.mjs';
      else if (path.startsWith('/assets/bitbrowser/')) file = '../modules/recharge/bitbrowser/' + path.slice('/assets/bitbrowser/'.length);
      if (!file) { unexpected.push(path); return route.abort(); }
      let body = await readFile(new URL(file, import.meta.url));
      if (path === '/') body = body.toString().replace('<body class="bit-local">', '<body class="bit-local" data-connection-profiles>');
      return route.fulfill({ contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', body });
    });
    await page.goto(origin); await page.locator('#bit-connection-profile').selectOption(profile.id);
    await page.waitForFunction(() => document.querySelector('#bit-local-token')?.value === 'synthetic-interface-key');
    await page.locator('#bit-local-group option[value="fixture-group"]').waitFor({ state: 'attached' });
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator('#bit-toggle-connection').click();
    await page.getByRole('button', { name: '查看本机接口密钥', exact: true }).click(); assert.equal(await page.locator('#bit-local-token').getAttribute('type'), 'text');
    await page.getByRole('button', { name: '隐藏本机接口密钥', exact: true }).click(); assert.equal(await page.locator('#bit-local-token').getAttribute('type'), 'password');
    assert.equal(await page.locator('#bit-proxy-country').isVisible(), false);
    assert.match(await page.locator('#bit-connection-profile option:checked').innerText(), /fixture-account.*办公室电脑/);
    await page.locator('#bit-toggle-connection').click();
    const beforeHelp = await page.locator('#bit-connection-profile').boundingBox();
    await page.locator('#bit-toggle-connection-help').click();
    assert.deepEqual(await page.locator('#bit-connection-profile').boundingBox(), beforeHelp);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#bit-connection-help').isVisible(), false);
    await page.locator('#bit-add-proxy').click();
    assert.equal(await page.locator('#bit-ip-country').isVisible(), false);
    assert.equal(await page.locator('#bit-ip-mode').isVisible(), false);
    assert.equal(await page.locator('#bit-ip-protocol').isVisible(), false);
    await page.locator('#bit-ip-name').fill('新电脑住宅 IP');
    await page.locator('#bit-ip-link').fill('synthetic-user:synthetic-pass@192.0.2.8:8080');
    await page.locator('#bit-ip-test').click();
    await page.getByText('代理检测未通过，请核对代理账号、密码、套餐余额或稍后重试。', { exact: true }).waitFor();
    assert.equal(await page.locator('#bit-ip-link').inputValue(), 'synthetic-user:synthetic-pass@192.0.2.8:8080');
    await page.locator('#bit-ip-test').click();
    await page.waitForFunction(() => document.querySelector('#bit-ip-probe-result').textContent.includes('8.8.8.8'));
    assert.equal(await page.locator('#bit-ip-country').inputValue(), '菲律宾');
    await page.locator('#bit-ip-save').click(); await page.getByText('合成保存失败，请重试', { exact: true }).waitFor();
    assert.equal(await page.locator('#bit-ip-link').inputValue(), 'synthetic-user:synthetic-pass@192.0.2.8:8080');
    const alignment = await page.locator('#bit-proxy-editor .field').evaluateAll(fields => fields.filter(field => field.getBoundingClientRect().height > 0).map(field => {
      const label = field.querySelector('label'), input = field.querySelector('input,select');
      const a = label.getBoundingClientRect(), b = input.getBoundingClientRect(); return { right: a.right, left: b.left, overlap: a.right > b.left + 1 };
    })); assert(alignment.every(item => !item.overlap), JSON.stringify({ width, alignment }));
    await page.locator('#bit-ip-save').click(); await page.locator('#bit-proxy-editor').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#bit-execution-proxy').inputValue(), items[0].id);
    // Long, multi-page data stays in the list; no extra production or network writes.
    items.push(...Array.from({ length: 11 }, (_, i) => ({ ...items[0], id: `fixture-${i}`, name: `合成长名称代理 ${i + 1} · 办公室备用网络资料` })));
    await page.locator('#bit-tab-library').click(); await page.locator('#bit-refresh-proxies').click();
    await page.waitForFunction(() => document.querySelector('#bit-ip-count').textContent === '12');
    await page.locator('#bit-ip-next').click(); await page.locator('#bit-ip-next').click();
    assert.match(await page.locator('#bit-ip-page-info').innerText(), /3 \/ 3/);
    assert.equal(await page.locator('#bit-ip-next').isDisabled(), true);
    await page.locator('#bit-ip-search').fill('没有匹配的合成资料');
    assert.equal(await page.locator('#bit-ip-empty').isVisible(), true);
    await page.locator('#bit-ip-search').fill('新电脑');
    await page.locator('#bit-ip-rows').getByRole('button', { name: '测试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bit-library-result').textContent.includes('8.8.8.8'));
    await page.locator('#bit-ip-rows').getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('#bit-ip-link').inputValue(), '');
    assert.equal(await page.locator('#bit-ip-country').inputValue(), '菲律宾');
    await page.locator('#bit-ip-name').fill('新电脑住宅 IP 已修改');
    await page.screenshot({ path: fileURLToPath(new URL(`drawer-${theme}-${width}.png`, output)), fullPage: true });
    await page.locator('#bit-ip-save').click(); await page.locator('#bit-proxy-editor').waitFor({ state: 'hidden' });
    await page.locator('#bit-tab-library').click(); await page.locator('#bit-ip-search').fill('');
    await page.screenshot({ path: fileURLToPath(new URL(`library-${theme}-${width}.png`, output)), fullPage: true });
    const actionGeometry = await page.locator('#bit-ip-rows tr:first-child td:last-child button').evaluateAll(buttons => buttons.map(button => { const a=button.getBoundingClientRect(), b=button.closest('.table-viewport').getBoundingClientRect(); return a.left>=b.left && a.right<=b.right+1; }));
    assert(actionGeometry.every(Boolean), `${width} operation clipped`);
    await page.locator('#bit-tab-login').click();
    assert.match(await page.locator('#bit-execution-proxy option:checked').innerText(), /菲律宾.*动态住宅/);
    const authorization = JSON.stringify({ sessionToken: 'synthetic-session', user: { id: 'user-fixture', email: 'fixture@example.test' }, account: { id: 'account-fixture' } });
    await page.locator('#bit-authorization-json').fill(authorization);
    assert.equal(await page.locator('#bit-start-login').isEnabled(), true);
    await page.locator('#bit-clear-authorization').click();
    assert.equal(await page.locator('#bit-window-name').inputValue(), '');
    assert.equal(await page.locator('#bit-authorization-json').inputValue(), '');
    assert.equal(await page.locator('#bit-authorization-result').innerText(), '');
    assert.equal(await page.locator('#bit-start-login').isDisabled(), true);
    assert.equal(await page.locator('#bit-execution-proxy').inputValue(), items[0].id);
    assert.equal(await page.locator('#bit-connection-profile').inputValue(), profile.id);
    if (width === 1440 && theme === 'light') {
      await page.evaluate(() => {
        const original = File.prototype.text;
        File.prototype.text = function () { return new Promise(resolve => { window.finishAuthorizationFile = value => { File.prototype.text = original; resolve(value); }; }); };
      });
      await page.locator('#bit-authorization-file').setInputFiles({ name: 'synthetic-authorization.json', mimeType: 'application/json', buffer: Buffer.from(authorization) });
      await page.getByText('正在读取授权文件…', { exact: true }).waitFor();
      await page.locator('#bit-clear-authorization').click();
      await page.evaluate(value => window.finishAuthorizationFile(value), authorization);
      assert.equal(await page.locator('#bit-authorization-result').innerText(), '');
      assert.equal(await page.locator('#bit-start-login').isDisabled(), true);
    }
    await page.locator('#bit-authorization-json').fill(authorization);
    await page.locator('#bit-window-name').fill('手工填写的窗口');
    await page.locator('#bit-clear-authorization').click();
    assert.equal(await page.locator('#bit-window-name').inputValue(), '手工填写的窗口');
    const nextAuthorization = JSON.stringify({ ...JSON.parse(authorization), user: { id: 'user-fixture-next', email: 'next-fixture@example.test' } });
    await page.locator('#bit-authorization-json').fill(nextAuthorization);
    await page.screenshot({ path: fileURLToPath(new URL(`authorization-${theme}-${width}.png`, output)), fullPage: true });
    await page.locator('#bit-start-login').click();
    await page.getByText('登录成功 · next-fixture@example.test。比特浏览器窗口已保留。', { exact: true }).waitFor();
    assert.deepEqual(selectedBody, { id: items[0].id, version: 2 });
    assert.deepEqual(await page.evaluate(() => window.fixtureLaunch), { country: 'PH', protocol: 'socks5', host: '192.0.2.8', port: 8080, email: 'next-fixture@example.test' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${width}.png`, output)), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); await context.close();
  }
});
