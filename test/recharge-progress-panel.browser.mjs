import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

const path = '/integrations/codexdaichong/api/';
const jobKey = 'isolated-progress-task';
const actor = { id: 'fixture', name: '离线验收管理员', role: 'admin' };
const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fixtureSession = () => JSON.stringify({
  user: { id: 'fixture-user', email: 'fixture@example.test' },
  accessToken: [
    encode({ typ: 'JWT', alg: 'RS256' }),
    encode({ iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], scp: ['model.request'],
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_user_id: 'fixture' } }),
    'synthetic'
  ].join('.')
});

test('充值进度使用同一任务，桌面右栏和手机顺序正确，失联后保留上次进度', { timeout: 40_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const [width, dark, uncertain] of [[1440, false, false], [390, true, false], [320, false, true]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async (t) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor, localFixtures: {} });
      let submissions = 0, reads = 0, next;
      let confirm;
      const confirmation = new Promise((resolve) => { confirm = resolve; });
      await context.route((url) => url.pathname === path + 'verify-cdk', (request) =>
        request.fulfill({ json: { success: true, data: { plan_type: 'plus', plan_label: 'Plus' } } }));
      await context.route((url) => url.pathname === path + 'run-process', async (request) => {
        submissions++;
        await confirmation;
        return uncertain ? request.fulfill({ status: 503, json: { success: false } })
          : request.fulfill({ json: { success: true, jobKey } });
      });
      await context.route((url) => url.pathname === path + 'task-status/' + jobKey, (request) => {
        reads++;
        return next ? request.fulfill({ json: { success: true, data: { jobKey, ...next } } })
          : request.fulfill({ status: 503, json: { success: false } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(8000);
      await page.clock.install();
      await page.goto(origin + '/#/workspace/recharge');
      if (dark) await toggleDesignTheme(page);
      const frame = page.frameLocator('iframe[data-view="redeem"]:visible');
      const panel = frame.getByRole('complementary', { name: '充值进度' });
      await panel.getByText('待开始', { exact: true }).waitFor();
      const bounds = await panel.evaluate((aside) => {
        const bounds = aside.getBoundingClientRect();
        const stepOne = document.querySelector('#step1').getBoundingClientRect();
        const stepTwo = document.querySelector('#step2').getBoundingClientRect();
        return { top: bounds.top, left: bounds.left, right: bounds.right, stepTop: stepOne.top,
          stepRight: stepOne.right, formBottom: stepTwo.bottom,
          width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(!bounds.overflow && bounds.right <= bounds.width);
      if (width > 900) {
        assert(bounds.left >= bounds.stepRight + 12);
        assert(Math.abs(bounds.top - bounds.stepTop) <= 1);
      } else assert(bounds.top >= bounds.formBottom + 12);

      next = dark ? { status: 'running', stage: 'unrecognized', progress: 67 }
        : { status: 'running', stage: 'payment_details', progress: 37 };
      await frame.locator('#cdkInput').fill('KC-FIXTURE');
      await frame.locator('#redeemBtn').click();
      await frame.locator('#tokenInput').fill(fixtureSession());
      await frame.locator('#startBtn').click();
      await panel.getByText('正在确认提交结果…', { exact: true }).waitFor();
      assert.equal(await panel.locator('#taskProgressPercent').isVisible(), false);
      confirm();
      if (uncertain) {
        await panel.getByText('提交结果待核对，请用原兑换码查询。', { exact: true }).waitFor();
        assert.equal(await panel.locator('#taskProgress').isVisible(), false);
        assert.equal(await frame.locator('#startBtn').isEnabled(), false);
        assert.equal(submissions, 1);
        assert.equal(reads, 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
        return;
      }
      await panel.getByText(dark ? '处理中' : '正在填写支付资料', { exact: true }).waitFor();
      await panel.getByText(dark ? '67%' : '37%', { exact: true }).waitFor();
      assert.equal(await frame.getByRole('button', { name: '兑换码查询' }).isEnabled(), false);

      if (!dark) {
        next = undefined;
        await page.clock.fastForward(5100);
        await panel.getByText('正在重新连接，已保留上次进度。', { exact: true }).waitFor();
        assert.equal(await panel.locator('#taskProgressPercent').textContent(), '37%');
        next = { status: 'running', progress: 62, captcha: { id: 'fixture-verification', status: 'pending',
          stage: 'awaiting_captcha', expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        await page.clock.fastForward(5100);
        await panel.getByText('等待完成验证', { exact: true }).waitFor();
        assert.equal(await panel.getByRole('button', { name: '打开验证页面' }).isEnabled(), true);
      }
      next = dark ? { status: 'failed', progress: 67, manualReview: true }
        : { status: 'success', progress: 100, renewalUnconfirmed: true };
      await page.clock.fastForward(5100);
      const title = dark ? '开通结果待核对' : '开通成功';
      await panel.getByText(title, { exact: true }).waitFor();
      if (dark) await panel.getByText('结果待核实，请勿重复充值，请联系客服处理。', { exact: true }).waitFor();
      else await panel.getByText('自动续订取消状态未确认，请到目标账号账单页核对。', { exact: true }).waitFor();
      assert.equal(await panel.getByRole('button', { name: '打开验证页面' }).isVisible(), false);
      await frame.getByRole('button', { name: '兑换码查询' }).click();
      assert.equal(await panel.isVisible(), false);
      await frame.getByRole('button', { name: '自助充值' }).click();
      await panel.getByText(title, { exact: true }).waitFor();
      const finalReads = reads;
      await page.clock.fastForward(6000);
      assert.equal(reads, finalReads);
      assert.equal(submissions, 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    });
  }
});
