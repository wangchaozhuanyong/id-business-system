import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';
import { CODEXDAICHONG_PREFIX } from '../modules/recharge/codexdaichong/gateway.mjs';

const adminViews = [
  ['概览中心', '#dashboard', '#stat_total'],
  ['系统配置', '#config', '#gpt_api_base_url', '[onclick="saveAllConfigs()"]'],
  ['代理池', '#proxies', '#proxy_pool_body', '[onclick="testAllSavedProxies()"]'],
  ['免税地址', '#tax_addresses', '#address_empty_hint', '#btn_generate_us_addresses'],
  ['支付链接调试', '#checkout_debug', '#checkout_session_input', '#checkout_generate_btn'],
  ['银行卡池', '#cards', '#card_pool_list_body', '[onclick="toggleCardPoolImportBox()"]'],
  ['CDK 管理', '#cdks', '#cdk_body', '[onclick="generateCDKs(this)"]'],
  ['Session 管理', '#sessions', '#session_body'],
  ['续费管理', '#cancel_renewal', '#cancel_renewal_session', '#cancel_renewal_btn'],
  ['任务管理', '#logs', '#log_body'],
  ['运行日志', '#runtime_logs', '#runtime_log_pre', '#runtime_log_clear_btn']
];
const cdk = 'KC-DEMO-ONLY';

