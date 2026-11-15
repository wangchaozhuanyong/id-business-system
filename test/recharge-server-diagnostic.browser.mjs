import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { nativeBrowserVerification } from '../server/access-roles.mjs';

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
      if (nativeBrowserVerification(pathname.replace('/integrations/codexdaichong', ''), request.method()))
        return route.fulfill({ status: 403, json: { code: 'SECURITY_CONFIRMATION_REQUIRED' } });
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

test('支付链接调试直接读取当前任务日志并保留读取失败前的内容', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1560, height: 960 }, serviceWorkers: 'block' });
  const actor = { id: 'debug-fixture', name: '离线验收管理员', role: 'super' };
  const traffic = await interceptDesign(page.context(), { actor, localFixtures: {}, localAuthUi: true });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  let readFailure = false, securityRequests = 0, starts = 0, statusReads = 0;
  let taskStatus = 'running', jobKey, hold;
  const entries = [];
  const append = (jobKey, text) => entries.push({ id: entries.length + 1, ts: Date.now(), jobKey, source: 'task', text });
  append('other-job', '其他任务的日志');
  const api = '**/integrations/codexdaichong/api/admin/';
  await page.route('**/api/local/auth/security**', route => {
    securityRequests++;
    return route.fulfill({ json: { available: true, bound: true, passwordConfirmed: false } });
  });
  await page.route(api + 'checkout/generate', route => {
    assert.equal(route.request().method(), 'POST');
    jobKey = 'debug-job-' + ++starts;
    taskStatus = 'running';
    append(jobKey, '调试任务已创建 ' + jobKey);
    return route.fulfill({ json: { success: true, jobKey } });
  });
  await page.route(api + 'checkout/status/*', route => {
    statusReads++;
    return route.fulfill({ json: { success: true, jobKey, status: taskStatus, screenshots: [] } });
  });
  await page.route(api + 'runtime-logs?*', async route => {
    assert.equal(route.request().method(), 'GET');
    if (nativeBrowserVerification('/api/admin/runtime-logs', route.request().method()))
      return route.fulfill({ status: 403, json: { code: 'SECURITY_CONFIRMATION_REQUIRED' } });
    if (readFailure) return route.fulfill({ status: 503, json: { success: false } });
    const params = new URL(route.request().url()).searchParams;
    const after = Number(params.get('after')), limit = Number(params.get('limit'));
    const rows = params.has('tail') ? entries.slice(-limit) : entries.filter(entry => entry.id > after).slice(0, limit);
    const gate = hold;
    if (gate && !params.has('tail')) {
      hold = undefined;
      gate.started.resolve();
      await gate.release.promise;
      try {
        await route.fulfill({ json: { success: true, entries: [...rows,
          { id: 500, ts: Date.now(), jobKey, source: 'task', text: '离页后到达的旧响应' }], nextAfter: 500 } });
      } catch { /* The hidden iframe cancels the read. */ }
      gate.done.resolve();
      return;
    }
    return route.fulfill({ json: { success: true, entries: rows, nextAfter: rows.at(-1)?.id ?? after } });
  });

  await page.goto(origin + '/#/online-recharge/chatgpt');
  const select = view => page.locator(`button[data-view="${view}"]`).click();
  await select('checkout_debug');
  const frame = page.frameLocator('.recharge-integration__content iframe:not([hidden])');
  const checkout = frame.locator('#checkout_debug.active');
  const startButton = checkout.locator('#checkout_generate_btn');
  const refresh = checkout.getByRole('button', { name: '刷新', exact: true });
  const log = checkout.locator('#checkout_debug_log_pre');
  const notice = checkout.locator('#checkout_debug_log_pre_status');
  const runningStatus = checkout.locator('#checkout_result_status');
  const start = async () => {
    await checkout.locator('#checkout_session_input').fill('{"user":{"email":"fixture@example.test"}}');
    await startButton.click();
  };

  await start();
  await log.getByText('调试任务已创建 debug-job-1').waitFor();
  assert.equal(starts, 1);
  assert.match(await runningStatus.textContent(), /调试进行中/);
  const statusBeforeRefresh = statusReads;
  await page.waitForResponse(response => response.url().includes('/checkout/status/') && response.ok());
  assert(statusReads > statusBeforeRefresh);

  await refresh.click();
  await log.getByText('调试任务已创建 debug-job-1').waitFor();
  await notice.waitFor({ state: 'hidden' });
  append(jobKey, '浏览器已开始调试');
  await log.getByText('浏览器已开始调试').waitFor();
  assert.doesNotMatch(await log.textContent(), /其他任务的日志/);
  assert.equal((await log.textContent()).match(/调试任务已创建/g)?.length, 1);

  const saved = await log.textContent();
  readFailure = true;
  await refresh.click();
  await notice.getByText('暂时无法读取运行日志，可点击「刷新」重试。', { exact: true }).waitFor();
  assert.equal(await log.textContent(), saved);
  readFailure = false;
  append(jobKey, '读取恢复后继续更新');
  await log.getByText('读取恢复后继续更新').waitFor();
  assert.equal(starts, 1, '日志读取失败不会重复提交任务');

  const delayed = hold = { started: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
  const retained = page.locator('iframe[data-view="checkout_debug"]:visible');
  try {
    await delayed.started.promise;
    await select('query');
    await frame.locator('#querySection').waitFor();
    await retained.waitFor({ state: 'hidden' });
  } finally { delayed.release.resolve(); }
  await delayed.done.promise;
  append(jobKey, '切页期间实际记录');
  await select('checkout_debug');
  await log.getByText('切页期间实际记录').waitFor();
  assert.doesNotMatch(await log.textContent(), /离页后到达的旧响应/);

  taskStatus = 'success';
  await checkout.locator('#checkout_generate_btn:enabled').waitFor();
  await start();
  await log.getByText('调试任务已创建 debug-job-2').waitFor();
  assert.doesNotMatch(await log.textContent(), /debug-job-1|其他任务的日志/);
  assert.equal(starts, 2);
  await checkout.getByRole('button', { name: '打开完整运行日志', exact: true }).click();
  const full = frame.locator('#runtime_logs.active');
  await full.locator('#runtime_log_pre').getByText('其他任务的日志').waitFor();
  assert.equal(starts, 2);
  assert.equal(securityRequests, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
  assert.deepEqual(traffic.unavailable, []);
});
