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

test(
  '受管手动工作台使用已测速线路，隔离两个账号和过期响应，支持窗口记录与原地址管理',
  { timeout: 60000 },
  async t => {
    const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const width of [1440, 320])
      await t.test(width + 'px', async t => {
        const ctx = await browser.newContext({
          viewport: { width, height: 860 },
          locale: 'zh-CN',
          timezoneId: 'America/Los_Angeles'
        });
        t.after(() => ctx.close());
        const traffic = await interceptDesign(ctx, {
          actor: { id: 'qa-admin', role: 'admin', name: '流程测试' },
          localFixtures: {},
          manualRechargeWorkspace: true,
          skipRechargeAssets: true
        });
        const id = 'recharge-' + 'a'.repeat(64),
          runId = '11111111-1111-4111-8111-111111111111';
        const viewerUrl = '/manual-workspaces/' + id + '/?run=' + runId;
        let entries = [
          {
            id,
            email: 'older@example.test',
            plan: 'plus',
            notes: '旧资料',
            revision: runId,
            lastOpenedAt: '2026-11-24T07:00:00Z'
          }
        ];
        const writes = [],
          errors = [];
        let probeCount = 0,
          delayed,
          activeSlot = null,
          conflicting = false;
        await ctx.route('**/api/local/manual-recharge/**', async route => {
          const req = route.request(),
            url = new URL(req.url()),
            part = url.pathname.split('/').at(-1);
          if (req.method() === 'GET') {
            if (part === 'routes')
              return route.fulfill({
                json: {
                  plans: { plus: 'PH', pro100: 'EG' },
                  countries: { PH: '菲律宾', EG: '埃及' },
                  choices:
                    url.searchParams.get('plan') === 'plus'
                      ? [{ id: '7', name: 'PH 主线', protocol: 'https', countryCode: 'PH', referenceIp: '192.0.2.7' }]
                      : []
                }
              });
            if (part === 'occupancy') return route.fulfill({ json: { active: activeSlot } });
            assert.equal(part, 'windows');
            const search = url.searchParams.get('search');
            const items = entries.filter(x => (x.email + x.notes).includes(search));
            return route.fulfill({ json: { page: 1, pageSize: 20, items, total: items.length } });
          }
          const data = req.postDataJSON();
          writes.push({ part, data, method: req.method() });
          if (part === 'probe') {
            if (++probeCount === 1)
              await new Promise(resolve => {
                delayed = resolve;
              });
            return route.fulfill({
              json: {
                ticket: 'test-ticket-' + probeCount,
                ip: '192.0.2.18',
                latencyMs: 83,
                name: '合成线路',
                protocol: 'socks5',
                countryCode: data.plan === 'plus' ? 'PH' : 'EG'
              }
            });
          }
          if (part === 'launch') {
            if (conflicting) return route.fulfill({ status: 409, json: { error: '出口已变化，请重测' } });
            return route.fulfill({ json: { viewerUrl } });
          }
          if (part === 'release') {
            activeSlot = null;
            return route.fulfill({ json: { ok: true } });
          }
          assert.equal(part, 'window');
          if (req.method() === 'PATCH') entries[0] = { ...entries[0], notes: data.notes };
          else entries = [];
          return route.fulfill({ json: { ok: true } });
        });
        await ctx.route('**/manual-workspaces/**', route =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>隔离窗口</h1>' })
        );
        await ctx.route('**/api/local/bitbrowser-addresses*', route =>
          route.fulfill({
            json: { version: 1, page: 1, pageSize: 20, total: 0, items: [], totals: { used: 0, unused: 0 } }
          })
        );
        const p = await ctx.newPage();
        p.setDefaultTimeout(4500);
        p.on('pageerror', error => errors.push(error.message));
        await p.goto(origin + '/#/recharge/start');
        if (width === 320) await toggleDesignTheme(p);
        const el = id => p.locator('#' + id);
        await el('mr-plan').selectOption('plus');
        await p.getByText('最近打开 · 2026-11-24 15:00').waitFor();
        await el('mr-json').fill('{bad');
        await el('mr-auth-message').getByText('JSON 格式无效，请粘贴完整内容。').waitFor();
        await p.evaluate(() =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              readText: () => new Promise(resolve => (window.completeTestPaste = resolve)),
              writeText: async value => {
                window.copiedTestEmail = value;
              }
            }
          })
        );
        await el('mr-paste').click();
        await el('mr-clear').click();
        await p.evaluate(value => window.completeTestPaste(value), json);
        assert.equal(await el('mr-json').inputValue(), '');
        await el('mr-paste').click();
        await p.evaluate(value => window.completeTestPaste(value), json);
        await el('mr-copy').click();
        assert.equal(await p.evaluate(() => window.copiedTestEmail), email);
        await el('mr-proxy').selectOption('7');
        assert.match(await el('mr-proxy').innerText(), /PH 主线 · HTTPS · 参考 192\.0\.2\.7/);
        const probe = el('mr-probe'),
          launch = el('mr-launch');
        assert.ok(await launch.isDisabled());
        await probe.click();
        await p.waitForFunction(() => document.querySelector('#mr-probe').textContent === '测速中…');
        await el('mr-clear').click();
        delayed();
        await p.waitForTimeout(50);
        assert.ok(await launch.isDisabled());
        assert.equal(await el('mr-email').innerText(), '—');
        await p.getByRole('button', { name: '打开浏览器 older@example.test' }).click();
        await p.waitForFunction(() => document.querySelector('#mr-probe').disabled === false);
        assert.equal(await el('mr-json').inputValue(), '');
        assert.equal(await el('mr-notes').inputValue(), '旧资料');
        await probe.click();
        await el('mr-result')
          .getByText(/SOCKS5 · 菲律宾 PH · 192\.0\.2\.18/)
          .waitFor();
        assert.ok(await launch.isEnabled());
        conflicting = true;
        await launch.click();
        await el('mr-result')
          .getByText(/出口已变化/)
          .waitFor();
        assert.ok(await launch.isDisabled());
        conflicting = false;
        const row = p.locator('.mr-records tbody tr').first();
        await row.getByRole('button', { name: /更多/ }).click();
        await p.getByRole('menuitem', { name: '修改备注' }).click();
        await p.locator('#mr-edit-form textarea').fill('备注已更新');
        await p.getByRole('button', { name: '保存备注' }).click();
        await row.getByText('备注已更新').waitFor();
        await el('bit-address-heading').click();
        await p.getByRole('button', { name: '生成地址' }).waitFor();
        await p.getByRole('button', { name: '生成地址' }).click();
        await p.locator('#bit-address-generate-count').waitFor();
        await p.getByRole('button', { name: '关闭抽屉' }).click();
        if (width === 320) await el('mr-search-toggle').click();
        await el('mr-address-search').fill('Oregon');
        const searched = p.waitForRequest(req => {
          const url = new URL(req.url());
          return url.pathname === '/api/local/bitbrowser-addresses' && url.searchParams.get('keyword') === 'Oregon';
        });
        await el('mr-address-search').press('Enter');
        await searched;
        if (width === 320) await el('mr-search-close').click();
        await el('mr-window-tab').click();
        await p.getByRole('button', { name: '历史登记' }).click();
        await el('bit-renewals-content').waitFor();
        assert.equal(await el('bit-renewal-entry').count(), 0);
        await p.getByRole('button', { name: '返回手动充值' }).click();
        await el('bit-address-heading').click();
        if (width === 320) await el('mr-search-toggle').click();
        assert.equal(await el('mr-address-search').inputValue(), 'Oregon');
        if (width === 320) await el('mr-search-close').click();
        await el('mr-window-tab').click();
        if (width === 320) {
          const gap = await p.evaluate(
            () =>
              document.querySelector('#mr-search-toggle').getBoundingClientRect().left -
              document.querySelector('#bit-address-heading').getBoundingClientRect().right
          );
          assert(gap >= 0, '搜索按钮挡住地址管理页签');
          await el('mr-search-toggle').click();
        }
        await el('mr-window-search').fill('不存在');
        await p.getByText('没有符合条件的窗口记录').waitFor();
        await el('mr-window-search').fill('');
        await row.getByText('备注已更新').waitFor();
        if (width === 320) await el('mr-search-close').click();
        await row.getByRole('button', { name: /更多/ }).click();
        await p.getByRole('menuitem', { name: '删除记录' }).click();
        await p.getByRole('dialog').getByRole('button', { name: '删除记录' }).click();
        await p.getByText('暂无浏览器窗口记录').waitFor();
        const [input, paste, clear, probeBounds, launchBounds] = await Promise.all(
          ['mr-json', 'mr-paste', 'mr-clear', 'mr-probe', 'mr-launch'].map(id => el(id).boundingBox())
        );
        assert.equal(paste.y - (input.y + input.height), 8);
        assert.equal(paste.x, input.x);
        assert.equal(clear.x + clear.width, input.x + input.width);
        assert.equal(clear.x - (paste.x + paste.width), 8);
        for (const [left, right] of [[paste, clear], [probeBounds, launchBounds]]) {
          assert.equal(left.y, right.y);
          assert(Math.abs(left.width - right.width) < 1);
          assert.equal(left.height, right.height);
          assert(left.height >= 44);
        }
        for (const [upper, lower] of [[paste, probeBounds], [clear, launchBounds]]) {
          assert.equal(upper.x, lower.x);
          assert.equal(upper.width, lower.width);
          assert.equal(upper.height, lower.height);
        }
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
        await el('mr-json').fill(json);
        await el('mr-notes').fill('本次');
        await el('mr-plan').selectOption('pro100');
        await probe.click();
        await el('mr-result').getByText(/83 ms/).waitFor();
        const beforeLaunches = writes.filter(x => x.part === 'launch').length;
        await launch.evaluate(node => {
          node.click();
          node.click();
        });
        await p.getByRole('heading', { name: '隔离窗口' }).waitFor();
        assert.equal(writes.filter(x => x.part === 'launch').length, beforeLaunches + 1);
        assert.match(p.url(), /manual-workspaces\/recharge-/);
        const accepted = writes.filter(x => x.part === 'launch').at(-1).data;
        assert.equal(accepted.email, email);
        assert.equal(accepted.notes, '本次');
        assert.equal(accepted.plan, 'pro100');
        assert.ok(!JSON.stringify(writes).includes('synthetic-session'));
        activeSlot = { id, email, runId, viewerUrl };
        await p.goBack();
        await el('mr-release').waitFor();
        assert.equal(await el('mr-json').inputValue(), '');
        await el('mr-release').click();
        await p.getByRole('dialog').getByRole('button', { name: '结束并释放' }).click();
        await el('mr-occupancy').waitFor({ state: 'hidden' });
        assert.deepEqual(writes.filter(x => x.part === 'release').at(-1).data, { id, runId });
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
        assert.deepEqual(traffic.unavailable, []);
      });
  }
);

