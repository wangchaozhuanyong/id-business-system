import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { toggleDesignTheme, interceptDesign, origin } from './helpers/offline-design.mjs';

const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const actor = { id: 'fixture', name: '离线验收管理员', role: 'admin' };
const api = '/integrations/codexdaichong/api/';
const output = process.env.ID_RECHARGE_QA_OUTPUT;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = () => JSON.stringify({
  user: { id: 'fixture', email: 'fixture@example.test' },
  accessToken: [encode({ typ: 'JWT', alg: 'RS256' }), encode({
    iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], scp: ['model.request'],
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_user_id: 'fixture' }
  }), 'synthetic'].join('.')
});
const frameOf = page => page.frameLocator('iframe[data-view="redeem"]:visible');

test('兑换开通铺满工作区：深浅主题、宽窄屏、真实标题对齐和页签切换', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  if (output) await mkdir(output, { recursive: true });
  const metrics = [];
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? '深色' : '浅色'}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 1920 ? 1080 : 900 } });
      try {
        const traffic = await interceptDesign(context, { actor, localFixtures: {} });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/workspace/recharge');
        if (dark) await toggleDesignTheme(page);
        const frame = frameOf(page);
        await frame.locator('#workspaceLogViewport').waitFor();
        if (dark) await frame.locator('html[data-id-theme="dark"]').waitFor();
        await frame.locator('body').evaluate(() => Promise.allSettled(document.getAnimations()
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
        const layout = await frame.locator('body').evaluate(() => {
          const box = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
          };
          const textTop = (selector, text) => {
            const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
            for (let node; (node = walker.nextNode());) if (node.textContent.includes(text)) {
              const range = document.createRange();
              range.selectNodeContents(node);
              return range.getBoundingClientRect().top;
            }
          };
          const borders = selector => {
            const style = getComputedStyle(document.querySelector(selector));
            return ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
              .map(name => Number.parseFloat(style[name]));
          };
          return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            page: box('.page-shell'), form: box('.workspace-recharge-form'), panel: box('.workspace-recharge-progress'),
            log: box('#workspaceLogViewport'), input: box('#tokenInput'), code: box('#cdkInput'),
            tabs: box('.tab-nav'), step1: box('#step1'), step2: box('#step2'), submit: box('#startBtn'),
            step1Borders: borders('#step1'), step2Borders: borders('#step2'),
            panelBorders: borders('.workspace-recharge-progress'), logBorders: borders('#workspaceLogViewport'),
            codeTitle: textTop('#workspace-code-title', '验证兑换码'), progressTitle: textTop('#workspace-progress-title', '充值进度') };
        });
        metrics.push({ width, dark, ...layout });
        assert(!layout.overflow, '嵌入页不得横向溢出');
        assert(layout.form.x <= 24 && layout.panel.right >= layout.width - 24, '工作区必须铺满可用宽度');
        assert(layout.form.x >= 16 && layout.panel.right <= layout.width - 16, '内容与外框必须保留左右留白');
        assert.equal(layout.step1.x, layout.tabs.x, '页签与步骤统一左边距');
        assert.equal(layout.step1.x, layout.step2.x, '两个步骤统一左边距');
        assert.equal(layout.code.x, layout.input.x, '兑换码与账号资料控件左边缘对齐');
        assert.deepEqual(layout.step1Borders, [0, 0, 0, 0], '验码步骤不再套卡片');
        assert.deepEqual(layout.step2Borders, [1, 0, 0, 0], '两个步骤之间只保留分隔线');
        assert.deepEqual(layout.logBorders, [0, 0, 0, 0], '日志使用底色区分，不再叠加边框');
        assert(layout.log.height >= 320 && layout.input.height >= 220, '日志与账号输入保留大面积阅读空间');
        assert(layout.code.width >= 150, '兑换码输入不能被按钮挤窄');
        if (layout.width > 900) {
          assert(Math.abs(layout.form.bottom - layout.panel.bottom) <= 1, '桌面两栏底边一致');
          assert(Math.abs(layout.codeTitle - layout.progressTitle) <= 1, '并排标题真实文字对齐');
          assert(layout.panel.width >= layout.width * 0.45, '日志使用约一半宽度');
          assert.deepEqual(layout.panelBorders, [0, 0, 0, 1], '桌面只保留中间分隔线');
          assert(layout.log.x - layout.panel.x >= 24, '日志不能贴着中间分隔线');
        } else {
          assert(layout.panel.y >= layout.form.bottom + 16, '窄屏顺序为操作表单、日志');
          assert.deepEqual(layout.panelBorders, [1, 0, 0, 0], '窄屏改用水平分隔线');
        }
        assert(Math.abs(layout.submit.right - layout.input.right) <= 1, '提交按钮与账号输入右边缘对齐');
        const emptyHeight = await page.locator('iframe[data-view="redeem"]:visible').evaluate(node => node.offsetHeight);
        await frame.locator('.workspace-log .title-help summary').click();
        await frame.getByText('显示本页收到的任务状态', { exact: false }).waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await frame.getByText('显示本页收到的任务状态', { exact: false }).isVisible(), false);
        assert.equal(await page.locator('iframe[data-view="redeem"]:visible').evaluate(node => node.offsetHeight), emptyHeight);
        if (output && (width === 1920 || width === 390)) {
          await frame.locator('#workspace-progress-title').click();
          await page.screenshot({ path: `${output}/empty-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
        }
        if (width === 1920) {
          await page.setViewportSize({ width, height: 900 });
          await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
          const resized = await frame.locator('.page-shell').evaluate(node => node.offsetHeight);
          assert(resized < layout.page.height && resized >= layout.page.height - 181, '高度跟随宿主视口，不能形成 iframe 增高循环');
          await page.setViewportSize({ width, height: 1080 });
        }
        await frame.getByRole('button', { name: '兑换码查询', exact: true }).click();
        await frame.locator('#queryInput').waitFor();
        for (const [tab, selector] of [['兑换码查询', '#querySection'], ['使用说明', '#workspaceGuide']]) {
          await frame.getByRole('button', { name: tab, exact: true }).click();
          await page.waitForFunction(() => {
            const iframe = document.querySelector('iframe[data-view="redeem"]:not([hidden])');
            return iframe && Math.abs(iframe.offsetHeight - iframe.contentDocument.body.offsetHeight) <= 1;
          });
          const region = await frame.locator(selector).evaluate(node => {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            return { x: rect.x, right: rect.right, border: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
              .map(name => Number.parseFloat(style[name])), overflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.equal(region.x, layout.form.x, `${tab}沿用统一边距`);
          assert.equal(region.right, layout.panel.right);
          assert.deepEqual(region.border, [0, 0, 0, 0], `${tab}不再叠加外框`);
          assert(!region.overflow);
          if (output && (width === 1920 || width === 390))
            await page.screenshot({ path: `${output}/${selector.slice(1)}-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
        }
        await frame.getByRole('button', { name: '自助充值', exact: true }).click();
        assert.equal(await frame.locator('#workspaceLogEmpty').isVisible(), true);
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
      } finally { await context.close(); }
    });
  }
  if (output) await writeFile(`${output}/layout.json`, JSON.stringify(metrics, null, 2));
});

