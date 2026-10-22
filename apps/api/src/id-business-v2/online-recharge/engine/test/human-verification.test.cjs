'use strict';
/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const { waitForHumanVerification, assertOriginalIdentity } = require('../human-verification.cjs');
const { installChatGptSession, bootstrapChatGptSession } = require('../upstream/session-auth');
const accountId = 'synthetic-account',
  userId = 'synthetic-user';
const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId } })).toString('base64url')}.synthetic`;
const session = {
  accessToken: token,
  account: { id: accountId },
  user: { id: userId, email: 'human@example.invalid' },
  sessionToken: 'synthetic-cookie'
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = privateKey.export({ format: 'pem', type: 'pkcs8' });
const cert = execFileSync(
  '/bin/sh',
  ['-c', 'cat | openssl req -new -x509 -key /dev/stdin -sha256 -days 1 -subj /CN=localhost'],
  { input: key, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
);

async function fixture(t, options = {}) {
  const requests = [],
    calls = [];
  let actual = session,
    clicks = 0,
    closed = false,
    screen;
  const server = https.createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, 'https://chatgpt.com');
    requests.push({
      path: url.pathname,
      native: url.searchParams.has('manual_verification'),
      authorization: Boolean(request.headers.authorization),
      closed
    });
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET') return response.writeHead(409).end();
    if (url.pathname === '/api/auth/session') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(actual));
    }
    response.setHeader('content-type', 'text/html');
    if (request.headers.host === 'challenges.cloudflare.com')
      return response.end(
        '<!doctype html><style>body{margin:0}input{position:absolute;left:10px;top:10px;width:25px;height:25px}</style><input aria-label="Synthetic checkbox" type="checkbox" onclick="parent.postMessage(\'synthetic-pass\',\'https://chatgpt.com\')">'
      );
    response.end(
      `<!doctype html><h1>Verify you are human</h1><p>Cloudflare security check</p><iframe style="width:300px;height:100px;border:0" src="https://challenges.cloudflare.com/turnstile/fixture"></iframe><script>addEventListener('message',event=>{if(event.origin==='https://challenges.cloudflare.com'&&event.data==='synthetic-pass'){document.body.innerHTML='<main><button>New chat</button><textarea id="prompt-textarea"></textarea></main>';window.syntheticClicks=(window.syntheticClicks||0)+1;}})</script>`
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-proxy-server',
      '--disable-background-networking',
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}, MAP challenges.cloudflare.com 127.0.0.1:${server.address().port}, MAP * ~NOTFOUND`
    ]
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  if (options.install) await installChatGptSession(context, JSON.stringify(session));
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  await page
    .frames()
    .find((frame) => frame.url().includes('challenges.cloudflare.com'))
    ?.waitForLoadState();
  const rpc = async (method, args) => {
    calls.push({ method, ack: args.ack });
    if (method === 'humanVerificationOpen') return { generation: 'synthetic-generation' };
    if (method === 'humanVerificationPoll') {
      screen ||= args.screen;
      if (options.cancel) return { stopped: true };
      return options.noClick
        ? { command: null }
        : { command: { sequence: 1, kind: 'click', frameId: screen.frameId, x: 20, y: 20 } };
    }
    if (method === 'humanVerificationAuthorize') {
      if (options.leaseLost)
        throw Object.assign(new Error('synthetic lease lost'), { code: 'LEASE_LOST' });
      return options.revoke ? { stopped: true } : { authorized: true };
    }
    if (method === 'humanVerificationClose') {
      closed = true;
      return { stopped: options.closeUnconfirmed !== true };
    }
    return { ok: true };
  };
  return {
    page,
    context,
    calls,
    requests,
    rpc,
    getScreen: () => screen,
    actual: (value) => {
      actual = value;
    },
    clicks: async () => {
      clicks = await page.evaluate(() => window.syntheticClicks || 0);
      return clicks;
    }
  };
}

