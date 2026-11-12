import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

const code = 'KC-OFFLINE-DISPLAY';
const jobKey = 'offline-recharge-display';
const email = 'offline-recharge@example.test';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const account = JSON.stringify({
  user: { email },
  accessToken: [
    encode({ typ: 'JWT', alg: 'RS256' }),
    encode({
      iss: 'https://auth.openai.com',
      aud: 'https://api.openai.com/v1',
      'https://api.openai.com/auth': { chatgpt_account_id: 'offline', chatgpt_user_id: 'offline' },
      scp: ['model.request'],
      exp: Math.floor(Date.now() / 1000) + 3600
    }),
    'offline-fixture-signature'
  ].join('.')
});
const api = origin + '/integrations/codexdaichong/api/';

test('recharge shortcuts and server-reported progress work on desktop and touch screens', async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const width of [1440, 390]) {
    await t.test(width + 'px', { timeout: 40_000 }, async (t) => {
      const mobile = width === 390;
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile });
      t.after(() => context.close());
      const routes = await interceptDesign(context, {
        actor: { id: 'display-fixture', name: '离线验收管理员', role: 'admin' }, localFixtures: {}
      });
      await context.addInitScript(() => {
        window.clipboardFixture = { value: '', denied: false };
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            async readText() {
              if (window.clipboardFixture.denied) throw new DOMException('Denied', 'NotAllowedError');
              return window.clipboardFixture.value;
            }
          }
        });
      });

      const page = await context.newPage();
      page.setDefaultTimeout(7500);
      await page.clock.install();
      const errors = [];
      const submissions = [];
      const verifyCodes = [];
      let socketAttempts = 0;
      let taskReads = 0;
      let reenterRunningCode = false;
      let task = { status: 'running', stage: 'payment_details', progress: 25 };
      let taskAvailable = true;
      let rejection = mobile ? 'plan-cards' : 'maintenance';
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('websocket', () => socketAttempts++);
      await page.route(api + 'verify-cdk', (route) => {
        verifyCodes.push(route.request().postDataJSON());
        const data = { plan_type: 'plus', plan_label: 'Plus' };
        if (reenterRunningCode) Object.assign(data, { status: 'processing', jobKey });
        return route.fulfill({ json: { success: true, data } });
      });
      await page.route(api + 'run-process', (route) => {
        submissions.push(route.request().postDataJSON());
        if (rejection) {
          const json = rejection === 'maintenance'
            ? { success: false, notAccepted: true, code: 'maintenance_mode', message: '系统维护中，充值任务未启动，请待维护结束后再提交' }
            : rejection === 'plan-cards'
              ? { success: false, notAccepted: true, code: 'recharge_plan_cards_unavailable', message: '该套餐暂无可用银行卡，请稍后再试或联系客服。' }
              : { success: false, message: 'Offline upstream unavailable' };
          return route.fulfill({ status: rejection === 'maintenance' || rejection === 'plan-cards' ? 503 : 200, json });
        }
        return route.fulfill({ json: { success: true, jobKey, stage: 'preparing' } });
      });
      await page.route(url => url.origin + url.pathname === api + 'task-status/' + jobKey, (route) => {
        taskReads++;
        return taskAvailable
          ? route.fulfill({ json: { success: true, data: { jobKey, ...task } } })
          : route.fulfill({ status: 503, json: { success: false } });
      });
      await page.route(api + 'cdk/query?*', (route) =>
        route.fulfill({ json: { success: true, data: { status: '开通中', planLabel: 'Plus', jobKey } } })
      );
      await page.route(api + 'cdk/query-batch', (route) =>
        route.fulfill({
          json: {
            success: true,
            data: { results: [{ cdk: code, status: '未使用' }], summary: { total: 1, unused: 1 } }
          }
        })
      );

      await page.goto(origin + '/#/workspace/recharge');
      const frame = page.frameLocator('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])');
      if (mobile) await toggleDesignTheme(page);
      const codeInput = frame.locator('#cdkInput');
      const accountInput = frame.locator('#tokenInput');
      const pasteCode = frame.getByRole('button', { name: '粘贴兑换码' });
      const pasteAccount = frame.getByRole('button', { name: '粘贴账号资料' });
      const clearCode = frame.getByRole('button', { name: '清空兑换码' });
      const clearAccount = frame.getByRole('button', { name: '清空账号资料' });
      const submit = frame.locator('#startBtn');
      const status = frame.locator('#statusMessage');
      const stage = frame.locator('#taskProgressText');
      const hint = frame.locator('#taskProgressHint');
      const title = frame.locator('#taskProgressTitle');
      const press = (button) => mobile ? button.tap() : button.click();
      const clipboard = (value, denied = false) =>
        frame.locator('html').evaluate((_html, fixture) => Object.assign(window.clipboardFixture, fixture), { value, denied });
      const waitForText = (target, message) => target.getByText(message, { exact: true }).waitFor();
      const advancePoll = () => page.clock.runFor(5200);

      await pasteCode.waitFor();
      assert.equal(await pasteAccount.isDisabled(), true);
      assert.equal(await frame.locator('#workspaceConfirm').count(), 0);
      if (mobile) {
        for (const target of [pasteCode, pasteAccount]) {
          assert.equal(await target.evaluate((button) => {
            const box = button.getBoundingClientRect();
            return box.height >= 44 && box.left >= 0 && box.right <= innerWidth;
          }), true);
        }
      }
      await clipboard(' ' + code + '\n');
      await press(pasteCode);
      assert.equal(await codeInput.inputValue(), code);
      assert.deepEqual(verifyCodes, []);
      await clipboard(' ');
      await press(pasteCode);
      await frame.locator('#cdkInputClipboardStatus').getByText(/剪贴板没有可粘贴的文本/).waitFor();
      assert.equal(await codeInput.inputValue(), code);
      await press(clearCode);
      assert.equal(await codeInput.inputValue(), '');
      assert.equal(await clearCode.isDisabled(), true);
      assert.deepEqual(verifyCodes, []);
      await clipboard(code);
      await press(pasteCode);
      await press(frame.locator('#redeemBtn'));
      await frame.locator('#workspaceVerifiedPlan').getByText(/Plus/).waitFor();
      assert.deepEqual(verifyCodes, [{ cdk: code }]);
      assert.equal(await pasteCode.isVisible(), false);
      await clipboard(account);
      await press(pasteAccount);
      assert.equal(await accountInput.inputValue(), account);
      await waitForText(frame.locator('#workspaceAccount'), email);
      assert.equal(await submit.isEnabled(), true);
      assert.deepEqual(submissions, []);
      await clipboard('', true);
      await press(pasteAccount);
      await frame.locator('#tokenInputClipboardStatus').getByText(/无法读取剪贴板/).waitFor();
      assert.equal(await accountInput.inputValue(), account);
      await press(clearAccount);
      assert.equal(await accountInput.inputValue(), '');
      assert.equal(await submit.isDisabled(), true);
      assert.deepEqual(submissions, []);
      await clipboard(account);
      await press(pasteAccount);

      await press(submit);
      await status.getByText(mobile ? /该套餐暂无可用银行卡/ : /系统维护中，充值任务未启动/).waitFor();
      assert.equal(await accountInput.inputValue(), account);
      assert.equal(await submit.isEnabled(), true);
      assert.deepEqual(submissions, [{ cdk: code, session: account }]);
      assert.equal(taskReads, 0);

      rejection = '';
      await press(submit);
      await waitForText(stage, '正在填写支付资料');
      await waitForText(title, '开通中');
      assert.equal(await frame.locator('#taskProgressPercent').textContent(), '25%');
      assert.equal(await frame.locator('#statusMessage').isVisible(), false);
      assert.equal(await accountInput.inputValue(), '');
      await waitForText(frame.locator('#workspaceAccount'), email);
      assert.equal(await pasteCode.isVisible(), false);
      assert.equal(await pasteAccount.isDisabled(), true);
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await frame.locator('#taskProgress').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(submissions.length, 2);

      taskAvailable = false;
      await advancePoll();
      await hint.getByText(/正在重新连接/).waitFor();
      assert.equal(await stage.textContent(), '正在填写支付资料');
      assert.equal(await submit.isDisabled(), true);
      taskAvailable = true;
      task = { status: 'running', stage: 'paying', progress: 40, captcha: { id: 'offline-captcha', stage: 'awaiting_captcha' } };
      await advancePoll();
      await waitForText(stage, '正在付款');
      assert.equal(await frame.locator('#captchaVerificationPanel').count(), 0);
      assert.equal(context.pages().length, 1);
      task = { status: 'running', stage: 'private stage fixture', progress: 100, captcha: null };
      await advancePoll();
      await waitForText(stage, '处理中');
      await hint.getByText(/无需重复提交/).waitFor();
      assert.equal(await frame.locator('#taskProgressPercent').textContent(), '99%');

      task = mobile
        ? { status: 'failed', manualReview: true, progress: 90, message: 'private diagnostic fixture' }
        : { status: 'success', renewalUnconfirmed: true, progress: 100, message: 'private diagnostic fixture' };
      await advancePoll();
      await waitForText(title, mobile ? '开通结果待核对' : '开通成功');
      assert.equal(await frame.locator('#taskProgressPercent').textContent(), mobile ? '99%' : '100%');
      if (!mobile) await hint.getByText(/自动续订取消状态未确认/).waitFor();
      assert.equal(await frame.getByText('private diagnostic fixture').count(), 0);
      assert.equal(await pasteAccount.isDisabled(), true);
      assert.equal(await submit.isDisabled(), true);

      task = { status: 'running', stage: 'subscription_check', progress: 90 };
      await press(frame.getByRole('button', { name: '兑换码查询', exact: true }));
      assert.equal(await frame.locator('#queryInput').inputValue(), code);
      const readsBeforeQuery = taskReads;
      await press(frame.locator('#queryBtn'));
      await waitForText(frame.locator('.query-result-card'), '正在确认订阅状态');
      assert.equal(taskReads, readsBeforeQuery + 1);
      await press(frame.getByRole('tab', { name: '批量查询', exact: true }));
      await frame.locator('#batchQueryInput').fill(code);
      await press(frame.locator('#batchQueryBtn'));
      await waitForText(frame.locator('.batch-query-row'), '未使用');
      assert.equal(taskReads, readsBeforeQuery + 1);
      await press(frame.getByRole('button', { name: '自助充值', exact: true }));
      await waitForText(title, mobile ? '开通结果待核对' : '开通成功');

      if (!mobile) {
        await page.reload();
        reenterRunningCode = true;
        await codeInput.fill(code);
        await press(frame.locator('#redeemBtn'));
        await waitForText(stage, '正在确认订阅状态');
        assert.equal(await submit.isDisabled(), true);
        assert.equal(submissions.length, 2);

        await page.reload();
        reenterRunningCode = false;
        rejection = 'unknown';
        await codeInput.fill(code);
        await press(frame.locator('#redeemBtn'));
        await accountInput.fill(account);
        await press(submit);
        await status.getByText(/提交结果暂时无法确认/).waitFor();
        assert.equal(await accountInput.inputValue(), '');
        assert.equal(await submit.isDisabled(), true);
        assert.equal(await pasteAccount.isDisabled(), true);
        assert.equal(submissions.length, 3);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(routes.external, []);
      assert.equal(socketAttempts, 0);
    });
  }
});
