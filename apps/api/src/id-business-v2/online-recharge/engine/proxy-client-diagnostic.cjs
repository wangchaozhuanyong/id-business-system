'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const ECHO_URL = 'https://api.ipify.org/?format=text';
const CLIENTS = [
  'navigation',
  'context_request',
  'same_origin_fetch',
  'context_request',
  'same_origin_fetch'
];
function failure(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`;
  return /CSP|Content Security Policy|connect-src/i.test(text)
    ? 'csp'
    : /CORS|cross.origin/i.test(text)
      ? 'cors'
      : /Timeout|TIMED_OUT|ETIMEDOUT|deadline/i.test(text)
        ? 'timeout'
        : /Abort|cancel/i.test(text)
          ? 'cancelled'
          : 'network';
}

// An explicitly invoked diagnostic, never a recharge-task fallback. It owns a
// blank context, receives only proxy configuration, and never reads task/env
// credentials, existing profiles or ChatGPT. Each comparison is an observation,
// not proof that the supplier uses the same exit for another target or time.
async function runProxyClientDiagnostic({ proxyConfig, chromium, timeoutMs = 90000, signal } = {}) {
  const budget = Math.min(90000, Math.max(1, Number(timeoutMs) || 90000));
  const cleanupBudget = Math.min(2000, Math.max(1, Math.floor(budget / 5)));
  const started = performance.now();
  const report = {
    format: 'proxy-client-comparison-v1',
    startedAt: new Date().toISOString(),
    maximumRequests: 5,
    maximumDurationMs: budget,
    browserMode: 'headless',
    echoTransport: 'https',
    requestsIssued: 0,
    blockedAuxiliaryRequests: 0,
    chatgptRequests: 0,
    observations: [],
    outcome: 'diagnostic_incomplete',
    conclusionScope: 'sampled_echo_service_window_only',
    cleanupConfirmed: false
  };
  let browser, context, page, activeClient;
  let closing = false,
    launchSettled = true,
    browserRequestIssued = false;
  let timer, aborted;
  const stopped = new Promise((_, reject) => {
    aborted = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(
      () => reject(new Error('diagnostic deadline')),
      Math.max(1, budget - cleanupBudget)
    );
  });
  // A timed-out operation is followed by owned context/browser closure in
  // finally. A race alone is never reported as confirmed cancellation.
  const run = (operation) => Promise.race([Promise.resolve().then(operation), stopped]);
  const timeout = () =>
    Math.max(1, Math.min(15000, budget - cleanupBudget - (performance.now() - started)));
  try {
    signal?.throwIfAborted();
    if (!proxyConfig?.server || proxyConfig.bypass) throw new Error('invalid proxy configuration');
    const proxy = new URL(proxyConfig.server);
    if (
      !['http:', 'https:', 'socks5:'].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password
    )
      throw new Error('invalid proxy configuration');
    launchSettled = false;
    browser = await run(async () => {
      try {
        const owned = await (
          chromium || require('./upstream/node_modules/playwright').chromium
        ).launch({
          headless: true,
          channel: 'chromium',
          proxy: proxyConfig,
          timeout: timeout()
        });
        browser = owned;
        if (closing) await owned.close();
        return owned;
      } finally {
        launchSettled = true;
      }
    });
    context = await run(() =>
      browser.newContext({ proxy: proxyConfig, serviceWorkers: 'block', acceptDownloads: false })
    );
    // All browser-side auxiliary requests/redirects are denied in this blank
    // diagnostic only. APIRequest redirects/retries are separately disabled.
    await run(() =>
      context.route('**/*', (route) => {
        const request = route.request();
        const navigation = request.isNavigationRequest();
        const permitted =
          request.url() === ECHO_URL &&
          request.method() === 'GET' &&
          ((activeClient === 'navigation' && navigation) ||
            (activeClient === 'same_origin_fetch' &&
              !navigation &&
              request.resourceType() === 'fetch'));
        if (
          !permitted ||
          browserRequestIssued ||
          report.requestsIssued >= 5 ||
          request.redirectedFrom()
        ) {
          report.blockedAuxiliaryRequests++;
          return route.abort().catch(() => {});
        }
        browserRequestIssued = true;
        report.requestsIssued++;
        return route.continue().catch(() => {});
      })
    );
    page = await run(() => context.newPage());
    let navigated = false;
    for (const client of CLIENTS) {
      signal?.throwIfAborted();
      const row = {
        client,
        at: new Date().toISOString(),
        sameOrigin: client === 'same_origin_fetch',
        complete: false
      };
      const began = performance.now();
      activeClient = client;
      browserRequestIssued = false;
      try {
        let result;
        if (client === 'navigation') {
          result = await run(async () => {
            const response = await page.goto(ECHO_URL, {
              waitUntil: 'domcontentloaded',
              timeout: timeout()
            });
            if (!response) throw new Error('navigation incomplete');
            navigated = page.url() === ECHO_URL;
            return { status: response.status(), text: await response.text() };
          });
        } else if (client === 'context_request') {
          if (report.requestsIssued >= 5) break;
          report.requestsIssued++;
          result = await run(async () => {
            const response = await context.request.get(ECHO_URL, {
              timeout: timeout(),
              maxRedirects: 0,
              maxRetries: 0,
              headers: { 'cache-control': 'no-store' }
            });
            try {
              return { status: response.status(), text: await response.text() };
            } finally {
              await response.dispose();
            }
          });
        } else {
          if (!navigated || page.url() !== ECHO_URL) {
            row.failureReason = 'same_origin_unavailable';
            continue;
          }
          result = await run(() =>
            page.evaluate(
              async ({ url, timeoutMs }) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                  const response = await fetch(url, {
                    cache: 'no-store',
                    credentials: 'omit',
                    redirect: 'error',
                    signal: controller.signal
                  });
                  return { status: response.status, text: await response.text() };
                } catch (error) {
                  if (controller.signal.aborted)
                    throw new Error('diagnostic fetch timeout', { cause: error });
                  throw error;
                } finally {
                  clearTimeout(timer);
                }
              },
              { url: ECHO_URL, timeoutMs: timeout() }
            )
          );
        }
        row.httpStatus = Number.isInteger(result.status) ? result.status : 0;
        const text = String(result.text || '').trim();
        if (result.status !== 200) row.failureReason = 'http_status';
        else if (text.length > 128 || !isIP(text)) row.failureReason = 'invalid_echo';
        else {
          row.complete = true;
          row.exitHash = createHash('sha256').update(text.toLowerCase()).digest('hex');
        }
      } catch (error) {
        row.failureReason = failure(error);
        if (signal?.aborted || performance.now() - started >= budget - cleanupBudget) break;
      } finally {
        activeClient = null;
        row.elapsedMs = Math.round(performance.now() - began);
        report.observations.push(row);
      }
    }
    if (report.observations.length === 5 && report.observations.every((row) => row.complete)) {
      report.outcome =
        new Set(report.observations.map((row) => row.exitHash)).size === 1
          ? 'observations_match'
          : 'observations_differ';
    }
  } catch (error) {
    report.failureReason = failure(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    activeClient = null;
    closing = true;
    let cleanupTimer;
    try {
      const close = Promise.allSettled([
        Promise.resolve().then(() => context?.close()),
        Promise.resolve().then(() => browser?.close())
      ]);
      await Promise.race([
        close,
        new Promise((resolve) => {
          cleanupTimer = setTimeout(resolve, cleanupBudget);
        })
      ]);
      report.cleanupConfirmed = launchSettled && (!browser || !browser.isConnected());
    } catch {
      /* A failed close is retained as incomplete cleanup. */
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (!report.cleanupConfirmed) report.outcome = 'diagnostic_incomplete';
    report.elapsedMs = Math.round(performance.now() - started);
    report.endedAt = new Date().toISOString();
  }
  return report;
}

module.exports = { runProxyClientDiagnostic };
