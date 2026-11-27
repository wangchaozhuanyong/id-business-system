import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

const proxyId = '303cd6c7-3c65-4f8a-a8e2-cc7bee884fae';
const email = 'manual-recharge@example.test';
const json = JSON.stringify({ user: { email }, sessionToken: 'synthetic-session' });
const frameSelector = 'iframe[data-view="manual-recharge"]:not([hidden])';
const endpoint = '/api/local/native-workbench-prototype/';

test('手动充值默认使用站内操作窗，按指定 IP 提交并保留续费管理', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390]) await t.test(width + 'px', async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
    t.after(() => context.close());
    const actor = { id: 'manual-operator', name: '离线操作员', role: 'admin' };
    const traffic = await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
    const requests = [], messages = [], errors = [];
    let connections = 0;
    let fail = true;
    await context.route(origin + endpoint + '*', async route => {
      const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1);
      if (action === 'ip-options') return route.fulfill({ json: {
        version: 7, choices: [{ id: proxyId, name: '已保存线路', endpoint: '192.0.2.15:8080', countryCode: 'PH' }]
      } });
      requests.push({ action, body: request.postDataJSON() });
      if (action === 'close') return route.fulfill({ json: { ok: true, closed: true } });
      assert.equal(action, 'launch');
      if (fail) {
        fail = false;
        return route.fulfill({ status: 422, json: { error: '合成出口验证失败' } });
      }
      return route.fulfill({ json: {
        profileKey: 'fixture-operator-profile', account: { email },
        proxy: { exitInfo: { verified: true, country: 'PH', ip: '192.0.2.20' } },
        loginVerification: { status: 'matched', actualEmail: email, message: '合成登录核验通过' }
      } });
    });
    await context.routeWebSocket('**/integrations/native-workbench/ws?*', socket => {
      assert.equal(new URL(socket.url()).searchParams.get('profileKey'), 'fixture-operator-profile');
      connections++;
      socket.onMessage(value => messages.push(JSON.parse(value)));
    });

    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    const paths = [];
    page.on('request', request => paths.push(new URL(request.url()).pathname));
    await page.goto(origin + '/#/recharge/start');
    if (width < 500) await toggleDesignTheme(page);
    const manual = page.frameLocator(frameSelector);
    assert.equal(await page.getByRole('tab', { name: '单号登录' }).count(), 0);
    await page.getByRole('tab', { name: '账号续费管理' }).waitFor();
    const input = manual.getByLabel('ChatGPT 授权 JSON');
    const submit = manual.getByRole('button', { name: '提交并打开操作窗' });
    await input.fill('{bad-json');
    await manual.getByText(/JSON 格式无效/).waitFor();
    assert(await submit.isDisabled());
    await input.fill(json);
    assert.equal(await manual.locator('#protoParsedEmail').textContent(), email);
    assert(await submit.isDisabled(), '必须明确选择 IP 才能提交');
    await manual.getByLabel('执行 IP').selectOption(proxyId);
    await submit.click();
    await manual.getByText('合成出口验证失败').waitFor();
    assert.equal(await input.inputValue(), json);
    assert.equal(await manual.getByLabel('执行 IP').inputValue(), proxyId);
    assert.equal(connections, 0);
    await submit.click();
    const stage = manual.getByRole('region', { name: 'ChatGPT 手动充值操作窗' });
    await stage.getByText(/192\.0\.2\.20/).waitFor();
    assert.equal(await input.inputValue(), '');
    const stageReady = () => stage.getByRole('button', { name: '重新核验登录' });
    await stageReady().click();
    assert(messages.some(message => message.type === 'recheckLogin'));
    const canvas = stage.locator('canvas');
    if (width < 500) await canvas.tap();
    else await canvas.click();
    assert(messages.some(message => message.type === 'mouse' && message.eventType === 'mousePressed'));
    assert(messages.some(message => message.type === 'mouse' && message.eventType === 'mouseReleased'));
    const iframeFits = await page.locator(frameSelector).evaluate(frame => {
      const doc = frame.contentDocument;
      const layout = doc.querySelector('main');
      return doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 1 &&
        layout.getBoundingClientRect().height <= frame.clientHeight + 1;
    });
    assert(iframeFits, '操作窗和控件在当前尺寸完整可见');

    await page.evaluate(() => window.IDDesignAPI.go('overview'));
    await page.evaluate(() => window.IDDesignAPI.go('recharge/start'));
    await stageReady().waitFor();
    await stage.getByRole('button', { name: '关闭浏览器' }).click();
    await stage.waitFor({ state: 'hidden' });
    await manual.getByText('操作窗已关闭。').waitFor();
    assert.deepEqual(requests, [
      { action: 'launch', body: { proxyId, proxyVersion: 7, sessionJson: json } },
      { action: 'launch', body: { proxyId, proxyVersion: 7, sessionJson: json } },
      { action: 'close', body: { profileKey: 'fixture-operator-profile' } }
    ]);
    assert.equal(connections, 2, '返回工作台重连现有操作窗');
    assert(!paths.some(path => /bitbrowser\/(local-login|login)|(?:checkout\/generate|recharge\/(?:redeem|submit))/.test(path)));
    assert.deepEqual(traffic.external, []);
    assert.deepEqual(errors, []);
  });
});