test('本次任务日志自动追加、去重、断线恢复、暂停跟随，刷新只读取一次', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const traffic = await interceptDesign(context, { actor, localFixtures: {} });
  const jobKey = 'workspace-log-fixture';
  let next = { status: 'running', stage: 'payment_details', progress: 37 };
  let reads = 0, submissions = 0, hold = null;
  await context.route(url => url.pathname === api + 'verify-cdk', route => route.fulfill({ json: {
    success: true, data: { plan_type: 'plus', plan_label: 'Plus' }
  } }));
  await context.route(url => url.pathname === api + 'run-process', route => {
    submissions++;
    return route.fulfill({ json: { success: true, jobKey, stage: 'preparing' } });
  });
  await context.route(url => url.pathname === api + 'task-status/' + jobKey, async route => {
    assert.equal(new URL(route.request().url()).search, '?view=steps');
    reads++;
    if (hold) await hold;
    return next ? route.fulfill({ json: { success: true, data: { jobKey, ...next,
      message: 'PRIVATE-RAW-LOG', rawOutput: 'PRIVATE-RAW-OUTPUT', session: 'PRIVATE-SESSION' } } })
      : route.fulfill({ status: 503, json: { success: false } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(origin + '/#/workspace/recharge');
  const frame = frameOf(page);
  const entries = frame.locator('#workspaceLogEntries');
  const refresh = frame.locator('#workspaceLogRefresh');
  const idle = () => frame.locator('#workspaceLogRefresh:not([disabled])').waitFor();
  await frame.locator('#cdkInput').fill('KC-FIXTURE');
  await frame.locator('#redeemBtn').click();
  await frame.locator('#tokenInput').fill(session());
  await frame.locator('#startBtn').click();
  await entries.getByText(/正在填写支付资料/).waitFor();
  await idle();
  const originalCount = await entries.locator('li').count();
  await refresh.click();
  await idle();
  assert.equal(await entries.locator('li').count(), originalCount, '同一状态不重复刷屏');
  assert.match(await entries.locator('time').first().textContent(), /^\d{2}:\d{2}:\d{2}$/);

  let release;
  hold = new Promise(resolve => { release = resolve; });
  const beforeSlowRead = reads;
  await refresh.click();
  await frame.getByRole('button', { name: '刷新中…', exact: true }).waitFor();
  assert.equal(await refresh.isEnabled(), false);
  await page.clock.fastForward(5100);
  assert.equal(reads, beforeSlowRead + 1, '慢请求期间不能重复轮询');
  release(); hold = null;
  await idle();

  next = undefined;
  await refresh.click();
  await entries.getByText(/连接暂时中断/).waitFor();
  await idle();
  const offlineCount = await entries.locator('li').count();
  await refresh.click();
  await idle();
  assert.equal(await entries.locator('li').count(), offlineCount, '连续断线仅提示一次');
  assert.equal(await frame.locator('#taskProgressPercent').textContent(), '37%');
  next = { status: 'running', stage: 'paying', progress: 50 };
  await page.clock.fastForward(5100);
  await entries.getByText(/连接已恢复/).waitFor();
  await entries.getByText(/正在付款/).waitFor();
  await idle();
  // Enough real response transitions to exercise internal scrolling, without changing the form or page height.
  const panelHeight = await frame.locator('.workspace-recharge-progress').evaluate(node => node.offsetHeight);
  for (let i = 0; i < 22; i++) {
    next = { status: 'running', stage: i % 2 ? 'paying' : 'payment_details', progress: 50 };
    await refresh.click();
    await idle();
  }
  const viewport = frame.locator('#workspaceLogViewport');
  assert(await viewport.evaluate(node => node.scrollHeight > node.clientHeight));
  assert(await viewport.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 2));
  await viewport.evaluate(node => { node.scrollTop = 0; });
  await frame.locator('#workspaceLogLatest:not([hidden])').waitFor();
  assert.equal(await frame.locator('#workspaceLogFollow').isChecked(), false);
  next = { status: 'running', stage: 'paid', progress: 80 };
  await refresh.click();
  await idle();
  assert.equal(await viewport.evaluate(node => node.scrollTop), 0, '查看旧记录时不能抢回底部');
  assert.equal(await frame.locator('.workspace-recharge-progress').evaluate(node => node.offsetHeight), panelHeight, '日志增长不得撑高页面');
  await frame.locator('#workspaceLogLatest').click();
  assert.equal(await frame.locator('#workspaceLogFollow').isChecked(), true);
  assert(await viewport.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 2));
  const openedAt = Date.parse('2026-11-10T15:14:37Z');
  const steps = [
    { stage: 'checkout_open', at: openedAt },
    { stage: 'payment_submitted', at: openedAt + 1000 },
    { stage: 'PRIVATE-NATIVE-TEXT', at: openedAt + 2000 }
  ];
  next = { status: 'running', progress: 85, steps };
  await refresh.click();
  await entries.getByText(/结账页面已打开/).waitFor();
  await idle();
  const checkout = entries.locator('li').filter({ hasText: '结账页面已打开' });
  assert.equal(await checkout.locator('time').textContent(), '23:14:37');
  await entries.getByText(/已发起付款，等待结果确认/).waitFor();
  await refresh.click();
  await idle();
  assert.equal(await checkout.count(), 1, '重复回读同一原始事件只显示一行');
  assert.equal(await entries.evaluate(node => [...node.querySelectorAll('time')].every((time, i, times) =>
    i === 0 || time.dateTime >= times[i - 1].dateTime)), true);
  next = { status: 'success', progress: 100, renewalUnconfirmed: true, steps, terminalAt: openedAt + 3000 };
  await page.clock.fastForward(5100);
  await entries.getByText(/开通成功/).waitFor();
  assert.equal(await entries.locator('li[data-tone="success"] time').textContent(), '23:14:40');
  assert.equal(await refresh.isEnabled(), false);
  assert.doesNotMatch(await frame.locator('body').innerText(), /PRIVATE-/);
  const finalReads = reads;
  await page.clock.fastForward(6000);
  assert.equal(reads, finalReads, '结束后停止轮询');
  assert.equal(submissions, 1, '刷新不重复提交充值');
  const finalText = await entries.innerText();
  await frame.getByRole('button', { name: '兑换码查询', exact: true }).click();
  await frame.getByRole('button', { name: '自助充值', exact: true }).click();
  assert.equal(await entries.innerText(), finalText, '页签切换保留本次日志');
  if (output) await page.screenshot({ path: `${output}/completed-desktop.png`, fullPage: true });
  await frame.locator('#backToStep1').click();
  assert.equal(await entries.locator('li').count(), 0, '更换兑换码隔离上次记录');
  assert.equal(await frame.locator('#workspaceLogEmpty').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});
