import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

const mount = '/integrations/codexdaichong';
const pageNames = [
  ['dashboard', '概览中心'],
  ['config', '系统配置'],
  ['proxies', '代理池'],
  ['tax_addresses', '免税地址'],
  ['checkout_debug', '支付链接调试'],
  ['cards', '银行卡池'],
  ['cdks', 'CDK 管理'],
  ['sessions', 'Session 管理'],
  ['cancel_renewal', '续费管理'],
  ['logs', '任务管理'],
  ['runtime_logs', '运行日志']
];
const task = 'fixture-task';
const cdk = 'KC-FIXTURE';
const session = () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return JSON.stringify({
    user: { id: 'fixture-user', email: 'fixture@example.test' },
    accessToken: [
      part({ typ: 'JWT', alg: 'RS256' }),
      part({
        iss: 'https://auth.openai.com',
        aud: ['https://api.openai.com/v1'],
        scp: ['model.request'],
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_user_id: 'fixture' }
      }),
      'synthetic'
    ].join('.')
  });
};

function reply(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function mockUpstream() {
  let fail = '',
    submitted = 0;
  const received = [];
  const hostile = '<img src=x onerror=window.testInjected=1>';
  const server = createServer(async (req, res) => {
    const path = req.url.split('?', 1)[0];
    received.push(path);
    if (path === fail) return reply(res, { success: false, message: hostile }, 503);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (path === '/api/public/runtime')
      return reply(res, {
        success: true,
        runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 }
      });
    if (path === '/api/public/payment-region')
      return reply(res, { success: true, region: 'PH', currency: 'PHP' });
    if (path === '/api/admin/region')
      return reply(res, { success: true, region: 'MY', label: '马来西亚', currency: 'MYR' });
    if (path === '/api/admin/session')
      return reply(res, { success: true, email: 'fixture@example.test' });
    if (path === '/api/admin/data')
      return reply(res, { stats: { total: 9, success: 6, failed: 3 }, config: {}, logs: [] });
    if (path === '/api/admin/cdks')
      return reply(res, [
        { code: cdk, plan_type: 'plus' },
        { code: hostile, plan_type: 'plus' }
      ]);
    if (path === '/api/admin/cards')
      return reply(res, { cards: [{ id: 1, last4: '0007', card_holder: '演示持卡人' }] });
    if (path === '/api/admin/task-logs')
      return reply(res, {
        tasks: [{ id: task, status: 'manual', progress: 70, cdk, message: '模拟后台任务' }]
      });
    if (path === '/api/admin/task-logs/' + task)
      return reply(res, {
        success: true,
        task: { jobKey: task, status: 'manual', progress: 70, message: '模拟开通结果' },
        runtimeEntries: Array.from({ length: 60 }, (_, index) => ({ text: '模拟诊断 ' + index }))
      });
    if (path === '/api/verify-cdk') {
      if (data?.cdk === 'missing-plan') return reply(res, { success: true, data: {} });
      if (data?.cdk !== cdk) return reply(res, { success: false, message: hostile }, 400);
      return reply(res, { success: true, data: { plan_type: 'plus', plan_label: '模拟 Plus' } });
    }
    if (path === '/api/run-process') {
      assert.equal(data?.cdk, cdk);
      assert.match(data?.session, /fixture@example.test/);
      submitted++;
      return reply(res, { success: true, jobKey: task });
    }
    if (path === '/api/task-status/' + task) {
      return reply(res, {
        success: true,
        data: { jobKey: task, status: 'manual', message: '模拟任务待人工核对', progress: 70 }
      });
    }
    if (path === '/api/cdk/query')
      return reply(res, {
        success: true,
        data: { status: '开通中', planLabel: '模拟 Plus', accountEmail: 'f***@example.test' }
      });
    return reply(res, {
      success: true,
      data: [],
      rows: [],
      items: [],
      entries: [],
      logs: [],
      total: 0,
      config: {}
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    received,
    origin: 'http://127.0.0.1:' + server.address().port,
    fail: (path) => {
      fail = path;
    },
    submitted: () => submitted
  };
}

test(
  'real pinned assets in the actual preview: workspace navigation, redemption and failed refresh',
  { timeout: 45_000 },
  async (t) => {
    const playwrightModule = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
    if (!playwrightModule)
      throw new Error('请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(runtime, 'codexdaichong-browser-test-'));
    const upstream = await mockUpstream();
    let browser, host;
    t.after(async () => {
      await browser?.close();
      for (const server of [host?.server, upstream.server]) {
        if (!server) continue;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(directory, { recursive: true, force: true });
    });
    const authPath = join(directory, 'employees.json');
    const user = {
      name: '测试主管',
      email: 'fixture@example.test',
      password: randomBytes(24).toString('hex')
    };
    await initializeLocalAdmin(authPath, user);
    host = await startPreview(0, {
      databasePath: ':memory:',
      authPath,
      rechargeConfig: { upstreamUrl: upstream.origin, secret: randomBytes(32).toString('hex') }
    });
    const origin = new URL(host.url).origin;
    assert.equal((await fetch(origin + mount + '/status')).status, 401);
    browser = await chromium.launch({
      ...(process.env.ID_RECHARGE_QA_BROWSER_CHANNEL
        ? {
            channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL
          }
        : {})
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6500);
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    const pageErrors = [];
    const staticMisses = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400 && /\.(css|js)(?:\?|$)/.test(response.url()))
        staticMisses.push(new URL(response.url()).pathname);
    });
    await page.goto(host.url + '#/workspace/recharge');
    const authHelp = page.locator('.local-auth-card .title-help');
    await authHelp.locator('summary').waitFor();
    await authHelp.locator('.title-description').waitFor({ state: 'hidden' });
    await page.locator('#local-auth-email').fill(user.email);
    await page.locator('#local-auth-password').fill(user.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const iframe = '.recharge-integration__content iframe:not([hidden])';
    const frame = page.frameLocator(iframe);
    const nav = page.getByRole('navigation', { name: 'ChatGPT 充值功能' });
    const select = (name) => nav.getByRole('button', { name, exact: true }).click();
    await frame.locator('#cdkInput').waitFor();
    await frame.locator('#cdkInput').fill('invalid');
    await frame.locator('#redeemBtn').click();
    await frame.getByText('<img src=x onerror=window.testInjected=1>', { exact: true }).waitFor();
    assert.equal(await frame.locator('img[src="x"]').count(), 0);
    await frame.locator('#cdkInput').fill('missing-plan');
    await frame.locator('#redeemBtn').click();
    await frame.locator('#workspacePlan').getByText('套餐待确认', { exact: true }).waitFor();
    await frame.locator('#backToStep1').click();
    await frame.locator('#cdkInput').fill(cdk);
    await frame.locator('#redeemBtn').click();
    await frame.locator('#tokenInput').fill('invalid');
    await frame
      .locator('#workspaceAccountHint')
      .getByText('请粘贴完整', { exact: false })
      .waitFor();
    assert.equal(await frame.locator('#startBtn').isEnabled(), false);
    await frame.locator('#tokenInput').fill(session());
    assert.equal(await frame.locator('#workspaceConfirm').count(), 0);
    await frame.locator('#tokenInput').fill(session() + ' ');
    assert.equal(await frame.locator('#startBtn').isEnabled(), true);
    assert.equal(upstream.submitted(), 0);
    await frame.locator('#startBtn').click();
    await frame.getByText('模拟任务待人工核对', { exact: true }).first().waitFor();
    assert.equal(upstream.submitted(), 1);
    await page.getByRole('button', { name: '线上代充', exact: true, expanded: false }).click();
    await page.getByRole('link', { name: 'ChatGPT 充值', exact: true }).click();
    await frame.locator('#queryInput').fill(cdk);
    await frame.locator('#queryBtn').click();
    await frame.locator('.query-result-card').getByText('开通中', { exact: true }).waitFor();

    await frame.getByRole('link', { name: '发票助手' }).click();
    await frame.locator('body[data-recharge-view="subscription"]').waitFor();

    for (const [id, name] of pageNames) {
      await select(name);
      await frame.locator('#' + id + '.active').waitFor();
      if (id === 'cdks') {
        await frame.locator('#cdk_body').getByText(cdk, { exact: true }).waitFor();
        await frame
          .locator('#cdk_body')
          .getByText('<img src=x onerror=window.testInjected=1>', { exact: true })
          .waitFor();
        assert.equal(await frame.locator('#cdk_body img[src="x"]').count(), 0);
      }
      if (id === 'cards')
        await frame.locator('#card_pool_list_body').getByText('演示持卡人').waitFor();
      if (id === 'logs') await frame.locator('#log_body').getByText('模拟后台任务').waitFor();
    }
    await select('任务管理');
    const logTrigger = frame.getByTitle('查看充值详细日志');
    await logTrigger.click();
    const drawer = page.getByRole('dialog', { name: '充值详细日志' });
    const detailFrame = drawer.frameLocator('iframe');
    const logBody = detailFrame.locator('#task_log_modal_body');
    await logBody.getByText('模拟开通结果', { exact: true }).waitFor();
    assert.equal(await frame.locator('#task_log_modal_overlay.open').count(), 0);
    const verifyDrawer = async (viewportWidth, viewportHeight) => {
      const box = await drawer.boundingBox();
      assert(box && box.y === 0 && box.x + box.width === viewportWidth && box.height === viewportHeight,
        JSON.stringify(box));
      assert.equal(await logBody.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    };
    await verifyDrawer(1440, 900);
    await detailFrame.getByText('查看技术诊断日志（60 条）', { exact: true }).click();
    assert.equal(await logBody.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop > 0;
    }), true);
    await page.setViewportSize({ width: 390, height: 850 });
    await verifyDrawer(390, 850);
    await logBody.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await frame.locator('#logs.active').waitFor();
    assert.equal(await logTrigger.evaluate((node) => document.activeElement === node), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#theme-toggle').click();
    await logTrigger.click();
    await detailFrame.locator('html[data-id-theme="dark"]').waitFor({ state: 'attached' });
    await drawer.getByRole('button', { name: '关闭抽屉' }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.locator('#theme-toggle').click();
    await select('系统配置');
    const region = frame.locator('.embedded-field-with-actions');
    await region.getByRole('status').getByText(/马来西亚/).waitFor();
    const layout = () => region.evaluate((field) => {
      const box = (selector) => {
        const { top, right, bottom, left } = field.querySelector(selector).getBoundingClientRect();
        return { top, right, bottom, left, center: (top + bottom) / 2 };
      };
      return {
        right: field.getBoundingClientRect().right,
        label: box('label'),
        select: box('select'),
        save: box('button'),
        status: box('[role="status"]')
      };
    });
    const desktop = await layout();
    for (const item of [desktop.label, desktop.save, desktop.status])
      assert(Math.abs(item.center - desktop.select.center) <= 1, JSON.stringify(desktop));
    await page.setViewportSize({ width: 390, height: 850 });
    const mobile = await layout();
    assert(mobile.label.right <= mobile.select.left, JSON.stringify(mobile));
    for (const item of [mobile.select, mobile.save, mobile.status])
      assert(item.right <= mobile.right + 1, JSON.stringify(mobile));
    await page.setViewportSize({ width: 1440, height: 900 });
    await select('概览中心');
    await frame.locator('#stat_total').getByText('9', { exact: true }).waitFor();
    upstream.fail('/api/admin/data');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText('ChatGPT 充值服务未就绪，已保留当前内容。', { exact: true }).waitFor();
    await frame.locator('#stat_total').getByText('9', { exact: true }).waitFor();
    const secondSession = await browser.newContext();
    try {
      const login = await secondSession.request.post(origin + '/api/local/auth/login', {
        headers: { Origin: origin },
        data: { email: user.email, password: user.password }
      });
      assert.equal(login.status(), 200);
      const logout = await secondSession.request.post(origin + '/api/local/auth/logout', {
        headers: { Origin: origin }
      });
      assert.equal(logout.status(), 200);
      assert.equal((await secondSession.request.get(origin + '/api/local/audit')).status(), 401);
    } finally {
      await secondSession.close();
    }
    await page.goto(host.url + '#/settings/login-logs');
    const loginLogs = page.locator('[data-table="系统登录日志"]');
    await loginLogs
      .getByRole('row', { name: /测试主管.*员工登录/ })
      .first()
      .waitFor();
    await loginLogs.getByRole('row', { name: /测试主管.*退出登录/ }).waitFor();
    await page.getByRole('tab', { name: '充值登录与 IP 封禁' }).click();
    await page.getByText('ChatGPT 充值服务未就绪', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '系统登录', exact: true }).click();
    await loginLogs.getByRole('row', { name: /测试主管.*退出登录/ }).waitFor();
    await page.goto(new URL('/mailbox-query', origin).href);
    const mailboxHelp = page.locator('.public-mailbox-panel .title-help').first();
    await mailboxHelp.locator('summary').click();
    await mailboxHelp.getByText('使用主邮箱查询码或买家查询码查看对应邮件。').waitFor();
    await page.locator('.public-mailbox-brand').click();
    await mailboxHelp.locator('.title-description').waitFor({ state: 'hidden' });
    assert.deepEqual(staticMisses, []);
    assert.deepEqual(pageErrors, []);
    assert(upstream.received.includes('/api/task-status/' + task));
  }
);
