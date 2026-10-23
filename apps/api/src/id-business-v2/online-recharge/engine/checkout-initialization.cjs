'use strict';
// Observe this task page only. Never intercept requests or read bodies, headers,
// field values, raw console output, stack traces, or complete URLs into evidence.
const { performance } = require('node:perf_hooks');
const EVENTS = new Set([
  'request',
  'response',
  'request_finished',
  'request_failed',
  'script_error',
  'console_error',
  'csp',
  'frame_attached',
  'frame_navigated',
  'frame_detached',
  'route_abort',
  'page_closed'
]);
const ENDPOINTS = new Set([
  'stripe_script',
  'stripe_frame',
  'stripe_elements',
  'stripe_init',
  'stripe_confirm',
  'stripe_other',
  'chatgpt_checkout',
  'chatgpt_auth',
  'chatgpt_script',
  'chatgpt_other',
  'openai_checkout',
  'verification',
  'other'
]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']);
const CODES = new Set([
  'DNS_FAILED',
  'PROXY_AUTH_FAILED',
  'PROXY_TUNNEL_FAILED',
  'TLS_FAILED',
  'CONNECTION_RESET',
  'CONNECTION_CLOSED',
  'CONNECTION_REFUSED',
  'TIMEOUT',
  'BLOCKED_BY_CLIENT',
  'BLOCKED_BY_CSP',
  'ABORTED',
  'NETWORK_FAILED',
  'JS_TYPE_ERROR',
  'JS_SYNTAX_ERROR',
  'JS_REFERENCE_ERROR',
  'SCRIPT_LOAD_FAILED',
  'SDK_INITIALIZATION_FAILED',
  'STRIPE_KEY_INVALID',
  'STRIPE_CLIENT_SECRET_INVALID',
  'CORS_BLOCKED',
  'SCRIPT_ERROR'
]);
const DIRECTIVES = new Set([
  'script-src',
  'script-src-elem',
  'frame-src',
  'connect-src',
  'default-src',
  'style-src',
  'other'
]);
const MAX_EVENTS = 64;
const MAX_FAILURE_CLASSES = 32;
const MAX_CRITICAL_EVENTS = 96;
const MAX_PENDING_REQUESTS = 48;
const RULES = new Set([
  'SESSION_GOOGLE_LOGIN',
  'SESSION_MICROSOFT_LOGIN',
  'SESSION_OFFICIAL_LOGIN',
  'RELOAD_CDP',
  'RELOAD_CDP_FAILURE',
  'RELOAD_FRAME',
  'RECOVERY_READONLY'
]);
const RESOURCES = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
  'unknown'
]);
const ROUTES = new Set([
  'auth_session',
  'auth_csrf',
  'checkout_page',
  'checkout_create',
  'stripe_elements',
  'stripe_init',
  'stripe_confirm',
  'other'
]);
const SOURCES = new Set(['our_route_abort', 'network_or_proxy', 'unknown_abort', 'network_other']);
const ABORT_STATES = new Set(['requested', 'completed', 'failed']);
const FAILURE_CODES = new Set([
  'ERR_FAILED',
  'ERR_ABORTED',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_CSP',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_AUTH_REQUESTED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_TIMED_OUT',
  'NS_BINDING_ABORTED',
  'NS_ERROR_NET_RESET',
  'NS_ERROR_UNKNOWN_HOST',
  'OTHER'
]);
const abortMarks = new WeakMap();
const pageObservers = new WeakMap();
function routeTemplate(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'other';
    if (
      ['chatgpt.com', 'openai.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith('.' + host)
      )
    ) {
      if (url.pathname === '/api/auth/session') return 'auth_session';
      if (url.pathname === '/api/auth/csrf') return 'auth_csrf';
      if (url.hostname === 'chatgpt.com' && /^\/checkout\//.test(url.pathname))
        return 'checkout_page';
      if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/payments/checkout')
        return 'checkout_create';
    }
    const category = endpoint(raw);
    return ['stripe_elements', 'stripe_init', 'stripe_confirm'].includes(category)
      ? category
      : 'other';
  } catch {
    return 'other';
  }
}
// Observation wraps the original cancellation without changing its arguments,
// retrying it, or replacing its error. CDP requests have no Playwright Request
// identity: record their rule separately rather than guessing a correlation.
async function observeCancellation(page, request, ruleId, cancel, correlate = true) {
  const mark = { ruleId, abortState: 'requested' };
  if (RULES.has(ruleId) && request && typeof request === 'object') {
    if (correlate) abortMarks.set(request, mark);
    pageObservers.get(page)?.(request, mark);
  }
  try {
    const result = await cancel();
    mark.abortState = 'completed';
    return result;
  } catch (error) {
    mark.abortState = 'failed';
    throw error;
  } finally {
    if (RULES.has(ruleId)) pageObservers.get(page)?.(request, mark);
  }
}
function abortRoute(route, ruleId, ...args) {
  const request = route.request();
  let page;
  try {
    page = request.frame()?.page();
  } catch {
    /* Request frame may not exist yet. */
  }
  return observeCancellation(page, request, ruleId, () => route.abort(...args));
}
const count = (n) => Number.isInteger(n) && n >= 0 && n <= 10000;
const elapsed = (n) => Number.isInteger(n) && n >= 0 && n <= 3600000;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
function endpoint(raw, resourceType) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'other';
    const host = url.hostname;
    if (host === 'js.stripe.com') {
      if (resourceType === 'document' || /\.html$/.test(url.pathname)) return 'stripe_frame';
      if (resourceType === 'script' || /^\/v3\/?$/.test(url.pathname) || /\.js$/.test(url.pathname))
        return 'stripe_script';
      return 'stripe_other';
    }
    if (host === 'api.stripe.com') {
      if (/^\/v1\/elements\/sessions?$/.test(url.pathname)) return 'stripe_elements';
      if (/^\/v1\/payment_pages\/[^/]+\/init$/.test(url.pathname)) return 'stripe_init';
      if (/\/(?:confirm|confirm_payment)$/.test(url.pathname)) return 'stripe_confirm';
      return 'stripe_other';
    }
    if (host === 'hooks.stripe.com' || host === 'm.stripe.network') return 'stripe_other';
    if (host === 'pay.openai.com' || host === 'checkout.stripe.com') return 'openai_checkout';
    if (host === 'chatgpt.com') {
      if (url.pathname.startsWith('/checkout') || url.pathname.startsWith('/backend-api/payments/'))
        return 'chatgpt_checkout';
      if (url.pathname.startsWith('/api/auth/')) return 'chatgpt_auth';
      return 'chatgpt_other';
    }
    if (host === 'cdn.oaistatic.com') return 'chatgpt_script';
    if (
      host === 'hcaptcha.com' ||
      host.endsWith('.hcaptcha.com') ||
      host === 'challenges.cloudflare.com'
    )
      return 'verification';
  } catch {
    /* Malformed or unavailable URLs are a category, never raw evidence. */
  }
  return 'other';
}
function networkCode(raw) {
  const text = String(raw || '');
  for (const [pattern, code] of [
    [/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/, 'DNS_FAILED'],
    [/PROXY_AUTH|407/, 'PROXY_AUTH_FAILED'],
    [/TUNNEL_CONNECTION|PROXY_CONNECTION/, 'PROXY_TUNNEL_FAILED'],
    [/CERT_|SSL_|TLS_/, 'TLS_FAILED'],
    [/CONNECTION_RESET|ECONNRESET/, 'CONNECTION_RESET'],
    [/CONNECTION_CLOSED/, 'CONNECTION_CLOSED'],
    [/CONNECTION_REFUSED|ECONNREFUSED/, 'CONNECTION_REFUSED'],
    [/TIMED_OUT|TIMEOUT|ETIMEDOUT/, 'TIMEOUT'],
    [/BLOCKED_BY_CLIENT/, 'BLOCKED_BY_CLIENT'],
    [/BLOCKED_BY_CSP/, 'BLOCKED_BY_CSP'],
    [/ABORTED|CANCELLED/, 'ABORTED']
  ])
    if (pattern.test(text)) return code;
  return 'NETWORK_FAILED';
}
function safeRow(row) {
  if (
    !object(row) ||
    Object.keys(row).some(
      (k) =>
        ![
          'event',
          'elapsedMs',
          'endpoint',
          'frame',
          'method',
          'status',
          'code',
          'directive',
          'requestId',
          'frameId',
          'resourceType',
          'routeTemplate',
          'source',
          'ruleId',
          'abortState',
          'failureCode',
          'navigationRelated',
          'ownerEndpoint',
          'startedMs',
          'responseMs',
          'durationMs'
        ].includes(k)
    ) ||
    !EVENTS.has(row.event) ||
    !elapsed(row.elapsedMs) ||
    !ENDPOINTS.has(row.endpoint) ||
    !['main', 'embedded', 'unknown'].includes(row.frame) ||
    (row.method !== undefined && !METHODS.has(row.method)) ||
    (row.status !== undefined &&
      (!Number.isInteger(row.status) || row.status < 100 || row.status > 599)) ||
    (row.code !== undefined && !CODES.has(row.code)) ||
    (row.directive !== undefined && !DIRECTIVES.has(row.directive)) ||
    (row.requestId !== undefined && (!count(row.requestId) || row.requestId < 1)) ||
    (row.frameId !== undefined && (!count(row.frameId) || row.frameId < 1)) ||
    (row.resourceType !== undefined && !RESOURCES.has(row.resourceType)) ||
    (row.routeTemplate !== undefined && !ROUTES.has(row.routeTemplate)) ||
    (row.source !== undefined && !SOURCES.has(row.source)) ||
    (row.ruleId !== undefined && !RULES.has(row.ruleId)) ||
    (row.abortState !== undefined && !ABORT_STATES.has(row.abortState)) ||
    (row.failureCode !== undefined && !FAILURE_CODES.has(row.failureCode)) ||
    (row.navigationRelated !== undefined && row.navigationRelated !== 'possible') ||
    (row.ownerEndpoint !== undefined && !ENDPOINTS.has(row.ownerEndpoint)) ||
    ['startedMs', 'responseMs', 'durationMs'].some(
      (key) => row[key] !== undefined && !elapsed(row[key])
    ) ||
    (row.startedMs !== undefined && row.startedMs > row.elapsedMs) ||
    (row.responseMs !== undefined && row.responseMs > row.elapsedMs)
  )
    return null;
  return { ...row };
}
const isFailure = (row) =>
  ['request_failed', 'script_error', 'console_error', 'csp'].includes(row.event) ||
  (row.event === 'response' && row.status >= 400);
