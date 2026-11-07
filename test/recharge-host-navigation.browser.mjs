import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';
import { CODEXDAICHONG_PREFIX } from '../modules/recharge/codexdaichong/gateway.mjs';

const frameSelector = '#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])';
const workspace = '#/workspace/recharge';
const mailboxes = '#/mailboxes/google';
const online = '#/online-recharge/chatgpt';
const lockNotice = '充值任务正在执行，请等待任务处理完成后再切换或刷新。';

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
    assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
    const { chromium } = await import(pathToFileURL(playwright).href);
    let clock = Date.now();
    const host = await startCodexdaichongDemoSite(0, { now: () => clock });
    t.after(
      () =>
        new Promise((resolve) => {
          host.server.close(resolve);
          host.server.closeAllConnections();
        })
    );
    const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(6000);
    const origin = new URL(host.url).origin;
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    const base = origin + CODEXDAICHONG_PREFIX;
    const statusUrl = base + '/status';
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

    await page.goto(host.url + workspace);
    await frame.getByRole('button', { name: '填入演示资料' }).click();
    await frame.locator('#redeemBtn').click();
    await frame.locator('#workspaceConfirm').check();
    const submitted = page.waitForResponse(
      (response) => response.url() === base + '/api/run-process'
    );
    await frame.locator('#startBtn').click();
    const { jobKey } = await (await submitted).json();
    assert(jobKey);
    await frame.getByText('演示任务正在处理', { exact: true }).first().waitFor();
    await lock(true);
    const runningFrame = await captureFrame(page);
    const task = async () => {
      const response = await fetch(base + '/api/task-status/' + encodeURIComponent(jobKey));
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const beforeNavigation = statusChecks;

    await sidebar.click();
    await toast.waitFor();
    await page.waitForURL(host.url + workspace);
    assert.equal(await runningFrame.same(), true);
    assert.equal((await task()).jobKey, jobKey);

    await page.evaluate((hash) => {
      location.hash = hash;
    }, online);
    await page.waitForURL(host.url + workspace);
    assert.equal(await runningFrame.same(), true);
    assert.equal((await task()).status, 'running');
    assert.equal((await task()).jobKey, jobKey);
    assert.equal(statusChecks, beforeNavigation);
    assert.equal(submissions, 1);
    await runningFrame.dispose();

    clock += 1500;
    await frame.getByText('演示任务已转待人工核对', { exact: true }).first().waitFor();
    await lock(false);
    assert.equal((await task()).isTerminal, true);
    assert.equal((await task()).jobKey, jobKey);
    await sidebar.click();
    await page.waitForURL(host.url + mailboxes);
    await page.locator(frameSelector).waitFor({ state: 'detached' });

    // The real online host has tabs and refresh, while actual submission is in the workspace.
    // Exercise those host controls with the same iframe lock bridge used by submission.
    await page.evaluate((hash) => {
      location.hash = hash;
    }, online);
    await page.waitForURL(host.url + online);
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
        await route.continue().catch(() => {});
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
    assert.deepEqual(pageErrors, []);
  }
);
