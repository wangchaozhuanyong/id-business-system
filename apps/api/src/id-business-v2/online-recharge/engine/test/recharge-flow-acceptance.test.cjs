'use strict';
// Runs the production task child and payment core. Only browser allocation,
// official-network transport, temporary credentials and server RPC are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const project = path.resolve(__dirname, '../../../../../../..');
const outputRoot = path.join(project, '.runtime/online-recharge-local-acceptance-20261017');
const origin = 'https://chatgpt.com';
const fixtureAccount = '11111111-1111-4111-8111-111111111111';
const fixtureCard = '22222222-2222-4222-8222-222222222222';
const fixtureAddress = {
  id: '33333333-3333-4333-8333-333333333333',
  country: 'US',
  region: 'US',
  line1: '1 Synthetic Street',
  city: 'Synthetic',
  state: 'Oregon',
  postal_code: '97201',
  firstName: 'Synthetic',
  lastName: 'Owner',
  is_active: true
};

function syntheticTask(scene) {
  const claims = {
    iss: 'https://auth.openai.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: fixtureAccount,
      chatgpt_user_id: 'fixture-user'
    },
    'https://api.openai.com/profile': { email: 'fixture@example.invalid' }
  };
  const accessToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
  return {
    id: randomUUID(),
    operation: 'recharge',
    provider: 'local',
    plan: 'pro_20x',
    workerId: 'synthetic-flow-worker',
    leaseId: randomUUID(),
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
    payload: {
      region: 'PH',
      paymentLimit: { currency: 'PHP', maxAmount: '9990' },
      scenario: scene
    },
    session: JSON.stringify({
      accessToken,
      sessionToken: 'synthetic-cookie-not-valid-anywhere',
      user: { id: 'fixture-user', email: 'fixture@example.invalid' },
      expires: new Date(Date.now() + 3600000).toISOString()
    })
  };
}

function strictRpcFixture(task) {
  let admitted = false,
    usage = 0,
    bills = 0;
  return async (method, args) => {
    assert.equal(args.taskId, task.id);
    assert.equal(args.leaseId, task.leaseId);
    assert.equal(args.leaseVersion, task.leaseVersion);
    switch (method) {
      case 'getRuntimeConfig':
        return {
          checkoutMode: 'api',
          headful: false,
          region: 'PH',
          hcaptcha: {},
          telegram: {},
          planNames: { pro_20x: 'chatgptpro' },
          paymentMaxCardAttempts: 3
        };
      case 'getActiveProxy':
        return { proxy_url: 'http://proxy-fixture.invalid:8080' };
      case 'getPaymentRegion':
        return 'PH';
      case 'getAppConfigValue':
        return null;
      case 'listAddresses':
        return [{ ...fixtureAddress }];
      case 'reserveCard':
        return {
          id: fixtureCard,
          card_number: '4242424242424242',
          card_expiry: '12/30',
          card_holder: 'Synthetic Owner',
          address_id: fixtureAddress.id,
          leaseId: 'synthetic-card-lease',
          leaseVersion: 1
        };
      case 'beforeExternalSubmit': {
        assert.equal(admitted, false);
        assert.equal(args.stage, 'payment_submit');
        assert.equal(args.cardId, fixtureCard);
        const recovery = require('../checkout-recovery.cjs').validateRecovery(
          args.checkoutRecovery
        );
        assert.equal(
          require('../checkout-recovery.cjs').sameContext(recovery, args.paymentContext),
          true
        );
        assert.equal(args.paymentContext.amount, '8919.64');
        assert.equal(args.paymentContext.currency, 'PHP');
        admitted = true;
        return { ok: true };
      }
      case 'bindCardPaymentProfile':
      case 'markAddressBound':
        assert.equal(admitted, true);
        return { ok: true };
      case 'recordCardUsage':
        assert.equal(admitted, true);
        assert.equal(args.paymentEvidence?.verified, true);
        assert.equal(++usage, 1);
        return { exhausted: false };
      case 'createBillingRecord':
        if (args.status === 'failed') {
          assert.equal(admitted, false);
          assert.equal(args.paymentEvidence?.verified === true, false);
          return { id: 'synthetic-failed-bill' };
        }
        assert.equal(admitted, true);
        assert.equal(args.status, 'success');
        assert.equal(args.paymentEvidence?.verified, true);
        assert.equal(args.amount, '8919.64');
        assert.equal(Object.hasOwn(args, 'card_number'), false);
        assert.equal(Object.hasOwn(args, 'card_cvc'), false);
        assert.equal(++bills, 1);
        return { id: 'synthetic-bill', amount: args.amount };
      case 'releaseCard':
        assert.equal(admitted, false);
        return { ok: true };
      default:
        throw new Error(`Unexpected fixture RPC: ${method}`);
    }
  };
}

