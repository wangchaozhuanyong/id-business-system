'use strict';
const { performance } = require('node:perf_hooks');

const blockedReasons = new Set([
  'other',
  'csp',
  'mixed-content',
  'origin',
  'inspector',
  'integrity',
  'subresource-filter',
  'content-type',
  'coep-frame-resource-needs-coep-header',
  'coop-sandboxed-iframe-cannot-navigate-to-coop-page',
  'corp-not-same-origin',
  'corp-not-same-site'
]);
function networkCode(text) {
  const code = String(text || '').match(/\bnet::ERR_[A-Z_]+\b/)?.[0];
  return code || 'UNKNOWN';
}
function proxyFacts() {
  let protocol = 'direct';
  try {
    protocol = new URL(process.env.PROXY).protocol.replace(':', '');
  } catch {
    /* No proxy details retained. */
  }
  return {
    protocol: ['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h', 'direct'].includes(protocol)
      ? protocol
      : 'unknown',
    providerStatisticsAvailable: false,
    reason: 'not_exposed_by_existing_transport'
  };
}

// Passive CDP evidence only. No interception, response bodies, header maps,
// request identifiers, IPs or URLs leave this task-local recorder.
async function observeSubscriptionNetwork(page, targetUrl, options = {}) {
  const started = performance.now();
  const events = [],
    requests = new Map();
  let session,
    active = true,
    available = false,
    truncated = false,
    cancellationAtMs;
  const listeners = [];
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const add = (value) => {
    if (!active) return;
    if (events.length >= 24) {
      truncated = true;
      return;
    }
    events.push({ atMs: elapsed(), ...value });
  };
  const snapshot = () => ({
    available,
    truncated,
    events: structuredClone(events),
    proxy: proxyFacts(),
    ...(cancellationAtMs !== undefined ? { cancellationAtMs } : {}),
    // A browser event is not acknowledgement from the origin server.
    originReceiptProven: false
  });
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const [name, listener] of listeners) session?.off(name, listener);
    try {
      session?.detach().catch(() => {});
    } catch {
      /* Browser already closed. */
    }
  };
  const observer = {
    snapshot,
    cancel() {
      cancellationAtMs = elapsed();
    },
    dispose
  };
  // Optional evidence must not consume the business attempt while attaching.
  // This cap only abandons the recorder; the original query deadline is intact.
  const setupController = new AbortController();
  const forwardAbort = () => setupController.abort();
  const setupTimer = setTimeout(forwardAbort, 250);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  // Abort only diagnostic setup, never the business request. A late CDP
  // attachment is detached and cannot start a delayed subscription read.
  const setup = async (pending) => {
    let abort;
    try {
      return await Promise.race([
        pending,
        new Promise((resolve) => {
          abort = () => {
            dispose();
            resolve(undefined);
          };
          if (setupController.signal.aborted) abort();
          else setupController.signal.addEventListener('abort', abort, { once: true });
        })
      ]);
    } finally {
      setupController.signal.removeEventListener('abort', abort);
    }
  };
  try {
    if (options.signal?.aborted || typeof page.context?.().newCDPSession !== 'function')
      return observer;
    session = await setup(
      page
        .context()
        .newCDPSession(page)
        .then((value) => {
          if (!active) {
            value.detach().catch(() => {});
            return undefined;
          }
          return value;
        })
    );
    if (!session || !active) return observer;
    const on = (name, listener) => {
      session.on(name, listener);
      listeners.push([name, listener]);
    };
    on('Network.requestWillBeSent', (event) => {
      if (event.request?.url !== targetUrl || event.request?.method !== 'GET') return;
      if (!requests.has(event.requestId) && requests.size >= 4) {
        truncated = true;
        return;
      }
      const ordinal = requests.get(event.requestId) || requests.size + 1;
      requests.set(event.requestId, ordinal);
      add({ event: 'browser_request', request: ordinal });
    });
    on('Network.responseReceived', (event) => {
      const request = requests.get(event.requestId);
      if (!request) return;
      const response = event.response || {},
        timing = {};
      for (const key of [
        'proxyStart',
        'proxyEnd',
        'dnsStart',
        'dnsEnd',
        'connectStart',
        'connectEnd',
        'sslStart',
        'sslEnd',
        'sendStart',
        'sendEnd',
        'receiveHeadersStart',
        'receiveHeadersEnd'
      ]) {
        const value = response.timing?.[key];
        if (Number.isFinite(value) && value >= -1 && value <= 180000)
          timing[key] = Math.round(value);
      }
      add({
        event: 'response_headers',
        request,
        ...(Number.isInteger(response.status) ? { httpStatus: response.status } : {}),
        remoteEndpointPresent: Boolean(response.remoteIPAddress),
        timing
      });
    });
    on('Network.loadingFailed', (event) => {
      const request = requests.get(event.requestId);
      if (!request) return;
      add({
        event: 'loading_failed',
        request,
        error: networkCode(event.errorText),
        canceled: event.canceled === true,
        blockedReason: blockedReasons.has(event.blockedReason)
          ? event.blockedReason
          : event.blockedReason
            ? 'other'
            : 'absent',
        corsErrorPresent: Boolean(event.corsErrorStatus)
      });
    });
    on('Network.loadingFinished', (event) => {
      const request = requests.get(event.requestId);
      if (request) add({ event: 'loading_finished', request });
    });
    await setup(session.send('Network.enable'));
    available = active;
  } catch {
    /* Evidence unavailable is not a business failure or proof of blocking. */
  } finally {
    clearTimeout(setupTimer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
  return observer;
}
module.exports = { observeSubscriptionNetwork, networkCode };
