import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
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

test('两个兑换入口共用提交保护和查询响应归属', { timeout: 45_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const entry of ['/redeem', '/workspace']) await t.test(entry, async st => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    st.after(() => context.close());
    const intercepted = await interceptDesign(context);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const verifyCode = async value => {
      await page.locator('#cdkInput').fill(value);
      await page.locator('#redeemBtn').click();
    };
    const opened = Promise.withResolvers(), released = Promise.withResolvers();
    const batchOpened = Promise.withResolvers(), batchRelease = Promise.withResolvers();
    st.after(() => { released.resolve(); batchRelease.resolve(); });
    const submit = page.locator('#startBtn'), token = page.locator('#tokenInput');
    let submissionCount = 0;
    await context.route(origin + prefix + '/api/**', async route => {
      const request = route.request(), resource = new URL(request.url()).pathname.slice(prefix.length);
      if (resource === '/api/verify-cdk') return route.fulfill({ json: { success: true, data: {
        plan_type: 'plus', plan_label: 'Plus',
        ...(request.postDataJSON().cdk === 'SYNTHETIC-RUNNING' && { status: 'processing', jobKey })
      } } });
      if (resource === '/api/task-status/' + jobKey) return route.fulfill({ json: { success: true, data: {
        status: 'running', isTerminal: false, jobKey, progress: 28
      } } });
      if (resource === '/api/run-process') {
        submissionCount++;
        return route.abort('connectionreset');
      }
      if (resource === '/api/cdk/query') {
        opened.resolve();
        await released.promise;
        return route.fulfill({ status: 404, json: { success: false, message: '旧兑换码未找到' } });
      }
      if (resource === '/api/cdk/query-batch') {
        const [cdk] = request.postDataJSON().cdks;
        if (cdk === 'SYNTHETIC-OLD') {
          batchOpened.resolve();
          await batchRelease.promise;
        }
        return route.fulfill({ json: { success: true, data: { results: [{ cdk, status: '未使用' }] } } });
      }
      return route.fallback();
    });

    await page.goto(origin + prefix + entry);
    await verifyCode('SYNTHETIC-RUNNING');
    await page.getByText('28%', { exact: true }).waitFor();
    assert(await submit.isDisabled());
    assert(await token.evaluate(input => input.readOnly));
    await submit.evaluate(button => button.click());
    assert.equal(submissionCount, 0);

    await page.reload();
    const query = page.locator('.tab-btn[data-tab="query"]'), redeem = page.locator('.tab-btn[data-tab="redeem"]');
    const queryInput = page.locator('#queryInput'), status = page.locator('#statusMessage');
    await query.click();
    await queryInput.fill('SYNTHETIC-OLD');
    await page.locator('#queryBtn').click();
    await opened.promise;
    await redeem.click();
    await verifyCode(code);
    await token.fill(syntheticSession());
    await submit.click();
    await status.getByText('提交结果暂时无法确认，请用原兑换码查询。', { exact: true }).waitFor();
    assert(await submit.isDisabled());
    assert.equal(await token.inputValue(), '');
    assert.equal(await queryInput.inputValue(), code);
    released.resolve();
    await page.locator('#queryBtn:not([disabled])').waitFor({ state: 'attached' });
    assert.equal(await status.textContent(), '提交结果暂时无法确认，请用原兑换码查询。');
    await submit.evaluate(button => button.click());
    assert.equal(submissionCount, 1);

    await query.click();
    await page.locator('[data-query-mode="batch"]').click();
    const batchInput = page.locator('#batchQueryInput'), batchButton = page.locator('#batchQueryBtn');
    await batchInput.fill('SYNTHETIC-OLD');
    await batchButton.click();
    await batchOpened.promise;
    await batchInput.fill('SYNTHETIC-NEW');
    await batchButton.click();
    const results = page.locator('#batchQueryResults');
    await results.getByText('SYNTHETIC-NEW', { exact: true }).waitFor();
    batchRelease.resolve();
    assert.equal(await results.getByText('SYNTHETIC-OLD', { exact: true }).count(), 0);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
  });
});