test('local demo workspace, retry, refresh failure and restart', { timeout: 45_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const hosts = new Set();
  const close = (host) =>
    new Promise((resolve) => {
      host.server.close(resolve);
      host.server.closeAllConnections();
      hosts.delete(host);
    });
  t.after(async () => {
    await browser.close();
    await Promise.all([...hosts].map(close));
  });

  let clock = Date.now();
  let refreshFailure = false;
  const start = async () => {
    const host = await startCodexdaichongDemoSite(0, {
      now: () => clock,
      failAdminRefresh: () => refreshFailure
    });
    hosts.add(host);
    return host;
  };
  const api = (host, path, body, method) => {
    const origin = new URL(host.url).origin;
    return fetch(
      origin + CODEXDAICHONG_PREFIX + '/api/' + path,
      body === undefined && !method
        ? undefined
        : {
            method: method ?? 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: body === undefined ? undefined : JSON.stringify(body)
          }
    );
  };
  const data = async (...args) => {
    const response = await api(...args);
    assert(response.ok, args[1] + ' returned ' + response.status);
    return response.json();
  };
  const host = await start();
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(6000);
  const origins = new Set([new URL(host.url).origin]);
  await page.route('**/*', (route) =>
    origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort()
  );
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const frame = page.frameLocator('.recharge-integration__content iframe:not([hidden])');
  await page.addInitScript(() => {
    if (window.parent !== window) return;
    window.rechargeLockEvents = [];
    window.addEventListener('message', (event) => {
      if (
        event.origin === location.origin &&
        event.data?.source === 'id-codexdaichong' &&
        event.data.type === 'navigation-lock'
      )
        window.rechargeLockEvents.push(event.data.locked);
    });
  });
  const nav = page.getByRole('navigation', { name: 'ChatGPT 充值功能' });
  const select = (name) => nav.getByRole('button', { name, exact: true }).click();
  const fill = () => frame.getByRole('button', { name: '填入演示资料' }).click();
  const verifyToolbarRow = async (toolbar, selector) => {
    const positions = await frame.locator(toolbar).evaluate(
      (node, selector) =>
        [...node.querySelectorAll(selector)].map((control) => {
          const { top, height } = control.getBoundingClientRect();
          return Math.round(top + height / 2);
        }),
      selector
    );
    assert(
      positions.length > 1 && Math.max(...positions) - Math.min(...positions) <= 2,
      toolbar + ' 的标题和操作应垂直对齐：' + positions.join(', ')
    );
  };
  const verifyAdminLayout = async (view, width) => {
    const active = frame.locator(view + '.active');
    await active.waitFor();
    await active.evaluate(
      async (node, { width, view }) => {
        const deadline = performance.now() + 2000;
        do {
          const header = node.querySelector(':scope > .page-header');
          const content = header.nextElementSibling.getBoundingClientRect();
          const notice = document.querySelector('.recharge-demo-note').getBoundingClientRect();
          if (
            getComputedStyle(header).display === 'none' &&
            content.x <= 24 &&
            content.y >= notice.bottom &&
            content.y - notice.bottom <= 24 &&
            document.documentElement.scrollWidth <= innerWidth + 1 &&
            document.documentElement.scrollHeight <= innerHeight + 1
          )
            return;
          await new Promise(requestAnimationFrame);
        } while (performance.now() < deadline);
        throw new Error(
          view +
            ' at ' +
            width +
            ': ' +
            [
              node.querySelector(':scope > .page-header').nextElementSibling.getBoundingClientRect()
                .x,
              document.documentElement.scrollWidth,
              innerWidth,
              document.documentElement.scrollHeight,
              innerHeight
            ].join(', ')
        );
      },
      { width, view }
    );
  };

  await page.goto(host.url + '#/recharge/start');
  const bitFrame = page.frameLocator('.recharge-integration__frame--bit-local');
  const addresses = page.locator('#bit-addresses-host');
  await addresses.getByRole('heading', { name: '地址管理', exact: true }).waitFor();
  assert.equal(await bitFrame.getByRole('button', { name: '地址管理', exact: true }).count(), 0);
  assert.equal(
    await page.locator('[data-recharge-module="bit"] .recharge-integration__toolbar').count(),
    0
  );
  const bitToolbar = bitFrame.locator('.bit-local__connection-toolbar');
  const bitToolbarFits = () =>
    bitToolbar.evaluate((node) => node.scrollWidth <= node.clientWidth);
  assert.equal(await bitToolbarFits(), true);
  await bitFrame.locator('#bit-window-name').fill('演示窗口名称');
  const countField = addresses.getByLabel('生成数量');
  const generate = addresses.getByRole('button', { name: '一键生成地址', exact: true });
  assert.equal(await countField.inputValue(), '10');
  await countField.fill('101');
  await generate.click();
  await page.getByText('每次可生成 1 至 100 条地址', { exact: true }).waitFor();
  await countField.fill('3');
  await generate.click();
  await page.getByText('已生成 3 条账单地址，付款前请核对资料。', { exact: true }).waitFor();
  assert.equal(await page.locator('#bit-address-list tbody tr').count(), 3);
  assert.equal(await page.getByRole('button', { name: '导入地址', exact: true }).count(), 1);
  assert.equal(await bitFrame.locator('#bit-window-name').inputValue(), '演示窗口名称');
  await page.setViewportSize({ width: 390, height: 820 });
  await page.getByRole('button', { name: '前往地址管理', exact: true }).click();
  assert.equal(await addresses.evaluate((node) => document.activeElement === node), true);
  assert.equal(await bitToolbarFits(), true);
  await page.setViewportSize({ width: 1280, height: 850 });

  await page.goto(host.url + '#/workspace/recharge');
  await frame.locator('#tokenInput:disabled').waitFor();
  assert.equal(await frame.locator('.workspace-recharge-heading h1').isVisible(), false);
  assert.equal(
    await frame.getByText('验码后自动匹配套餐，请核对账号再提交。', { exact: true }).count(),
    0
  );
  const pageHelp = page.locator('#page-title summary');
  const pageNote = page.locator('#page-description');
  await pageNote.waitFor({ state: 'hidden' });
  const formY = await frame.locator('#step1').evaluate((node) => node.getBoundingClientRect().top);
  await pageHelp.click();
  await pageNote.getByText('验码后自动匹配套餐，请核对账号再提交。', { exact: true }).waitFor();
  assert.equal(
    await frame.locator('#step1').evaluate((node) => node.getBoundingClientRect().top),
    formY
  );
  await pageHelp.press('Escape');
  await pageNote.waitFor({ state: 'hidden' });
  const desktopColumns = () =>
    frame
      .locator('#redeemSection')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  assert.equal(await desktopColumns(), 2);
  assert.equal(
    await frame
      .locator('.tab-nav [data-tab="query"]')
      .evaluate((node) => getComputedStyle(node).whiteSpace),
    'nowrap'
  );
  await page.setViewportSize({ width: 390, height: 820 });
  assert.equal(Math.round((await pageHelp.boundingBox()).height), 44);
  assert.equal(await desktopColumns(), 1);
  assert.equal(
    await frame.locator('body').evaluate((element) => element.scrollWidth <= innerWidth),
    true
  );
  await page.locator('#theme-toggle').click();
  await frame.locator('html[data-id-theme="dark"]').waitFor({ state: 'attached' });
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 1280, height: 850 });
  const guideTab = frame.getByRole('button', { name: '使用说明', exact: true });
  const guide = frame.locator('#workspaceGuide');
  const form = frame.locator('#redeemSection');
  const queryInput = frame.locator('#queryInput');
  const queryTab = frame.getByRole('button', { name: '兑换码查询', exact: true });
  await frame.getByRole('link', { name: '如何获取账号资料？' }).click();
  await guide.getByRole('heading', { name: '充值使用说明' }).waitFor();
  assert.equal(await guideTab.getAttribute('aria-pressed'), 'true');
  assert.equal(await form.isVisible(), false);
  assert.equal(await frame.locator('#flowStatusBadge').isVisible(), false);
  assert.equal(await guide.getByRole('list', { name: '充值四步' }).locator('li').count(), 4);
  assert.equal(await guide.locator('figure').count(), 2);
  const figures = guide.locator('figure');
  assert.equal((await figures.nth(0).boundingBox()).y, (await figures.nth(1).boundingBox()).y);
  assert.equal(await guide.locator('#workspace-session-url').inputValue(), 'https://chatgpt.com/api/auth/session');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(host.url).origin });
  await guide.getByRole('button', { name: '复制页面地址' }).click();
  await guide.getByText('已复制公开页面地址。', { exact: false }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'https://chatgpt.com/api/auth/session'
  );
  await page.setViewportSize({ width: 390, height: 820 });
  await page.locator('#theme-toggle').click();
  await frame.locator('html[data-id-theme="dark"]').waitFor({ state: 'attached' });
  assert((await figures.nth(1).boundingBox()).y > (await figures.nth(0).boundingBox()).y);
  assert(await guide.evaluate((node) => node.ownerDocument.body.scrollWidth <= innerWidth));
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 1280, height: 850 });
  await guide.getByRole('button', { name: '查询充值结果' }).click();
  assert((await queryInput.boundingBox()).height <= 46, '单个兑换码输入应为单行控件');
  await queryInput.fill('test-lookup-draft');
  await frame.getByRole('tab', { name: '批量查询' }).click();
  await frame.locator('#batchQueryInput').fill('test-batch-draft');
  await guideTab.click();
  await queryTab.click();
  assert.equal(await queryInput.inputValue(), 'test-lookup-draft');
  assert.equal(await frame.locator('#batchQueryInput').isVisible(), true);
  assert.equal(await frame.locator('#batchQueryInput').inputValue(), 'test-batch-draft');
  await frame.getByRole('button', { name: '自助充值', exact: true }).click();
  const samples = frame.getByRole('combobox', { name: '演示兑换码样例' });
  for (const [code, label] of [
    ['KC-DEMO-02', '演示 Pro 100'],
    ['KC-DEMO-03', '演示 Pro 200']
  ]) {
    await samples.selectOption(code);
    await fill();
    await frame.locator('#redeemBtn').click();
    await frame
      .locator('#workspaceVerifiedPlan')
      .getByText('已锁定套餐 · ' + label)
      .waitFor();
    await frame.locator('#workspacePlan').getByText(label, { exact: true }).waitFor();
    assert.equal((await data(host, 'cdk/query?cdk=' + code)).data.planLabel, label);
    await frame.locator('#backToStep1').click();
    await frame.locator('#workspaceVerifiedPlan').waitFor({ state: 'hidden' });
  }
  await samples.selectOption(cdk);
  await fill();
  assert.equal((await api(host, 'verify-cdk', { cdk: 'unknown' })).status, 400);
  await frame.locator('#redeemBtn').click();
  const authorization = frame.locator('#tokenInput');
  await frame.locator('#startBtn:enabled').waitFor();
  assert.equal(await authorization.getAttribute('readonly'), '');
  await frame.locator('#workspacePlan').getByText('演示 Plus', { exact: true }).waitFor();
  await frame
    .locator('#workspaceAccount')
    .getByText('demo@example.test', { exact: true })
    .waitFor();
  await guideTab.click();
  await guide.getByRole('button', { name: '开始充值' }).click();
  await frame.locator('#workspacePlan').getByText('演示 Plus', { exact: true }).waitFor();
  assert.equal(await frame.locator('#workspaceConfirm').count(), 0);
  assert.equal(await frame.locator('#startBtn').isEnabled(), true);
  const session = await authorization.inputValue();
  const payload = { cdk, session };
  const submission = page.waitForResponse((response) =>
    response.url().endsWith('/api/run-process')
  );
  await frame.locator('#startBtn').click();
  const { jobKey } = await (await submission).json();
  assert.ok(jobKey);
  await frame.locator('#taskProgressTitle').getByText('开通中', { exact: true }).waitFor();
  await frame
    .locator('html[data-recharge-navigation-locked="true"]')
    .waitFor({ state: 'attached' });
  assert.equal(
    await frame.getByRole('button', { name: '兑换码查询', exact: true }).isEnabled(),
    false
  );
  assert.equal(await page.evaluate(() => window.rechargeLockEvents.at(-1)), true);
  const repeats = await Promise.all(
    Array.from({ length: 3 }, () => data(host, 'run-process', payload))
  );
  assert(repeats.every((entry) => entry.jobKey === jobKey));
  assert.equal((await data(host, 'task-status/' + jobKey)).data.isTerminal, false);
  assert.equal((await data(host, 'cdk/query?cdk=' + cdk)).data.jobKey, jobKey);
  assert.equal(
    (await data(host, 'cdk/query-batch', { cdks: [cdk, cdk] })).data.summary.processing,
    1
  );
  clock += 1500;
  await frame.locator('#taskProgressTitle').getByText('开通结果待核对', { exact: true }).waitFor();
  await frame
    .locator('html[data-recharge-navigation-locked="false"]')
    .waitFor({ state: 'attached' });
  await page.waitForFunction(() => window.rechargeLockEvents.at(-1) === false);
  assert.equal(await authorization.inputValue(), '');
  assert.equal((await data(host, 'task-status/' + jobKey)).data.isTerminal, true);
  assert.equal((await data(host, 'run-process', payload)).jobKey, jobKey);
  assert.equal((await data(host, 'admin/task-logs')).tasks.length, 1);
  assert.equal((await data(host, 'cdk/query-batch', { cdks: [cdk] })).data.summary.unused, 1);

  await frame.getByRole('button', { name: '兑换码查询', exact: true }).click();
  await frame.locator('#querySection').waitFor();
  assert.equal(await frame.locator('#queryInput').inputValue(), cdk);
  await frame.locator('#queryBtn').click();
  await frame.locator('.query-result-card').getByText('未使用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '线上代充', exact: true, expanded: false }).click();
  await page.getByRole('link', { name: 'ChatGPT 充值', exact: true }).click();
  await frame.locator('#querySection').waitFor();
  assert.equal(await frame.locator('.site-hero h1').isVisible(), false);
  assert.equal(await frame.locator('.card-head h2').isVisible(), false);
  assert.equal(await nav.getByRole('button', { name: '兑换开通', exact: true }).count(), 0);
  assert.equal(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await frame.getByRole('link', { name: '发票助手' }).click();
  await frame.locator('#checkBtn:disabled').waitFor();
  const invoiceHelp = frame.locator('.compact-hero .title-help');
  await invoiceHelp.locator('.title-description').waitFor({ state: 'hidden' });
  await invoiceHelp.locator('summary').click();
  await invoiceHelp.locator('.title-description').waitFor();
  await frame.locator('#billingLink[aria-disabled="true"]').waitFor({ state: 'attached' });

  for (const [name, view, content, disabled] of adminViews) {
    await select(name);
    await verifyAdminLayout(view, 1280);
    await frame
      .locator(view + '.active')
      .locator(content)
      .waitFor();
    if (disabled)
      await frame
        .locator(view)
        .locator(disabled + ':disabled')
        .waitFor();
    if (name === '银行卡池') {
      await frame.locator(content).getByText('虚构演示持卡人').waitFor();
      await frame.getByRole('tab', { name: 'Orbitcard 用卡记录' }).click();
      await frame.locator('#orbitcard_usage_filters').waitFor();
      await verifyToolbarRow('#orbitcard_usage_filters', 'input, select, button');
    }
    if (name === 'CDK 管理') {
      await frame.locator(content).getByText(cdk, { exact: true }).waitFor();
      await frame.locator('#cdk_search:enabled').waitFor();
      await frame.locator('.cdk-copy[aria-disabled="true"]').filter({ hasText: cdk }).waitFor();
      await verifyToolbarRow(
        '#cdks .panel-header',
        '.panel-title, input, select, .btn, .filter-trigger'
      );
      await frame
        .locator('#cdks .table-toolbar-filters')
        .getByRole('button', { name: '全部状态' })
        .click();
      await frame
        .locator('#cdks .table-toolbar-filters')
        .getByRole('button', { name: '未使用', exact: true })
        .click();
    }
    if (name === 'Session 管理') {
      await verifyToolbarRow('#sessions .panel-header', '.panel-title, input, button');
      await page.setViewportSize({ width: 1024, height: 850 });
      await verifyToolbarRow('#sessions .panel-header', '.panel-title, input, button');
      await page.setViewportSize({ width: 1280, height: 850 });
    }
    if (name === '任务管理') {
      await frame.locator(content).getByText('演示任务已转待人工核对').waitFor();
      await frame.locator('[data-view-task-log="' + jobKey + '"]:enabled').click();
      await frame.getByText(jobKey + ' · manual · 70%', { exact: true }).waitFor();
      await frame.locator('[onclick="closeTaskLogModal()"]:enabled').click();
    }
    if (name === '运行日志')
      await frame.getByText('本机模拟上游已就绪', { exact: false }).waitFor();
    if (name === '系统配置') {
      const panelHelp = frame
        .locator('#config .title-with-help')
        .filter({ hasText: '第三方代充 API' });
      await panelHelp.locator('.title-description').waitFor({ state: 'hidden' });
      await panelHelp.locator('summary').click();
      await panelHelp.locator('.title-description').waitFor();
      await panelHelp.locator('summary').press('Escape');
    }
  }
  assert.equal((await api(host, 'admin/cdks/generate', {})).status, 403);
  assert.equal((await api(host, 'admin/task-logs/' + jobKey, undefined, 'DELETE')).status, 403);
  await select('概览中心');
  await frame.locator('#stat_total').getByText('1', { exact: true }).waitFor();
  refreshFailure = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('ChatGPT 充值服务未就绪，已保留当前内容。', { exact: true }).waitFor();
  await frame.locator('#stat_total').getByText('1', { exact: true }).waitFor();
  refreshFailure = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await frame.locator('#stat_total').getByText('1', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#theme-toggle').click();
  await frame.locator('html[data-id-theme="dark"]').waitFor({ state: 'attached' });
  for (const [name, view] of adminViews) {
    await select(name);
    await verifyAdminLayout(view, 390);
    if (view === '#cards' || view === '#logs') {
      const tabs = frame.locator(view).getByRole('tab');
      for (const tab of await tabs.all()) {
        await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        await verifyAdminLayout(view, 390);
      }
    }
  }
  assert.equal(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await select('支付链接调试');
  await verifyAdminLayout('#checkout_debug', 390);
  const checkoutField = frame.locator('.embedded-field:has(#checkout_plan_type)');
  assert.equal(
    await checkoutField.evaluate((element) => {
      const label = element.querySelector('label').getBoundingClientRect();
      const input = element.querySelector('select').getBoundingClientRect();
      return label.right < input.left && Math.abs(label.top - input.top) < 2 && input.height === 44;
    }),
    true
  );
  const help = page.locator('#page-title summary');
  await help.click();
  await page
    .locator('#page-description')
    .getByText('启动浏览器并注入 Session', { exact: false })
    .waitFor();
  await help.press('Escape');
  await page.locator('#page-description').waitFor({ state: 'hidden' });
  await select('任务管理');
  await frame.locator('#logs').getByRole('tab', { name: '任务管理', exact: true }).click();
  await frame.locator('[data-view-task-log="' + jobKey + '"]:enabled').click();
  await frame.getByText(jobKey + ' · manual · 70%', { exact: true }).waitFor();
  const modal = await frame.locator('#task_log_modal_overlay .screenshot-modal').boundingBox();
  assert(modal.y >= 0 && modal.y + modal.height <= 844);
  await frame.locator('[onclick="closeTaskLogModal()"]:enabled').click();
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 1280, height: 850 });
  assert.equal(await nav.getByRole('button', { name: '登录日志', exact: true }).count(), 0);
  await page.goto(host.url + '#/settings/login-logs');
  await page.getByText('当前预览未启用统一登录', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '充值登录与 IP 封禁' }).click();
  await page.getByText('此处的 IP 封禁仅作用于充值服务。', { exact: true }).waitFor();
  await verifyAdminLayout('#admin_login_logs', 1280);
  await frame.getByText('本机演示会话', { exact: true }).waitFor();
  await frame.locator('[data-ban-ip]:disabled').waitFor();
  await close(host);

  const restarted = await start();
  origins.add(new URL(restarted.url).origin);
  assert.equal((await api(restarted, 'task-status/' + jobKey)).status, 404);
  assert.equal((await api(restarted, 'run-process', payload)).status, 400);
  assert.equal((await data(restarted, 'admin/task-logs')).tasks.length, 0);
  assert.equal((await data(restarted, 'cdk/query?cdk=' + cdk)).data.status, '未使用');
  await page.goto(restarted.url + '#/workspace/recharge');
  await fill();
  await frame.locator('#redeemBtn').click();
  await frame.locator('#startBtn:enabled').waitFor();
  const freshSession = await frame.locator('#tokenInput').inputValue();
  let uncertainRequests = 0;
  await page.route('**/api/run-process', (route) => {
    uncertainRequests += 1;
    return route.fulfill({ status: 503, json: { success: false } });
  });
  await frame.locator('#startBtn').click();
  await frame.getByText('提交结果暂时无法确认，请用原兑换码查询。', { exact: true }).waitFor();
  assert.equal(await frame.locator('#startBtn').isEnabled(), false);
  assert.equal(await frame.locator('#tokenInput').inputValue(), '');
  await frame.getByRole('button', { name: '兑换码查询', exact: true }).click();
  assert.equal(await frame.locator('#queryInput').inputValue(), cdk);
  await frame.getByRole('button', { name: '自助充值', exact: true }).click();
  await frame.locator('#backToStep1').click();
  await fill();
  await frame.locator('#redeemBtn').click();
  await frame.locator('#workspacePlan').getByText('演示 Plus', { exact: true }).waitFor();
  assert.equal(await frame.locator('#startBtn').isEnabled(), false);
  assert.equal(uncertainRequests, 1);
  const fresh = await data(restarted, 'run-process', { cdk, session: freshSession });
  assert.ok(fresh.jobKey);
  assert.notEqual(fresh.jobKey, jobKey);
  assert.deepEqual(errors, []);
});
