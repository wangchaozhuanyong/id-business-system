'use strict';

// Original-checkout identity and payment receipts stay separate from a quote or a redirect.
// Credentials are consumed only in memory; only the bounded receipt projection leaves this file.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout, clearTimeout } = require('node:timers');
const TRUSTED = new Set(['chatgpt.com', 'pay.openai.com', 'checkout.stripe.com']);
const CONTEXT_FIELDS = [
  'kind',
  'sourcePlan',
  'targetPlan',
  'accountId',
  'cardId',
  'cardLast4',
  'currency',
  'amount',
  'quoteId'
];
const CHECKOUT_PATH = '/backend-api/payments/checkout';
const MAX_BODY = 512 * 1024;

function identityFailure() {
  return Object.assign(new Error('原单恢复标识或付款绑定无效'), {
    code: 'CHECKOUT_RECOVERY_INVALID'
  });
}
function unsupportedIdentity() {
  return Object.assign(new Error('当前结账页的原单格式尚未核实支持，本次未提交付款'), {
    code: 'CHECKOUT_RECOVERY_UNSUPPORTED'
  });
}
function checkoutIdentity(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw identityFailure();
  }
  if (
    url.protocol !== 'https:' ||
    !TRUSTED.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw identityFailure();
  if (
    url.hostname === 'chatgpt.com' &&
    /^\/checkout\/[^/]+\/cs_(?:live|test)_[^/]+\/?$/.test(url.pathname)
  )
    throw unsupportedIdentity();
  const native =
    url.hostname === 'chatgpt.com' &&
    /^\/checkout\/([a-z][a-z0-9_]{0,40})\/(oaics_[A-Za-z0-9_]{1,200})\/?$/.exec(url.pathname);
  const hostedIds = ['pay.openai.com', 'checkout.stripe.com'].includes(url.hostname)
    ? url.pathname.split('/').filter((part) => /^cs_(?:live|test)_[A-Za-z0-9]{1,200}$/.test(part))
    : [];
  if (hostedIds.length > 1) throw identityFailure();
  const checkoutId = native?.[2] || hostedIds[0];
  if (!checkoutId) throw identityFailure();
  return { checkoutId, processorEntity: native?.[1] || null, checkoutUrl: url.href };
}
function minorAmount(amount, currency) {
  const match = /^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(String(amount || ''));
  if (!match || !/^[A-Z]{3}$/.test(String(currency || ''))) return null;
  const digits = [
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'JPY',
    'KMF',
    'KRW',
    'MGA',
    'PYG',
    'RWF',
    'UGX',
    'VND',
    'VUV',
    'XAF',
    'XOF',
    'XPF'
  ].includes(currency)
    ? 0
    : ['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(currency)
      ? 3
      : 2;
  const fraction = match[2] || '';
  if (/[^0]/.test(fraction.slice(digits))) return null;
  return (
    BigInt(match[1]) * 10n ** BigInt(digits) +
    BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0')
  );
}
function quoteIdForUrl(url) {
  return (
    'quote:' +
    createHash('sha256').update(checkoutIdentity(url).checkoutId).digest('hex').slice(0, 32)
  );
}
function buildCheckoutRecovery(url, paymentContext) {
  const identity = checkoutIdentity(url);
  const quoteId = quoteIdForUrl(url);
  if (
    !paymentContext ||
    paymentContext.quoteId !== quoteId ||
    !['initial', 'upgrade'].includes(paymentContext.kind) ||
    !['plus', 'pro_5x', 'pro_20x', 'pro_500'].includes(paymentContext.targetPlan) ||
    !['free', 'plus', 'pro_5x', 'pro_20x'].includes(paymentContext.sourcePlan) ||
    !['accountId', 'cardId'].every(
      (field) =>
        typeof paymentContext[field] === 'string' &&
        paymentContext[field].length > 0 &&
        paymentContext[field].length <= 190
    ) ||
    !/^\d{4}$/.test(String(paymentContext.cardLast4 || '')) ||
    minorAmount(paymentContext.amount, paymentContext.currency) === null
  )
    throw identityFailure();
  return {
    version: 1,
    ...identity,
    ...Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, paymentContext[key]]))
  };
}
function validateRecovery(value) {
  if (!value || value.version !== 1) throw identityFailure();
  const validated = buildCheckoutRecovery(value.checkoutUrl, value);
  if (
    validated.checkoutId !== value.checkoutId ||
    validated.processorEntity !== value.processorEntity
  )
    throw identityFailure();
  return validated;
}
function sameContext(recovery, context) {
  return CONTEXT_FIELDS.every((field) => recovery[field] === context?.[field]);
}
function accountMatches(headers, accountId) {
  try {
    const authorization = headers.authorization || headers.Authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;
    const claims = JSON.parse(
      Buffer.from(authorization.slice(7).split('.')[1], 'base64url').toString('utf8')
    );
    return (
      claims['https://api.openai.com/auth']?.chatgpt_account_id === accountId &&
      (!headers['chatgpt-account-id'] || headers['chatgpt-account-id'] === accountId)
    );
  } catch {
    return false;
  }
}
function boundNativeSession(data, recovery) {
  const session = data?.checkout_session || data;
  const plan = require('./plans.cjs').PLANS[recovery.targetPlan]?.apiName;
  return session &&
    session.checkout_session_id === recovery.checkoutId &&
    session.processor_entity === recovery.processorEntity &&
    session.checkout_state?.id === recovery.checkoutId &&
    Boolean(plan) &&
    session.plan_name === plan
    ? session
    : null;
}
function actualEvidence(data, recovery, linkedIntent) {
  const expected = minorAmount(recovery.amount, recovery.currency);
  const matches = (value) => Number.isSafeInteger(value) && BigInt(value) === expected;
  const sessionId = data?.session_id ?? data?.id;
  const paidCheckout =
    data?.object === 'checkout.session' &&
    sessionId === recovery.checkoutId &&
    data.status === 'complete' &&
    data.payment_status === 'paid' &&
    matches(data.amount_total) &&
    String(data.currency || '').toUpperCase() === recovery.currency;
  const intent = [data, data?.payment_intent].find(
    (value) =>
      value &&
      value.object === 'payment_intent' &&
      value.id === linkedIntent &&
      value.status === 'succeeded' &&
      matches(value.amount_received) &&
      String(value.currency || '').toUpperCase() === recovery.currency
  );
  if (!paidCheckout && !intent) return null;
  return {
    ...Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, recovery[key]])),
    source: 'checkout',
    quoteVerified: true,
    verified: true
  };
}
function checkLive(options) {
  if (options.signal?.aborted) throw Object.assign(new Error('任务已停止'), { code: 'LEASE_LOST' });
  if (performance.now() >= options.deadlineAt)
    throw Object.assign(new Error('原单读取已到期限'), { code: 'ORIGINAL_PAYMENT_READ_TIMEOUT' });
  return Math.max(1, Math.ceil(options.deadlineAt - performance.now()));
}
async function bounded(operation, options, maximum) {
  const timeout = Math.min(checkLive(options), maximum ?? Infinity);
  let timer, onAbort;
  const halted = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('原单读取已到期限'), { code: 'ORIGINAL_PAYMENT_READ_TIMEOUT' })
        ),
      timeout
    );
    onAbort = () => reject(Object.assign(new Error('任务已停止'), { code: 'LEASE_LOST' }));
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), halted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
function observePayment(page, rawRecovery, options = {}) {
  const recovery = validateRecovery(rawRecovery);
  const clock = { ...options, deadlineAt: options.deadlineAt ?? performance.now() + 180000 };
  let armed = options.alreadySubmitted === true,
    stopped = false,
    linkedIntent = null,
    evidence = null,
    phaseStarted = false;
  let chain = Promise.resolve();
  const accept = async (data, request) => {
    if (stopped || !armed) return;
    checkLive(clock);
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    const method = request.method;
    if (
      (data?.checkout_session_id && data.checkout_session_id !== recovery.checkoutId) ||
      (data?.session_id && data.session_id !== recovery.checkoutId)
    )
      return;
    let bound;
    if (url.origin === 'https://chatgpt.com') {
      const reading =
        method === 'GET' &&
        recovery.processorEntity &&
        url.pathname === `${CHECKOUT_PATH}/${recovery.processorEntity}/${recovery.checkoutId}`;
      const confirming =
        method === 'POST' &&
        url.pathname === `${CHECKOUT_PATH}/confirm` &&
        request.body?.checkout_session_id === recovery.checkoutId;
      if (!(reading || confirming) || !accountMatches(request.headers || {}, recovery.accountId))
        return;
      const native = boundNativeSession(data, recovery);
      if (reading && !native) return;
      bound = Boolean(native) || confirming;
      if (native) data = native;
    } else if (url.origin === 'https://api.stripe.com') {
      const checkoutPath = `/v1/payment_pages/${recovery.checkoutId}/`;
      bound =
        url.pathname.startsWith(checkoutPath) &&
        ['init', 'confirm'].includes(url.pathname.slice(checkoutPath.length));
      if (
        !bound &&
        !(
          method === 'GET' &&
          linkedIntent &&
          url.pathname === `/v1/payment_intents/${linkedIntent}`
        )
      )
        return;
    } else return;
    if (bound) {
      const candidate = data?.object === 'payment_intent' ? data : data?.payment_intent;
      const id = typeof candidate === 'string' ? candidate : candidate?.id;
      const clientSecretId =
        typeof data?.client_secret === 'string' &&
        /^(pi_[A-Za-z0-9]{1,180})_secret_[A-Za-z0-9]+$/.exec(data.client_secret)?.[1];
      const candidateId = id || clientSecretId;
      if (candidateId && /^pi_[A-Za-z0-9]{1,180}$/.test(candidateId)) {
        if (linkedIntent && linkedIntent !== candidateId) return;
        linkedIntent = candidateId;
      }
    }
    evidence ||= actualEvidence(data, recovery, linkedIntent);
  };
  const response = (value) => {
    chain = chain
      .catch(() => {})
      .then(async () => {
        if (stopped || !armed || value.status() < 200 || value.status() >= 300) return;
        const request = value.request();
        const url = new URL(value.url());
        if (!['chatgpt.com', 'api.stripe.com'].includes(url.hostname)) return;
        const headers = await bounded(() => request.allHeaders(), clock, 2000);
        let body;
        try {
          body = request.postDataJSON?.();
        } catch {
          body = null;
        }
        const text = await bounded(() => value.text(), clock, 10000);
        if (text.length > MAX_BODY) return;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        await accept(data, { url: value.url(), method: request.method(), headers, body });
      })
      .catch(() => {});
  };
  page.on?.('response', response);
  return {
    arm() {
      checkLive(clock);
      if (armed) throw identityFailure();
      armed = true;
    },
    startDeadline(deadlineAt) {
      if (!phaseStarted) {
        clock.deadlineAt = deadlineAt;
        phaseStarted = true;
      }
    },
    accept,
    evidence: () => evidence,
    async flush() {
      await bounded(() => chain, clock, 2000).catch(() => {});
      return evidence;
    },
    async dispose() {
      page.off?.('response', response);
      await bounded(() => chain, clock, 2000).catch(() => {});
      stopped = true;
    }
  };
}
async function recoverOriginalPayment(rawRecovery, options = {}) {
  if (!rawRecovery) return { reason: 'LEGACY_ORIGINAL_IDENTITY_MISSING', paymentEvidence: null };
  let recovery;
  try {
    recovery = validateRecovery(rawRecovery);
  } catch {
    return { reason: 'CHECKOUT_RECOVERY_INVALID', paymentEvidence: null };
  }
  if (options.paymentContext && !sameContext(recovery, options.paymentContext))
    return { reason: 'CHECKOUT_RECOVERY_INVALID', paymentEvidence: null };
  const clock = {
    signal: options.signal || require('./rpc.cjs').taskSignal?.(),
    deadlineAt: Math.min(
      Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity,
      performance.now() + 180000
    )
  };
  let prepared, session, context, page, observer;
  try {
    const runtime = require('./upstream/browser-runtime'),
      auth = require('./upstream/session-auth');
    const verification = require('./upstream/human-verification');
    prepared = await bounded(
      () =>
        require('./upstream/playwright-proxy').preparePlaywrightProxy(
          String(process.env.PROXY || '').trim()
        ),
      clock
    );
    session = await bounded(
      () =>
        runtime.connectTaskBrowser({
          proxyConfig: prepared.proxyConfig,
          headful: process.env.HEADFUL === '1'
        }),
      clock
    );
    context = await bounded(
      () =>
        session.browser.newContext({
          proxy: prepared.proxyConfig || undefined,
          userAgent: session.realUserAgent,
          locale: 'en-US'
        }),
      clock
    );
    page = await bounded(() => context.newPage(), clock);
    await verification.prepareVerificationPage?.(page, { signal: clock.signal });
    const installed = await bounded(
      () => auth.installChatGptSession(context, options.sessionRaw),
      clock
    );
    // The recovery page cannot produce a new checkout, confirmation, authentication, or billing mutation.
    await page.route('**/*', (route) =>
      ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
        ? route.fallback()
        : route.abort('blockedbyclient')
    );
    const login = await bounded(
      () =>
        auth.bootstrapChatGptSession(page, options.sessionRaw, {
          sessionData: installed?.sessionData || installed,
          cookieVerified: installed?.cookieVerified === true,
          signal: clock.signal,
          deadlineAt: clock.deadlineAt
        }),
      clock
    );
    observer = observePayment(page, recovery, { ...clock, alreadySubmitted: true });
    let readStatus;
    if (recovery.checkoutId.startsWith('oaics_') && recovery.processorEntity) {
      const path = `${CHECKOUT_PATH}/${recovery.processorEntity}/${recovery.checkoutId}`;
      const token =
        login.session?.accessToken || auth.extractAccessTokenFromRaw(options.sessionRaw || '');
      const value = await bounded(
        () =>
          page.evaluate(
            async ({ path, token, account, timeout }) => {
              if (globalThis.location.origin !== 'https://chatgpt.com') return { status: 0 };
              const control = new AbortController(),
                timer = setTimeout(() => control.abort(), timeout);
              try {
                const response = await fetch(path, {
                  method: 'GET',
                  credentials: 'same-origin',
                  cache: 'no-store',
                  redirect: 'error',
                  headers: { Authorization: `Bearer ${token}`, 'chatgpt-account-id': account },
                  signal: control.signal
                });
                const text = await response.text();
                return { status: response.status, text: text.length <= 512 * 1024 ? text : null };
              } finally {
                clearTimeout(timer);
              }
            },
            { path, token, account: recovery.accountId, timeout: Math.min(10000, checkLive(clock)) }
          ),
        clock,
        11000
      );
      readStatus = value.status;
      if (value.status === 200 && value.text) {
        let data;
        try {
          data = JSON.parse(value.text);
        } catch {
          data = null;
        }
        if (data)
          await observer.accept(data, {
            url: 'https://chatgpt.com' + path,
            method: 'GET',
            headers: { authorization: 'Bearer ' + token, 'chatgpt-account-id': recovery.accountId }
          });
      }
    } else {
      await bounded(
        () =>
          page.goto(recovery.checkoutUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(20000, checkLive(clock))
          }),
        clock
      );
    }
    const paymentEvidence = await observer.flush();
    const confirmation = options.confirmSubscription
      ? await bounded(
          () =>
            options.confirmSubscription({ page, browserContext: context, signal: clock.signal }),
          clock
        )
      : undefined;
    return {
      paymentEvidence,
      confirmation,
      reason: paymentEvidence
        ? null
        : readStatus === 401
          ? 'SESSION_INVALID'
          : readStatus === 403
            ? 'UPSTREAM_FORBIDDEN'
            : 'ORIGINAL_PAYMENT_EVIDENCE_MISSING'
    };
  } catch (error) {
    if (error.code === 'LEASE_LOST') throw error;
    const verificationFailure =
      /^(VERIFICATION_|VLM_)[A-Z_]+$/.test(error.code || '') || error.code === 'SESSION_INVALID';
    const diagnostics = {};
    for (const key of ['state', 'revision', 'solverCode', 'httpStatus', 'providerCode']) {
      const value = error.diagnostics?.[key];
      if (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value))
      )
        diagnostics[key] = value;
    }
    return {
      paymentEvidence: observer?.evidence() || null,
      reason:
        error.code === 'ORIGINAL_PAYMENT_READ_TIMEOUT'
          ? 'ORIGINAL_PAYMENT_READ_TIMEOUT'
          : verificationFailure
            ? error.code
            : 'ORIGINAL_PAYMENT_READ_FAILED',
      ...(verificationFailure
        ? {
            queryFailure: {
              ok: false,
              errorCode: error.code,
              error:
                error.code === 'SESSION_INVALID'
                  ? '原账号登录状态未通过核验'
                  : '原单读取所需的自动验证未完成',
              verificationDiagnostics: diagnostics
            }
          }
        : {})
    };
  } finally {
    await observer?.dispose();
    if (page)
      await Promise.resolve(
        require('./upstream/human-verification').disposeVerificationPage?.(page)
      ).catch(() => {});
    if (context) await context.close().catch(() => {});
    if (session)
      await require('./upstream/browser-runtime').closeTaskBrowser(session, session.browser);
    if (prepared) await prepared.cleanup().catch(() => {});
  }
}
module.exports = {
  buildCheckoutRecovery,
  quoteIdForUrl,
  validateRecovery,
  sameContext,
  minorAmount,
  observePayment,
  recoverOriginalPayment,
  actualEvidence
};