test('整页刷新后沿用原兑换码的待核对状态，其他码仍可办理', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const otherCode = 'KC-SYNTHETIC-DIFFERENT';
  const lookupPath = '/api/task-status/' + jobKey;
  for (const entry of ['/redeem', '/workspace']) await t.test(entry, async st => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    st.after(() => context.close());
    const intercepted = await interceptDesign(context);
    let recoverOriginal = false, verificationUnavailable = false;
    const requests = [], firstSubmit = Promise.withResolvers(), release = Promise.withResolvers();
    st.after(() => release.resolve());
    await context.route(origin + prefix + '/api/**', async route => {
      const request = route.request(), resource = new URL(request.url()).pathname.slice(prefix.length);
      if (resource === '/api/verify-cdk') {
        const { cdk } = request.postDataJSON();
        if (verificationUnavailable) return route.fulfill({ status: 500, json: {
          success: false, message: '暂时无法验证兑换码'
        } });
        return route.fulfill({ json: { success: true, data: {
          plan_type: 'plus', plan_label: 'Plus',
          ...(recoverOriginal && cdk === code && { status: 'processing', jobKey })
        } } });
      }
      if (resource === lookupPath) return route.fulfill({ json: {
        success: true, data: { jobKey, status: 'failed', isTerminal: true, progress: 20 }
      } });
      if (resource === '/api/cdk/query') return route.fulfill({ json: {
        success: true, data: { status: '未使用', planLabel: 'Plus' }
      } });
      if (resource === '/api/run-process') {
        const { cdk } = request.postDataJSON();
        requests.push(cdk);
        if (requests.length === 1) {
          firstSubmit.resolve();
          await release.promise;
          return route.abort('connectionreset');
        }
        return route.fulfill({ status: 503, json: {
          success: false, notAccepted: true, code: 'maintenance_mode', message: '系统维护中，充值任务未启动'
        } });
      }
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const token = page.locator('#tokenInput'), submit = page.locator('#startBtn');
    const session = syntheticSession();
    const verify = async cdk => {
      await page.locator('#cdkInput').fill(cdk);
      await page.locator('#redeemBtn').click();
      await page.locator('#tokenInput:enabled').waitFor();
    };
    const assertPending = async () => {
      await page.getByText('该兑换码有待核对的提交，请先查询。', { exact: true }).waitFor();
      assert(await submit.isDisabled());
      assert(await token.evaluate(input => input.readOnly));
      await submit.evaluate(button => button.click());
      assert.deepEqual(requests, [code]);
    };

    await page.goto(origin + prefix + entry);
    await verify(code);
    await token.fill(session);
    const clicking = submit.click();
    await firstSubmit.promise;
    await clicking;
    const storage = await page.evaluate(() => Object.entries(sessionStorage)
      .filter(([key]) => key.startsWith('id-recharge-review:')));
    assert.equal(storage.length, 2, 'one salt and one opaque in-flight marker');
    assert(storage.some(([key, value]) => /^id-recharge-review:[a-f0-9]{64}$/.test(key) && value === 'pending'));
    assert(!JSON.stringify(storage).includes(code));
    assert(!JSON.stringify(storage).includes('unsigned-test-fixture'));

    // Reload while the first request is still outstanding.
    await page.reload();
    release.resolve();
    verificationUnavailable = true;
    await page.locator('#cdkInput').fill(code.toLowerCase());
    await page.locator('#redeemBtn').click();
    await page.locator('#statusMessage').getByText('暂时无法验证兑换码 该兑换码有待核对的提交，请先查询。', { exact: true }).waitFor();
    await page.locator('.tab-btn[data-tab="query"]').click();
    assert.equal(await page.locator('#queryInput').inputValue(), code.toLowerCase());
    await page.locator('#queryBtn').click();
    await page.locator('#statusMessage').getByText('未使用', { exact: true }).waitFor();
    await page.getByText('上次提交仍待核对，请联系客服确认，勿重复提交。', { exact: true }).waitFor();
    await page.locator('.tab-btn[data-tab="redeem"]').click();
    verificationUnavailable = false;
    await verify(code.toLowerCase());
    await assertPending();
    assert(await submit.isDisabled(), 'an unused-code lookup does not establish the original submission outcome');

    const alternate = entry === '/redeem' ? '/workspace' : '/redeem';
    await page.goto(origin + prefix + alternate);
    await verify(code);
    await assertPending();
    await page.locator('#backToStep1').click();
    await verify(otherCode);
    await token.fill(session);
    await submit.click();
    await page.getByText('系统维护中，充值任务未启动', { exact: true }).waitFor();
    assert(await submit.isEnabled(), 'an explicit refusal keeps the new code retryable');
    assert.equal(await page.evaluate(() => Object.values(sessionStorage).filter(value => value === 'pending').length), 1);

    await page.reload();
    recoverOriginal = true;
    await verify(code);
    await page.locator('#taskProgressTitle').getByText('本次开通未完成', { exact: true }).waitFor();
    await token.fill(session);
    assert(await submit.isEnabled(), 'the original task receipt controls whether another attempt is available');
    assert.equal(await page.evaluate(() => Object.values(sessionStorage).filter(value => value === 'pending').length), 0);
    assert.deepEqual(requests, [code, otherCode]);
    assert.deepEqual(errors, []);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
  });
});

