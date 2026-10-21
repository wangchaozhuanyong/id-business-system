'use strict';
// Observe this task page only. Never intercept requests or read bodies, headers,
// field values, raw console output, stack traces, or complete URLs into evidence.
const { performance } = require('node:perf_hooks');
const EVENTS = new Set([
  'request',
  'response',
  'request_failed',
  'script_error',
  'console_error',
  'csp',
  'frame_attached',
  'frame_navigated',
  'frame_detached',
  'page_closed'
]);
const ENDPOINTS = new Set([
  'stripe_script',
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
const count = (n) => Number.isInteger(n) && n >= 0 && n <= 10000;
const elapsed = (n) => Number.isInteger(n) && n >= 0 && n <= 3600000;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
function endpoint(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'other';
    const host = url.hostname;
    if (host === 'js.stripe.com') return 'stripe_script';
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
          'directive'
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
    (row.directive !== undefined && !DIRECTIVES.has(row.directive))
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
          'eventCount',
          'readFailures',
          'truncated'
        ].includes(k)
    ) ||
    value.version !== 1 ||
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
    events.some((v) => !v) ||
    (value.firstFailure !== null && !firstFailure) ||
    (firstFailure && (!isFailure(firstFailure) || !value.eventCount)) ||
    value.eventCount < events.length
  )
    return undefined;
  return {
    version: 1,
    elapsedMs: value.elapsedMs,
    eventCount: value.eventCount,
    readFailures: value.readFailures,
    truncated: value.truncated,
    events,
    firstFailure
  };
}
function observe(page, { signal } = {}) {
  const started = performance.now(),
    events = [],
    listeners = [];
  let stopped = false,
    eventCount = 0,
    readFailures = 0,
    truncated = false,
    firstFailure = null;
  const time = () => Math.min(3600000, Math.max(0, Math.floor(performance.now() - started)));
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
    if (events.length < MAX_EVENTS) events.push(row);
    else truncated = true;
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
    const category = endpoint(request.url());
    const method = request.method();
    let frame = 'unknown';
    try {
      frame = frameKind(request.frame());
    } catch {
      // A navigation request may arrive before its frame exists. Keep its
      // failure/status evidence even when that optional association is absent.
      readFailures = Math.min(10000, readFailures + 1);
    }
    return {
      endpoint: category,
      frame,
      method: METHODS.has(method) ? method : 'OTHER'
    };
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const [name, listener] of listeners) {
      try {
        page.off(name, listener);
      } catch {
        readFailures = Math.min(10000, readFailures + 1);
      }
    }
    signal?.removeEventListener('abort', stop);
  };
  const snapshot = () =>
    sanitize({
      version: 1,
      elapsedMs: time(),
      eventCount,
      readFailures,
      truncated,
      events: events.map((row) => ({ ...row })),
      firstFailure: firstFailure ? { ...firstFailure } : null
    });
  try {
    listen('request', (request) => record({ event: 'request', ...requestData(request) }));
    listen('response', (response) =>
      record({ event: 'response', ...requestData(response.request()), status: response.status() })
    );
    listen('requestfailed', (request) =>
      record({
        event: 'request_failed',
        ...requestData(request),
        code: networkCode(request.failure()?.errorText)
      })
    );
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
      listen(name, (frame) =>
        record({ event, endpoint: endpoint(frame.url()), frame: frameKind(frame) })
      );
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
module.exports = { observe, sanitize, endpoint, networkCode };
