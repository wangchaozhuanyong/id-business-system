import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('server direct diagnostic compares the live exit, plan and full proxy pool without submitting a checkout', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const path = '/integrations/codexdaichong/api/admin/recharge-routing';

  for (const [width, dark] of [[1440, false], [390, true]]) await t.test(`${width}px ${dark ? 'dark' : 'light'}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    t.after(() => page.close());
    const { external, unavailable, handle } = await interceptDesign(page.context(), { localFixtures: {} });
    const errors = [], writes = [];
    let countryCode = 'JP', proxyLabels = [], failedProbe = false, failedRead = false;
    let deferred;
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    await page.route('**/integrations/codexdaichong/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname === path + '/check-local') {
        writes.push({ pathname, body: request.postData() });
        const pending = deferred;
        if (pending) {
          pending.started.resolve();
          await pending.release.promise;
        }
        return route.fulfill(failedProbe ? { status: 503, json: { success: false, message: 'fixture failure' } } : {
          json: { success: true, ok: true, countryCode, ip: '8.8.8.8', checkedAt: '2026-11-13T08:16:38Z' }
        }).catch(error => { if (!pending) throw error; });
      }
      if (request.method() !== 'GET') {
        writes.push({ pathname, body: request.postData() });
        return route.abort();
      }
      if (pathname !== path) return handle(route);
      if (failedRead) return route.fulfill({ status: 503, json: { success: false } });
      return route.fulfill({ json: {
        success: true, version: 1, audit: [], auditCount: 0, checks: [], proxyLabels,
        regions: { PH: { label: '菲律宾', currency: 'PHP' }, EG: { label: '埃及', currency: 'EGP' } },
        plans: { plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' },
        proxyCountries: [{ code: 'JP', name: '日本' }, { code: 'PH', name: '菲律宾' }, { code: 'EG', name: '埃及' }]
      } });
    });

    await page.goto(origin + '/#/online-recharge/chatgpt');
    const select = view => page.locator(`button[data-view="${view}"]`).click();
    await select('checkout_debug');
    const frame = page.frameLocator('.recharge-integration__content iframe:not([hidden])');
    const panel = frame.locator('#checkout-server-diagnostic');
    const button = panel.getByRole('button', { name: '检测服务器直连', exact: true });
    const result = panel.getByRole('status');
    const expectResult = message => result.filter({ hasText: message }).waitFor();
    const start = () => panel.locator('#checkout-server-check').click();
    const bounds = () => panel.evaluate(node => {
      const box = node.getBoundingClientRect();
      const toolbar = node.querySelector('.checkout-server-toolbar').getBoundingClientRect();
      return { left: box.left, width: box.width, top: box.top, toolbarHeight: toolbar.height };
    });
    await panel.getByText('菲律宾（PH）／PHP', { exact: true }).waitFor();
    await expectResult('尚未检测服务器出口');
    assert.deepEqual(writes, [], '进入页面不能自动探测');
    if (dark) await toggleDesignTheme(page);
    await settle(page);
    const help = panel.locator('.title-help summary');
    const before = await bounds();
    assert.equal(await panel.locator('.title-help').getAttribute('open'), null);
    await help.click();
    assert.notEqual(await panel.locator('.title-help').getAttribute('open'), null);
    assert.deepEqual(await bounds(), before, '说明浮层不应挤动内容');
    await help.press('Escape');
    assert.equal(await panel.locator('.title-help').getAttribute('open'), null);

    deferred = { started: Promise.withResolvers(), release: Promise.withResolvers() };
    try {
      await start();
      await deferred.started.promise;
      await expectResult('正在检测服务器出口');
      assert(await panel.locator('#checkout-server-check').isDisabled());
      assert.equal(await panel.getAttribute('aria-busy'), 'true');
    } finally { deferred.release.resolve(); deferred = undefined; }
    await expectResult('出口国家不符，套餐要求菲律宾（PH）');
    assert.match(await panel.locator('#checkout-server-exit').textContent(), /日本（JP）/);
    assert.equal(await panel.locator('#checkout-server-pool').textContent(), '0 条');
    assert.equal(await frame.locator('#checkout_session_input').inputValue(), '');
    assert.equal(await writes.length, 1);
    if (output) await page.screenshot({ path: join(output, `direct-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
    assert(await panel.evaluate(node => node.ownerDocument.documentElement.scrollWidth <= innerWidth));

    countryCode = 'PH';
    await button.click();
    await expectResult('本次检测符合直连条件');
    await frame.locator('#checkout_plan_type').selectOption('pro100');
    await expectResult('出口国家不符，套餐要求埃及（EG）');
    await frame.locator('#checkout_plan_type').selectOption('plus');
    proxyLabels = [{ proxyId: 8, countryCode: null }];
    await start();
    await expectResult('代理池非空，当前规则不允许直连');
    assert.equal(await panel.locator('#checkout-server-pool').textContent(), '1 条');

    failedProbe = true;
    await start();
    await expectResult('上方保留上次成功结果');
    assert.match(await panel.locator('#checkout-server-exit').textContent(), /菲律宾（PH）/);
    failedProbe = false;
    failedRead = true;
    await start();
    await expectResult('暂时无法判断直连条件');
    failedRead = false;

    deferred = { started: Promise.withResolvers(), release: Promise.withResolvers() };
    try {
      await start();
      await deferred.started.promise;
      await select('dashboard');
      await frame.locator('#dashboard.active').waitFor();
    } finally { deferred.release.resolve(); deferred = undefined; }
    await select('checkout_debug');
    await expectResult('尚未检测服务器出口');
    assert(await button.isEnabled());
    assert.equal(writes.length, 6);
    assert(writes.every(({ pathname, body }) => pathname === path + '/check-local' && body === null),
      '诊断只发送无请求体的服务器检测，不提交 Session、任务或配置');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(unavailable, []);
  });
});
