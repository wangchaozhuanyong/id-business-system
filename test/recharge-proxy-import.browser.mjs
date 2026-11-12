import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('代理国家和类型必选，批量保存、补录类型及慢响应保留后续输入', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const output = root + '/.runtime/proxy-types/browser';
  await mkdir(output, { recursive: true });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { external } = await interceptDesign(context);
    let fail = true, editFail = true, typeConflict = true, release, pending;
    const writes = [], edits = [], typeEdits = [];
    const proxy = id => ({
      id, is_active: true, protocol: 'socks5', proxy_url_masked: 'socks5://proxy-' + id + '.example.test:1080'
    });
    const rows = [proxy(1), proxy(2)];
    const labels = new Map([[1, null], [2, 'PH']]);
    const types = new Map([[2, 'dynamic_residential']]);
    const checks = [{ proxyId: 2, status: 'verified', countryCode: 'MX', ip: '203.0.113.42',
      checkedAt: '2026-11-11T02:00:00.000Z', latencyMs: 32 }];
    const api = origin + '/integrations/codexdaichong/api/admin/';
    await context.route(api + 'recharge-routing', route => route.fulfill({ json: {
      success: true, version: 1, audit: [], auditCount: 0, checks,
      regions: { PH: { label: '菲律宾', currency: 'PHP' }, EG: { label: '埃及', currency: 'EGP' } },
      plans: { plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' },
      proxyCountries: [{ code: 'PH', name: '菲律宾' }, { code: 'EG', name: '埃及' }, { code: 'MX', name: '墨西哥' }],
      proxyLabels: Array.from(labels, ([proxyId, countryCode]) => ({ proxyId, countryCode })),
      proxyTypes: Array.from(types, ([proxyId, proxyType]) => ({ proxyId, proxyType }))
    } }));
    await context.route(api + 'recharge-routing/proxies/*/country', route => {
      const id = Number(new URL(route.request().url()).pathname.split('/').at(-2));
      const body = route.request().postDataJSON();
      edits.push(body);
      if (editFail) return route.fulfill({ status: 503, json: { success: false, message: '合成标注失败' } });
      labels.set(id, body.countryCode);
      return route.fulfill({ json: { success: true, proxyId: id, countryCode: body.countryCode } });
    });
    await context.route(api + 'recharge-routing/proxies/1/type', route => {
      const body = route.request().postDataJSON();
      typeEdits.push(body);
      if (typeConflict) {
        typeConflict = false;
        types.set(1, 'static_residential');
        return route.fulfill({ status: 409, json: { success: false, message: '合成类型冲突' } });
      }
      types.set(1, body.proxyType);
      return route.fulfill({ json: { success: true, proxyId: 1, proxyType: body.proxyType } });
    });
    await context.route(api + 'recharge-routing/proxies/1/check', route => {
      const result = { proxyId: 1, status: 'verified', countryCode: 'MX', ip: '203.0.113.17',
        checkedAt: '2026-11-11T02:05:00.000Z' };
      checks.push(result);
      return route.fulfill({ json: { success: true, ok: true, latencyMs: 30, ...result } });
    });
    await context.route(api + 'proxies', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { success: true, proxies: rows } });
      const body = route.request().postDataJSON();
      writes.push(body);
      if (pending) await pending;
      if (fail) return route.fulfill({ status: 503, json: { success: false, message: '合成失败' } });
      for (const _ of body.proxies) {
        const id = rows.length + 1;
        rows.push(proxy(id));
        labels.set(id, body.countryCode);
        types.set(id, body.proxyType);
      }
      return route.fulfill({ json: { success: true, added: body.proxies.length, proxyType: body.proxyType, message: '已保存代理' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/online-recharge/chatgpt');
    const frame = page.frameLocator('#main iframe:not([hidden])');
    await frame.locator('#querySection').waitFor();
    if (theme === 'dark') await toggleDesignTheme(page);
    await page.locator('button[data-view="proxies"]').click();
    const input = frame.locator('#proxy_add_input');
    await input.waitFor();
    const country = frame.getByRole('combobox', { name: '代理国家', exact: true });
    const type = frame.getByRole('combobox', { name: '代理类型', exact: true });
    await country.locator('option[value="MX"]').waitFor({ state: 'attached' });
    assert.deepEqual(await country.locator('option').allTextContents(), ['请选择代理国家', '菲律宾（PH）', '埃及（EG）', '墨西哥（MX）']);
    assert(await country.getAttribute('required') !== null);
    assert(await type.getAttribute('required') !== null);
    assert.deepEqual(await type.locator('option').allTextContents(), ['请选择代理类型', '动态住宅', '静态住宅', '独享静态住宅', '移动代理']);
    const countryBox = await country.boundingBox(), inputBox = await input.boundingBox();
    const labelBox = await frame.locator('label[for="proxy_add_country"]').boundingBox();
    assert(labelBox.x + labelBox.width <= countryBox.x && countryBox.y + countryBox.height <= inputBox.y);
    const typeBox = await type.boundingBox();
    assert(typeBox.y + typeBox.height <= inputBox.y);
    assert.equal(await frame.locator('#proxy_pool_scroll_hint').isVisible(), width <= 760);
    const legacy = frame.locator('#proxy_country_1');
    const legacyType = frame.locator('#proxy_type_1');
    const measured = frame.locator('#proxy_ip_2');
    await legacy.getByText('待标注', { exact: true }).waitFor();
    await frame.getByRole('columnheader', { name: '标注国家', exact: true }).waitFor();
    await frame.getByRole('columnheader', { name: '代理类型', exact: true }).waitFor();
    await legacyType.getByText('未设置', { exact: true }).waitFor();
    await frame.locator('#proxy_type_2').getByText('动态住宅', { exact: true }).waitFor();
    await frame.getByRole('columnheader', { name: '实测出口', exact: true }).waitFor();
    await frame.locator('#proxy_country_2').getByText('国家不一致', { exact: true }).waitFor();
    assert.deepEqual(await measured.locator(':scope > *').allTextContents(), ['203.0.113.42', '墨西哥（MX）']);
    assert.equal(await frame.locator('#proxy_check_2').innerText(), '活跃');
    assert.equal(await frame.locator('#proxy_lat_2').innerText(), '32ms');
    await settle(page);
    await page.screenshot({ path: `${output}/proxy-types-${width}-${theme}.png` });
    if (width <= 760) {
      const header = frame.getByRole('columnheader', { name: '代理类型', exact: true });
      const readable = await header.evaluate(cell => {
        const viewport = cell.closest('.table-container');
        viewport.scrollLeft += cell.getBoundingClientRect().left - viewport.getBoundingClientRect().left;
        const label = document.createRange();
        label.selectNodeContents(cell);
        const bounds = label.getBoundingClientRect();
        const actions = cell.parentElement.lastElementChild.getBoundingClientRect();
        return viewport.scrollLeft > 0 && bounds.left >= viewport.getBoundingClientRect().left && bounds.right <= actions.left;
      });
      assert(readable, `代理类型列在 ${width}px 可横向滑动并完整读到表头`);
    }
    const hint = frame.locator('#proxy_add_hint');
    const save = frame.getByRole('button', { name: '保存到代理池', exact: true });
    const raw = 'Socks5://gate.example.test:8082:example-res-country-ph-session-12345678:synthetic-pass';
    const canonical = 'socks5://example-res-country-ph-session-12345678:synthetic-pass@gate.example.test:8082';
    await input.fill(raw + '\n' + canonical);
    await input.dispatchEvent('paste');
    await hint.filter({ hasText: /已识别 1 条.*去重 1 条/ }).waitFor();
    assert.equal(await input.inputValue(), canonical);
    await save.click();
    await hint.filter({ hasText: '请选择代理国家' }).waitFor();
    assert.equal(writes.length, 0);
    await country.selectOption('PH');
    await save.click();
    await hint.filter({ hasText: '请选择代理类型' }).waitFor();
    assert.equal(writes.length, 0);
    await type.selectOption('dedicated_static_residential');
    await save.click();
    await hint.filter({ hasText: '输入已保留' }).waitFor();
    assert.equal(await input.inputValue(), canonical);
    assert.equal(await country.inputValue(), 'PH');
    assert.equal(await type.inputValue(), 'dedicated_static_residential');
    assert.deepEqual(writes[0], { proxies: [canonical], countryCode: 'PH', proxyType: 'dedicated_static_residential' });
    fail = false;
    await save.click();
    await frame.locator('#proxy_country_3').getByText('菲律宾（PH）', { exact: true }).waitFor();
    await frame.locator('#proxy_type_3').getByText('独享静态住宅', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(await country.inputValue(), '');
    assert.equal(await type.inputValue(), '');
    assert.equal(writes.length, 2);
    await legacy.getByRole('button', { name: '补标', exact: true }).click();
    const editor = legacy.getByRole('combobox', { name: '代理国家标注', exact: true });
    await editor.selectOption('EG');
    await legacy.getByRole('button', { name: '保存标注', exact: true }).click();
    await legacy.getByText('合成标注失败', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'EG');
    editFail = false;
    await legacy.getByRole('button', { name: '保存标注', exact: true }).click();
    await legacy.getByText('埃及（EG）', { exact: true }).waitFor();
    assert.deepEqual(edits.at(-1), { countryCode: 'EG', expectedCountryCode: null });
    await frame.locator('#proxy_row_1').getByRole('button', { name: '检测', exact: true }).click();
    await legacy.getByText('国家不一致', { exact: true }).waitFor();
    await frame.locator('#proxy_ip_1').getByText('墨西哥（MX）', { exact: true }).waitFor();
    assert.equal(await frame.locator('#proxy_check_1').innerText(), '活跃');
    assert.equal(labels.get(1), 'EG');
    await legacyType.getByRole('button', { name: '设置类型', exact: true }).click();
    const typeEditor = legacyType.getByRole('combobox', { name: '已保存代理类型' });
    await typeEditor.selectOption('mobile');
    await legacyType.getByRole('button', { name: '保存类型', exact: true }).click();
    await legacyType.getByText('合成类型冲突', { exact: true }).waitFor();
    assert.equal(await typeEditor.inputValue(), 'mobile');
    await legacyType.getByRole('button', { name: '取消', exact: true }).click();
    await legacyType.getByRole('button', { name: '修改类型', exact: true }).click();
    assert.equal(await typeEditor.inputValue(), 'mobile');
    await legacyType.getByRole('button', { name: '保存类型', exact: true }).click();
    await legacyType.getByText('移动代理', { exact: true }).waitFor();
    assert.deepEqual(typeEdits, [
      { proxyType: 'mobile', expectedProxyType: null },
      { proxyType: 'mobile', expectedProxyType: 'static_residential' }
    ]);

    const invalid = raw + '\nhttps://api.example.test/extract?id=synthetic';
    await country.selectOption('MX');
    await type.selectOption('static_residential');
    await input.fill(invalid);
    await save.click();
    assert.match(await hint.innerText(), /第 2 行.*整批未保存/);
    assert.equal(writes.length, 2);
    assert.equal(await input.inputValue(), invalid);
    await input.fill(raw.replace('8082', '8083') + '\n' + raw.replace('8082', '8084'));
    pending = new Promise(resolve => { release = resolve; });
    await save.click();
    await frame.locator('#proxy_add_input[data-saving="true"]').waitFor();
    await input.fill('gate.example.test:1080:next-user:next-synthetic-pass');
    await country.selectOption('EG');
    await type.selectOption('mobile');
    release();
    await frame.locator('#proxy_add_input[data-saving="true"]').waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'gate.example.test:1080:next-user:next-synthetic-pass');
    assert.equal(await country.inputValue(), 'EG');
    assert.equal(await type.inputValue(), 'mobile');
    assert.deepEqual([writes.at(-1).countryCode, writes.at(-1).proxyType, writes.at(-1).proxies.length], ['MX', 'static_residential', 2]);
    for (const id of [4, 5]) await frame.locator('#proxy_type_' + id).getByText('静态住宅', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await input.evaluate(node => node.ownerDocument.documentElement.scrollWidth <= node.ownerDocument.defaultView.innerWidth), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await context.close();
  }
});