test('线路服务掉线时仍可选套餐，恢复后按已选套餐读取最新国家和线路', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await interceptDesign(context, {
    actor: { id: 'qa-routing', role: 'admin', name: '线路复核' },
    localFixtures: {},
    manualRechargeWorkspace: true,
    skipRechargeAssets: true
  });
  const plans = { plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' };
  let online = false;
  await context.route('**/api/local/manual-recharge/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/occupancy')) return route.fulfill({ json: { active: null } });
    if (url.pathname.endsWith('/windows'))
      return route.fulfill({ json: { page: 1, pageSize: 20, total: 0, items: [] } });
    assert.ok(url.pathname.endsWith('/routes'));
    if (!online) return route.fulfill({ status: 503, json: { error: '线路暂不可用' } });
    assert.equal(url.searchParams.get('plan'), 'pro500');
    return route.fulfill({ json: { plans, countries: { EG: '埃及' }, choices: [
      { id: '8', countryCode: 'EG', name: '埃及测试线路' }
    ] } });
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/recharge/start');
  const accountPlan = page.getByLabel('续费套餐'), retry = page.getByRole('button', { name: '重新读取线路' });
  await retry.waitFor();
  await page.getByLabel('ChatGPT 授权 JSON').fill('{"user":{"email":"qa@example.test"}}');
  await accountPlan.selectOption('pro500');
  await retry.waitFor();
  assert.equal(await accountPlan.inputValue(), 'pro500');
  assert.equal(await page.locator('#mr-country').textContent(), '暂不可用');
  assert.ok(await page.getByRole('button', { name: '一键测速' }).isDisabled());
  online = true;
  await retry.click();
  await page.locator('#mr-country').getByText('埃及 EG').waitFor();
  assert.equal(await accountPlan.inputValue(), 'pro500');
  assert.ok(await page.getByRole('button', { name: '一键测速' }).isEnabled());
  await page.getByLabel('执行 IP').selectOption('8');
});

