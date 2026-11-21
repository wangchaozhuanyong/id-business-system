import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CODEXDAICHONG_PREFIX } from '../modules/recharge/codexdaichong/gateway.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const frameSelector = '#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])';
const workspace = '#/workspace/recharge';
const mailboxes = '#/mailboxes/google';
const online = '#/online-recharge/chatgpt';
const lockNotice = '充值任务正在执行，请等待任务处理完成后再切换或刷新。';
const code = 'KC-NAVIGATION-FIXTURE';
const jobKey = 'navigation-fixture-job';

function syntheticSession() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return JSON.stringify({
    user: { id: 'navigation-user', email: 'navigation@example.test' },
    accessToken: [
      encode({ typ: 'JWT', alg: 'RS256' }),
      encode({
        iss: 'https://auth.openai.com',
        aud: ['https://api.openai.com/v1'],
        scp: ['model.request'],
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'navigation-fixture', chatgpt_user_id: 'navigation-fixture' }
      }),
      'synthetic'
    ].join('.')
  });
}

async function captureFrame(page) {
  const frame = page.locator(frameSelector);
  const identity = await frame.evaluateHandle((node) => ({
    node,
    document: node.contentDocument
  }));
  return {
    same: () =>
      frame.evaluate(
        (node, before) => node === before.node && node.contentDocument === before.document,
        identity
      ),
    dispose: () => identity.dispose()
  };
}

