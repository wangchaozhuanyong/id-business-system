import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { rechargeBrowserPresentation } from '../modules/recharge/codexdaichong/progress-presentation.mjs';

const prefix = '/integrations/codexdaichong';
const code = 'KC-SYNTHETIC-REVIEW';
const jobKey = 'synthetic-original-job';
const privateUrl = 'https://private-checkout.example.test/opaque-payment-link';
const reviewMessage = '结果待核实，请勿重复充值，请联系客服处理。';
const failureMessage = '执行失败，请联系客服处理。';

function syntheticSession() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const account = 'synthetic-browser-test-account';
  return JSON.stringify({
    user: { id: account, email: 'synthetic@example.test' },
    accessToken: [encode({ typ: 'JWT', alg: 'RS256' }), encode({
      iss: 'https://auth.openai.com',
      aud: ['https://api.openai.com/v1'],
      scp: ['model.request'],
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: account }
    }), 'unsigned-test-fixture'].join('.')
  });
}

const outcomes = [
  {
    name: '失败记录写入超长时显示待核实，并锁住同码再次提交',
    width: 1440,
    status: 'failed',
    progress: 80,
    original: "MySQL 执行失败: Data too long for column 'error_message' at row 1",
    title: '开通结果待核对',
    message: reviewMessage,
    locked: true
  },
  {
    name: 'Checkout 确认失败时在手机上显示执行失败',
    width: 390,
    status: 'failed',
    progress: 20,
    original: '等待 Checkout 页面超时，确认失败，未提交付款',
    title: '本次开通未完成',
    message: failureMessage,
    locked: false
  },
  {
    name: '原任务为 manual 时仍锁住同码再次提交',
    width: 390,
    status: 'manual',
    progress: 70,
    original: '演示任务已转待人工核对',
    title: '开通结果待核对',
    message: reviewMessage,
    locked: true
  }
];

test('自助充值终态在原任务回读后显示固定提示', { timeout: 45_000 }, async (t) => {
  const entry = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  assert(entry, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
  const { chromium } = await import(pathToFileURL(entry).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const outcome of outcomes) await t.test(outcome.name, async (subtest) => {
    const context = await browser.newContext({ viewport: { width: outcome.width, height: 950 }, serviceWorkers: 'block' });
    subtest.after(() => context.close());
    const intercepted = await interceptDesign(context);
    const session = syntheticSession();
    const requests = [];
    await context.route(origin + prefix + '/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(prefix.length);
      const method = request.method();
      if (path === '/api/verify-cdk' && method === 'POST') {
        requests.push({ method, path, body: request.postDataJSON() });
        return route.fulfill({ json: { success: true, data: { plan_type: 'plus', plan_label: 'Plus' } } });
      }
      if (path === '/api/run-process' && method === 'POST') {
        requests.push({ method, path, body: request.postDataJSON() });
        return route.fulfill({ json: { success: true, jobKey } });
      }
      if (path === '/api/task-status/' + jobKey && method === 'GET') {
        requests.push({ method, path });
        const result = rechargeBrowserPresentation(path, 200, { success: true, data: {
          jobKey, status: outcome.status, progress: outcome.progress, isTerminal: true,
          message: `${outcome.original} ${privateUrl}`, checkoutUrl: privateUrl, captcha: null
        } });
        assert.equal(result.data.manualReview === true, outcome.locked);
        return route.fulfill({ json: result });
      }
      if (method !== 'GET') {
        requests.push({ method, path });
        return route.abort();
      }
      return route.fallback();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + prefix + '/workspace');
    const cdk = page.locator('#cdkInput');
    const account = page.locator('#tokenInput');
    const submit = page.locator('#startBtn');
    const verifyCode = async () => {
      await cdk.fill(code);
      await page.getByRole('button', { name: '验证兑换码', exact: true }).click();
      await page.locator('#workspaceVerifiedPlan').waitFor();
    };
    await verifyCode();
    await account.fill(session);
    await submit.click();
    await page.locator('#taskProgressText').getByText(outcome.message, { exact: true }).waitFor();

    assert.equal(await page.locator('#taskProgressTitle').textContent(), outcome.title);
    assert.equal(await page.locator('#taskProgressText').textContent(), outcome.message);
    assert.equal(await page.locator('#taskProgressPercent').textContent(), `${outcome.progress}%`);
    assert.equal(await account.inputValue(), '', '账号资料在任务获受理后应清空');
    const text = await page.locator('body').innerText();
    assert(!text.includes(outcome.original));
    assert(!text.includes('error_message'));
    assert(!text.includes(privateUrl));
    assert.equal(await page.locator('a[href="' + privateUrl + '"]').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    assert.equal(await account.evaluate(input => input.readOnly), outcome.locked);
    if (outcome.locked) {
      await submit.evaluate((button) => button.click());
      await page.getByRole('button', { name: '更换兑换码', exact: true }).click();
      await verifyCode();
      assert.equal(await account.evaluate(input => input.readOnly), true);
      assert.equal(await submit.isDisabled(), true);
      await submit.evaluate((button) => button.click());
    } else {
      await account.fill(session);
      assert.equal(await submit.isEnabled(), true);
    }

    assert.deepEqual(requests, [
      { method: 'POST', path: '/api/verify-cdk', body: { cdk: code } },
      { method: 'POST', path: '/api/run-process', body: { session, cdk: code } },
      { method: 'GET', path: '/api/task-status/' + jobKey },
      ...(outcome.locked ? [{ method: 'POST', path: '/api/verify-cdk', body: { cdk: code } }] : [])
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
  });
});