test('公开站保留暂停状态，工作台显示邮箱且不提交会话', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const actor = { id: 'manual-operator', name: '离线操作员', role: 'admin' };
  await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
  const html = await readFile(new URL('../frontend/native-workbench-prototype.html', import.meta.url), 'utf8');
  await context.route('**/integrations/native-workbench/prototype?embedded=1', route => route.fulfill({
    contentType: 'text/html',
    body: html.replace('<body class="proto-body">', '<body class="proto-body" data-workbench-paused data-workbench-embedded>')
  }));
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith(endpoint)) requests.push(request.method());
  });
  await page.goto(origin + '/#/recharge/start');
  const manual = page.frameLocator(frameSelector);
  await manual.getByText('当前站点的内置浏览器仍暂停开放。').waitFor();
  await manual.getByLabel('ChatGPT 授权 JSON').fill(json);
  assert.equal(await manual.locator('#protoParsedEmail').textContent(), email);
  assert(await manual.getByRole('button', { name: '提交并打开操作窗' }).isDisabled());
  assert.deepEqual(requests, []);
});

test('正式工作区仅提交识别出的邮箱和所选 IP，打开站内账号工作区', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const actor = { id: 'manual-operator', name: '离线操作员', role: 'admin' };
  const traffic = await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
  const html = await readFile(new URL('../frontend/native-workbench-prototype.html', import.meta.url), 'utf8');
  const viewer = '/manual-workspaces/recharge-' + 'a'.repeat(64) + '/';
  const requests = [];
  await context.route('**/integrations/native-workbench/prototype?embedded=1', route => route.fulfill({
    contentType: 'text/html',
    body: html.replace('<body class="proto-body">', '<body class="proto-body" data-workbench-isolated data-workbench-embedded>')
  }));
  await context.route(origin + viewer, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>账号工作区</h1>' }));
  await context.route(origin + endpoint + '*', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: {
      version: 7, choices: [{ id: proxyId, name: '已保存线路', endpoint: '192.0.2.15:8080', countryCode: 'PH' }]
    } });
    requests.push(request.postDataJSON());
    return route.fulfill({ json: { viewerUrl: viewer, exitIp: '192.0.2.20', country: 'PH', accountStatus: 'check-in-browser' } });
  });
  const page = await context.newPage();
  const localStreams = [];
  const navigationErrors = [];
  page.on('pageerror', error => navigationErrors.push(error.message));
  page.on('websocket', socket => { if (socket.url().includes('/integrations/native-workbench/ws')) localStreams.push(socket.url()); });
  await page.goto(origin + '/#/recharge/start');
  const manual = page.frameLocator(frameSelector);
  await manual.getByLabel('ChatGPT 授权 JSON').fill(json);
  assert.equal(await manual.locator('#protoParsedEmail').textContent(), email);
  await manual.getByLabel('执行 IP').selectOption(proxyId);
  await manual.getByRole('button', { name: '提交并打开操作窗' }).click();
  await page.getByRole('heading', { name: '账号工作区' }).waitFor({ timeout: 5000 });
  assert.equal(new URL(page.url()).pathname, viewer);
  assert.deepEqual(requests, [{ email, proxyId, proxyVersion: 7 }]);
  assert.deepEqual(localStreams, []);
  assert.deepEqual(navigationErrors, []);
  assert.deepEqual(traffic.external, []);
});
