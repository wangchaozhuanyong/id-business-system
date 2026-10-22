'use strict';
/* global window */
// Runs the production task child and payment core. Only browser allocation,
// official-network transport, temporary credentials and server RPC are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const project = path.resolve(__dirname, '../../../../../../..');
const outputRoot = path.join(project, '.runtime/online-recharge-local-acceptance-20261017');
const repairOutputRoot = path.join(project, '.runtime/online-checkout-repair-20261018');
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

function syntheticTask(scene, { sessionRefresh } = {}) {
  const claims = {
    iss: 'https://auth.openai.com',
    exp: Math.floor(Date.now() / 1000) + (sessionRefresh ? -60 : 3600),
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
    renewalAdmitted = false,
    usage = 0,
    bills = 0;
  return async (method, args) => {
    assert.equal(args.taskId, task.id);
    assert.equal(args.leaseId, task.leaseId);
    assert.equal(args.leaseVersion, task.leaseVersion);
    switch (method) {
      case 'humanVerificationOpen':
        return { generation: 'synthetic-manual-generation' };
      case 'humanVerificationClose':
        return { stopped: true };
      case 'progress':
        assert.equal(args.stage, 'human_verification');
        return { ok: true };
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
        if (args.stage === 'renewal_update') {
          assert.equal(admitted, true);
          assert.equal(usage, 1);
          assert.equal(bills, 1);
          assert.equal(renewalAdmitted, false);
          assert.equal(args.renewalAction, 'disable');
          renewalAdmitted = true;
          return { ok: true };
        }
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
  assert.ok(['success', 'recover', 'unknown', 'readiness'].includes(scene));
  const cardFields = options.cardFields || 'standard';
  assert.ok(
    [
      'standard',
      'rendered-hidden',
      'legacy-names',
      'legacy-placeholders',
      'legacy-stable-nested',
      'prepared-visible-shadow'
    ].includes(cardFields)
  );
  const billingFields = options.billingFields || 'standard';
  assert.ok(
    ['standard', 'rendered-hidden', 'legacy-names', 'legacy-testids', 'legacy-collapsed'].includes(
      billingFields
    )
  );
  const sessionRefresh = options.sessionRefresh || null;
  assert.ok(sessionRefresh === null || ['same-account', 'wrong-account'].includes(sessionRefresh));
  const authUi = options.authUi || null;
  assert.ok(
    authUi === null ||
      [
        'hidden-login',
        'visible-login',
        'login-redirect',
        'unconfirmed',
        'challenge',
        'transient-login',
        'chat-guest-recover',
        'guest-until-reload',
        'permanent-guest',
        'late-guest'
      ].includes(authUi)
  );
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
  const task = options.task || syntheticTask(scene, { sessionRefresh });
  const rpc = options.rpc || strictRpcFixture(task);
  const directory =
    options.outputDir || path.join(outputRoot, `engine-${scene}-${randomUUID().slice(0, 8)}`);
  assert.ok(
    [outputRoot, repairOutputRoot].some((root) =>
      path.resolve(directory).startsWith(root + path.sep)
    )
  );
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
    logs = [],
    progress = [];
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
    else if (message.type === 'fixture_progress') progress.push(message.projection);
    else if (message.type === 'fixture_error') failure = message.code;
  });
  child.send({
    type: 'fixture_start',
    task,
    diagnosticDelay: options.diagnosticDelay,
    cardFields,
    billingFields,
    sessionRefresh,
    authUi
  });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  const evidence = {
    scene,
    cardFields,
    billingFields,
    ...(sessionRefresh ? { sessionRefresh } : {}),
    ...(authUi ? { authUi } : {}),
    ...(options.diagnosticDelay ? { diagnosticDelay: { ...options.diagnosticDelay } } : {}),
    entry: 'task-runner.runTask → execute → upstream/index.run',
    exit,
    result,
    metrics: report,
    ...(progress.length ? { progress } : {}),
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

function billingHtml(mode) {
  const controls =
    mode === 'legacy-names'
      ? '<input autocomplete="off" name="billingName"><select autocomplete="off" name="billingAddressCountry"><option value="PH">Philippines</option><option value="US">United States</option></select><input autocomplete="off" name="line1"><input autocomplete="off" name="billingAddressCity"><select autocomplete="off" name="billingAddressState"><option value="">Choose</option><option value="OR">Oregon</option></select><input autocomplete="off" name="billingAddressZip">'
      : ['legacy-testids', 'legacy-collapsed'].includes(mode)
        ? '<input autocomplete="off" data-testid="billingName"><select autocomplete="off" data-testid="billingCountry"><option value="PH">Philippines</option><option value="US">United States</option></select><input autocomplete="off" data-testid="billingAddressLine1"><input autocomplete="off" data-testid="billingLocality"><select autocomplete="off" data-testid="billingAdministrativeArea"><option value="">Choose</option><option value="OR">Oregon</option></select><input autocomplete="off" data-testid="billingPostalCode">'
        : '<input id="billingName" autocomplete="billing name" name="billingName"><select autocomplete="billing country"><option value="PH">Philippines</option><option value="US">United States</option></select><input autocomplete="billing address-line1"><input autocomplete="billing address-level2"><select autocomplete="billing address-level1"><option value="">Choose</option><option value="OR">Oregon</option></select><input autocomplete="billing postal-code">';
  const collapsedControls = controls.replace(
    '<select autocomplete="off" data-testid="billingCountry"><option value="PH">Philippines</option><option value="US">United States</option></select>',
    '<button type="button" role="combobox" data-testid="billingCountry" id="fixture-country" aria-controls="fixture-country-options" aria-expanded="false">Philippines</button><div id="fixture-country-options" hidden><div tabindex="0" data-value="US">United States</div></div>'
  );
  return mode === 'legacy-collapsed'
    ? `<button type="button" id="fixture-billing-toggle" aria-expanded="false" aria-controls="fixture-billing-fields">Billing address</button><div id="fixture-billing-fields" hidden>${collapsedControls}</div>`
    : mode === 'rendered-hidden'
      ? `<div hidden style="display:block">${controls}</div>`
      : controls;
}

function checkoutHtml(checkoutId, scene, billingFields, cardFields) {
  const preparedCard = cardFields === 'prepared-visible-shadow';
  return `<!doctype html><html><head>${scene === 'readiness' ? '<script type="module" src="/fixture-checkout-pending-module.js"></script>' : ''}${preparedCard ? '<style>@keyframes fixture-lifecycle {from {opacity:.99} to {opacity:1}} #fixture-animation {animation:fixture-lifecycle 100s linear}</style>' : ''}</head><body><h1>Configure your plan</h1><p>Due today PHP 8919.64</p>
    ${scene === 'readiness' ? '<section hidden><iframe src="https://challenges.cloudflare.com/fixture-hidden-residue" style="width:300px;height:90px"></iframe></section>' : ''}
    <div id="fixture-verification-overlay">One more step before you are done. Select the checkbox below.</div>
    <iframe id="fixture-verification" style="width:300px;height:90px" src="https://newassets.hcaptcha.com/captcha/v1/fixture/static/hcaptcha.html?kind=checkbox#frame=checkbox"></iframe>
    ${preparedCard ? '<div id="fixture-animation">Payment UI animation</div><div style="height:1800px" aria-hidden="true"></div><p id="fixture-card-anchor">Card number</p><div id="fixture-card-host" style="visibility:hidden"></div>' : `<iframe style="width:900px;height:190px" src="https://js.stripe.com/fixture-card?session=${checkoutId}"></iframe>`}
    <section aria-label="Link"><input autocomplete="billing name" name="linkName" placeholder="Optional Link name"></section>
    <section aria-label="Billing address"><h2>Billing address</h2>
      ${billingHtml(billingFields)}
    </section><label><input name="terms" type="checkbox">I agree</label><button type="submit">Subscribe</button>
    <div id="outcome"></div><script>
      window.actualClicks=0; window.cardReady=false; window.fixtureCheckoutDomContentLoaded=0; window.billingOpens=0; window.countryChoices=0;
      window.preparationScrolls=0; window.cardMounts=0; window.animationCallbacks=0;
      ${
        preparedCard
          ? `
      document.querySelector('#fixture-animation').addEventListener('animationend',()=>{
        window.animationCallbacks++;
        document.querySelector('#fixture-card-host').hidden=true;
      });
      addEventListener('scroll',()=>window.preparationScrolls++,{passive:true});
      const cardObserver=new IntersectionObserver(entries=>{
        if(!entries.some(entry=>entry.isIntersecting)||window.cardMounts)return;
        window.cardMounts++;
        const card=document.createElement('iframe');
        card.setAttribute('aria-hidden','true');
        card.style.cssText='width:900px;height:190px;visibility:visible';
        card.src='https://js.stripe.com/fixture-card?session=${checkoutId}';
        document.querySelector('#fixture-card-host').append(card);
        cardObserver.disconnect();
      },{threshold:.5});
      cardObserver.observe(document.querySelector('#fixture-card-anchor'));
      `
          : ''
      }
      document.querySelector('#fixture-billing-toggle')?.addEventListener('click',event=>{
        if(!event.isTrusted)throw Error('Synthetic billing toggle must be a real click');
        window.billingOpens++;event.currentTarget.setAttribute('aria-expanded','true');document.querySelector('#fixture-billing-fields').hidden=false;
      });
      document.querySelector('#fixture-country')?.addEventListener('click',()=>{
        document.querySelector('#fixture-country').setAttribute('aria-expanded','true');document.querySelector('#fixture-country-options').hidden=false;
      });
      document.querySelector('#fixture-country-options [data-value="US"]')?.addEventListener('click',event=>{
        if(!event.isTrusted)throw Error('Synthetic country choice must be a real click');
        window.countryChoices++;document.querySelector('#fixture-country').textContent='United States';document.querySelector('#fixture-country').setAttribute('aria-expanded','false');document.querySelector('#fixture-country-options').hidden=true;
      });
      addEventListener('DOMContentLoaded',()=>window.fixtureCheckoutDomContentLoaded++);
      addEventListener('message',event=>{if(event.origin==='https://js.stripe.com'&&event.data?.type==='fixture-card-ready')window.cardReady=event.data.ready;});
      addEventListener('message',event=>{if(event.origin==='https://newassets.hcaptcha.com'&&event.data==='fixture-verified'){
        document.querySelector('#fixture-verification').hidden=true;
        document.querySelector('#fixture-verification-overlay').remove();
      }});
      document.querySelector('button[type="submit"]').addEventListener('click',async event=>{
        event.preventDefault(); window.actualClicks++;
        const controls=Array.from(document.querySelectorAll('section[aria-label="Billing address"] input,section[aria-label="Billing address"] select'));
        const billingReady=controls.every(input=>Boolean(input.value))&&(!document.querySelector('#fixture-country')||document.querySelector('#fixture-country').textContent==='United States');
        const response=await fetch('/backend-api/payments/checkout/confirm',{method:'POST',
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__CHATGPT_BOOTSTRAP_SESSION__.accessToken},
          body:JSON.stringify({checkout_session_id:'${checkoutId}',actualClicks:window.actualClicks,
            trustedClick:event.isTrusted,cardReady:window.cardReady,billingReady,billingOpens:window.billingOpens,countryChoices:window.countryChoices,terms:document.querySelector('[name=terms]').checked,
            domContentLoaded:window.fixtureCheckoutDomContentLoaded,documentReadyState:document.readyState,
            preparationScrolls:window.preparationScrolls,cardMounts:window.cardMounts,animationCallbacks:window.animationCallbacks,
            hiddenCloudflareResidue:Boolean(document.querySelector('section[hidden] iframe[src*="challenges.cloudflare.com"]'))})});
        await response.json();
        document.querySelector('#outcome').textContent=${JSON.stringify(
          scene === 'unknown'
            ? 'Your plan change could not be completed. Please try again.'
            : 'Thank you for subscribing'
        )};
      });
    </script></body></html>`;
}

async function fixtureChild(
  scene,
  task,
  diagnosticDelay,
  cardFields = 'standard',
  billingFields = 'standard',
  sessionRefresh = null,
  authUi = null
) {
  const { chromium, request } = require('../upstream/node_modules/playwright');
  const rpc = require('../rpc.cjs');
  const metrics = {
    loginCookieVerified: 0,
    refreshedAuthResponses: 0,
    originalBearerRequests: 0,
    refreshedBearerRequests: 0,
    authUi,
    authPageDocuments: 0,
    authHomepagePages: [],
    authHomepageReloadPageIds: [],
    authRedirectDocuments: 0,
    authProbeIdentityResponses: 0,
    authStateTransitions: [],
    authStateAtCheckoutCreation: null,
    checkoutCreations: 0,
    checkoutDocuments: 0,
    checkoutDomContentLoaded: 0,
    pendingModuleRequests: 0,
    initializations: 0,
    actualPaymentClicks: 0,
    trustedPaymentClicks: 0,
    paymentRequests: 0,
    cardReadBack: false,
    billingReadBack: false,
    billingFields,
    billingOpens: 0,
    countryChoices: 0,
    renewalRequests: 0,
    cookieLessRequests: 0,
    cardFields,
    cardFrameDocuments: 0,
    preparationScrolls: 0,
    cardMounts: 0,
    animationCallbacks: 0,
    checkoutRecordingCaptures: 0,
    emptyCardRecordingCaptures: 0,
    filledCardRecordingCaptures: 0,
    subscriptionChecksBefore: 0,
    subscriptionChecksAfter: 0,
    duplicateAdmissionBlocked: false,
    checkboxClicks: 0,
    checkboxCleared: false,
    formReadFailures: [],
    unexpectedNetwork: 0
  };
  const syntheticPageIds = new WeakMap();
  let nextSyntheticPageId = 0;
  const session = JSON.parse(task.session);
  const originalClaims = sessionRefresh
    ? JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString('utf8'))
    : null;
  const refreshedAccount =
    sessionRefresh === 'wrong-account'
      ? '99999999-9999-4999-8999-999999999999'
      : originalClaims?.['https://api.openai.com/auth'].chatgpt_account_id;
  const refreshedClaims = sessionRefresh
    ? {
        ...originalClaims,
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': {
          ...originalClaims['https://api.openai.com/auth'],
          chatgpt_account_id: refreshedAccount
        }
      }
    : null;
  const refreshedSession = sessionRefresh
    ? {
        ...session,
        accessToken: `${session.accessToken.split('.')[0]}.${Buffer.from(JSON.stringify(refreshedClaims)).toString('base64url')}.synthetic-refreshed`,
        account: { id: refreshedAccount }
      }
    : session;
  let willRenew = true;
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
  let delayedRead = false,
    activeFormStage = null;
  for (const stage of ['verify', 'verifyCard', 'fillCard', 'fillBilling']) {
    const original = form[stage];
    form[stage] = async (...args) => {
      let restore;
      const priorStage = activeFormStage;
      activeFormStage = stage;
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
        activeFormStage = priorStage;
      }
    };
  }
  let subscribed = false,
    activeContext,
    browser,
    requestId = 0;
  let releasePendingModule;
  const pendingModule = new Promise((resolve) => {
    releasePendingModule = resolve;
  });
  const startedAt = Date.now();
  const progress = (stage, extra = {}) => {
    if (scene === 'readiness')
      process.send({
        type: 'fixture_progress',
        projection: { stage, elapsedMs: Date.now() - startedAt, metrics: { ...metrics }, ...extra }
      });
  };
  const tracedHandles = new WeakSet();
  const traceBrowserRead = async (operation, frame, action) => {
    const started = Date.now();
    const readStage = activeFormStage || 'opening';
    try {
      return await action();
    } finally {
      if (Date.now() - started >= 200)
        progress('slow-browser-read', {
          operation,
          readStage,
          frameKind:
            frame.parentFrame() === null
              ? 'main'
              : frame.url().includes('stripe.com')
                ? 'card'
                : frame.url().includes('hcaptcha.com')
                  ? 'captcha'
                  : 'other',
          durationMs: Date.now() - started
        });
    }
  };
  const traceHandle = (frame, handle) => {
    if (!handle || tracedHandles.has(handle)) return handle;
    tracedHandles.add(handle);
    const evaluate = handle.evaluate.bind(handle);
    handle.evaluate = (...args) =>
      traceBrowserRead('element_evaluate', frame, () => evaluate(...args));
    return handle;
  };
  const traceFrame = (frame) => {
    const evaluate = frame.evaluate.bind(frame);
    frame.evaluate = (...args) =>
      traceBrowserRead('frame_evaluate', frame, () => evaluate(...args));
    const frameElement = frame.frameElement.bind(frame);
    frame.frameElement = async (...args) =>
      traceHandle(
        frame,
        await traceBrowserRead('frame_element', frame, () => frameElement(...args))
      );
    const locator = frame.locator.bind(frame);
    frame.locator = (...args) => {
      const found = locator(...args);
      const elementHandles = found.elementHandles.bind(found);
      found.elementHandles = async (...args) =>
        (await elementHandles(...args)).map((handle) => traceHandle(frame, handle));
      return found;
    };
  };
  if (scene === 'readiness') {
    for (const stage of ['checkoutPageLoadFailed', 'inspectCardReadiness']) {
      const read = form[stage];
      form[stage] = async (...args) => {
        const started = Date.now();
        progress('checkout-read-start', { operation: stage });
        try {
          const result = await read(...args);
          progress('checkout-read-settled', {
            operation: stage,
            durationMs: Date.now() - started,
            ...(typeof result === 'boolean'
              ? { visibleLoadFailed: result }
              : {
                  ready: result.ready,
                  code: result.code,
                  inspection: safeInspection(result.inspection)
                })
          });
          return result;
        } catch (error) {
          progress('checkout-read-failed', {
            operation: stage,
            durationMs: Date.now() - started,
            code: /^CHECKOUT_[A-Z_]+$/.test(error.code || '') ? error.code : 'READ_FAILED'
          });
          throw error;
        }
      };
    }
    const media = require('../safe-media.cjs');
    const finish = media.finish;
    media.finish = async (...args) => {
      progress('media-finish-start');
      try {
        return await finish(...args);
      } finally {
        progress('media-finish-settled');
      }
    };
  }
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
    const json = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(value)
      });
    if (req.method() === 'GET' && url.origin === origin && url.pathname === '/') {
      assert.equal(req.isNavigationRequest(), true);
      const requestPage = req.frame().page();
      assert.equal(req.frame(), requestPage.mainFrame());
      assert.ok(syntheticPageIds.has(requestPage));
      metrics.authHomepagePages.push(syntheticPageIds.get(requestPage));
      metrics.authPageDocuments++;
      if (authUi === 'login-redirect')
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body><script>location.replace("https://auth.openai.com/u/login")</script></body></html>'
        });
      const chatUi =
        '<button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea>';
      if (
        [
          'transient-login',
          'chat-guest-recover',
          'guest-until-reload',
          'permanent-guest',
          'late-guest'
        ].includes(authUi)
      ) {
        const initial =
          authUi === 'guest-until-reload'
            ? metrics.authPageDocuments >= 3
              ? 'recovered'
              : 'guest'
            : ['transient-login', 'permanent-guest'].includes(authUi)
              ? 'guest'
              : 'initial';
        const transitions = {
          'transient-login': [{ after: 3800, phase: 'recovered' }],
          'chat-guest-recover': [
            { after: 2600, phase: 'guest' },
            { after: 3800, phase: 'recovered' }
          ],
          'guest-until-reload': [],
          'permanent-guest': [],
          'late-guest': [{ after: 2800, phase: 'guest' }]
        }[authUi];
        return route.fulfill({
          contentType: 'text/html',
          body: `<html><body><main id="fixture-auth"></main><script>
            const setAuthPhase = phase => {
              document.getElementById('fixture-auth').innerHTML = phase === 'guest' ? ${JSON.stringify(`${chatUi}<button>Log in</button>`)} : ${JSON.stringify(chatUi)};
              document.body.dataset.authPhase = phase;
              window.reportSyntheticAuthPhase({ phase, document: ${metrics.authPageDocuments} });
            };
            setAuthPhase(${JSON.stringify(initial)});
            for (const step of ${JSON.stringify(transitions)}) setTimeout(() => setAuthPhase(step.phase), step.after);
          </script></body></html>`
        });
      }
      const authMarkup =
        {
          'hidden-login': `${chatUi}<div hidden>Log in Sign up</div><div style="display:none">Sign in with Google</div><div style="visibility:hidden">Sign in to continue</div><div style="opacity:0"><button>Log in</button><button>Sign up for free</button><h1>Sign in to continue</h1></div><div inert><button>Log in</button><h1>Sign in to continue</h1></div><div aria-hidden="true"><button>Log in</button><h1>Sign in to continue</h1></div><article data-message-author-role="user"><p>Earlier message: Sign in to continue, Log in Sign up, Sign in with Google.</p></article><script type="application/json">{"message":"登录 ChatGPT"}</script><template>使用 Google 登录</template>`,
          'visible-login': `${chatUi}<h1>Sign in to continue</h1><label>Email<input type="email"></label>`,
          unconfirmed: `<main>Loading account</main><div style="opacity:0">${chatUi}</div><div inert>${chatUi}</div><div aria-hidden="true">${chatUi}</div>`,
          challenge: '<h1>Verify you are human</h1>'
        }[authUi] || chatUi;
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><body>${authMarkup}</body></html>`
      });
    }
    if (
      req.method() === 'GET' &&
      url.origin === 'https://auth.openai.com' &&
      url.pathname === '/u/login'
    ) {
      metrics.authRedirectDocuments++;
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><body><h1>Sign in to continue</h1></body></html>'
      });
    }
    if (url.origin === origin && url.pathname === '/api/auth/session') {
      assert.match(req.headers().cookie || '', /__Secure-next-auth\.session-token/);
      metrics.loginCookieVerified++;
      if (authUi === 'unconfirmed') return json({ error: 'synthetic_unconfirmed' });
      metrics.authProbeIdentityResponses++;
      if (sessionRefresh) metrics.refreshedAuthResponses++;
      return json(sessionRefresh ? refreshedSession : session);
    }
    if (req.method() === 'GET' && url.pathname === '/backend-api/accounts/check/v4-2023-04-27') {
      if (sessionRefresh) {
        if (req.headers().authorization === `Bearer ${session.accessToken}`) {
          metrics.originalBearerRequests++;
          return json({}, 401);
        }
        assert.equal(req.headers().authorization, `Bearer ${refreshedSession.accessToken}`);
        metrics.refreshedBearerRequests++;
      } else assert.equal(req.headers().authorization, `Bearer ${session.accessToken}`);
      if (metrics.paymentRequests) metrics.subscriptionChecksAfter++;
      else metrics.subscriptionChecksBefore++;
      return json({
        accounts: {
          default: {
            account: { account_id: sessionRefresh ? refreshedAccount : accountId },
            entitlement: {
              has_active_subscription: subscribed,
              subscription_plan: subscribed ? 'pro_20x' : 'free'
            },
            last_active_subscription: {
              purchase_origin_platform: 'chatgpt_web',
              currency: 'PHP',
              will_renew: willRenew
            }
          }
        }
      });
    }
    if (
      req.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/backend-api/subscriptions/cancel'
    ) {
      assert.equal(subscribed, true);
      assert.equal(req.postDataJSON().account_id, accountId);
      assert.equal(
        req.headers().authorization,
        `Bearer ${(sessionRefresh ? refreshedSession : session).accessToken}`
      );
      assert.match(req.headers().cookie || '', /__Secure-next-auth\.session-token/);
      assert.equal(rpc.wasSubmitted(), true);
      metrics.renewalRequests++;
      assert.equal(metrics.renewalRequests, 1);
      willRenew = false;
      return json({ ok: true });
    }
    if (
      req.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/backend-api/payments/checkout'
    ) {
      const body = req.postDataJSON();
      if (sessionRefresh)
        assert.equal(req.headers().authorization, `Bearer ${refreshedSession.accessToken}`);
      assert.equal(body.plan_name, 'chatgptpro');
      assert.equal(body.billing_details.currency, 'PHP');
      metrics.checkoutCreations++;
      assert.equal(metrics.checkoutCreations, 1);
      if (
        [
          'transient-login',
          'chat-guest-recover',
          'guest-until-reload',
          'permanent-guest',
          'late-guest'
        ].includes(authUi)
      ) {
        const authPage = activeContext.pages().find((page) => page.url() === origin + '/');
        assert.ok(authPage);
        metrics.authStateAtCheckoutCreation = await authPage.getAttribute(
          'body',
          'data-auth-phase'
        );
        assert.equal(metrics.authStateAtCheckoutCreation, 'recovered');
      }
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
            : checkoutHtml(checkoutId, scene, billingFields, cardFields)
      });
    }
    if (
      scene === 'readiness' &&
      req.method() === 'GET' &&
      url.origin === origin &&
      url.pathname === '/fixture-checkout-pending-module.js'
    ) {
      metrics.pendingModuleRequests++;
      await pendingModule;
      return route
        .fulfill({ contentType: 'application/javascript', body: 'export {};' })
        .catch(() => {});
    }
    if (
      scene === 'readiness' &&
      req.method() === 'GET' &&
      url.hostname === 'challenges.cloudflare.com' &&
      url.pathname === '/fixture-hidden-residue'
    )
      return route.fulfill({
        contentType: 'text/html',
        body: '<div role="checkbox" aria-checked="false" style="width:220px;height:40px">Cloudflare. Verify you are human.</div>'
      });
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
    ) {
      metrics.cardFrameDocuments++;
      if (cardFields === 'legacy-stable-nested')
        return route.fulfill({
          contentType: 'text/html',
          body: `<html><body><iframe style="width:850px;height:150px" src="https://elements.stripe.com/fixture-nested-card?session=${checkoutId}"></iframe><script>
          addEventListener('message',event=>{if(event.origin==='https://elements.stripe.com'&&event.data?.type==='fixture-card-ready')parent.postMessage(event.data,'https://chatgpt.com');});
          </script></body></html>`
        });
    }
    if (
      req.method() === 'GET' &&
      ((url.origin === 'https://js.stripe.com' && url.pathname === '/fixture-card') ||
        (cardFields === 'legacy-stable-nested' &&
          url.origin === 'https://elements.stripe.com' &&
          url.pathname === '/fixture-nested-card'))
    ) {
      const fields = {
        standard:
          '<input autocomplete="cc-csc"><input autocomplete="cc-number"><input autocomplete="cc-exp">',
        'rendered-hidden':
          '<section hidden style="display:block"><input autocomplete="cc-csc"><input autocomplete="cc-number"><input autocomplete="cc-exp"></section>',
        'legacy-names':
          '<input autocomplete="off" name="cardCvc"><input autocomplete="off" name="number"><input autocomplete="off" name="exp-date">',
        'legacy-placeholders':
          '<input autocomplete="off" placeholder="CVC"><input autocomplete="off" placeholder="1234 1234 1234 1234"><input autocomplete="off" placeholder="MM / YY">',
        'legacy-stable-nested':
          '<input autocomplete="off" data-elements-stable-field-name="cardCvc"><input autocomplete="off" data-elements-stable-field-name="cardNumber"><input autocomplete="off" data-elements-stable-field-name="cardExpiry">',
        'prepared-visible-shadow':
          '<label id="fixture-control-label-a">Security code</label><input autocomplete="off" aria-labelledby="fixture-control-label-a"><label id="fixture-control-label-b">Card number</label><input autocomplete="off" aria-labelledby="fixture-control-label-b"><label id="fixture-control-label-c">Expiration date</label><input autocomplete="off" aria-labelledby="fixture-control-label-c">'
      }[cardFields];
      const parentOrigin = cardFields === 'legacy-stable-nested' ? 'https://js.stripe.com' : origin;
      if (cardFields === 'legacy-stable-nested') metrics.cardFrameDocuments++;
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><body>${cardFields === 'prepared-visible-shadow' ? '<div id="fixture-shadow-host" aria-hidden="true"></div>' : fields}<script>
        const fieldRoot=${cardFields === 'prepared-visible-shadow' ? `document.querySelector('#fixture-shadow-host').attachShadow({mode:'open'})` : 'document'};
        ${cardFields === 'prepared-visible-shadow' ? `fieldRoot.innerHTML=${JSON.stringify(fields)};` : ''}
        const publish=()=>parent.postMessage({type:'fixture-card-ready',ready:Array.from(fieldRoot.querySelectorAll('input')).every(input=>Boolean(input.value))},'${parentOrigin}');
        fieldRoot.addEventListener('input',publish);fieldRoot.addEventListener('change',publish);
        fetch('https://api.stripe.com/v1/payment_pages/${checkoutId}/init',{method:'POST',body:'key=pk_test_fixture'}).catch(()=>{});
        </script></body></html>`
      });
    }
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
      if (sessionRefresh)
        assert.equal(req.headers().authorization, `Bearer ${refreshedSession.accessToken}`);
      assert.equal(body.checkout_session_id, checkoutId);
      assert.equal(body.actualClicks, 1);
      assert.equal(body.trustedClick, true);
      assert.equal(body.cardReady, true);
      assert.equal(body.billingReady, true);
      assert.equal(body.billingOpens, billingFields === 'legacy-collapsed' ? 1 : 0);
      assert.equal(body.countryChoices, billingFields === 'legacy-collapsed' ? 1 : 0);
      assert.equal(body.terms, true);
      assert.equal(rpc.wasSubmitted(), true);
      if (scene === 'readiness') {
        assert.equal(metrics.pendingModuleRequests, 1);
        assert.equal(metrics.checkoutDomContentLoaded, 0);
        assert.equal(body.domContentLoaded, 0);
        assert.equal(body.documentReadyState, 'interactive');
        assert.equal(body.hiddenCloudflareResidue, true);
        metrics.readinessProof = {
          domContentLoadedAtPayment: metrics.checkoutDomContentLoaded,
          pageDomContentLoadedAtPayment: body.domContentLoaded,
          documentReadyStateAtPayment: body.documentReadyState,
          hiddenCloudflareResidueAtPayment: body.hiddenCloudflareResidue
        };
      }
      metrics.paymentRequests++;
      metrics.actualPaymentClicks = body.actualClicks;
      metrics.trustedPaymentClicks++;
      metrics.cardReadBack = body.cardReady;
      metrics.billingOpens = body.billingOpens;
      metrics.countryChoices = body.countryChoices;
      metrics.billingReadBack = body.billingReady;
      if (cardFields === 'prepared-visible-shadow') {
        assert.equal(body.cardMounts, 1);
        assert.equal(body.preparationScrolls >= 1, true);
        assert.equal(body.animationCallbacks, 0);
        assert.equal(metrics.checkoutRecordingCaptures >= 1, true);
        metrics.preparationScrolls = body.preparationScrolls;
        metrics.cardMounts = body.cardMounts;
        metrics.animationCallbacks = body.animationCallbacks;
      }
      assert.equal(metrics.paymentRequests, 1);
      progress('actual-payment-request');
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
  const transport = (extraHeaders, sharesCookies = true) => ({
    async fetch(url, options = {}) {
      if (!sharesCookies) {
        metrics.cookieLessRequests++;
        return {
          status: () => 403,
          ok: () => false,
          text: async () => '{}',
          json: async () => ({})
        };
      }
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
  request.newContext = async (options) => transport(options?.extraHTTPHeaders, false);
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
    const closeBrowser = browser.close.bind(browser);
    browser.close = async (...args) => {
      progress('browser-close-start');
      try {
        return await closeBrowser(...args);
      } finally {
        progress('browser-close-settled');
      }
    };
    const nativeContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await nativeContext({ ...options, serviceWorkers: 'block' });
      const closeContext = context.close.bind(context);
      context.close = async (...args) => {
        progress('context-close-start');
        try {
          return await closeContext(...args);
        } finally {
          progress('context-close-settled');
        }
      };
      activeContext = context;
      const nativePage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await nativePage();
        syntheticPageIds.set(page, ++nextSyntheticPageId);
        if (authUi === 'guest-until-reload') {
          const reload = page.reload.bind(page);
          page.reload = async (...reloadOptions) => {
            assert.equal(page.url(), origin + '/');
            metrics.authHomepageReloadPageIds.push(syntheticPageIds.get(page));
            return reload(...reloadOptions);
          };
        }
        if (
          [
            'transient-login',
            'chat-guest-recover',
            'guest-until-reload',
            'permanent-guest',
            'late-guest'
          ].includes(authUi)
        ) {
          await page.exposeFunction('reportSyntheticAuthPhase', (observation) => {
            assert.ok(['initial', 'guest', 'recovered'].includes(observation.phase));
            assert.ok(Number.isSafeInteger(observation.document) && observation.document > 0);
            metrics.authStateTransitions.push({
              phase: observation.phase,
              document: observation.document
            });
          });
        }
        await page.route('**/*', handle);
        page.on('domcontentloaded', () => {
          if (page.url() === checkoutUrl) metrics.checkoutDomContentLoaded++;
        });
        if (scene === 'readiness') {
          traceFrame(page.mainFrame());
          page.on('frameattached', (frame) => traceFrame(frame));
          const capture = page.screenshot.bind(page);
          page.screenshot = async (...args) => {
            progress('native-screenshot-start');
            try {
              const image = await capture(...args);
              progress('native-screenshot-completed');
              return image;
            } catch (error) {
              progress('native-screenshot-failed', {
                failure: error.name === 'TimeoutError' ? 'timeout' : 'capture_failed'
              });
              throw error;
            }
          };
        }
        if (cardFields === 'prepared-visible-shadow') {
          const capture = page.screenshot.bind(page);
          page.screenshot = async (...args) => {
            const image = await capture(...args);
            if (page.url() === checkoutUrl) {
              metrics.checkoutRecordingCaptures++;
              const observed = await page.evaluate(() => ({
                filled: window.cardReady === true,
                animationCallbacks: window.animationCallbacks
              }));
              if (observed.filled) metrics.filledCardRecordingCaptures++;
              else metrics.emptyCardRecordingCaptures++;
              metrics.animationCallbacks = observed.animationCallbacks;
            }
            return image;
          };
        }
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
    progress('task-runner-start');
    await require('../task-runner.cjs').runTask(task);
    progress('task-runner-returned');
    process.send({ type: 'fixture_report', report: metrics });
  } finally {
    process.removeListener('message', receive);
    for (const entry of pending.values()) entry.reject(new Error('Synthetic task finished'));
    pending.clear();
    await browser?.close();
    releasePendingModule();
  }
}

module.exports = { runSyntheticRecharge, syntheticTask, strictRpcFixture };
if (process.env.RECHARGE_FLOW_FIXTURE_CHILD === '1') {
  process.once('message', (message) => {
    fixtureChild(
      process.env.RECHARGE_FLOW_FIXTURE_SCENE,
      message.task,
      message.diagnosticDelay,
      message.cardFields,
      message.billingFields,
      message.sessionRefresh,
      message.authUi
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
    ['readiness', {}, 'readiness'],
    [
      'success',
      {
        authUi: 'hidden-login',
        outputDir: path.join(repairOutputRoot, `auth-ui-hidden-${randomUUID().slice(0, 8)}`)
      },
      'hidden login content preserves authenticated chat'
    ],
    ...['transient-login', 'chat-guest-recover', 'guest-until-reload'].map((authUi) => [
      'success',
      {
        authUi,
        outputDir: path.join(
          repairOutputRoot,
          `auth-stability-${authUi}-${randomUUID().slice(0, 8)}`
        )
      },
      `stable authentication recovery: ${authUi}`
    ]),
    [
      'success',
      {
        sessionRefresh: 'same-account',
        outputDir: path.join(repairOutputRoot, `session-refresh-same-${randomUUID().slice(0, 8)}`)
      },
      'cookie-refreshed session reaches one payment'
    ],
    [
      'success',
      {
        cardFields: 'prepared-visible-shadow',
        outputDir: path.join(repairOutputRoot, `full-flow-${randomUUID().slice(0, 8)}`)
      },
      'prepared native card with physically visible ARIA-marked frame and shadow fields'
    ],
    [
      'success',
      { cardFields: 'rendered-hidden', billingFields: 'rendered-hidden' },
      'CSS-rendered hidden card and billing controls'
    ],
    [
      'success',
      { cardFields: 'legacy-names', billingFields: 'legacy-names' },
      'original field names'
    ],
    [
      'recover',
      { cardFields: 'legacy-placeholders', billingFields: 'legacy-collapsed' },
      'original placeholders after recovery'
    ],
    [
      'unknown',
      { cardFields: 'legacy-stable-nested', billingFields: 'legacy-testids' },
      'original stable fields in nested frames'
    ],
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
        const outcome = actual.result?.result;
        const bootstrap = outcome?.bootstrapDiagnostics;
        const safeOutcome = {
          status: actual.result?.status,
          errorCode: outcome?.errorCode ?? outcome?.code ?? null,
          bootstrapDiagnostics: bootstrap
            ? Object.fromEntries(
                [
                  'reason',
                  'authApiVerified',
                  'visibleLogin',
                  'loggedInUi',
                  'redirectDetected',
                  'challengeDetected',
                  'pageClosed'
                ].map((key) => [key, bootstrap[key]])
              )
            : null
        };
        assert.equal(
          actual.result?.status,
          scene === 'unknown' ? 'awaiting_review' : 'succeeded',
          JSON.stringify(safeOutcome)
        );
        assert.equal(metrics.loginCookieVerified, 1);
        if (fixtureOptions.authUi) {
          assert.equal(metrics.authUi, fixtureOptions.authUi);
          assert.equal(metrics.authProbeIdentityResponses, 1);
          assert.equal(metrics.authRedirectDocuments, 0);
          if (
            ['transient-login', 'chat-guest-recover', 'guest-until-reload'].includes(
              fixtureOptions.authUi
            )
          ) {
            assert.equal(metrics.authStateAtCheckoutCreation, 'recovered');
            assert.ok(metrics.authStateTransitions.some((item) => item.phase === 'guest'));
            assert.ok(metrics.authStateTransitions.some((item) => item.phase === 'recovered'));
            if (fixtureOptions.authUi === 'guest-until-reload') {
              assert.equal(
                metrics.authPageDocuments,
                3,
                'warmup, bootstrap and exactly one homepage refresh'
              );
              assert.notEqual(metrics.authHomepagePages[0], metrics.authHomepagePages[1]);
              assert.equal(metrics.authHomepagePages[1], metrics.authHomepagePages[2]);
              assert.deepEqual(metrics.authHomepageReloadPageIds, [metrics.authHomepagePages[1]]);
            }
          }
        }
        if (fixtureOptions.sessionRefresh) {
          assert.equal(metrics.refreshedAuthResponses, 1);
          assert.equal(metrics.originalBearerRequests, 0);
          assert.equal(metrics.refreshedBearerRequests >= 2, true);
          assert.equal(actual.result.result.confirmation.observedCanonicalPlan, 'pro_20x');
        }
        assert.equal(metrics.checkoutCreations, 1);
        assert.equal(metrics.checkoutDocuments, scene === 'recover' ? 2 : 1);
        assert.equal(metrics.initializations, 1);
        assert.equal(metrics.cardFields, fixtureOptions.cardFields || 'standard');
        assert.equal(metrics.billingFields, fixtureOptions.billingFields || 'standard');
        assert.equal(
          metrics.billingOpens,
          fixtureOptions.billingFields === 'legacy-collapsed' ? 1 : 0
        );
        assert.equal(
          metrics.countryChoices,
          fixtureOptions.billingFields === 'legacy-collapsed' ? 1 : 0
        );
        assert.equal(
          metrics.cardFrameDocuments,
          fixtureOptions.cardFields === 'legacy-stable-nested' ? 2 : 1
        );
        assert.equal(metrics.actualPaymentClicks, 1);
        assert.equal(metrics.trustedPaymentClicks, 1);
        assert.equal(metrics.paymentRequests, 1);
        assert.equal(metrics.cardReadBack, true);
        assert.equal(metrics.billingReadBack, true);
        assert.equal(metrics.subscriptionChecksBefore >= 1, true);
        assert.equal(metrics.subscriptionChecksAfter >= 1, true);
        assert.equal(metrics.unexpectedNetwork, 0);
        assert.equal(metrics.cookieLessRequests, 0);
        assert.equal(metrics.renewalRequests, scene === 'unknown' ? 0 : 1);
        assert.equal(metrics.checkboxClicks, 1);
        assert.equal(metrics.checkboxCleared, true);
        assert.deepEqual(metrics.formReadFailures, []);
        if (fixtureOptions.cardFields === 'prepared-visible-shadow') {
          assert.equal(metrics.cardMounts, 1);
          assert.equal(metrics.preparationScrolls >= 1, true);
          assert.equal(metrics.animationCallbacks, 0);
          assert.equal(metrics.checkoutRecordingCaptures >= 1, true);
          assert.equal(metrics.emptyCardRecordingCaptures >= 1, true);
          assert.equal(metrics.filledCardRecordingCaptures >= 1, true);
          assert.equal(actual.result.result.paymentEvidence.amount, '8919.64');
          assert.equal(actual.result.result.paymentEvidence.currency, 'PHP');
          assert.equal(actual.result.result.confirmation.observedCanonicalPlan, 'pro_20x');
        }
        if (scene === 'readiness') {
          assert.equal(metrics.checkoutDomContentLoaded, 0);
          assert.equal(metrics.pendingModuleRequests, 1);
          assert.deepEqual(metrics.readinessProof, {
            domContentLoadedAtPayment: 0,
            pageDomContentLoadedAtPayment: 0,
            documentReadyStateAtPayment: 'interactive',
            hiddenCloudflareResidueAtPayment: true
          });
          assert.equal(actual.result.result.paymentEvidence.amount, '8919.64');
          assert.equal(actual.result.result.paymentEvidence.currency, 'PHP');
          assert.equal(actual.result.result.confirmation.observedCanonicalPlan, 'pro_20x');
        }
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
          actual.actions.filter(
            (item) => item.method === 'beforeExternalSubmit' && item.stage === 'payment_submit'
          ).length,
          1
        );
        assert.equal(
          actual.actions.filter(
            (item) => item.method === 'beforeExternalSubmit' && item.stage === 'renewal_update'
          ).length,
          scene === 'unknown' ? 0 : 1
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
          assert.equal(actual.result.result.autoRenewCancellation.ok, true);
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
  test(
    'cookie refresh rejects a different account before any subscription or payment request',
    { timeout: 50000 },
    async () => {
      const actual = await runSyntheticRecharge('success', {
        sessionRefresh: 'wrong-account',
        outputDir: path.join(repairOutputRoot, `session-refresh-wrong-${randomUUID().slice(0, 8)}`)
      });
      assert.equal(actual.failure, '');
      assert.equal(actual.result.status, 'failed');
      assert.equal(actual.result.result.code, 'ACCOUNT_MISMATCH');
      assert.equal(actual.metrics.loginCookieVerified, 1);
      assert.equal(actual.metrics.refreshedAuthResponses, 1);
      for (const key of [
        'originalBearerRequests',
        'refreshedBearerRequests',
        'checkoutCreations',
        'checkoutDocuments',
        'initializations',
        'actualPaymentClicks',
        'paymentRequests',
        'unexpectedNetwork'
      ])
        assert.equal(actual.metrics[key], 0, key);
      assert.equal(
        actual.actions.some((action) =>
          [
            'reserveCard',
            'beforeExternalSubmit',
            'recordCardUsage',
            'recordCardDecline',
            'createBillingRecord'
          ].includes(action.method)
        ),
        false
      );
    }
  );
  for (const [authUi, expectedCode] of [
    ['visible-login', 'SESSION_NOT_CONFIRMED'],
    ['login-redirect', 'SESSION_NOT_CONFIRMED'],
    ['unconfirmed', 'SESSION_NOT_CONFIRMED'],
    ['challenge', 'HUMAN_VERIFICATION_REQUIRED'],
    ['permanent-guest', 'SESSION_NOT_CONFIRMED'],
    ['late-guest', 'SESSION_NOT_CONFIRMED']
  ])
    test(`unconfirmed login never reaches a payment: ${authUi}`, { timeout: 50000 }, async () => {
      const actual = await runSyntheticRecharge('success', {
        authUi,
        outputDir: path.join(repairOutputRoot, `auth-ui-${authUi}-${randomUUID().slice(0, 8)}`)
      });
      assert.equal(actual.failure, '');
      assert.equal(actual.result.status, 'failed');
      assert.equal(
        actual.result.result.errorCode ?? actual.result.result.confirmation?.queryErrorCode,
        expectedCode
      );
      const diagnostic =
        actual.result.result.bootstrapDiagnostics ??
        actual.result.result.confirmation?.queryBootstrapDiagnostics;
      assert.equal(
        diagnostic.reason,
        {
          'visible-login': 'visible_login_content',
          'login-redirect': 'login_redirect',
          unconfirmed: 'login_not_confirmed',
          challenge: 'verification_failed',
          'permanent-guest': 'visible_login_controls',
          'late-guest': 'visible_login_controls'
        }[authUi]
      );
      assert.equal(diagnostic.authApiVerified, authUi !== 'unconfirmed');
      assert.equal(diagnostic.redirectDetected, authUi === 'login-redirect');
      assert.equal(diagnostic.pageClosed, false);
      if (['permanent-guest', 'late-guest'].includes(authUi)) {
        assert.equal(actual.metrics.authStateAtCheckoutCreation, null);
        assert.ok(actual.metrics.authStateTransitions.some((item) => item.phase === 'guest'));
      }
      assert.equal(
        Object.entries(diagnostic).every(([key, value]) =>
          key === 'lastAwait'
            ? [
                'navigation',
                'wait',
                'challenge',
                'login_controls',
                'logged_in_ui',
                'ui_stability',
                'verification',
                'session_api'
              ].includes(value)
            : typeof value === 'boolean' || value === diagnostic.reason
        ),
        true
      );
      assert.equal(actual.metrics.authProbeIdentityResponses, authUi === 'unconfirmed' ? 0 : 1);
      assert.equal(
        actual.metrics.authRedirectDocuments,
        authUi === 'login-redirect' ? actual.metrics.authPageDocuments : 0
      );
      if (authUi === 'login-redirect') assert.ok(actual.metrics.authRedirectDocuments > 0);
      for (const key of [
        'subscriptionChecksBefore',
        'subscriptionChecksAfter',
        'checkoutCreations',
        'checkoutDocuments',
        'initializations',
        'actualPaymentClicks',
        'paymentRequests',
        'renewalRequests',
        'unexpectedNetwork'
      ])
        assert.equal(actual.metrics[key], 0, key);
      assert.equal(
        actual.actions.some((action) =>
          [
            'reserveCard',
            'beforeExternalSubmit',
            'recordCardUsage',
            'recordCardDecline',
            'createBillingRecord'
          ].includes(action.method)
        ),
        false
      );
    });
}