test('停留工作台时复核已占用名额，回收后可直接打开下一账号，空闲和后台停止周期读取', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await interceptDesign(context, {
    actor: { id: 'qa-slot', role: 'admin', name: '窗口复核' },
    localFixtures: {},
    manualRechargeWorkspace: true,
    skipRechargeAssets: true
  });
  const previous = 'recharge-' + 'a'.repeat(64),
    next = 'recharge-' + 'b'.repeat(64);
  const nextEmail = 'next@example.test';
  let slot = {
    id: previous,
    email: 'first@example.test',
    runId: '11111111-1111-4111-8111-111111111111',
    viewerUrl: '/manual-workspaces/' + previous + '/',
    recheckAfterMs: 60_000
  };
  let reads = 0,
    launches = 0;
  await context.route('**/api/local/manual-recharge/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'occupancy') {
      reads++;
      return route.fulfill({ json: { active: slot } });
    }
    if (action === 'windows') return route.fulfill({ json: { page: 1, pageSize: 20, total: 0, items: [] } });
    if (action === 'routes')
      return route.fulfill({ json: { plans: { plus: 'PH' }, countries: { PH: '菲律宾' }, choices: [] } });
    if (action === 'probe')
      return route.fulfill({
        json: { ticket: 'tested', countryCode: 'PH', ip: '192.0.2.17', latencyMs: 50 }
      });
    assert.equal(action, 'launch');
    assert.equal(route.request().postDataJSON().email, nextEmail);
    launches++;
    return route.fulfill({ json: { viewerUrl: '/manual-workspaces/' + next + '/' } });
  });
  await context.route('**/manual-workspaces/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>第二个账号的窗口</h1>' })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(origin + '/#/recharge/start');
  await page
    .locator('#mr-occupied-text')
    .getByText(/first@example.test/)
    .waitFor();
  await page.locator('#mr-plan').selectOption('plus');
  await page.locator('#mr-json').fill(JSON.stringify({ user: { email: nextEmail } }));
  await page.locator('#mr-probe').click();
  await page.locator('#mr-result').getByText(/50 ms/).waitFor();
  assert.ok(await page.locator('#mr-launch').isDisabled());
  const baseline = reads;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(40_000);
  assert.equal(reads, baseline, '后台停止周期读取');
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/occupancy')),
    page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    })
  ]);
  await page.locator('#mr-resume:enabled').waitFor();
  const afterVisible = reads;
  slot = null;
  await page.clock.fastForward(15_100);
  await page.locator('#mr-occupancy').waitFor({ state: 'hidden' });
  assert.equal(reads, afterVisible + 1, '已知占用最长15秒复核');
  assert.ok(await page.locator('#mr-launch').isEnabled());
  await page.clock.fastForward(45_000);
  assert.equal(reads, afterVisible + 1, '无占用不轮询');
  await page.locator('#mr-launch').click();
  await page.getByRole('heading', { name: '第二个账号的窗口' }).waitFor();
  assert.equal(launches, 1);
});