// Reusable by the API service-graph acceptance: raw RPC arguments travel only
// over this child IPC boundary into the supplied handler and are never logged.
async function runSyntheticRecharge(scene, options = {}) {
  assert.ok(['success', 'recover', 'unknown'].includes(scene));
  if (options.diagnosticDelay) {
    assert.ok(['verify', 'verifyCard'].includes(options.diagnosticDelay.stage));
    assert.ok(Number.isFinite(options.diagnosticDelay.milliseconds));
    assert.ok(
      options.diagnosticDelay.milliseconds > 0 && options.diagnosticDelay.milliseconds <= 2000
    );
    assert.ok(
      options.diagnosticDelay.kind == null ||
        ['candidate_eligibility', 'value'].includes(options.diagnosticDelay.kind)
    );
    if (options.diagnosticDelay.kind) assert.equal(options.diagnosticDelay.stage, 'verifyCard');
  }
  const task = options.task || syntheticTask(scene);
  const rpc = options.rpc || strictRpcFixture(task);
  const directory =
    options.outputDir || path.join(outputRoot, `engine-${scene}-${randomUUID().slice(0, 8)}`);
  assert.ok(path.resolve(directory).startsWith(outputRoot + path.sep));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const child = fork(__filename, [], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
        : {}),
      RECHARGE_FLOW_FIXTURE_CHILD: '1',
      RECHARGE_FLOW_FIXTURE_SCENE: scene,
      ONLINE_RECHARGE_RUNTIME_DIR: directory,
      ONLINE_RECHARGE_MEDIA_DIR: path.join(directory, 'media'),
      ONLINE_RECHARGE_FFMPEG_PATH: path.join(directory, 'no-synthetic-encoder'),
      CAPTCHA_CLEAR_TIMEOUT_MS: '12000',
      CHECKOUT_READY_WAIT_MS: '6000',
      PAYMENT_RESULT_TIMEOUT_MS: '4000',
      CAPTCHA_OVERLAY_WAIT_MS: '1200',
      POST_SUBMIT_POLL_MS: '100'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let result,
    report,
    failure = '',
    output = '';
  const actions = [],
    logs = [];
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  child.on('message', (message) => {
    if (message.type === 'fixture_rpc') {
      const args = message.args;
      actions.push({
        method: message.method,
        taskScoped: args.taskId === task.id,
        ...(args.stage ? { stage: args.stage } : {}),
        ...(args.paymentEvidence
          ? { paymentEvidenceVerified: args.paymentEvidence.verified === true }
          : {}),
        ...(args.amount ? { amount: args.amount, currency: args.currency } : {})
      });
      Promise.resolve()
        .then(() => rpc(message.method, args))
        .then(
          (value) =>
            child.connected &&
            child.send({ type: 'fixture_rpc_response', requestId: message.requestId, value }),
          (error) => {
            failure = error.code || 'RPC_FIXTURE_REJECTED';
            if (child.connected)
              child.send({
                type: 'fixture_rpc_response',
                requestId: message.requestId,
                error: {
                  code: error.code || 'RPC_FIXTURE_REJECTED',
                  message: 'Fixture RPC rejected the actual operation'
                }
              });
          }
        );
    } else if (message.type === 'result') result = message;
    else if (message.type === 'log') logs.push(message.log);
    else if (message.type === 'fixture_report') report = message.report;
    else if (message.type === 'fixture_error') failure = message.code;
  });
  child.send({ type: 'fixture_start', task, diagnosticDelay: options.diagnosticDelay });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  const evidence = {
    scene,
    ...(options.diagnosticDelay ? { diagnosticDelay: { ...options.diagnosticDelay } } : {}),
    entry: 'task-runner.runTask → execute → upstream/index.run',
    exit,
    result,
    metrics: report,
    actions,
    failure,
    boundaries: [
      'browser allocation',
      'proxy connection',
      'official HTTP transport to local browser routes',
      'temporary CVC source',
      options.rpc ? 'injected RPC service graph' : 'strict in-memory RPC fixture'
    ],
    workerSchedulerCovered: false,
    productionUsed: false,
    realPaymentUsed: false
  };
  await fs.writeFile(
    path.join(directory, 'evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 }
  );
  await fs.writeFile(
    path.join(directory, 'engine.log'),
    logs.map((item) => item.text).join('\n') + '\n' + output,
    { mode: 0o600 }
  );
  assert.equal(exit.code, 0, `Synthetic task process failed: ${failure}; ${directory}`);
  assert.ok(report, `Synthetic task report missing: ${directory}`);
  return { ...evidence, directory };
}

function checkoutHtml(checkoutId, scene) {
  return `<!doctype html><html><body><h1>Configure your plan</h1><p>Due today PHP 8919.64</p>
    <div id="fixture-verification-overlay">One more step before you are done. Select the checkbox below.</div>
    <iframe id="fixture-verification" style="width:300px;height:90px" src="https://newassets.hcaptcha.com/captcha/v1/fixture/static/hcaptcha.html?kind=checkbox#frame=checkbox"></iframe>
    <iframe style="width:900px;height:190px" src="https://js.stripe.com/fixture-card?session=${checkoutId}"></iframe>
    <section aria-label="Link"><input autocomplete="billing name" name="linkName" placeholder="Optional Link name"></section>
    <section aria-label="Billing address"><h2>Billing address</h2>
      <input id="billingName" autocomplete="billing name" name="billingName">
      <select autocomplete="billing country"><option value="PH">Philippines</option><option value="US">United States</option></select>
      <input autocomplete="billing address-line1"><input autocomplete="billing address-level2">
      <select autocomplete="billing address-level1"><option value="">Choose</option><option value="OR">Oregon</option></select>
      <input autocomplete="billing postal-code">
    </section><label><input name="terms" type="checkbox">I agree</label><button type="submit">Subscribe</button>
    <div id="outcome"></div><script>
      window.actualClicks=0; window.cardReady=false;
      addEventListener('message',event=>{if(event.origin==='https://js.stripe.com'&&event.data?.type==='fixture-card-ready')window.cardReady=event.data.ready;});
      addEventListener('message',event=>{if(event.origin==='https://newassets.hcaptcha.com'&&event.data==='fixture-verified'){
        document.querySelector('#fixture-verification').hidden=true;
        document.querySelector('#fixture-verification-overlay').remove();
      }});
      document.querySelector('button').addEventListener('click',async event=>{
        event.preventDefault(); window.actualClicks++;
        const controls=Array.from(document.querySelectorAll('section[aria-label="Billing address"] input,section[aria-label="Billing address"] select'));
        const billingReady=controls.every(input=>Boolean(input.value));
        const response=await fetch('/backend-api/payments/checkout/confirm',{method:'POST',
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__CHATGPT_BOOTSTRAP_SESSION__.accessToken},
          body:JSON.stringify({checkout_session_id:'${checkoutId}',actualClicks:window.actualClicks,
            trustedClick:event.isTrusted,cardReady:window.cardReady,billingReady,terms:document.querySelector('[name=terms]').checked})});
        await response.json();
        document.querySelector('#outcome').textContent=${JSON.stringify(
          scene === 'unknown'
            ? 'Your plan change could not be completed. Please try again.'
            : 'Thank you for subscribing'
        )};
      });
    </script></body></html>`;
}

async function fixtureChild(scene, task, diagnosticDelay) {
  const { chromium, request } = require('../upstream/node_modules/playwright');
  const rpc = require('../rpc.cjs');
  const metrics = {
    loginCookieVerified: 0,
    checkoutCreations: 0,
    checkoutDocuments: 0,
    initializations: 0,
    actualPaymentClicks: 0,
    trustedPaymentClicks: 0,
    paymentRequests: 0,
    cardReadBack: false,
    billingReadBack: false,
    subscriptionChecksBefore: 0,
    subscriptionChecksAfter: 0,
    duplicateAdmissionBlocked: false,
    checkboxClicks: 0,
    checkboxCleared: false,
    formReadFailures: [],
    unexpectedNetwork: 0
  };
  const session = JSON.parse(task.session);
  const accountId = require('../upstream/session-auth').extractProfileFromToken(
    session.accessToken
  ).accountId;
  const checkoutId = `cs_test_flow${scene}`;
  const checkoutUrl = `${origin}/checkout/openai_llc/${checkoutId}`;
  const form = require('../checkout-form.cjs');
  const inspectionKeys = [
    'complete',
    'framesChecked',
    'framesSkipped',
    'framesFailed',
    'readAttempts',
    'contentLoadFailed',
    'timedOut',
    'pageClosed',
    'aborted',
    'readPhase'
  ];
  const safeInspection = (inspection) =>
    Object.fromEntries(
      inspectionKeys
        .filter((key) => Object.hasOwn(inspection || {}, key))
        .map((key) => [key, inspection[key]])
    );
  async function recordFormFailure(stage, page, observed) {
    const frames = page.frames().map((frame) => ({
      kind:
        frame === page.mainFrame()
          ? 'main'
          : frame.url().includes('hcaptcha.com')
            ? 'captcha'
            : frame.url().includes('stripe.com')
              ? 'card'
              : 'other',
      detached: frame.isDetached()
    }));
    const locations = String(observed.stack || '')
      .split('\n')
      .map((line) => line.match(/\b(?:checkout-form|stripe-payment)\.(?:cjs|js):\d+:\d+/)?.[0])
      .filter(Boolean);
    const failure = {
      stage,
      code: observed.errorCode || observed.code || 'UNCLASSIFIED',
      ...([
        'frame_scan',
        'candidate_handles',
        'candidate_eligibility',
        'value',
        'control_read'
      ].includes(observed.readPhase)
        ? { readPhase: observed.readPhase }
        : {}),
      frames,
      locations,
      ...(observed.missing ? { missing: observed.missing } : {}),
      ...(observed.inspection ? { inspection: safeInspection(observed.inspection) } : {})
    };
    try {
      const read = await form.inspectCardReadiness(page, { deadline: Date.now() + 2000 });
      failure.afterFailureInspection = safeInspection(read.inspection);
    } catch {
      failure.afterFailureInspection = { complete: false };
    }
    metrics.formReadFailures.push(failure);
  }
  let delayedRead = false;
  for (const stage of ['verify', 'verifyCard', 'fillCard', 'fillBilling']) {
    const original = form[stage];
    form[stage] = async (...args) => {
      let restore;
      if (!delayedRead && diagnosticDelay?.stage === stage) {
        const frame = args[0]
          .frames()
          .find((frame) =>
            frame.url().includes(diagnosticDelay.kind ? 'stripe.com' : 'hcaptcha.com')
          );
        if (frame && diagnosticDelay.kind) {
          const locate = frame.locator.bind(frame);
          frame.locator = (selector, ...locatorArgs) => {
            const locator = locate(selector, ...locatorArgs);
            if (!selector.includes('[autocomplete="cc-number"]')) return locator;
            const elementHandles = locator.elementHandles.bind(locator);
            locator.elementHandles = async (...handleArgs) => {
              const handles = await elementHandles(...handleArgs);
              for (const handle of handles) {
                const evaluate = handle.evaluate.bind(handle);
                handle.evaluate = async (...evaluateArgs) => {
                  const result = await evaluate(...evaluateArgs);
                  const matchesRead =
                    diagnosticDelay.kind === 'candidate_eligibility'
                      ? evaluateArgs[1]?.control === true
                      : typeof evaluateArgs[0] === 'function' &&
                        String(evaluateArgs[0]).includes('aria-valuetext');
                  if (!delayedRead && matchesRead) {
                    delayedRead = true;
                    metrics.injectedReadDelay = {
                      stage,
                      frame: 'card',
                      kind: diagnosticDelay.kind,
                      milliseconds: diagnosticDelay.milliseconds
                    };
                    await new Promise((resolve) =>
                      setTimeout(resolve, diagnosticDelay.milliseconds)
                    );
                  }
                  return result;
                };
              }
              return handles;
            };
            return locator;
          };
          restore = () => {
            frame.locator = locate;
          };
        } else if (frame) {
          const read = frame.frameElement.bind(frame);
          frame.frameElement = async () => {
            const handle = await read();
            if (!delayedRead) {
              delayedRead = true;
              metrics.injectedReadDelay = {
                stage,
                frame: 'captcha',
                milliseconds: diagnosticDelay.milliseconds
              };
              await new Promise((resolve) => setTimeout(resolve, diagnosticDelay.milliseconds));
            }
            return handle;
          };
          restore = () => {
            frame.frameElement = read;
          };
        }
      }
      try {
        const result = await original(...args);
        if (result?.ok === false) await recordFormFailure(stage, args[0], result);
        return result;
      } catch (error) {
        await recordFormFailure(stage, args[0], error);
        throw error;
      } finally {
        restore?.();
      }
    };
  }
  let subscribed = false,
    activeContext,
    browser,
    requestId = 0;
  const pending = new Map();
  const receive = (message) => {
    if (message.type !== 'fixture_rpc_response') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.error)
      entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else entry.resolve(message.value);
  };
  process.on('message', receive);
  rpc.setTransportForTest(
    (method, args) =>
      new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        process.send({ type: 'fixture_rpc', requestId: id, method, args });
      })
  );
  require('../credential-client.cjs').setRequesterForTest(() => '123');
  require('../upstream/playwright-proxy').preparePlaywrightProxy = async () => ({
    proxyConfig: undefined,
    cleanup: async () => {},
    relayed: false
  });
  const blockedNodeNetwork = () => {
    metrics.unexpectedNetwork++;
    throw new Error('Synthetic acceptance forbids Node network');
  };
  global.fetch = blockedNodeNetwork;
  require('node:http').request = blockedNodeNetwork;
  require('node:https').request = blockedNodeNetwork;
  const handle = async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const json = (value) =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(value)
      });
    if (req.method() === 'GET' && url.origin === origin && url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><body><button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea></body></html>'
      });
    if (url.origin === origin && url.pathname === '/api/auth/session') {
      assert.match(req.headers().cookie || '', /__Secure-next-auth\.session-token/);
      metrics.loginCookieVerified++;
      return json(session);
    }
    if (req.method() === 'GET' && url.pathname === '/backend-api/accounts/check/v4-2023-04-27') {
      assert.equal(req.headers().authorization, `Bearer ${session.accessToken}`);
      if (metrics.paymentRequests) metrics.subscriptionChecksAfter++;
      else metrics.subscriptionChecksBefore++;
      return json({
        accounts: {
          default: {
            account: { account_id: accountId },
            entitlement: {
              has_active_subscription: subscribed,
              subscription_plan: subscribed ? 'pro_20x' : 'free'
            },
            last_active_subscription: {
              purchase_origin_platform: 'chatgpt_web',
              currency: 'PHP',
              will_renew: false
            }
          }
        }
      });
    }
    if (
      req.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/backend-api/payments/checkout'
    ) {
      const body = req.postDataJSON();
      assert.equal(body.plan_name, 'chatgptpro');
      assert.equal(body.billing_details.currency, 'PHP');
      metrics.checkoutCreations++;
      assert.equal(metrics.checkoutCreations, 1);
      return json({
        checkout_session_id: checkoutId,
        processor_entity: 'openai_llc',
        url: checkoutUrl
      });
    }
    if (req.method() === 'GET' && req.url() === checkoutUrl) {
      metrics.checkoutDocuments++;
      return route.fulfill({
        contentType: 'text/html',
        body:
          scene === 'recover' && metrics.checkoutDocuments === 1
            ? '<html><body><h1>Content failed to load</h1><button>Try again</button></body></html>'
            : checkoutHtml(checkoutId, scene)
      });
    }
    if (req.method() === 'GET' && url.hostname === 'newassets.hcaptcha.com')
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><body>
        <div id="checkbox" role="checkbox" aria-checked="false" tabindex="0" style="width:150px;height:40px">I am human</div>
        <script>document.querySelector('#checkbox').addEventListener('click',async event=>{
          await fetch('https://chatgpt.com/fixture-verification?trusted='+Number(event.isTrusted));
          event.target.setAttribute('aria-checked','true');
          parent.postMessage('fixture-verified','https://chatgpt.com');
        });</script></body></html>`
      });
    if (
      req.method() === 'GET' &&
      url.origin === origin &&
      url.pathname === '/fixture-verification'
    ) {
      assert.equal(url.searchParams.get('trusted'), '1');
      metrics.checkboxClicks++;
      metrics.checkboxCleared = true;
      return json({ verified: true });
    }
    if (
      req.method() === 'GET' &&
      url.origin === 'https://js.stripe.com' &&
      url.pathname === '/fixture-card'
    )
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><body><input autocomplete="cc-csc"><input autocomplete="cc-number"><input autocomplete="cc-exp"><script>
        const publish=()=>parent.postMessage({type:'fixture-card-ready',ready:Array.from(document.querySelectorAll('input')).every(input=>Boolean(input.value))},'https://chatgpt.com');
        addEventListener('input',publish);addEventListener('change',publish);
        fetch('https://api.stripe.com/v1/payment_pages/${checkoutId}/init',{method:'POST',body:'key=pk_test_fixture'}).catch(()=>{});
        </script></body></html>`
      });
    if (
      req.method() === 'POST' &&
      url.origin === 'https://api.stripe.com' &&
      url.pathname === `/v1/payment_pages/${checkoutId}/init`
    ) {
      metrics.initializations++;
      return json({
        id: checkoutId,
        object: 'checkout.session',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: 891964,
        currency: 'php'
      });
    }
    if (
      req.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/backend-api/payments/checkout/confirm'
    ) {
      const body = req.postDataJSON();
      assert.equal(body.checkout_session_id, checkoutId);
      assert.equal(body.actualClicks, 1);
      assert.equal(body.trustedClick, true);
      assert.equal(body.cardReady, true);
      assert.equal(body.billingReady, true);
      assert.equal(body.terms, true);
      assert.equal(rpc.wasSubmitted(), true);
      metrics.paymentRequests++;
      metrics.actualPaymentClicks = body.actualClicks;
      metrics.trustedPaymentClicks++;
      metrics.cardReadBack = body.cardReady;
      metrics.billingReadBack = body.billingReady;
      assert.equal(metrics.paymentRequests, 1);
      if (scene === 'unknown') {
        await assert.rejects(
          rpc.beforeExternalSubmit({ stage: 'payment_submit' }),
          (error) => error.code === 'RESULT_UNKNOWN'
        );
        metrics.duplicateAdmissionBlocked = true;
      } else subscribed = true;
      return json({
        id: checkoutId,
        object: 'checkout.session',
        status: scene === 'unknown' ? 'open' : 'complete',
        payment_status: scene === 'unknown' ? 'unpaid' : 'paid',
        amount_total: 891964,
        currency: 'php'
      });
    }
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': '*'
        }
      });
    metrics.unexpectedNetwork++;
    return route.abort('blockedbyclient');
  };
  const transport = (extraHeaders) => ({
    async fetch(url, options = {}) {
      const page = activeContext
        .pages()
        .find((page) => page.url().startsWith(origin) && !page.isClosed());
      assert.ok(page, 'Actual browser transport requires its authenticated task page');
      const response = await page.evaluate(
        async ({ url, method, headers, data }) => {
          const result = await fetch(url, {
            method,
            headers,
            credentials: 'include',
            body: data == null ? undefined : JSON.stringify(data)
          });
          return { status: result.status, text: await result.text() };
        },
        {
          url,
          method: options.method || 'GET',
          headers: { ...extraHeaders, ...options.headers },
          data: options.data
        }
      );
      return {
        status: () => response.status,
        ok: () => response.status >= 200 && response.status < 300,
        text: async () => response.text,
        json: async () => JSON.parse(response.text)
      };
    },
    async post(url, options) {
      return this.fetch(url, { ...options, method: 'POST' });
    },
    async get(url, options) {
      return this.fetch(url, { ...options, method: 'GET' });
    },
    async dispose() {}
  });
  request.newContext = async (options) => transport(options?.extraHTTPHeaders);
  const runtime = require('../upstream/browser-runtime');
  runtime.connectTaskBrowser = async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--site-per-process',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
      ]
    });
    const nativeContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await nativeContext({ ...options, serviceWorkers: 'block' });
      activeContext = context;
      const nativePage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await nativePage();
        await page.route('**/*', handle);
        return page;
      };
      if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
      const fixtureTransport = transport();
      for (const method of ['post', 'get', 'fetch'])
        context.request[method] = fixtureTransport[method].bind(fixtureTransport);
      return context;
    };
    return {
      browser,
      ownsBrowser: true,
      realUserAgent: `Mozilla/5.0 Chrome/${browser.version()} Safari/537.36`
    };
  };
  try {
    await require('../task-runner.cjs').runTask(task);
    process.send({ type: 'fixture_report', report: metrics });
  } finally {
    process.removeListener('message', receive);
    for (const entry of pending.values()) entry.reject(new Error('Synthetic task finished'));
    pending.clear();
    await browser?.close();
  }
}

