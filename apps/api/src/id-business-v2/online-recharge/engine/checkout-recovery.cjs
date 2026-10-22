'use strict';

// Original-checkout identity and payment receipts stay separate from a quote or a redirect.
// Credentials are consumed only in memory; only the bounded receipt projection leaves this file.
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
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
const officialCheckouts = new WeakMap();
const originalCheckoutReloads = new WeakMap();
const SOURCE_KEYS = ['kind', 'checkoutId', 'processorEntity'];
const BLOCKED_REQUEST_OPERATIONS = new Set([
  'READ_REQUEST',
  'CHECKOUT_CREATE',
  'STRIPE_INIT_SAME_CHECKOUT',
  'STRIPE_INIT_OTHER_CHECKOUT',
  'STRIPE_INIT_NATIVE_UNBOUND',
  'STRIPE_OTHER_WRITE',
  'OTHER_WRITE',
  'OTHER_REQUEST'
]);
const BLOCKED_REQUEST_REASONS = new Set([
  'NON_INITIALIZATION_OPERATION',
  'ORIGINAL_CHECKOUT_MISMATCH',
  'NATIVE_CHECKOUT_UNBOUND',
  'UNKNOWN_PARAMETER',
  'DUPLICATE_PARAMETER',
  'INVALID_PARAMETER_VALUE',
  'BODY_UNAVAILABLE',
  'BODY_TOO_LARGE',
  'INVALID_REQUEST',
  'GUARD_UNAVAILABLE',
  'GUARD_REJECTED',
  'LEASE_LOST',
  'PAYMENT_ALREADY_STARTED',
  'ORIGINAL_CHECKOUT_CHANGED',
  'FRAME_GUARD_UNPROVEN',
  'DIAGNOSTIC_LIMIT'
]);
const RELOAD_DIAGNOSTIC_CODES = new Set([
  'LEASE_LOST',
  'CHECKOUT_RELOAD_READONLY',
  'CHECKOUT_RELOAD_READY',
  'CHECKOUT_RELOAD_NOT_ATTEMPTED',
  'CHECKOUT_RELOAD_TIMEOUT',
  'CHECKOUT_RELOAD_PAYMENT_STARTED',
  'CHECKOUT_RELOAD_ALREADY_ATTEMPTED',
  'CHECKOUT_RELOAD_NOT_REQUIRED',
  'CHECKOUT_RELOAD_ORIGINAL_CHANGED',
  'CHECKOUT_RELOAD_STATE_UNAVAILABLE',
  'CHECKOUT_RELOAD_FAILED',
  'CHECKOUT_RELOAD_PAGE_CLOSED',
  'CHECKOUT_RELOAD_GUARD_UNAVAILABLE',
  'CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN'
]);

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
function officialSource(value, checkoutId, processorEntity) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === SOURCE_KEYS.length &&
    SOURCE_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value.kind === 'official_checkout_response' &&
    value.checkoutId === checkoutId &&
    value.processorEntity === processorEntity
  );
}
function rememberOfficialCheckout(page, source) {
  officialCheckouts.delete(page);
  if (source === undefined || source === null) return;
  if (
    !/^cs_(?:live|test)_[A-Za-z0-9]{1,200}$/.test(source.checkoutId || '') ||
    !/^[a-z][a-z0-9_]{0,40}$/.test(source.processorEntity || '') ||
    !officialSource(source, source.checkoutId, source.processorEntity)
  )
    throw identityFailure();
  officialCheckouts.set(page, Object.freeze({ ...source }));
}
function officialCheckoutForPage(page) {
  const source = officialCheckouts.get(page);
  return source ? { ...source } : undefined;
}
function checkoutIdentity(raw, source) {
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
  const native =
    url.hostname === 'chatgpt.com' &&
    /^\/checkout\/([a-z][a-z0-9_]{0,40})\/(oaics_[A-Za-z0-9_]{1,200}|cs_(?:live|test)_[A-Za-z0-9]{1,200})\/?$/.exec(
      url.pathname
    );
  const hostedIds = ['pay.openai.com', 'checkout.stripe.com'].includes(url.hostname)
    ? url.pathname.split('/').filter((part) => /^cs_(?:live|test)_[A-Za-z0-9]{1,200}$/.test(part))
    : [];
  if (hostedIds.length > 1) throw identityFailure();
  const checkoutId = native?.[2] || hostedIds[0];
  if (!checkoutId) throw identityFailure();
  const embeddedStripe = native && checkoutId.startsWith('cs_');
  if (embeddedStripe && !officialSource(source, checkoutId, native[1])) throw unsupportedIdentity();
  return {
    checkoutId,
    processorEntity: native?.[1] || null,
    checkoutUrl: url.href,
    ...(embeddedStripe ? { source: { ...source } } : {})
  };
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
function quoteIdForUrl(url, source) {
  return (
    'quote:' +
    createHash('sha256').update(checkoutIdentity(url, source).checkoutId).digest('hex').slice(0, 32)
  );
}
function buildCheckoutRecovery(url, paymentContext, source) {
  const identity = checkoutIdentity(url, source);
  const quoteId = quoteIdForUrl(url, source);
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
  const validated = buildCheckoutRecovery(value.checkoutUrl, value, value.source);
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
function amountConflict(data, recovery) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
  const expected = minorAmount(recovery.amount, recovery.currency);
  const matches = (value) => Number.isSafeInteger(value) && BigInt(value) === expected;
  const wrongCurrency = (value) => String(value || '').toUpperCase() !== recovery.currency;
  const hasFact = (value, field) => Object.hasOwn(value, field) && value[field] !== undefined;
  if (
    (hasFact(data, 'amount_total') && !matches(data.amount_total)) ||
    (data.total_summary &&
      hasFact(data.total_summary, 'due') &&
      !matches(data.total_summary.due)) ||
    (hasFact(data, 'currency') && wrongCurrency(data.currency))
  )
    return true;
  // A nested receipt cannot override contradictory checkout facts, nor can a
  // valid checkout total override an explicit contradictory linked intent.
  const checkoutPaid =
    data.object === 'checkout.session' &&
    data.status === 'complete' &&
    data.payment_status === 'paid';
  return [data, data.payment_intent].some(
    (intent) =>
      intent &&
      intent.object === 'payment_intent' &&
      (((intent.status === 'succeeded' || checkoutPaid) &&
        hasFact(intent, 'amount_received') &&
        !matches(intent.amount_received)) ||
        (hasFact(intent, 'currency') && wrongCurrency(intent.currency)))
  );
}
function actualEvidence(data, recovery, linkedIntent) {
  if (amountConflict(data, recovery)) return null;
  const expected = minorAmount(recovery.amount, recovery.currency);
  const matches = (value) => Number.isSafeInteger(value) && BigInt(value) === expected;
  const sessionId = data && Object.hasOwn(data, 'session_id') ? data.session_id : data?.id;
  const hasAmount = data && Object.hasOwn(data, 'amount_total');
  const hasSummary = data?.total_summary && Object.hasOwn(data.total_summary, 'due');
  const exactPaidAmount =
    (hasAmount || hasSummary) &&
    (!hasAmount || matches(data.amount_total)) &&
    (!hasSummary || matches(data.total_summary.due));
  const paidCheckout =
    data?.object === 'checkout.session' &&
    sessionId === recovery.checkoutId &&
    data.status === 'complete' &&
    data.payment_status === 'paid' &&
    exactPaidAmount &&
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
function readOnlyInitialization(request, recovery) {
  let url;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  if (
    request.method() !== 'POST' ||
    url.origin !== 'https://api.stripe.com' ||
    url.username ||
    url.password ||
    url.pathname !== `/v1/payment_pages/${recovery.checkoutId}/init` ||
    !recovery.checkoutId.startsWith('cs_')
  )
    return false;
  const body = request.postData?.() || '';
  if (typeof body !== 'string' || body.length > 16000) return false;
  const allowed = {
    key: /^pk_(?:live|test)_[A-Za-z0-9]{1,300}$/,
    browser_locale: /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/,
    redirect_type: /^(?:url|iframe)$/,
    eid: /^[A-Za-z0-9_-]{1,300}$/,
    _stripe_version: /^[A-Za-z0-9_.;-]{1,120}$/
  };
  const values = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(body)) values.append(key, value);
  const used = new Set();
  for (const [key, value] of values) {
    if (used.has(key) || !Object.hasOwn(allowed, key) || !allowed[key].test(value)) return false;
    used.add(key);
  }
  return true;
}
function readOnlyRecoveryRequest(request, recovery) {
  const method = request.method();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  return readOnlyInitialization(request, recovery);
}
function blockedRequestClassification(request, original) {
  const method = request.method();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method))
    return { operation: 'READ_REQUEST', reason: 'GUARD_REJECTED' };
  const url = new URL(request.url());
  if (method === 'POST' && decodeURIComponent(url.pathname).replace(/\/+$/, '') === CHECKOUT_PATH)
    return { operation: 'CHECKOUT_CREATE', reason: 'NON_INITIALIZATION_OPERATION' };
  if (method !== 'POST' || url.origin !== 'https://api.stripe.com')
    return { operation: 'OTHER_WRITE', reason: 'NON_INITIALIZATION_OPERATION' };
  if (url.username || url.password)
    return { operation: 'STRIPE_OTHER_WRITE', reason: 'INVALID_REQUEST' };
  if (!/^\/v1\/payment_pages\/[^/]+\/init$/.test(url.pathname))
    return { operation: 'STRIPE_OTHER_WRITE', reason: 'NON_INITIALIZATION_OPERATION' };
  if (!original.checkoutId.startsWith('cs_'))
    return { operation: 'STRIPE_INIT_NATIVE_UNBOUND', reason: 'NATIVE_CHECKOUT_UNBOUND' };
  if (url.pathname !== `/v1/payment_pages/${original.checkoutId}/init`)
    return { operation: 'STRIPE_INIT_OTHER_CHECKOUT', reason: 'ORIGINAL_CHECKOUT_MISMATCH' };
  const operation = 'STRIPE_INIT_SAME_CHECKOUT';
  const body = request.postData?.() || '';
  if (typeof body !== 'string') return { operation, reason: 'BODY_UNAVAILABLE' };
  if (body.length > 16000) return { operation, reason: 'BODY_TOO_LARGE' };
  const allowed = {
    key: /^pk_(?:live|test)_[A-Za-z0-9]{1,300}$/,
    browser_locale: /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/,
    redirect_type: /^(?:url|iframe)$/,
    eid: /^[A-Za-z0-9_-]{1,300}$/,
    _stripe_version: /^[A-Za-z0-9_.;-]{1,120}$/
  };
  const values = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(body)) values.append(key, value);
  const used = new Set();
  for (const [key, value] of values) {
    if (used.has(key)) return { operation, reason: 'DUPLICATE_PARAMETER' };
    if (!Object.hasOwn(allowed, key)) return { operation, reason: 'UNKNOWN_PARAMETER' };
    if (!allowed[key].test(value)) return { operation, reason: 'INVALID_PARAMETER_VALUE' };
    used.add(key);
  }
  return { operation, reason: 'GUARD_REJECTED' };
}
function blockedGuardReason(error) {
  if (error?.code === 'LEASE_LOST') return 'LEASE_LOST';
  if (error?.code === 'CHECKOUT_RELOAD_PAYMENT_STARTED') return 'PAYMENT_ALREADY_STARTED';
  if (error?.code === 'CHECKOUT_RELOAD_ORIGINAL_CHANGED') return 'ORIGINAL_CHECKOUT_CHANGED';
  if (error?.code === 'CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN') return 'FRAME_GUARD_UNPROVEN';
  return 'GUARD_REJECTED';
}
function recordBlockedRequest(state, request, reason) {
  // Diagnostics never grant a request or retain its URL, identity, parameters or credentials.
  let classification;
  try {
    classification = blockedRequestClassification(request, state.original);
  } catch {
    classification = { operation: 'OTHER_WRITE', reason: 'INVALID_REQUEST' };
  }
  try {
    if (reason) classification.reason = reason;
    const counters = state.blockedRequestDiagnostics;
    let key = classification.operation + '|' + classification.reason;
    if (!counters.has(key) && counters.size >= 15) {
      classification = { operation: 'OTHER_REQUEST', reason: 'DIAGNOSTIC_LIMIT' };
      key = 'OTHER_REQUEST|DIAGNOSTIC_LIMIT';
    }
    const prior = counters.get(key);
    counters.set(key, { ...classification, count: Math.min(10000, (prior?.count || 0) + 1) });
  } catch {
    // A failed diagnostic must never prevent the existing rejection from running.
  }
}
function sanitizeOriginalCheckoutReloadDiagnostics(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const { reloadAttempts, blockedWrites, code, blockedRequestDiagnostics: sourceRows } = raw;
    if (
      reloadAttempts !== 1 ||
      !Number.isInteger(blockedWrites) ||
      blockedWrites < 0 ||
      blockedWrites > 10000 ||
      !RELOAD_DIAGNOSTIC_CODES.has(code)
    )
      return undefined;
    const rows = sourceRows === undefined ? [] : sourceRows;
    if (!Array.isArray(rows) || rows.length > 16) return undefined;
    const seen = new Set(),
      blockedRequestDiagnostics = [];
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== 3 ||
        !Object.hasOwn(row, 'operation') ||
        !Object.hasOwn(row, 'reason') ||
        !Object.hasOwn(row, 'count')
      )
        return undefined;
      const { operation, reason, count } = row;
      if (
        !BLOCKED_REQUEST_OPERATIONS.has(operation) ||
        !BLOCKED_REQUEST_REASONS.has(reason) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 10000
      )
        return undefined;
      const key = operation + '|' + reason;
      if (seen.has(key)) return undefined;
      seen.add(key);
      blockedRequestDiagnostics.push({ operation, reason, count });
    }
    return {
      reloadAttempts: 1,
      blockedWrites,
      ...(blockedRequestDiagnostics.length ? { blockedRequestDiagnostics } : {}),
      code
    };
  } catch {
    return undefined;
  }
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
function reloadFailure(code) {
  const message =
    code === 'LEASE_LOST'
      ? '任务已停止'
      : code === 'CHECKOUT_RELOAD_TIMEOUT'
        ? '原结账页重载超过本次总时限'
        : code === 'CHECKOUT_RELOAD_PAYMENT_STARTED'
          ? '原任务已提交付款，未重载结账页'
          : code === 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED'
            ? '原结账页已使用一次重载机会'
            : code === 'CHECKOUT_RELOAD_NOT_REQUIRED'
              ? '未确认原结账页存在可见加载失败'
              : code === 'CHECKOUT_RELOAD_ORIGINAL_CHANGED'
                ? '原结账页身份发生变化，未继续恢复'
                : '原结账页恢复条件未通过核验';
  return Object.assign(new Error(message), { code });
}
function submittedState(check) {
  if (typeof check !== 'function') throw reloadFailure('CHECKOUT_RELOAD_STATE_UNAVAILABLE');
  let submitted;
  try {
    submitted = check();
  } catch (error) {
    if (error?.code === 'LEASE_LOST') throw error;
    throw reloadFailure('CHECKOUT_RELOAD_STATE_UNAVAILABLE');
  }
  if (submitted !== false)
    throw reloadFailure(
      submitted === true ? 'CHECKOUT_RELOAD_PAYMENT_STARTED' : 'CHECKOUT_RELOAD_STATE_UNAVAILABLE'
    );
}
function reloadClock(options) {
  if (!Number.isFinite(options?.deadlineAt))
    throw reloadFailure('CHECKOUT_RELOAD_STATE_UNAVAILABLE');
  if (options.signal?.aborted || options.ownerSignal?.aborted) throw reloadFailure('LEASE_LOST');
  if (performance.now() >= options.deadlineAt) throw reloadFailure('CHECKOUT_RELOAD_TIMEOUT');
  submittedState(options.isSubmitted);
}
function haltOriginalReload(state, error) {
  if (state.phase !== 'halted') {
    state.phase = 'halted';
    state.code =
      error?.code === 'LEASE_LOST' || /^CHECKOUT_[A-Z0-9_]+$/.test(error?.code || '')
        ? error.code
        : 'CHECKOUT_RELOAD_FAILED';
  }
  clearTimeout(state.timer);
  return reloadFailure(state.code);
}
function assertOriginalReload(page, state, options = state.options) {
  if (state.phase === 'halted') throw reloadFailure(state.code);
  reloadClock(state.options);
  reloadClock({ ...options, deadlineAt: Math.min(state.options.deadlineAt, options.deadlineAt) });
  if (page.isClosed?.() || page.context() !== state.context)
    throw reloadFailure('CHECKOUT_RELOAD_ORIGINAL_CHANGED');
  let identity;
  try {
    identity = checkoutIdentity(page.url(), officialCheckoutForPage(page));
  } catch {
    throw reloadFailure('CHECKOUT_RELOAD_ORIGINAL_CHANGED');
  }
  if (
    identity.checkoutUrl !== state.original.checkoutUrl ||
    identity.checkoutId !== state.original.checkoutId ||
    identity.processorEntity !== state.original.processorEntity ||
    JSON.stringify(identity.source) !== JSON.stringify(state.original.source)
  )
    throw reloadFailure('CHECKOUT_RELOAD_ORIGINAL_CHANGED');
}
function originalCheckoutReloadDiagnostics(page) {
  const state = originalCheckoutReloads.get(page);
  return {
    reloadAttempts: state?.reloadAttempts || 0,
    blockedWrites: state?.blockedWrites || 0,
    ...(state?.blockedRequestDiagnostics.size
      ? {
          blockedRequestDiagnostics: [...state.blockedRequestDiagnostics.values()].map((item) => ({
            ...item
          }))
        }
      : {}),
    code: state?.code || 'CHECKOUT_RELOAD_NOT_ATTEMPTED'
  };
}
async function reloadOriginalCheckout(page, options = {}) {
  const existing = originalCheckoutReloads.get(page);
  if (existing)
    throw haltOriginalReload(existing, reloadFailure('CHECKOUT_RELOAD_ALREADY_ATTEMPTED'));
  reloadClock(options);
  const original = checkoutIdentity(page.url(), officialCheckoutForPage(page));
  const clock = { deadlineAt: options.deadlineAt, signal: options.signal };
  let loadFailed;
  try {
    loadFailed = await bounded(
      () =>
        require('./checkout-form.cjs').checkoutPageLoadFailed?.(page, {
          deadline: Date.now() + Math.max(0, clock.deadlineAt - performance.now()),
          signal: clock.signal
        }),
      clock
    );
  } catch (error) {
    if (error?.code === 'LEASE_LOST' || error?.code === 'CHECKOUT_FORM_ABORTED')
      throw reloadFailure('LEASE_LOST');
    throw reloadFailure(
      ['ORIGINAL_PAYMENT_READ_TIMEOUT', 'CHECKOUT_FORM_TIMEOUT'].includes(error?.code)
        ? 'CHECKOUT_RELOAD_TIMEOUT'
        : 'CHECKOUT_RELOAD_FAILED'
    );
  }
  reloadClock(options);
  if (loadFailed !== true) throw reloadFailure('CHECKOUT_RELOAD_NOT_REQUIRED');
  // Reserve before the first async route mutation so concurrent calls cannot reload twice.
  const reserved = originalCheckoutReloads.get(page);
  if (reserved)
    throw haltOriginalReload(reserved, reloadFailure('CHECKOUT_RELOAD_ALREADY_ATTEMPTED'));
  const state = {
    options: { ...options },
    original,
    context: page.context(),
    phase: 'readonly',
    code: 'CHECKOUT_RELOAD_READONLY',
    reloadAttempts: 1,
    blockedWrites: 0,
    blockedRequestDiagnostics: new Map(),
    inFlight: true,
    childTargets: new Map(),
    channels: new Set(),
    commandSequence: 0
  };
  originalCheckoutReloads.set(page, state);
  const leaseLost = () =>
    (state.phase === 'finished'
      ? state.options.ownerSignal || state.options.signal
      : state.options.signal
    )?.aborted || state.options.ownerSignal?.aborted;
  const abort = () => {
    if (leaseLost()) haltOriginalReload(state, reloadFailure('LEASE_LOST'));
  };
  state.options.signal?.addEventListener('abort', abort, { once: true });
  state.options.ownerSignal?.addEventListener('abort', abort, { once: true });
  state.timer = setTimeout(
    () => haltOriginalReload(state, reloadFailure('CHECKOUT_RELOAD_TIMEOUT')),
    Math.max(1, state.options.deadlineAt - performance.now())
  );
  page.once?.('close', () => {
    haltOriginalReload(state, reloadFailure('CHECKOUT_RELOAD_PAGE_CLOSED'));
    state.options.signal?.removeEventListener('abort', abort);
    state.options.ownerSignal?.removeEventListener('abort', abort);
    for (const channel of state.channels) channel.close();
  });
  const guard = async (cdp, event) => {
    const raw = event.request;
    const request = {
      url: () => raw.url,
      method: () => raw.method,
      frame: () => null,
      resourceType: () => String(event.resourceType || '').toLowerCase(),
      postData: () => raw.postData || ''
    };
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(raw.method);
    const reject = async (reason) => {
      if (writing) state.blockedWrites += 1;
      recordBlockedRequest(state, request, reason);
      await require('./checkout-initialization.cjs')
        .observeCancellation(
          page,
          request,
          'RELOAD_CDP',
          () =>
            cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient'
            }),
          false
        )
        .catch(() => {});
    };
    const proceed = () => cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    let url;
    try {
      url = new URL(request.url());
      if (
        request.method() === 'POST' &&
        decodeURIComponent(url.pathname).replace(/\/+$/, '') === CHECKOUT_PATH
      ) {
        return await reject();
      }
      if (state.phase === 'finished') {
        if (leaseLost()) throw reloadFailure('LEASE_LOST');
        return await proceed();
      }
      assertOriginalReload(page, state);
      if (
        event.resourceType === 'Document' &&
        event.frameId === state.mainFrameId &&
        url.href !== state.original.checkoutUrl
      )
        throw reloadFailure('CHECKOUT_RELOAD_ORIGINAL_CHANGED');
      // An omitted large POST body cannot be assumed to be a safe empty initialization.
      if (
        (writing && raw.hasPostData && typeof raw.postData !== 'string') ||
        !readOnlyRecoveryRequest(request, state.original)
      )
        return await reject(
          writing && raw.hasPostData && typeof raw.postData !== 'string'
            ? 'BODY_UNAVAILABLE'
            : undefined
        );
      return await proceed();
    } catch (error) {
      haltOriginalReload(state, error);
      await reject(blockedGuardReason(error));
    }
  };
  const bindGuard = (cdp) => {
    cdp.on('Fetch.requestPaused', (event) => {
      guard(cdp, event).catch((error) => {
        haltOriginalReload(state, error);
        require('./checkout-initialization.cjs')
          .observeCancellation(
            page,
            {
              url: () => event.request.url,
              method: () => event.request.method,
              frame: () => null
            },
            'RELOAD_CDP_FAILURE',
            () =>
              cdp.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: 'BlockedByClient'
              }),
            false
          )
          .catch(() => {});
      });
    });
  };
  const autoAttach = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
    filter: [{ type: 'iframe', exclude: false }, { exclude: true }]
  };
  const commandClock = (rejectOnly = false) => ({
    // This is only a protocol-command bound. Finished loading must not create
    // a new recharge budget or keep using the expired loading deadline.
    deadlineAt:
      rejectOnly || state.phase === 'finished'
        ? performance.now() + 2000
        : Math.min(state.options.deadlineAt, performance.now() + 2000),
    signal: rejectOnly
      ? undefined
      : state.phase === 'finished'
        ? state.options.ownerSignal || state.options.signal
        : state.options.signal
  });
  const assertGuardLive = () => {
    if (state.phase === 'halted') throw reloadFailure(state.code);
    if (leaseLost()) throw reloadFailure('LEASE_LOST');
    if (page.isClosed?.() || page.context() !== state.context)
      throw reloadFailure('CHECKOUT_RELOAD_PAGE_CLOSED');
    if (state.phase !== 'finished') assertOriginalReload(page, state);
  };
  const childChannel = (parent, sessionId) => {
    const channel = new EventEmitter();
    const pending = new Map();
    let closed = false;
    const receive = (event) => {
      if (event.sessionId !== sessionId || closed) return;
      let message;
      try {
        message = JSON.parse(event.message);
      } catch {
        haltOriginalReload(state, reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE'));
        channel.close();
        return;
      }
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE'));
        else entry.resolve(message.result || {});
      } else if (message.method) channel.emit(message.method, message.params || {});
    };
    parent.on('Target.receivedMessageFromTarget', receive);
    channel.send = async (method, params = {}, rejectingAncestor = false) => {
      if (closed) throw reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE');
      const id = ++state.commandSequence;
      const rejectOnly = method === 'Fetch.failRequest' || rejectingAncestor;
      try {
        return await bounded(
          () =>
            new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              if (
                method === 'Runtime.runIfWaitingForDebugger' ||
                method === 'Fetch.continueRequest'
              ) {
                try {
                  assertGuardLive();
                } catch (error) {
                  pending.delete(id);
                  reject(error);
                  return;
                }
              }
              parent
                .send(
                  'Target.sendMessageToTarget',
                  {
                    sessionId,
                    message: JSON.stringify({ id, method, params })
                  },
                  rejectOnly
                )
                .catch(() => {
                  const entry = pending.get(id);
                  if (!entry) return;
                  pending.delete(id);
                  entry.reject(reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE'));
                });
            }),
          commandClock(rejectOnly)
        );
      } finally {
        pending.delete(id);
      }
    };
    channel.close = () => {
      if (closed) return;
      closed = true;
      parent.removeListener('Target.receivedMessageFromTarget', receive);
      for (const entry of pending.values())
        entry.reject(reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE'));
      pending.clear();
      channel.emit('close');
      channel.removeAllListeners();
      state.channels.delete(channel);
    };
    parent.once('close', channel.close);
    channel.once('close', () => parent.removeListener('close', channel.close));
    state.channels.add(channel);
    return channel;
  };
  const bindTargets = (parent, legacyParent = false) => {
    const children = new Map();
    parent.on('Page.frameAttached', ({ frameId, parentFrameId }) => {
      if (state.ownedFrameIds.has(parentFrameId)) state.ownedFrameIds.add(frameId);
    });
    parent.on('Target.detachedFromTarget', ({ sessionId }) => {
      const child = children.get(sessionId);
      if (child) {
        child.detached = true;
        children.delete(sessionId);
        if (state.childTargets.get(child.targetId) === child)
          state.childTargets.delete(child.targetId);
        child.channel.close();
      }
    });
    parent.on('Target.attachedToTarget', (event) => {
      const info = event.targetInfo || {};
      const channel = childChannel(parent, event.sessionId);
      const child = { channel, targetId: info.targetId, ready: false };
      children.set(event.sessionId, child);
      // Only this page's iframe descendants can be resumed. Existing running
      // targets cannot retroactively prove that their first writes were guarded.
      const legacy = event.waitingForDebugger === false && (!state.reloadStarted || legacyParent);
      const owned =
        info.type === 'iframe' &&
        typeof info.targetId === 'string' &&
        state.ownedFrameIds.has(info.parentFrameId) &&
        (event.waitingForDebugger === true || legacy) &&
        !state.childTargets.has(info.targetId);
      if (!owned) {
        haltOriginalReload(state, reloadFailure('CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN'));
        return;
      }
      state.childTargets.set(info.targetId, child);
      state.ownedFrameIds.add(info.targetId);
      bindGuard(channel);
      bindTargets(channel, legacy);
      (async () => {
        assertGuardLive();
        await channel.send('Page.enable');
        await channel.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }]
        });
        await channel.send('Target.setAutoAttach', autoAttach);
        assertGuardLive();
        // A running target from the failed document is never retroactively
        // writable or resumed. Reload must destroy it before a fresh paused
        // target can receive this capability.
        if (legacy) return;
        child.ready = true;
        await channel.send('Runtime.runIfWaitingForDebugger');
      })().catch((error) => {
        child.ready = false;
        if (child.detached || page.isClosed?.()) return;
        haltOriginalReload(state, error);
        // Keep the target paused and its interception installed until page close.
        // Disabling auto-attach or detaching here could resume unprotected code.
      });
    });
  };
  const ensureFrameGuard = async (frame) => {
    while (frame && frame !== page.mainFrame()) {
      let identity;
      try {
        identity = await bounded(() => state.context.newCDPSession(frame), commandClock());
      } catch (error) {
        if (
          error?.message ===
          "browserContext.newCDPSession: This frame does not have a separate CDP session, it is a part of the parent frame's session"
        ) {
          frame = frame.parentFrame();
          continue;
        }
        throw reloadFailure('CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN');
      }
      try {
        const { targetInfo } = await bounded(
          () => identity.send('Target.getTargetInfo'),
          commandClock()
        );
        if (state.childTargets.get(targetInfo?.targetId)?.ready === true) return;
        throw reloadFailure('CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN');
      } finally {
        await identity.detach().catch(() => {});
      }
    }
    if (!state.guardReady || !state.autoAttachReady)
      throw reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE');
  };
  const childFrameGuard = async (route) => {
    const request = route.request();
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
    const reject = async (reason) => {
      if (writing) state.blockedWrites += 1;
      recordBlockedRequest(state, request, reason);
      await require('./checkout-initialization.cjs')
        .abortRoute(route, 'RELOAD_FRAME', 'blockedbyclient')
        .catch(() => {});
    };
    try {
      if (state.phase === 'halted') throw reloadFailure(state.code);
      if (leaseLost()) throw reloadFailure('LEASE_LOST');
      if (request.frame() === page.mainFrame()) {
        if (!state.guardReady && writing) return await reject('GUARD_UNAVAILABLE');
        return await route.fallback();
      }
      const url = new URL(request.url());
      if (
        request.method() === 'POST' &&
        decodeURIComponent(url.pathname).replace(/\/+$/, '') === CHECKOUT_PATH
      )
        return await reject();
      if (state.phase !== 'finished') {
        assertOriginalReload(page, state);
        if (!readOnlyRecoveryRequest(request, state.original)) return await reject();
      }
      if (writing) {
        // This exact frame target was paused before scripts started, and only
        // resumed after its Fetch guard and recursive auto-attach were ACKed.
        await ensureFrameGuard(request.frame());
        if (state.phase === 'halted') throw reloadFailure(state.code);
        if (leaseLost()) throw reloadFailure('LEASE_LOST');
        if (state.phase !== 'finished') assertOriginalReload(page, state);
      }
      return await route.fallback();
    } catch (error) {
      haltOriginalReload(
        state,
        error?.code === 'ORIGINAL_PAYMENT_READ_TIMEOUT'
          ? reloadFailure('CHECKOUT_RELOAD_TIMEOUT')
          : error
      );
      await reject(blockedGuardReason(error));
    }
  };
  try {
    // Keep a deny-write fallback even when CDP admission fails or a concurrent
    // recovery attempt halts the state before Fetch has finished installing.
    await bounded(() => page.route('**/*', childFrameGuard), clock);
    // Playwright routes only the first URL of an HTTP redirect. This same-target
    // Fetch guard also pauses redirected requests before any network write.
    await bounded(async () => {
      if (typeof state.context.newCDPSession !== 'function')
        throw reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE');
      state.cdp = await state.context.newCDPSession(page);
      const { frameTree } = await state.cdp.send('Page.getFrameTree');
      state.mainFrameId = frameTree?.frame?.id;
      if (!state.mainFrameId) throw reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE');
      state.ownedFrameIds = new Set();
      const ownTree = (tree) => {
        state.ownedFrameIds.add(tree.frame.id);
        for (const child of tree.childFrames || []) ownTree(child);
      };
      ownTree(frameTree);
      bindGuard(state.cdp);
      bindTargets(state.cdp);
      await state.cdp.send('Page.enable');
      await state.cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }]
      });
      state.guardReady = true;
      await state.cdp.send('Target.setAutoAttach', autoAttach);
      state.autoAttachReady = true;
    }, clock);
    assertOriginalReload(page, state);
    await bounded(async () => {
      assertOriginalReload(page, state);
      try {
        state.reloadStarted = true;
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(10000, checkLive(clock))
        });
      } finally {
        state.inFlight = false;
      }
    }, clock);
    assertOriginalReload(page, state);
    return originalCheckoutReloadDiagnostics(page);
  } catch (error) {
    throw haltOriginalReload(
      state,
      error?.code === 'ORIGINAL_PAYMENT_READ_TIMEOUT' ||
        (state.reloadStarted && !error?.code && error?.name === 'TimeoutError')
        ? reloadFailure('CHECKOUT_RELOAD_TIMEOUT')
        : !state.guardReady && !error?.code
          ? reloadFailure('CHECKOUT_RELOAD_GUARD_UNAVAILABLE')
          : error
    );
  }
}
async function finishOriginalCheckoutReload(page, options = {}) {
  const state = originalCheckoutReloads.get(page);
  if (!state || state.inFlight || state.phase !== 'readonly')
    throw reloadFailure(
      state?.phase === 'halted' ? state.code : 'CHECKOUT_RELOAD_STATE_UNAVAILABLE'
    );
  try {
    assertOriginalReload(page, state, options);
    state.phase = 'finished';
    state.code = 'CHECKOUT_RELOAD_READY';
    clearTimeout(state.timer);
    return originalCheckoutReloadDiagnostics(page);
  } catch (error) {
    throw haltOriginalReload(state, error);
  }
}
function observePayment(page, rawRecovery, options = {}) {
  const recovery = validateRecovery(rawRecovery);
  const clock = { ...options, deadlineAt: options.deadlineAt ?? performance.now() + 180000 };
  let armed = options.alreadySubmitted === true,
    stopped = false,
    linkedIntent = null,
    evidence = null,
    amountConflictObserved = false,
    phaseStarted = false;
  let resolveOriginalRead;
  const originalRead = new Promise((resolve) => {
    resolveOriginalRead = resolve;
  });
  let chain = Promise.resolve();
  const accept = async (data, request) => {
    if (stopped || !armed) return;
    checkLive(clock);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    const method = request.method;
    if (
      (Object.hasOwn(data, 'checkout_session_id') &&
        data.checkout_session_id !== recovery.checkoutId) ||
      (Object.hasOwn(data, 'session_id') && data.session_id !== recovery.checkoutId)
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
        (['GET', 'POST'].includes(method) && url.pathname === `${checkoutPath}init`) ||
        (method === 'POST' && url.pathname === `${checkoutPath}confirm`);
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
    if (
      data.object === 'checkout.session' &&
      !Object.hasOwn(data, 'session_id') &&
      Object.hasOwn(data, 'id') &&
      data.id !== recovery.checkoutId
    )
      return;
    if (bound) resolveOriginalRead();
    if (bound) {
      const candidate = data?.object === 'payment_intent' ? data : data?.payment_intent;
      const id = typeof candidate === 'string' ? candidate : candidate?.id;
      const clientSecretId =
        typeof data?.client_secret === 'string' &&
        /^(pi_[A-Za-z0-9]{1,180})_secret_[A-Za-z0-9]+$/.exec(data.client_secret)?.[1];
      const candidateId = id || clientSecretId;
      if (candidateId && /^pi_[A-Za-z0-9]{1,180}$/.test(candidateId)) {
        if (linkedIntent && linkedIntent !== candidateId) {
          // Ignore the unrelated intent, but retain explicit contradictory
          // facts returned for this original checkout itself.
          const checkoutFacts = { ...data };
          delete checkoutFacts.payment_intent;
          if (data.object !== 'payment_intent' && amountConflict(checkoutFacts, recovery)) {
            amountConflictObserved = true;
            evidence = null;
          }
          return;
        }
      }
      if (amountConflict(data, recovery)) {
        amountConflictObserved = true;
        evidence = null;
        return;
      }
      if (!amountConflictObserved && candidateId && /^pi_[A-Za-z0-9]{1,180}$/.test(candidateId))
        linkedIntent = candidateId;
    } else {
      if (data.object !== 'payment_intent' || data.id !== linkedIntent) return;
      if (amountConflict(data, recovery)) {
        amountConflictObserved = true;
        evidence = null;
        return;
      }
    }
    if (amountConflictObserved) return;
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
    async waitForOriginalRead() {
      await bounded(() => originalRead, clock, 10000).catch(() => {});
    },
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
    // Stripe's same-session init reads the original state. It cannot carry billing,
    // card or confirmation fields; every other POST remains blocked.
    await page.route('**/*', (route) =>
      readOnlyRecoveryRequest(route.request(), recovery)
        ? route.fallback()
        : require('./checkout-initialization.cjs').abortRoute(
            route,
            'RECOVERY_READONLY',
            'blockedbyclient'
          )
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
      await observer.waitForOriginalRead();
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
  reloadOriginalCheckout,
  finishOriginalCheckoutReload,
  originalCheckoutReloadDiagnostics,
  sanitizeOriginalCheckoutReloadDiagnostics,
  rememberOfficialCheckout,
  officialCheckoutForPage,
  readOnlyRecoveryRequest,
  buildCheckoutRecovery,
  quoteIdForUrl,
  validateRecovery,
  sameContext,
  minorAmount,
  observePayment,
  recoverOriginalPayment,
  actualEvidence
};