test('旧验码请求失败后不会覆盖重新打开的兑换表单', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const entry of ['/redeem', '/workspace']) await t.test(entry, async subtest => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    subtest.after(() => context.close());
    const intercepted = await interceptDesign(context);
    const previousRequest = Promise.withResolvers(), release = Promise.withResolvers();
    subtest.after(() => release.resolve());
    await context.route(origin + prefix + '/api/verify-cdk', async route => {
      if (route.request().postDataJSON().cdk === code) {
        previousRequest.resolve();
        await release.promise;
        return route.abort('connectionreset');
      }
      return route.fulfill({ json: { success: true, data: { plan_type: 'plus', plan_label: 'Plus' } } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(origin + prefix + entry);
    const input = page.locator('#cdkInput'), verify = page.locator('#redeemBtn');
    await input.fill(code);
    await verify.click();
    await previousRequest.promise;

    await page.evaluate(() => window.idRechargeClearTransient());
    await input.fill('KC-SYNTHETIC-NEW');
    await verify.click();
    await page.locator('#tokenInput:enabled').waitFor();
    const failed = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/verify-cdk'));
    release.resolve();
    await failed;
    await settle(page);
    assert(await page.locator('#statusMessage').isHidden());
    assert.equal(await page.getByText('暂时无法读取兑换码校验结果。', { exact: true }).count(), 0);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
  });
});

test('切到兑换码查询后，迟到的验码结果不会盖掉查询内容', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const entry of ['/redeem', '/workspace']) await t.test(entry, async subtest => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    subtest.after(() => context.close());
    const intercepted = await interceptDesign(context);
    const verifying = Promise.withResolvers(), release = Promise.withResolvers();
    subtest.after(() => release.resolve());
    await context.route(origin + prefix + '/api/**', async route => {
      const resource = new URL(route.request().url()).pathname.slice(prefix.length);
      if (resource === '/api/verify-cdk') {
        verifying.resolve();
        await release.promise;
        return route.fulfill({ status: 500, json: { success: false, message: '原验码请求失败' } });
      }
      if (resource === '/api/cdk/query') return route.fulfill({ json: {
        success: true, data: { status: '未使用', planLabel: '查询到的套餐' }
      } });
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(origin + prefix + entry);
    const input = page.locator('#cdkInput'), verify = page.locator('#redeemBtn');
    await input.fill(code);
    await verify.click();
    await verifying.promise;
    await page.locator('.tab-btn[data-tab="query"]').click();
    await page.locator('#queryInput').fill('KC-SYNTHETIC-QUERY');
    await page.locator('#queryBtn').click();
    const result = page.locator('#statusMessage').getByText('查询到的套餐', { exact: true });
    await result.waitFor();
    const received = page.waitForEvent('requestfinished', request => request.url().endsWith('/api/verify-cdk'));
    release.resolve();
    await received;
    await settle(page);
    assert(await result.isVisible());
    assert.equal(await page.getByText('原验码请求失败', { exact: true }).count(), 0);
    await page.locator('.tab-btn[data-tab="redeem"]').click();
    assert(await verify.isEnabled());
    assert(await input.isEditable());
    assert.equal(await input.inputValue(), code);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
  });
});

test('会话存储不可用时在发送前提示，验码和查询仍可使用', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await interceptDesign(context);
  await context.addInitScript(() => {
    const store = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('id-recharge-review:')) throw new DOMException('fixture', 'QuotaExceededError');
      return store.call(this, key, value);
    };
  });
  let submissions = 0;
  await context.route(origin + prefix + '/api/**', route => {
    const resource = new URL(route.request().url()).pathname.slice(prefix.length);
    if (resource === '/api/verify-cdk') return route.fulfill({ json: { success: true, data: { plan_type: 'plus' } } });
    if (resource === '/api/cdk/query') return route.fulfill({ json: { success: true, data: { status: '未使用' } } });
    if (resource === '/api/run-process') { submissions++; return route.abort(); }
    return route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin + prefix + '/workspace');
  await page.locator('#cdkInput').fill(code);
  await page.locator('#redeemBtn').click();
  await page.locator('#tokenInput').fill(syntheticSession());
  await page.locator('#startBtn').click();
  await page.getByText(/无法保存本次提交的核对状态/).waitFor();
  assert.equal(submissions, 0);
  await page.locator('.tab-btn[data-tab="query"]').click();
  await page.locator('#queryBtn').click();
  await page.locator('#statusMessage').getByText('未使用', { exact: true }).waitFor();
});
