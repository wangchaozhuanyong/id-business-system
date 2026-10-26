'use strict';
/* global window, document */
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
  const server = https.createServer({ key, cert }, async (request, response) => {
    const url = new URL(request.url, 'https://chatgpt.com');
    requests.push({
      path: url.pathname,
      method: request.method,
      native: url.searchParams.has('manual_verification'),
      authorization: Boolean(request.headers.authorization),
      closed
    });
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET') return response.writeHead(409).end();
    if (url.pathname.startsWith('/backend-api/accounts/check/') && options.accountReply) {
      const reply = await options.accountReply();
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      return response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    }
    if (url.pathname === '/api/auth/session') {
      if (options.sessionChallenge && !options.sessionChallengeCleared) {
        response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        return response.end(
          `<h1>Verify you are human</h1><p>Cloudflare security check</p>${options.noActionableSession ? '' : '<iframe style="width:300px;height:100px;border:0" src="https://challenges.cloudflare.com/turnstile/fixture"></iframe>'}<script>addEventListener('message',event=>{if(event.origin==='https://challenges.cloudflare.com'&&event.data==='synthetic-pass')document.body.innerHTML='<main>Verified</main>';})</script>`
        );
      }
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(actual));
    }
    response.setHeader('content-type', 'text/html');
    if (request.headers.host === 'challenges.cloudflare.com')
      return response.end(
        '<!doctype html><style>body{margin:0}input{position:absolute;left:10px;top:10px;width:25px;height:25px}</style><input aria-label="Synthetic checkbox" type="checkbox" onclick="parent.postMessage(\'synthetic-pass\',\'https://chatgpt.com\')">'
      );
    response.end(
      `<!doctype html>${options.initiallyClear ? '<main><button>New chat</button><textarea id="prompt-textarea"></textarea></main>' : '<h1>Verify you are human</h1><p>Cloudflare security check</p><iframe style="width:300px;height:100px;border:0" src="https://challenges.cloudflare.com/turnstile/fixture"></iframe>'}<script>addEventListener('message',event=>{if(event.origin==='https://challenges.cloudflare.com'&&event.data==='synthetic-pass'){document.body.innerHTML='<main><button>New chat</button><textarea id="prompt-textarea"></textarea></main>';window.syntheticClicks=(window.syntheticClicks||0)+1;}})</script>`
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

for (const mode of ['completed', 'no_actionable', 'identity_mismatch', 'cancelled']) {
  test(`首次Session挑战接续：${mode}，保留首次分类并仅在原探针页面完成人工验证`, async (t) => {
    const options = {
      initiallyClear: true,
      sessionChallenge: true,
      noActionableSession: mode === 'no_actionable',
      cancel: mode === 'cancelled'
    };
    const f = await fixture(t, options);
    let originalProbe,
      waits = 0;
    const pending = installChatGptSession(f.context, JSON.stringify(session), {
      deadlineAt: performance.now() + 10000,
      onHumanVerification: async (page, opts) => {
        waits++;
        originalProbe = page;
        assert.equal(page.context(), f.context);
        assert.equal(page.url(), 'https://chatgpt.com/api/auth/session');
        assert.equal(opts.sessionProbe, true);
        const result = await waitForHumanVerification(page, opts, { rpc: f.rpc });
        options.sessionChallengeCleared = true;
        if (mode === 'identity_mismatch')
          f.actual({ ...session, account: { id: 'other-account' } });
        return result;
      }
    });
    if (['identity_mismatch', 'cancelled'].includes(mode)) {
      await assert.rejects(pending, (error) => {
        assert.equal(
          error.code,
          mode === 'cancelled' ? 'HUMAN_VERIFICATION_CANCELLED' : 'ACCOUNT_MISMATCH'
        );
        assert.equal(error.bootstrapDiagnostics.initialSessionProbe.classification, 'CF_CHALLENGE');
        return true;
      });
    } else {
      const result = await pending;
      assert.equal(result.cookieVerified, mode === 'completed');
      assert.equal(result.initialSessionProbe.classification, 'CF_CHALLENGE');
      assert.equal(result.initialSessionProbe.manualActionable, mode === 'completed');
      if (mode === 'completed') assert.equal(result.initialSessionProbe.manualCompleted, true);
    }
    assert.equal(waits, mode === 'no_actionable' ? 0 : 1);
    assert.equal(
      f.requests.filter((row) => row.path === '/api/auth/session').length,
      ['completed', 'identity_mismatch'].includes(mode) ? 2 : 1
    );
    assert.ok(f.requests.every((row) => row.method === 'GET'));
    assert.ok(!f.requests.some((row) => /checkout|payment/.test(row.path)));
    if (originalProbe) assert.equal(originalProbe.isClosed(), true);
    assert.equal(f.context.pages().length, 1);
  });
}

for (const mode of [
  'completed',
  'automatic_native',
  'preflight',
  'subscription_identity_mismatch',
  'identity_mismatch',
  'still_blocked',
  'cancelled',
  'lease_lost',
  'deadline',
  'no_actionable_page',
  'unknown_403',
  'policy_403',
  'no_callback'
]) {
  test(`订阅403接续：${mode}，仅在原页本人验证及身份复核后追加一次只读查询`, async (t) => {
    const options = {
      initiallyClear: true,
      install: true,
      cancel: mode === 'cancelled',
      leaseLost: mode === 'lease_lost',
      noClick: mode === 'deadline'
    };
    const f = await fixture(t, options);
    if (mode === 'automatic_native') {
      const human = require('../upstream/human-verification');
      const originalClear = human.clearHumanVerification;
      const originalRoot = process.env.ONLINE_RECHARGE_PROFILE_ROOT;
      const originalEnabled = process.env.HCAPTCHA_SOLVER_ENABLED;
      process.env.ONLINE_RECHARGE_PROFILE_ROOT = __dirname;
      process.env.HCAPTCHA_SOLVER_ENABLED = '1';
      human.clearHumanVerification = async (page) => {
        assert.equal(page, f.page);
        await page.evaluate(() => {
          document.body.innerHTML =
            '<main><button>New chat</button><textarea id="prompt-textarea"></textarea></main>';
        });
        return { cleared: true };
      };
      t.after(() => {
        human.clearHumanVerification = originalClear;
        if (originalRoot === undefined) delete process.env.ONLINE_RECHARGE_PROFILE_ROOT;
        else process.env.ONLINE_RECHARGE_PROFILE_ROOT = originalRoot;
        if (originalEnabled === undefined) delete process.env.HCAPTCHA_SOLVER_ENABLED;
        else process.env.HCAPTCHA_SOLVER_ENABLED = originalEnabled;
      });
    }
    let reads = 0,
      waits = 0;
    const account = {
      accounts: {
        default: {
          account: { account_id: accountId },
          entitlement: { has_active_subscription: false, subscription_plan: 'free' },
          last_active_subscription: {}
        }
      }
    };
    if (mode === 'subscription_identity_mismatch')
      account.accounts.default.account.account_id = 'other-account';
    options.accountReply = async () => {
      reads++;
      if (reads > 1 && mode !== 'still_blocked') return { status: 200, body: account };
      if (mode === 'unknown_403')
        return { status: 403, body: { error: { message: 'Cloudflare generic wording' } } };
      if (mode === 'policy_403')
        return { status: 403, body: { error: { code: 'unsupported_country' } } };
      if (reads === 1 && mode !== 'no_actionable_page') {
        await f.page.evaluate(() => {
          document.body.innerHTML =
            '<h1>Verify you are human</h1><p>Cloudflare security check</p><iframe style="width:300px;height:100px;border:0" src="https://challenges.cloudflare.com/turnstile/fixture"></iframe>';
        });
        await f.page.frameLocator('iframe').getByRole('checkbox').waitFor({ state: 'visible' });
      }
      return {
        status: 403,
        headers: {
          'cf-mitigated': 'challenge',
          'cf-ray': 'synthetic-private-ray',
          'content-type': 'text/html'
        },
        body: '<html>Just a moment</html>'
      };
    };
    const observer = require('../subscription-diagnostics.cjs').observeAuthResponses(
      f.page,
      JSON.stringify(session)
    );
    t.after(() => observer.dispose());
    const callback = async (page, opts) => {
      waits++;
      assert.equal(page, f.page);
      assert.equal(page.context(), f.context);
      const completed = await waitForHumanVerification(page, opts, { rpc: f.rpc });
      if (mode === 'identity_mismatch') f.actual({ ...session, account: { id: 'other-account' } });
      return completed;
    };
    const queryOptions = {
      page: f.page,
      browserContext: f.context,
      sessionRaw: JSON.stringify(session),
      authDiagnostics: observer,
      deadlineAt: performance.now() + (mode === 'deadline' ? 3000 : 10000),
      ...(mode === 'no_callback'
        ? {}
        : {
            onHumanVerification:
              mode === 'automatic_native'
                ? require('../unpaid-validation.cjs').automaticVerification
                : callback
          })
    };
    let result;
    if (['preflight', 'subscription_identity_mismatch'].includes(mode)) {
      const preflight = await require('../confirmation.cjs').preflightPayment(
        'pro_5x',
        token,
        queryOptions
      );
      result = { ok: preflight.allowed, diagnostics: preflight.confirmation.queryDiagnostics };
      if (mode === 'preflight') assert.equal(preflight.kind, 'initial');
      else assert.equal(preflight.confirmation.accountId, 'other-account');
    } else if (mode === 'lease_lost') {
      await assert.rejects(
        require('../upstream/subscription-check').querySubscriptionBySession(token, queryOptions),
        { code: 'LEASE_LOST' }
      );
      result = { ok: false, diagnostics: [] };
    } else
      result = await require('../upstream/subscription-check').querySubscriptionBySession(
        token,
        queryOptions
      );
    assert.equal(result.ok, ['completed', 'preflight', 'automatic_native'].includes(mode));
    assert.equal(
      reads,
      [
        'completed',
        'preflight',
        'automatic_native',
        'subscription_identity_mismatch',
        'still_blocked'
      ].includes(mode)
        ? 2
        : 1
    );
    assert.equal(
      waits,
      [
        'completed',
        'preflight',
        'subscription_identity_mismatch',
        'identity_mismatch',
        'still_blocked',
        'cancelled',
        'lease_lost',
        'deadline'
      ].includes(mode)
        ? 1
        : 0
    );
    assert.equal(f.page.isClosed(), false, 'Borrowed original page stays owned by the caller');
    if (mode === 'automatic_native') assert.deepEqual(f.calls, []);
    assert.equal(
      f.requests.some(
        (request) => request.method !== 'GET' || /checkout|payment/.test(request.path)
      ),
      false
    );
    assert.ok(!JSON.stringify(result).includes('synthetic-private-ray'));
    if (mode === 'completed') {
      assert.equal(result.diagnostics.at(-1).afterHumanVerification, true);
      assert.equal(result.diagnostics.at(-1).authResponses.session.matchesTargetAccount, true);
      assert.deepEqual(result.diagnostics.at(-1).authResponses.csrf, { observed: false });
      assert.equal(f.requests.filter((request) => request.native).length, 1);
    }
    if (mode === 'identity_mismatch') assert.equal(result.errorCode, 'ACCOUNT_MISMATCH');
    if (mode === 'cancelled') assert.equal(result.errorCode, 'HUMAN_VERIFICATION_CANCELLED');
    if (mode === 'no_actionable_page')
      assert.equal(result.diagnostics[0].actionableVerification, false);
    if (mode === 'unknown_403')
      assert.equal(result.diagnostics[0].responseFacts.classification, 'UNKNOWN_403');
    if (mode === 'policy_403')
      assert.equal(result.diagnostics[0].responseFacts.classification, 'POLICY_OR_REGION_BLOCK');
  });
}

test('订阅查询前已存在可操作验证时复用本人入口，不调用自动求解或重复读取', async (t) => {
  const options = { install: true };
  const f = await fixture(t, options);
  let reads = 0,
    waits = 0;
  options.accountReply = async () => {
    reads++;
    return {
      status: 200,
      body: {
        accounts: {
          default: {
            account: { account_id: accountId },
            entitlement: { has_active_subscription: false, subscription_plan: 'free' },
            last_active_subscription: {}
          }
        }
      }
    };
  };
  const result = await require('../confirmation.cjs').preflightPayment('pro_5x', token, {
    page: f.page,
    browserContext: f.context,
    sessionRaw: JSON.stringify(session),
    deadlineAt: performance.now() + 8000,
    onHumanVerification: async (page, budget) => {
      waits++;
      return waitForHumanVerification(page, budget, { rpc: f.rpc });
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(waits, 1);
  assert.equal(reads, 1);
  assert.equal(f.requests.filter((request) => request.native).length, 1);
  assert.equal(
    f.requests.some((request) => request.method !== 'GET' || /checkout|payment/.test(request.path)),
    false
  );
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