test('原页人工点击仅作用于验证 iframe，撤销交互后再读取真实同账号会话', async (t) => {
  const f = await fixture(t, { install: true });
  await waitForHumanVerification(f.page, { deadlineAt: performance.now() + 6000 }, { rpc: f.rpc });
  assert.equal(await f.clicks(), 1);
  assert.equal(f.getScreen().width, 300);
  assert.equal(f.getScreen().height, 100);
  assert.equal(f.calls.at(-1).method, 'humanVerificationClose');
  await assertOriginalIdentity(f.page, JSON.stringify(session), {
    deadlineAt: performance.now() + 4000
  });
  const native = f.requests.filter((item) => item.native);
  assert.equal(native.length, 1);
  assert.equal(native[0].closed, true);
  assert.equal(native[0].authorization, false);
});
test('官网真实身份变化时拒绝继续，页面 Session 同样返回真实账号', async (t) => {
  const f = await fixture(t, { install: true });
  f.actual({ ...session, account: { id: 'other-account' } });
  await assert.rejects(assertOriginalIdentity(f.page, JSON.stringify(session)), {
    code: 'ACCOUNT_MISMATCH'
  });
  assert.equal(f.requests.filter((item) => item.native).length, 1);
  assert.equal(
    await f.page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).account.id),
    'other-account'
  );
});
for (const [label, options, code] of [
  ['取消', { cancel: true }, 'HUMAN_VERIFICATION_CANCELLED'],
  ['迟到授权', { revoke: true }, 'HUMAN_VERIFICATION_CANCELLED'],
  ['失去租约', { leaseLost: true }, 'LEASE_LOST']
])
  test(`${label}后不点击、不进入付款，仍撤销接管`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(
      waitForHumanVerification(f.page, { deadlineAt: performance.now() + 4000 }, { rpc: f.rpc }),
      { code }
    );
    assert.equal(await f.clicks(), 0);
    assert.equal(f.calls.at(-1).method, 'humanVerificationClose');
    assert.equal(
      f.requests.some((item) => /checkout|payment/.test(item.path)),
      false
    );
  });
test('人工等待不延长传入总期限', async (t) => {
  const f = await fixture(t, { noClick: true });
  const start = performance.now();
  await assert.rejects(
    waitForHumanVerification(f.page, { deadlineAt: start + 350 }, { rpc: f.rpc }),
    { code: 'VERIFICATION_TIMEOUT' }
  );
  assert.ok(performance.now() - start < 1500);
  assert.equal(await f.clicks(), 0);
  assert.equal(f.calls.at(-1).method, 'humanVerificationClose');
});
test('真实 bootstrap 在同页接续并重新检查身份，不重新创建浏览器或充值任务', async (t) => {
  const f = await fixture(t, { install: true });
  const result = await bootstrapChatGptSession(f.page, JSON.stringify(session), {
    cookieVerified: true,
    sessionData: session,
    deadlineAt: performance.now() + 12000,
    onHumanVerification: (page, options) => waitForHumanVerification(page, options, { rpc: f.rpc })
  });
  assert.equal(result.email, session.user.email);
  assert.equal(await f.clicks(), 1);
  assert.equal(f.context.pages().length, 1);
  assert.equal(f.calls.filter((item) => item.method === 'humanVerificationOpen').length, 1);
  assert.equal(f.requests.filter((item) => item.native).length, 1);
});

test('撤销接管回执未确认时不继续登录或结账', async (t) => {
  const f = await fixture(t, { closeUnconfirmed: true });
  await assert.rejects(
    waitForHumanVerification(f.page, { deadlineAt: performance.now() + 4000 }, { rpc: f.rpc }),
    { code: 'HUMAN_VERIFICATION_REQUIRED' }
  );
  assert.equal(
    f.requests.filter((item) => item.native || /checkout|payment/.test(item.path)).length,
    0
  );
});
test('主页面离开原首页立即停止，验证指令不能导航或付款', async (t) => {
  const f = await fixture(t);
  const rpc = async (method, args) => {
    if (method === 'humanVerificationPoll') await f.page.goto('https://chatgpt.com/pricing');
    return f.rpc(method, args);
  };
  await assert.rejects(
    waitForHumanVerification(f.page, { deadlineAt: performance.now() + 4000 }, { rpc }),
    { code: 'HUMAN_VERIFICATION_REQUIRED' }
  );
  assert.equal(await f.clicks(), 0);
});