test('旧版占用只在 423 时按确认邮箱恢复，输错邮箱可重试，取消不会发起释放', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await interceptDesign(context, {
    actor: { id: 'qa-old', role: 'admin', name: '历史窗口' },
    localFixtures: {},
    manualRechargeWorkspace: true,
    skipRechargeAssets: true
  });
  const original = 'previous@example.test',
    attempted = [];
  let code = 503;
  await context.route('**/api/local/manual-recharge/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'occupancy')
      return code
        ? route.fulfill({ status: code, json: { error: code === 423 ? '旧工作区仍在运行' : '暂时无法读取' } })
        : route.fulfill({ json: { active: null } });
    if (action === 'routes')
      return route.fulfill({ json: { plans: { plus: 'PH' }, countries: { PH: '菲律宾' }, choices: [] } });
    if (action === 'windows')
      return route.fulfill({
        json: {
          page: 1,
          pageSize: 20,
          total: 1,
          items: [
            { id: 'old', email: original, plan: 'plus', notes: '', lastOpenedAt: '2026-11-01T07:00:00Z' }
          ]
        }
      });
    assert.equal(action, 'release-legacy');
    const data = route.request().postDataJSON();
    attempted.push(data);
    if (data.email !== original) return route.fulfill({ status: 409, json: { error: '请核对旧窗口邮箱' } });
    code = 0;
    return route.fulfill({ json: { ok: true } });
  });
  const p = await context.newPage();
  p.setDefaultTimeout(4000);
  await p.goto(origin + '/#/recharge/start');
  const release = p.locator('#mr-legacy-release'),
    hinted = p.locator('#mr-occupied-text');
  await hinted.getByText('暂时无法读取').waitFor();
  assert.ok(await release.isHidden());
  code = 423;
  await p.locator('#mr-reload-slot').click();
  await release.waitFor();
  assert.ok(await release.isDisabled());
  await p
    .locator('#mr-legacy-help')
    .getByText(/财务窗口/)
    .waitFor();
  const wrong = 'wrong@example.test';
  await p.locator('#mr-json').fill(JSON.stringify({ user: { email: wrong } }));
  await release.click();
  await p.getByRole('dialog').getByText(new RegExp(wrong)).waitFor();
  await p.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(attempted, []);
  await release.click();
  await p.getByRole('dialog').getByRole('button', { name: '按旧账号结束' }).click();
  await hinted.getByText('请核对旧窗口邮箱').waitFor();
  assert.deepEqual(attempted, [{ email: wrong }]);
  await p.getByRole('button', { name: '打开浏览器 ' + original }).click();
  await release.click();
  await p.getByRole('dialog').getByText(new RegExp(original)).waitFor();
  await p.getByRole('dialog').getByRole('button', { name: '按旧账号结束' }).click();
  await p.locator('#mr-occupancy').waitFor({ state: 'hidden' });
  assert.ok(await release.isHidden());
  assert.deepEqual(attempted, [{ email: wrong }, { email: original }]);
});