test(
  'host navigation and refresh preserve the running recharge frame until it unlocks',
  { timeout: 30_000 },
  async (t) => {
    const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
    const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
    const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' });
    const traffic = await interceptDesign(context, {
      actor: { id: 'navigation-admin', name: '隔离管理员', role: 'super' },
      localFixtures: {}
    });
    const host = origin + '/';
    const base = origin + CODEXDAICHONG_PREFIX;
    const statusUrl = base + '/status';
    const taskUrl = base + '/api/task-status/' + jobKey;
    const session = syntheticSession();
    const commands = [];
    const unexpectedWrites = [];
    let terminal = false;
    await context.route(base + '/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(CODEXDAICHONG_PREFIX.length);
      if (path === '/api/verify-cdk' && request.method() === 'POST') {
        commands.push({ path, body: request.postDataJSON() });
        return route.fulfill({ json: { success: true, data: { plan_type: 'plus', plan_label: 'Plus' } } });
      }
      if (path === '/api/run-process' && request.method() === 'POST') {
        commands.push({ path, body: request.postDataJSON() });
        return route.fulfill({ json: { success: true, jobKey } });
      }
      if (path === '/api/task-status/' + jobKey && request.method() === 'GET') {
        return route.fulfill({ json: { success: true, data: {
          jobKey, status: terminal ? 'manual' : 'running', isTerminal: terminal, progress: 28
        } } });
      }
      if (request.method() !== 'GET') {
        unexpectedWrites.push(path);
        return route.abort();
      }
      return route.fallback();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.clock.install();
    let statusChecks = 0;
    let submissions = 0;
    const pageErrors = [];
    page.on('request', (request) => {
      if (request.url() === statusUrl) statusChecks++;
      if (request.url() === base + '/api/run-process') submissions++;
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const frame = page.frameLocator(frameSelector);
    const region = page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view');
    const lock = (locked) =>
      frame
        .locator('html[data-recharge-navigation-locked="' + locked + '"]')
        .waitFor({ state: 'attached' });
    const toast = page.getByText(lockNotice, { exact: true });
    const sidebar = page.getByRole('link', { name: '谷歌邮箱', exact: true });

    await page.goto(host + workspace);
    await frame.locator('#cdkInput').fill(code);
    await frame.locator('#redeemBtn').click();
    await frame.locator('#workspaceVerifiedPlan').waitFor();
    await frame.locator('#tokenInput').fill(session);
    const submitted = page.waitForResponse(
      (response) => response.url() === base + '/api/run-process'
    );
    await frame.locator('#startBtn').click();
    assert.equal((await (await submitted).json()).jobKey, jobKey);
    await frame.locator('#taskProgressTitle').getByText('开通中', { exact: true }).waitFor();
    await lock(true);
    const runningFrame = await captureFrame(page);
    const task = () => page.evaluate(async url => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('隔离任务读取失败');
      return (await response.json()).data;
    }, taskUrl);
    const beforeNavigation = statusChecks;

    await page.locator('#sidebar').getByRole('button', { name: '邮箱管理', exact: true }).click();
    await sidebar.click();
    await toast.waitFor();
    await page.waitForURL(host + workspace);
    assert.equal(await runningFrame.same(), true);
    assert.equal((await task()).jobKey, jobKey);

    await page.evaluate((hash) => {
      location.hash = hash;
    }, online);
    await page.waitForURL(host + workspace);
    assert.equal(await runningFrame.same(), true);
    assert.equal((await task()).status, 'running');
    assert.equal((await task()).jobKey, jobKey);
    assert.equal(statusChecks, beforeNavigation);
    assert.equal(submissions, 1);
    await runningFrame.dispose();

    terminal = true;
    await page.clock.fastForward(1600);
    await frame.locator('#taskProgressTitle').getByText('开通结果待核对', { exact: true }).waitFor();
    await lock(false);
    assert.equal((await task()).isTerminal, true);
    assert.equal((await task()).jobKey, jobKey);
    await sidebar.click();
    await page.waitForURL(host + mailboxes);
    await page.locator(frameSelector).waitFor({ state: 'detached' });

    // The real online host has tabs and refresh, while actual submission is in the workspace.
    // Exercise those host controls with the same iframe lock bridge used by submission.
    await page.evaluate((hash) => {
      location.hash = hash;
    }, online);
    await page.waitForURL(host + online);
    await frame.locator('#querySection').waitFor();
    const nav = page.getByRole('navigation', { name: 'ChatGPT 充值功能' });
    const query = nav.getByRole('button', { name: '查询状态', exact: true });
    const dashboard = nav.getByRole('button', { name: '概览中心', exact: true });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    const setLock = (locked) =>
      frame
        .locator('html')
        .evaluate((_node, value) => window.idRechargeSetNavigationLock(value), locked);
    const onlineFrame = await captureFrame(page);
    const beforeControls = statusChecks;
    await setLock(true);
    await lock(true);
    await dashboard.click();
    await refresh.click();
    assert.equal(await query.getAttribute('aria-pressed'), 'true');
    assert.equal(await dashboard.getAttribute('aria-pressed'), 'false');
    assert.equal(await region.getAttribute('aria-busy'), 'false');
    assert.equal(await onlineFrame.same(), true);
    assert.equal(statusChecks, beforeControls);
    await setLock(false);

    // A refresh started before the lock must also leave the original iframe in place.
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    await page.route(
      statusUrl,
      async (route) => {
        started.resolve();
        await resume.promise;
        await route.fulfill({ json: { ready: true, admin: true } }).catch(() => {});
      },
      { times: 1 }
    );
    try {
      await refresh.click();
      await started.promise;
      assert.equal(await region.getAttribute('aria-busy'), 'true');
      await setLock(true);
      await page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
      assert.equal(await onlineFrame.same(), true);
    } finally {
      resume.resolve();
    }
    await setLock(false);

    const refreshed = page.waitForResponse(statusUrl);
    await refresh.click();
    assert.equal((await refreshed).status(), 200);
    await page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
    assert.equal(await onlineFrame.same(), false);
    await onlineFrame.dispose();
    await dashboard.click();
    await frame.locator('#dashboard.active').waitFor();
    assert.equal(await dashboard.getAttribute('aria-pressed'), 'true');
    assert.equal(new URL(page.url()).hash, online);
    assert.equal((await task()).jobKey, jobKey);
    assert.equal(submissions, 1);
    assert.deepEqual(commands, [
      { path: '/api/verify-cdk', body: { cdk: code } },
      { path: '/api/run-process', body: { session, cdk: code } }
    ]);
    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(traffic.external, []);
    assert.deepEqual(traffic.unavailable, []);
  }
);
