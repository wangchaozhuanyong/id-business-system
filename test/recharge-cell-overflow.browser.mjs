import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test(
  'recharge table messages stay within their columns and retain full text',
  { timeout: 45_000 },
  async (t) => {
    const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
    const browser = await playwright.chromium.launch({
      channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const message = '结账阶段等待超时。' + '长文字'.repeat(100) + ' <img src=x> "末尾"';
    const tasks = Array.from({ length: 23 }, (_, index) => ({
      id: `fixture-${index}`,
      cdk: '尾号 1234',
      token: '已记录（隐藏）',
      message,
      automation: { phase: '准备订阅' },
      progress: 20,
      status: ['manual', 'failed', 'running', 'success', 'card_invalid', 'maintenance', 'fixture-unknown'][index] ?? 'failed'
    }));
    const holdCode = 'KC-FIXTURE-REVIEW1234';
    const holds = [{ id: 1, failedJobKey: 'fixture-session', cdkCode: holdCode, accountEmail: 'test@example.test', reason: message }];
    const denied = '当前账号无权执行此操作';
    let sessionVerified = false;
    let verificationRequests = 0;
    let codeListRequests = 0;
    let sessionReadError = '';
    let sessionRecordStatus = 'manual';
    let resolveAttempts = 0;
    let taskRows = tasks;
    let taskReadFailed = false;
    let deferHoldSnapshot;
    await interceptDesign(page.context(), {
      localFixtures: {},
      localAuthUi: true,
      actor: { id: 'fixture-admin', name: '测试管理员', role: 'super' }
    });
    await page.route('**/api/local/auth/security', (route) => route.fulfill({
      json: { available: true, bound: true, passwordConfirmed: sessionVerified }
    }));
    await page.route('**/api/local/auth/security/confirm-password', (route) => {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), { password: 'fixture-action-only' });
      verificationRequests += 1;
      sessionVerified = true;
      return route.fulfill({ json: { success: true } });
    });
    await page.route('**/integrations/codexdaichong/api/admin/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const path = pathname.split('/').pop();
      if (path === 'data')
        return route.fulfill({
          json: {
            stats: { total: taskRows.length, success: 0, failed: taskRows.length },
            config: {},
            logs: taskRows.map(({ id, status, progress }) => ({ id, status, progress })),
            manual_holds: []
          }
        });
      if (path === 'task-logs') return taskReadFailed
        ? route.fulfill({ status: 503, json: { success: false } })
        : route.fulfill({ json: { tasks: taskRows } });
      if (path === 'cdks') {
        codeListRequests += 1;
        if (!sessionVerified) return route.fulfill({
          status: 403,
          json: { error: '请用当前登录密码确认这项操作', code: 'SECURITY_CONFIRMATION_REQUIRED' }
        });
        return route.fulfill({ json: [{ code: 'FIXTURE-REDEEMABLE-CODE', type: '自助' }] });
      }
      if (path === 'activation-manual-holds') {
        const snapshot = [...holds];
        const defer = deferHoldSnapshot;
        deferHoldSnapshot = undefined;
        if (defer) await defer();
        return route.fulfill({ json: { success: true, holds: snapshot } });
      }
      if (pathname.endsWith('/activation-manual-holds/1/resolve') && route.request().method() === 'POST') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) return route.fulfill({ status: 403, json: { error: denied } });
        holds.length = 0;
        return route.fulfill({ json: { success: true, message: '人工审核已解除，该卡密可重新提交' } });
      }
      if (path === 'sessions') {
        if (sessionReadError) return route.fulfill({ status: 503, json: { error: sessionReadError } });
        return route.fulfill({
          json: {
            items: [
              {
                job_key: 'fixture-session',
                token_preview: 'test@example.test',
                has_session: true,
                message,
                status: sessionRecordStatus
              }
            ],
            total: 1
          }
        });
      }
      if (pathname.endsWith('/sessions/fixture-session')) {
        if (!sessionVerified) return route.fulfill({
          status: 403,
          json: { error: '请用当前登录密码确认这项操作', code: 'SECURITY_CONFIRMATION_REQUIRED' }
        });
        return route.fulfill({ json: { success: true, session: { session_payload: '{"note":"隔离测试资料"}' } } });
      }
      return route.fallback();
    });
    await page.goto(origin + '/#/online-recharge/chatgpt');
    const frame = page.frameLocator('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe[data-view-group="admin"]:not([hidden])');
    async function select(view) {
      await page.locator(`button[data-view="${view}"]`).click();
      await frame.locator(`#${view}.active`).waitFor();
    }
    async function checkRow(body) {
      const row = frame.locator(`#${body} tr`).first();
      const preview = row.locator('.recharge-cell-text').first();
      await preview.waitFor();
      assert.equal(await preview.getAttribute('title'), message);
      assert.deepEqual(
        await preview.evaluate((node) => {
          const cell = node.closest('td');
          const style = getComputedStyle(node);
          return {
            overflow: style.overflowX,
            ellipsis: style.textOverflow,
            textClipped: node.scrollWidth > node.clientWidth,
            insideCell:
              node.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 1,
            cellFits: cell.scrollWidth <= cell.clientWidth + 1
          };
        }),
        {
          overflow: 'hidden',
          ellipsis: 'ellipsis',
          textClipped: true,
          insideCell: true,
          cellFits: true
        }
      );
      assert.equal(await row.locator('td:last-child button').first().isEnabled(), true);
      assert.equal(
        await row
          .locator('td:last-child')
          .evaluate((cell) => cell.scrollWidth <= cell.clientWidth + 1),
        true
      );
      assert.equal(await row.locator('img').count(), 0);
      return preview;
    }

    await select('logs');
    await frame.getByRole('button', { name: '停止自动刷新' }).click();
    await frame.getByText('已转入人工确认的任务，可在「待人工确认」中核对。', { exact: false }).waitFor();
    assert.equal(await frame.locator('#log_body [data-delete-task]').count(), 0);
    await checkRow('log_body');
    await frame.locator('#log_body').getByText('尾号 1234', { exact: true }).first().waitFor();
    await frame.locator('#log_body').getByText('已记录（隐藏）', { exact: true }).first().waitFor();
    await frame.locator('#log_body').getByText('曾转人工', { exact: true }).waitFor();
    assert.deepEqual((await frame.locator('#log_body .status-badge').allTextContents()).slice(0, 7),
      ['曾转人工', '失败', '处理中', '成功', '银行卡无效', '维护中断', '未知状态']);
    await frame.locator('body').evaluate(() => window.loadData(false));
    await checkRow('log_body');
    await frame.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await frame.locator('#log_body tr').count(), 3);
    await checkRow('log_body');
    await frame.getByRole('button', { name: '上一页', exact: true }).click();

    await select('sessions');
    const sessionStatus = frame.locator('#session_list_status');
    const refreshSessions = frame.locator('#sessions').getByRole('button', { name: '刷新', exact: true });
    const verification = page.getByRole('dialog', { name: '确认重要操作' });
    await checkRow('session_body');
    await frame.locator('#session_body').getByText('曾转人工', { exact: true }).waitFor();
    await refreshSessions.click();
    await sessionStatus.waitFor({ state: 'hidden' });
    assert.equal(await verification.count(), 0);
    const sessionLink = frame.locator('#session_body [data-view-session]');
    const sessionBody = frame.locator('#session_modal_body');
    const closeSession = frame.locator('#session_modal_overlay button[onclick="closeSessionModal()"]').first();
    await sessionLink.click();
    await verification.getByRole('button', { name: '取消', exact: true }).click();
    await sessionBody.getByText(/请用当前登录密码确认/).waitFor();
    await closeSession.click();
    assert.equal(verificationRequests, 0);
    await sessionLink.click();
    await verification.getByLabel('当前登录密码').fill('fixture-action-only');
    await verification.getByRole('button', { name: '确认', exact: true }).click();
    await sessionBody.getByText(/隔离测试资料/).waitFor();
    await closeSession.click();
    assert.equal(verificationRequests, 1);
    assert.equal(await frame.locator('#session_body [data-delete-task]').count(), 0);
    assert.equal(await frame.locator('#session_body [data-copy-session]').count(), 1);
    assert.equal(await frame.locator('#session_body [data-export-session]').count(), 1);
    assert.equal(codeListRequests, 0, '浏览其它页面没有在后台读取完整充值码');
    await select('cdks');
    await frame.locator('#cdk_body').getByText('FIXTURE-REDEEMABLE-CODE', { exact: true }).waitFor();
    assert.equal(verificationRequests, 1, '当前会话已确认密码时，查看完整充值码无需重复输入');
    await page.locator('#theme-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    sessionReadError = '暂时无法读取代充资料';
    await select('sessions');
    await refreshSessions.click();
    await frame.getByText(sessionReadError, { exact: true }).waitFor();
    await checkRow('session_body');
    await select('logs');
    const taskPreview = await checkRow('log_body');
    await taskPreview.press('Enter');
    const dialog = frame.getByRole('dialog', { name: '完整内容' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.recharge-cell-full-text').textContent(), message);
    assert.equal(await dialog.locator('img').count(), 0);
    await dialog.getByRole('button', { name: '关闭' }).press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    await frame.getByRole('button', { name: '恢复自动刷新', exact: true }).click();
    await frame.getByRole('tab', { name: '待人工确认', exact: true }).click();
    const holdPreview = await checkRow('activation_manual_hold_body');
    const holdRows = frame.locator('#activation_manual_hold_body');
    await holdRows.getByText(holdCode, { exact: true }).waitFor();
    await frame.locator('body').evaluate(() => window.loadData(false));
    await holdRows.getByText(holdCode, { exact: true }).waitFor();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/admin/data')),
      page.waitForResponse(response => response.url().includes('/api/admin/activation-manual-holds?')
        && response.request().method() === 'GET')
    ]);
    await holdRows.getByText(holdCode, { exact: true }).waitFor();
    await holdPreview.tap();
    assert.equal(await dialog.locator('.recharge-cell-full-text').textContent(), message);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await dialog.waitFor({ state: 'hidden' });

    const resolveHold = frame.getByRole('button', { name: '解除', exact: true });
    const confirmHold = frame.locator('#admin_confirm_ok');
    await resolveHold.click();
    await confirmHold.click();
    await frame.locator('#message_container').getByText(denied, { exact: true }).waitFor();

    let releaseOldRead;
    const oldReadStarted = new Promise(start => {
      deferHoldSnapshot = () => new Promise(resume => { releaseOldRead = resume; start(); });
    });
    t.after(() => releaseOldRead?.());
    await frame.locator('[data-switch-panel="holds"]').getByRole('button', { name: '刷新', exact: true }).click();
    await oldReadStarted;
    await resolveHold.click();
    await confirmHold.click();
    await frame.getByText('暂无待人工确认记录', { exact: true }).waitFor();
    const oldResponse = page.waitForResponse(response => response.url().includes('/api/admin/activation-manual-holds?'));
    releaseOldRead();
    const oldResult = await (await oldResponse).json();
    assert.equal(oldResult.holds.length, 1);
    await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await holdRows.getByText(holdCode, { exact: true }).count(), 0);
    assert.equal(resolveAttempts, 2);
    await select('sessions');
    await frame.locator('#session_body').getByText('曾转人工', { exact: true }).waitFor();
    sessionReadError = '';
    sessionRecordStatus = 'FAILED';
    await refreshSessions.click();
    await frame.locator('#session_body').getByText('失败', { exact: true }).waitFor();
    await select('logs');

    await frame.getByRole('tab', { name: '任务管理', exact: true }).click();
    await frame.locator('#log_body').getByText('尾号 1234', { exact: true }).first().waitFor();
    const refreshTasks = frame.getByRole('button', { name: '立即刷新' });
    taskReadFailed = true;
    await refreshTasks.click();
    await frame.locator('#message_container').getByText('刷新失败，已保留上次记录', { exact: true }).waitFor();
    await frame.locator('#log_body').getByText('尾号 1234', { exact: true }).first().waitFor();
    taskReadFailed = false;
    taskRows = [];
    await refreshTasks.click();
    await frame.getByText('暂无任务记录', { exact: true }).waitFor();
    assert.equal(await frame.locator('#log_body .recharge-cell-text').count(), 0);
    assert.deepEqual(errors, []);
  }
);