module.exports = { runSyntheticRecharge, syntheticTask, strictRpcFixture };
if (process.env.RECHARGE_FLOW_FIXTURE_CHILD === '1') {
  process.once('message', (message) => {
    fixtureChild(
      process.env.RECHARGE_FLOW_FIXTURE_SCENE,
      message.task,
      message.diagnosticDelay
    ).then(
      () => process.exit(0),
      (error) => {
        process.send({ type: 'fixture_error', code: error.code || 'FIXTURE_EXECUTION_FAILED' });
        process.exit(1);
      }
    );
  });
} else if (require.main === module) {
  const test = require('node:test');
  for (const [scene, fixtureOptions, label] of [
    ['success', {}, 'success'],
    ['recover', {}, 'recover'],
    ['unknown', {}, 'unknown'],
    [
      'success',
      { diagnosticDelay: { stage: 'verify', milliseconds: 350 } },
      'one transient hidden-frame read'
    ],
    [
      'success',
      {
        diagnosticDelay: { stage: 'verifyCard', kind: 'candidate_eligibility', milliseconds: 350 }
      },
      'one transient candidate eligibility read'
    ],
    [
      'success',
      { diagnosticDelay: { stage: 'verifyCard', kind: 'value', milliseconds: 350 } },
      'one transient card value read'
    ]
  ])
    test(
      `production task child completes one isolated recharge flow: ${label}`,
      { timeout: 50000 },
      async () => {
        const actual = await runSyntheticRecharge(scene, fixtureOptions);
        const metrics = actual.metrics;
        assert.equal(actual.failure, '');
        assert.equal(metrics.loginCookieVerified, 1);
        assert.equal(metrics.checkoutCreations, 1);
        assert.equal(metrics.checkoutDocuments, scene === 'recover' ? 2 : 1);
        assert.equal(metrics.initializations, 1);
        assert.equal(metrics.actualPaymentClicks, 1);
        assert.equal(metrics.trustedPaymentClicks, 1);
        assert.equal(metrics.paymentRequests, 1);
        assert.equal(metrics.cardReadBack, true);
        assert.equal(metrics.billingReadBack, true);
        assert.equal(metrics.subscriptionChecksBefore >= 1, true);
        assert.equal(metrics.subscriptionChecksAfter >= 1, true);
        assert.equal(metrics.unexpectedNetwork, 0);
        assert.equal(metrics.checkboxClicks, 1);
        assert.equal(metrics.checkboxCleared, true);
        assert.deepEqual(metrics.formReadFailures, []);
        if (fixtureOptions.diagnosticDelay) {
          assert.deepEqual(metrics.injectedReadDelay, {
            stage: fixtureOptions.diagnosticDelay.stage,
            frame: fixtureOptions.diagnosticDelay.kind ? 'card' : 'captcha',
            ...(fixtureOptions.diagnosticDelay.kind
              ? { kind: fixtureOptions.diagnosticDelay.kind }
              : {}),
            milliseconds: fixtureOptions.diagnosticDelay.milliseconds
          });
        }
        assert.equal(
          actual.actions.filter((item) => item.method === 'beforeExternalSubmit').length,
          1
        );
        assert.equal(actual.actions.filter((item) => item.method === 'reserveCard').length, 1);
        if (scene === 'unknown') {
          assert.equal(actual.result.status, 'awaiting_review');
          assert.equal(actual.result.result.resultUnknown, true);
          assert.equal(metrics.duplicateAdmissionBlocked, true);
          assert.equal(
            actual.actions.some((item) =>
              ['recordCardUsage', 'createBillingRecord', 'releaseCard'].includes(item.method)
            ),
            false
          );
        } else {
          assert.equal(actual.result.status, 'succeeded');
          assert.equal(actual.result.result.success, true);
          assert.equal(actual.result.result.paymentEvidence.verified, true);
          assert.equal(actual.result.result.confirmation.verified, true);
          assert.equal(
            actual.actions.filter((item) => item.method === 'recordCardUsage').length,
            1
          );
          assert.equal(
            actual.actions.filter((item) => item.method === 'createBillingRecord').length,
            1
          );
        }
      }
    );
}
