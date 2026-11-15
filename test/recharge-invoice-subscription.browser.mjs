import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const prefix = '/integrations/codexdaichong';
const account = id => JSON.stringify({ user: { email: id + '@example.test' }, accessToken: syntheticToken(id) });

function syntheticToken(id, remaining = 3600) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [encode({ alg: 'RS256' }), encode({ sub: id, exp: Math.floor(Date.now() / 1000) + remaining }), 'synthetic'].join('.');
}

test('invoice query follows the currently pasted Session and renders only the original successful reply', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const width of [1440, 390]) await t.test(`${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    t.after(() => page.close());
    const { external, unavailable } = await interceptDesign(page.context());
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    const old = { start: Promise.withResolvers(), release: Promise.withResolvers() };
    const rejected = { status: 401, json: { success: false, message: 'Session 无效或已过期，请重新获取 Session' } };
    const successful = { success: true, data: {
      hasActiveSubscription: true, plan: 'ChatGPT Plus', email: 'new@example.test', expiresAtDisplay: '2026-12-13 18:00',
      billingPageUrl: 'https://unexpected.example.test/'
    } };
    let response = rejected;
    await page.route(origin + prefix + '/api/public/subscription/check', async route => {
      const request = route.request();
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers().origin, origin);
      const payload = request.postDataJSON();
      requests.push(payload);
      if (JSON.parse(payload.session).user.email === 'old@example.test') {
        old.start.resolve();
        await old.release.promise;
        await route.fulfill(rejected).catch(() => {});
      } else await route.fulfill(response);
    });

    await page.goto(origin + prefix + '/subscription');
    const input = page.locator('#sessionInput');
    const submit = page.locator('#checkBtn');
    const status = page.locator('#statusMessage');
    const results = page.locator('#resultSection');
    const billing = page.getByRole('link', { name: '打开 OpenAI 账单页面' });
    const chatgptLink = status.getByRole('link', { name: '打开 ChatGPT', exact: true });
    const previousSession = account('rejected');
    const oldSession = account('old');
    const newSession = account('new');
    const show = message => status.getByText(message).waitFor();
    assert(await billing.isVisible());

    await input.fill(JSON.stringify({ accessToken: syntheticToken('expired', -3600) }));
    await submit.click();
    await show('accessToken 已过期');
    assert.equal(requests.length, 0);
    assert(await chatgptLink.isHidden());

    await input.fill(previousSession);
    assert(await status.isHidden());
    await submit.click();
    await show('请在 ChatGPT 退出并重新登录，再点「获取 Session」');
    assert(await chatgptLink.isVisible());
    assert.equal(await chatgptLink.getAttribute('href'), 'https://chatgpt.com/');
    assert(await results.isHidden());
    assert(await billing.isVisible());
    assert.equal(await input.inputValue(), previousSession);

    await input.fill(oldSession);
    assert(await chatgptLink.isHidden());
    try {
      await submit.click();
      await old.start.promise;
      assert(await submit.isDisabled());
      response = { json: successful };
      await input.fill(newSession);
      assert(await submit.isEnabled());
      assert(await status.isHidden());
      await submit.click();
      await results.getByText('ChatGPT Plus', { exact: true }).waitFor();
    } finally { old.release.resolve(); }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await status.isHidden());
    assert(await results.getByText('new@example.test', { exact: true }).isVisible());
    assert.equal(await billing.getAttribute('href'), 'https://chatgpt.com/account/manage');
    assert.deepEqual(requests.map(({ session }) => session), [previousSession, oldSession, newSession]);
    assert(requests.every(request => Object.keys(request).length === 2 && Number.isFinite(request.timezone_offset_min)));

    const literalEmail = '<b>receipt@example.test</b>';
    response = { json: { ...successful, data: { ...successful.data, email: literalEmail } } };
    await submit.click();
    await results.getByText(literalEmail, { exact: true }).waitFor();
    assert.equal(await results.locator('b').count(), 0);

    const responseDetail = 'synthetic upstream response detail';
    response = { status: 502, contentType: 'text/html', body: '<p>' + responseDetail + '</p>' };
    await submit.click();
    await show('订阅查询服务响应异常（502）');
    assert(!(await status.textContent()).includes(responseDetail));

    response = { status: 401, json: { success: false, message: '请通过统一账号登录' } };
    await submit.click();
    await show('ID 系统登录已失效');
    assert(await chatgptLink.isHidden());
    assert.equal(await input.inputValue(), '');
    assert(await results.isHidden());
    assert(await billing.isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(unavailable, []);
  });
});