function sanitize(value) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'version',
          'elapsedMs',
          'events',
          'firstFailure',
          'failureClasses',
          'failureClassesTruncated',
          'eventCount',
          'readFailures',
          'truncated',
          'criticalEvents',
          'criticalEventCount',
          'criticalTruncated',
          'requestCounts',
          'pendingRequests',
          'pendingRequestCount',
          'pendingRequestsTruncated'
        ].includes(k)
    ) ||
    ![1, 2].includes(value.version) ||
    !elapsed(value.elapsedMs) ||
    !count(value.eventCount) ||
    !count(value.readFailures) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_EVENTS
  )
    return undefined;
  const events = value.events.map(safeRow);
  const firstFailure = value.firstFailure === null ? null : safeRow(value.firstFailure);
  if (
    !Array.isArray(value.failureClasses) ||
    value.failureClasses.length > MAX_FAILURE_CLASSES ||
    typeof value.failureClassesTruncated !== 'boolean'
  )
    return undefined;
  const failureClasses = value.failureClasses.map((entry) => {
    if (!object(entry)) return null;
    const { count: occurrences, lastElapsedMs, ...first } = entry;
    const row = safeRow(first);
    if (
      !row ||
      !isFailure(row) ||
      !count(occurrences) ||
      occurrences < 1 ||
      !elapsed(lastElapsedMs) ||
      lastElapsedMs < row.elapsedMs
    )
      return null;
    return { ...row, count: occurrences, lastElapsedMs };
  });
  if (
    events.some((v) => !v) ||
    failureClasses.some((v) => !v) ||
    (value.firstFailure !== null && !firstFailure) ||
    (firstFailure && (!isFailure(firstFailure) || !value.eventCount)) ||
    value.eventCount < events.length
  )
    return undefined;
  let extra = {};
  if (value.version === 2) {
    if (
      !Array.isArray(value.criticalEvents) ||
      value.criticalEvents.length > MAX_CRITICAL_EVENTS ||
      !count(value.criticalEventCount) ||
      value.criticalEventCount < value.criticalEvents.length ||
      typeof value.criticalTruncated !== 'boolean' ||
      !Array.isArray(value.pendingRequests) ||
      value.pendingRequests.length > MAX_PENDING_REQUESTS ||
      !count(value.pendingRequestCount) ||
      value.pendingRequestCount < value.pendingRequests.length ||
      typeof value.pendingRequestsTruncated !== 'boolean' ||
      !Array.isArray(value.requestCounts) ||
      value.requestCounts.length > ENDPOINTS.size
    )
      return undefined;
    const criticalEvents = value.criticalEvents.map(safeRow);
    const pendingRequests = value.pendingRequests.map(safeRow);
    if (
      criticalEvents.some((row) => !row) ||
      pendingRequests.some((row) => !row || row.event !== 'request')
    )
      return undefined;
    const requestCounts = value.requestCounts.map((row) => {
      const keys = ['started', 'responses', 'finished', 'failed', 'pending'];
      if (
        !object(row) ||
        !ENDPOINTS.has(row.endpoint) ||
        Object.keys(row).some((key) => key !== 'endpoint' && !keys.includes(key)) ||
        keys.some((key) => !count(row[key]))
      )
        return null;
      return { ...row };
    });
    if (
      requestCounts.some((row) => !row) ||
      new Set(requestCounts.map((row) => row.endpoint)).size !== requestCounts.length
    )
      return undefined;
    extra = {
      criticalEvents,
      criticalEventCount: value.criticalEventCount,
      criticalTruncated: value.criticalTruncated,
      requestCounts,
      pendingRequests,
      pendingRequestCount: value.pendingRequestCount,
      pendingRequestsTruncated: value.pendingRequestsTruncated
    };
  } else if (
    [
      'criticalEvents',
      'criticalEventCount',
      'criticalTruncated',
      'requestCounts',
      'pendingRequests',
      'pendingRequestCount',
      'pendingRequestsTruncated'
    ].some((key) => key in value)
  )
    return undefined;
  return {
    version: value.version,
    elapsedMs: value.elapsedMs,
    eventCount: value.eventCount,
    readFailures: value.readFailures,
    truncated: value.truncated,
    events,
    firstFailure,
    failureClasses,
    failureClassesTruncated: value.failureClassesTruncated,
    ...extra
  };
}
function observe(page, { signal } = {}) {
  const started = performance.now(),
    events = [],
    failureClasses = [],
    listeners = [],
    frameIds = new WeakMap(),
    requestIds = new WeakMap(),
    requestStates = new WeakMap(),
    pending = new Map(),
    requestCounts = new Map(),
    criticalEvents = [],
    navigations = [];
  let frameSequence = 0,
    requestSequence = 0;
  const identity = (map, item, next) => {
    if (!item || typeof item !== 'object') return undefined;
    if (!map.has(item)) map.set(item, next());
    return map.get(item);
  };
  const frameId = (frame) => identity(frameIds, frame, () => Math.min(10000, ++frameSequence));
  let stopped = false,
    eventCount = 0,
    readFailures = 0,
    truncated = false,
    failureClassesTruncated = false,
    firstFailure = null,
    criticalEventCount = 0,
    criticalTruncated = false,
    pendingRequestCount = 0,
    frozenMs;
  const time = () => Math.min(3600000, Math.max(0, Math.floor(performance.now() - started)));
  const critical = (row) =>
    /^(?:stripe_|openai_checkout|chatgpt_checkout|verification)/.test(row.endpoint) ||
    /^frame_/.test(row.event) ||
    ['script_error', 'console_error', 'csp', 'route_abort'].includes(row.event) ||
    (row.frame === 'embedded' && row.resourceType === 'script');
  const frameKind = (frame) =>
    !frame ? 'unknown' : frame === page.mainFrame() ? 'main' : 'embedded';
  const record = (data) => {
    if (stopped || signal?.aborted) return;
    const row = safeRow({ elapsedMs: time(), ...data });
    if (!row) {
      readFailures = Math.min(10000, readFailures + 1);
      return;
    }
    eventCount = Math.min(10000, eventCount + 1);
    if (!firstFailure && isFailure(row)) firstFailure = row;
    if (isFailure(row)) {
      const same = failureClasses.find((previous) =>
        [
          'event',
          'endpoint',
          'frame',
          'method',
          'status',
          'code',
          'directive',
          'source',
          'ruleId',
          'ownerEndpoint',
          'resourceType'
        ].every((key) => previous[key] === row[key])
      );
      if (same) {
        same.count = Math.min(10000, same.count + 1);
        same.lastElapsedMs = row.elapsedMs;
      } else if (failureClasses.length < MAX_FAILURE_CLASSES) {
        failureClasses.push({ ...row, count: 1, lastElapsedMs: row.elapsedMs });
      } else failureClassesTruncated = true;
    }
    if (events.length < MAX_EVENTS) events.push(row);
    else truncated = true;
    if (critical(row)) {
      criticalEventCount = Math.min(10000, criticalEventCount + 1);
      // Keep the first half and the latest half. General page traffic cannot
      // consume this separate payment/frame timeline; overflow stays explicit.
      if (criticalEvents.length === MAX_CRITICAL_EVENTS) {
        criticalEvents.splice(MAX_CRITICAL_EVENTS / 2, 1);
        criticalTruncated = true;
      }
      criticalEvents.push(row);
    }
  };
  const listen = (name, callback) => {
    const safe = (...args) => {
      if (stopped || signal?.aborted) return;
      try {
        callback(...args);
      } catch {
        readFailures = Math.min(10000, readFailures + 1);
      }
    };
    page.on(name, safe);
    listeners.push([name, safe]);
  };
  const requestData = (request) => {
    const resourceType = RESOURCES.has(request.resourceType?.())
      ? request.resourceType()
      : 'unknown';
    const category = endpoint(request.url(), resourceType);
    const method = request.method();
    let frame = 'unknown',
      id,
      ownerEndpoint;
    try {
      const owner = request.frame();
      frame = frameKind(owner);
      id = frameId(owner);
      ownerEndpoint = endpoint(owner?.url?.(), 'document');
    } catch {
      // A navigation request may arrive before its frame exists. Keep its
      // failure/status evidence even when that optional association is absent.
      readFailures = Math.min(10000, readFailures + 1);
    }
    return {
      endpoint: category,
      frame,
      ...(id ? { frameId: id } : {}),
      ...(ownerEndpoint ? { ownerEndpoint } : {}),
      requestId: identity(requestIds, request, () => Math.min(10000, ++requestSequence)),
      resourceType,
      routeTemplate: routeTemplate(request.url()),
      method: METHODS.has(method) ? method : 'OTHER'
    };
  };
  const recordAbort = (request, mark) => {
    try {
      record({ event: 'route_abort', ...requestData(request), source: 'our_route_abort', ...mark });
    } catch {
      readFailures = Math.min(10000, readFailures + 1);
    }
  };
  pageObservers.set(page, recordAbort);
  const stop = () => {
    if (stopped) return;
    frozenMs = time();
    stopped = true;
    if (pageObservers.get(page) === recordAbort) pageObservers.delete(page);
    for (const [name, listener] of listeners) {
      try {
        page.off(name, listener);
      } catch {
        readFailures = Math.min(10000, readFailures + 1);
      }
    }
    signal?.removeEventListener('abort', stop);
  };
  const related = (row) => {
    if (
      row.event !== 'request_failed' ||
      row.code !== 'ABORTED' ||
      row.source === 'our_route_abort'
    )
      return { ...row };
    // Same-frame timing is a correlation only, including a detach observed just
    // after requestfailed. It must never turn into an asserted cause.
    return {
      ...row,
      ...(row.frameId &&
      navigations.some(
        (n) => n.frameId === row.frameId && Math.abs(n.elapsedMs - row.elapsedMs) < 1500
      )
        ? { navigationRelated: 'possible' }
        : {})
    };
  };
  const snapshot = () =>
    sanitize({
      version: 2,
      elapsedMs: frozenMs ?? time(),
      eventCount,
      readFailures,
      truncated,
      events: events.map(related),
      firstFailure: firstFailure ? related(firstFailure) : null,
      failureClasses: failureClasses.map(related),
      failureClassesTruncated,
      criticalEvents: criticalEvents.map(related),
      criticalEventCount,
      criticalTruncated,
      requestCounts: [...requestCounts.values()].map((row) => ({ ...row })),
      pendingRequests: [...pending.values()].map((row) => ({
        ...row,
        durationMs: (frozenMs ?? time()) - row.startedMs
      })),
      pendingRequestCount,
      pendingRequestsTruncated: pendingRequestCount > pending.size
    });
  const countsFor = (category) => {
    if (!requestCounts.has(category))
      requestCounts.set(category, {
        endpoint: category,
        started: 0,
        responses: 0,
        finished: 0,
        failed: 0,
        pending: 0
      });
    return requestCounts.get(category);
  };
  const increment = (row, key, delta = 1) => {
    row[key] = Math.max(0, Math.min(10000, row[key] + delta));
  };
  const lifecycle = (request, event, status) => {
    const data = requestData(request),
      at = time(),
      counters = countsFor(data.endpoint);
    let state = requestStates.get(request);
    if (event === 'request' && !state) {
      state = { startedMs: at, ended: false };
      requestStates.set(request, state);
      increment(counters, 'started');
      increment(counters, 'pending');
      pendingRequestCount = Math.min(10000, pendingRequestCount + 1);
      if (pending.size === MAX_PENDING_REQUESTS && critical(data)) {
        const expendable = [...pending].find(([, row]) => !critical(row));
        if (expendable) pending.delete(expendable[0]);
      }
      if (pending.size < MAX_PENDING_REQUESTS)
        pending.set(data.requestId, {
          event: 'request',
          ...data,
          elapsedMs: at,
          startedMs: at
        });
    } else if (event === 'response') {
      increment(counters, 'responses');
      if (state && !state.ended) state.responseMs = at;
      const active = pending.get(data.requestId);
      if (active) Object.assign(active, { responseMs: at, status, elapsedMs: at });
    } else if (['request_finished', 'request_failed'].includes(event)) {
      increment(counters, event === 'request_finished' ? 'finished' : 'failed');
      if (state && !state.ended) {
        state.ended = true;
        increment(counters, 'pending', -1);
        pendingRequestCount = Math.max(0, pendingRequestCount - 1);
        pending.delete(data.requestId);
      }
    }
    return {
      ...data,
      ...(status !== undefined ? { status } : {}),
      ...(state
        ? {
            startedMs: state.startedMs,
            durationMs: at - state.startedMs,
            ...(state.responseMs !== undefined ? { responseMs: state.responseMs } : {})
          }
        : {})
    };
  };
  try {
    listen('request', (request) => record({ event: 'request', ...lifecycle(request, 'request') }));
    listen('response', (response) =>
      record({ event: 'response', ...lifecycle(response.request(), 'response', response.status()) })
    );
    listen('requestfinished', (request) =>
      record({ event: 'request_finished', ...lifecycle(request, 'request_finished') })
    );
    listen('requestfailed', (request) => {
      const errorText = String(request.failure()?.errorText || '');
      const code = networkCode(errorText);
      const failureCode =
        [...FAILURE_CODES].find(
          (value) => value !== 'OTHER' && new RegExp('\\b' + value + '\\b').test(errorText)
        ) || 'OTHER';
      const mark = abortMarks.get(request);
      record({
        event: 'request_failed',
        ...lifecycle(request, 'request_failed'),
        code,
        failureCode,
        source: mark
          ? 'our_route_abort'
          : /^(?:DNS_|PROXY_|TLS_|CONNECTION_)/.test(code)
            ? 'network_or_proxy'
            : code === 'ABORTED'
              ? 'unknown_abort'
              : 'network_other',
        ...(mark ? { ...mark } : {})
      });
    });
    listen('pageerror', (error) =>
      record({
        event: 'script_error',
        endpoint: 'other',
        frame: 'unknown',
        code:
          {
            TypeError: 'JS_TYPE_ERROR',
            SyntaxError: 'JS_SYNTAX_ERROR',
            ReferenceError: 'JS_REFERENCE_ERROR'
          }[error?.name] || 'SCRIPT_ERROR'
      })
    );
    listen('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/Content Security Policy|violat(?:es|ed|ing).*directive/i.test(text)) {
        const directive =
          text.match(
            /\b(?:script-src-elem|script-src|frame-src|connect-src|default-src|style-src)\b/
          )?.[0] || 'other';
        record({
          event: 'csp',
          endpoint: endpoint(message.location()?.url),
          frame: 'unknown',
          code: 'BLOCKED_BY_CSP',
          directive
        });
      } else {
        const code = /CORS policy|Access-Control-Allow-Origin|Cross-Origin Request Blocked/i.test(
          text
        )
          ? 'CORS_BLOCKED'
          : /Invalid (?:publishable|API) Key|No API key provided|api_key_expired|invalid_api_key/i.test(
                text
              )
            ? 'STRIPE_KEY_INVALID'
            : /client.?secret/i.test(text) && /invalid|missing|required|expired/i.test(text)
              ? 'STRIPE_CLIENT_SECRET_INVALID'
              : /ChunkLoadError|Loading chunk|Failed to (?:fetch|load).*module|Loading.*script.*failed/i.test(
                    text
                  )
                ? 'SCRIPT_LOAD_FAILED'
                : /Stripe|IntegrationError|initCheckout|initializ/i.test(text)
                  ? 'SDK_INITIALIZATION_FAILED'
                  : 'SCRIPT_ERROR';
        record({
          event: 'console_error',
          endpoint: endpoint(message.location()?.url),
          frame: 'unknown',
          code
        });
      }
    });
    for (const [name, event] of [
      ['frameattached', 'frame_attached'],
      ['framenavigated', 'frame_navigated'],
      ['framedetached', 'frame_detached']
    ])
      listen(name, (frame) => {
        const id = frameId(frame);
        if (event !== 'frame_attached') {
          navigations.push({ frameId: id, elapsedMs: time() });
          if (navigations.length > MAX_EVENTS) navigations.shift();
        }
        record({
          event,
          endpoint: endpoint(frame.url(), 'document'),
          frame: frameKind(frame),
          ...(id ? { frameId: id } : {})
        });
      });
    listen('close', () => {
      record({ event: 'page_closed', endpoint: 'other', frame: 'main' });
      stop();
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  } catch {
    readFailures = Math.min(10000, readFailures + 1);
    stop();
  }
  return { snapshot, dispose: stop };
}
module.exports = {
  observe,
  sanitize,
  endpoint,
  networkCode,
  abortRoute,
  observeCancellation,
  routeTemplate
};
