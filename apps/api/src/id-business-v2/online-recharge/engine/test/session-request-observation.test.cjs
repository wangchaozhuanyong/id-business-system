'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeSessionRequests } = require('../subscription-diagnostics.cjs');
const secret = 'synthetic-sensitive-value-not-for-output';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function request({ type = 'document', previous = null, headers, reject = false, url } = {}) {
  return {
    url: () => url || 'https://chatgpt.com/api/auth/session?synthetic=' + secret,
    resourceType: () => type,
    method: () => 'GET',
    redirectedFrom: () => previous,
    allHeaders: () =>
      reject
        ? Promise.reject(new Error(secret))
        : Promise.resolve(
            headers || {
              Cookie: `__Secure-next-auth.session-token.0=${secret}; cf_clearance=${secret}`,
              Authorization: secret,
              'Sec-Fetch-Mode': type === 'document' ? 'navigate' : 'cors',
              'Sec-Fetch-Dest': type === 'document' ? 'document' : 'empty'
            }
          ),
    failure: () => ({ errorText: 'net::ERR_ABORTED ' + secret })
  };
}
function response(req, status = 200) {
  return {
    request: () => req,
    status: () => status,
    headers: () => ({
      'content-type': status === 403 ? 'text/html' : 'application/json',
      'set-cookie': secret,
      ...(status === 403 ? { 'cf-mitigated': 'challenge' } : {})
    })
  };
}
test('listener captures immediate first navigation, homepage fetch and redirects by request identity without credentials', async () => {
  const context = new EventEmitter(),
    events = [];
  const observer = observeSessionRequests(context, (e) => events.push(e));
  const initial = request();
  context.emit('request', initial);
  context.emit('response', response(initial));
  const next = request({ type: 'fetch' });
  context.emit('request', next);
  context.emit('response', response(next, 302));
  const redirected = request({ type: 'fetch', previous: next });
  context.emit('request', redirected);
  context.emit('response', response(redirected, 403));
  await flush();
  assert.equal(events.filter((e) => e.event === 'request').length, 3);
  assert.equal(
    events.find((e) => e.event === 'request' && e.sequence === 1).resourceType,
    'document'
  );
  assert.equal(events.find((e) => e.event === 'request' && e.sequence === 2).resourceType, 'fetch');
  assert.equal(
    events.find((e) => e.event === 'request' && e.sequence === 3).redirectedFromSequence,
    2
  );
  assert.equal(events.find((e) => e.event === 'response' && e.sequence === 2).httpStatus, 302);
  assert.equal(
    events.find((e) => e.event === 'response' && e.sequence === 3).cfMitigated,
    'challenge'
  );
  const headers = events.filter((e) => e.event === 'request_headers');
  assert.equal(headers.length, 3);
  assert.ok(headers.every((e) => e.complete && e.sessionCookieSent && e.clearanceCookieSent));
  assert.ok(!JSON.stringify(events).includes(secret));
  observer.dispose();
});
test('header read failure is explicit and cannot be mistaken for Cookie absence', async () => {
  const context = new EventEmitter(),
    events = [];
  observeSessionRequests(context, (e) => events.push(e));
  const req = request({ reject: true });
  context.emit('request', req);
  context.emit('response', response(req, 403));
  await flush();
  const failed = events.find((e) => e.event === 'request_headers');
  assert.equal(failed.complete, false);
  assert.equal(failed.readFailed, true);
  assert.equal(failed.sessionCookieSent, undefined);
  assert.equal(failed.clearanceCookieSent, undefined);
  assert.ok(!JSON.stringify(events).includes(secret));
  context.emit('close');
});
test('close detaches the listeners and suppresses late header observations', async () => {
  const context = new EventEmitter(),
    events = [];
  let release;
  const observer = observeSessionRequests(context, (e) => events.push(e));
  const req = request();
  req.allHeaders = () =>
    new Promise((r) => {
      release = r;
    });
  context.emit('request', req);
  await Promise.resolve();
  context.emit('close');
  release({ Cookie: secret });
  await flush();
  observer.dispose();
  assert.deepEqual(
    events.map((e) => e.event),
    ['connection_observer', 'request']
  );
  assert.equal(events[0].setupOperation, 'context_support');
  assert.equal(events[0].setupFailure, 'unsupported');
  for (const name of ['request', 'response', 'requestfailed', 'close'])
    assert.equal(context.listenerCount(name), 0);
});
test('close before the observation microtask prevents a late header read', async () => {
  const context = new EventEmitter();
  let reads = 0;
  observeSessionRequests(context, () => {});
  const req = request();
  req.allHeaders = async () => {
    reads++;
    return {};
  };
  context.emit('request', req);
  context.emit('close');
  await flush();
  assert.equal(reads, 0);
});

test('logging and browser observation errors cannot throw into business request or cleanup', async () => {
  const context = new EventEmitter();
  observeSessionRequests(context, () => {
    throw new Error(secret);
  });
  const req = request();
  assert.doesNotThrow(() => context.emit('request', req));
  assert.doesNotThrow(() =>
    context.emit('response', {
      request: () => {
        throw new Error(secret);
      }
    })
  );
  assert.doesNotThrow(() => context.emit('requestfailed', req));
  await flush();
  assert.doesNotThrow(() => context.emit('close'));
});
test('only bounded official Session observations are retained; no browser commands or HTTP calls are issued', async () => {
  const context = new EventEmitter(),
    events = [];
  context.newCDPSession =
    context.newPage =
    context.addCookies =
      () => {
        throw new Error('UNEXPECTED_BROWSER_MUTATION');
      };
  observeSessionRequests(context, (e) => events.push(e));
  context.emit(
    'request',
    request({ url: 'https://example.invalid/api/auth/session?secret=' + secret })
  );
  for (let i = 0; i < 35; i++) context.emit('request', request());
  await flush();
  assert.equal(events.filter((e) => e.event === 'request').length, 30);
  assert.equal(events.filter((e) => e.event === 'request_headers').length, 30);
  assert.ok(!JSON.stringify(events).includes(secret));
  context.emit('close');
});

function homepageFixture() {
  const context = new EventEmitter(),
    page = new EventEmitter(),
    events = [];
  const frame = { page: () => page };
  page.mainFrame = () => frame;
  // A failed CDP setup must not disable context/page navigation evidence.
  context.newCDPSession = () => {
    throw new Error(secret);
  };
  context.newPage = context.addCookies = () => {
    throw new Error('UNEXPECTED_MUTATION');
  };
  const observer = observeSessionRequests(context, (value) => events.push(value));
  const req = (options = {}) => ({
    ...request({
      url: options.url || 'https://chatgpt.com/?synthetic=' + secret,
      previous: options.previous
    }),
    isNavigationRequest: () => true,
    frame: () => options.frame || frame,
    failure: () => ({ errorText: options.error || 'net::ERR_TIMED_OUT ' + secret })
  });
  return { context, page, frame, events, observer, req };
}
const homepageEvents = (f) => f.events.filter((e) => e.event.startsWith('homepage_'));

test('homepage without response remains an observation gap and survives CDP failure', () => {
  const f = homepageFixture();
  const req = f.req();
  f.context.emit('request', req);
  f.context.emit('close');
  const events = homepageEvents(f);
  assert.equal(events[0].event, 'homepage_request');
  assert.equal(events[1].event, 'homepage_navigation_snapshot');
  assert.equal(events[1].reason, 'context_closed');
  assert.equal(events[1].responseHeadersObserved, false);
  assert.equal(events[1].domContentLoadedObserved, false);
  assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('homepage response and download completion do not imply DOMContentLoaded or login success', () => {
  const f = homepageFixture(),
    req = f.req();
  f.context.emit('request', req);
  f.context.emit('response', response(req, 403));
  f.context.emit('requestfinished', req);
  f.observer.dispose();
  const events = homepageEvents(f);
  assert.equal(events.find((e) => e.event === 'homepage_response').httpStatus, 403);
  assert.equal(events.find((e) => e.event === 'homepage_response').cfMitigated, 'challenge');
  const snapshot = events.at(-1);
  assert.equal(snapshot.responseHeadersObserved, true);
  assert.equal(snapshot.requestFinishedObserved, true);
  assert.equal(snapshot.domContentLoadedObserved, false);
  assert.equal(snapshot.requestFailedObserved, false);
  assert.ok(!JSON.stringify(events).includes(secret));
});

test('homepage lifecycle correlates redirect hops and ignores later unrelated navigation', () => {
  const f = homepageFixture(),
    first = f.req();
  const redirected = f.req({
    url: 'https://chatgpt.com/auth/login?secret=' + secret,
    previous: first
  });
  f.context.emit('request', first);
  f.context.emit('response', response(first, 302));
  f.context.emit('requestfinished', first);
  f.context.emit('request', redirected);
  f.context.emit('response', response(redirected, 200));
  f.page.emit('domcontentloaded');
  f.page.emit('domcontentloaded');
  const unrelated = f.req({ url: 'https://unrelated.invalid/?secret=' + secret });
  f.context.emit('request', unrelated);
  f.page.emit('domcontentloaded');
  f.page.emit('close');
  const events = homepageEvents(f),
    loaded = events.filter((e) => e.event === 'homepage_domcontentloaded');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].navigationSequence, 2);
  assert.equal(loaded[0].redirectedFromNavigationSequence, 1);
  assert.equal(loaded[0].destination, 'official_other');
  assert.equal(events.filter((e) => e.event === 'homepage_request').length, 2);
  assert.equal(
    events.find((e) => e.event === 'homepage_navigation_snapshot' && e.navigationSequence === 1)
      .domContentLoadedObserved,
    false
  );
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.equal(f.page.listenerCount('domcontentloaded'), 0);
  f.observer.dispose();
});

test('iframe, homepage fetch, lookalike origins and unrelated documents cannot become homepage navigation', () => {
  const f = homepageFixture();
  const iframe = { page: () => f.page };
  const candidates = [
    f.req({ frame: iframe }),
    f.req({ url: 'https://chatgpt.com.evil.invalid/' }),
    f.req({ url: 'https://chatgpt.com/settings' }),
    f.req({ url: 'http://chatgpt.com/' }),
    f.req({ url: 'https://user:password@chatgpt.com/' })
  ];
  const fetch = f.req();
  fetch.resourceType = () => 'fetch';
  const nonNavigation = f.req();
  nonNavigation.isNavigationRequest = () => false;
  candidates.push(fetch, nonNavigation);
  for (const req of candidates) f.context.emit('request', req);
  f.page.emit('domcontentloaded');
  f.context.emit('close');
  assert.deepEqual(homepageEvents(f), []);
});

test('homepage failure keeps only allowlisted browser codes and never infers timeout from arbitrary text', () => {
  for (const [error, code] of [
    ['net::ERR_TUNNEL_CONNECTION_FAILED ' + secret, 'ERR_TUNNEL_CONNECTION_FAILED'],
    ['net::ERR_TIMED_OUT ' + secret, 'ERR_TIMED_OUT'],
    ['net::ERR_ABORTED ' + secret, 'ERR_ABORTED'],
    ['net::ERR_UNLISTED ' + secret, 'UNKNOWN'],
    ['timeout ' + secret, 'UNKNOWN']
  ]) {
    const f = homepageFixture(),
      req = f.req({ error });
    f.context.emit('request', req);
    f.context.emit('requestfailed', req);
    f.context.emit('requestfailed', req);
    f.observer.dispose();
    const failed = homepageEvents(f).filter((e) => e.event === 'homepage_request_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].networkCode, code);
    assert.equal(homepageEvents(f).at(-1).requestFailedObserved, true);
    assert.ok(!JSON.stringify(f.events).includes(secret));
  }
});

test('homepage metadata read failure retains observed headers without inventing status or challenge absence', () => {
  const f = homepageFixture(),
    req = f.req();
  f.context.emit('request', req);
  f.context.emit('response', {
    request: () => req,
    status: () => 200,
    headers: () => {
      throw new Error(secret);
    }
  });
  f.observer.dispose();
  const failed = homepageEvents(f).find((e) => e.event === 'homepage_response');
  assert.equal(failed.complete, false);
  assert.equal(failed.readFailed, true);
  assert.equal(failed.httpStatus, undefined);
  assert.equal(failed.cfMitigated, undefined);
  assert.equal(homepageEvents(f).at(-1).responseHeadersObserved, true);
});

test('homepage diagnostics survive the existing child and parent log sanitizers', () => {
  const { sanitize, redactText } = require('../security.cjs');
  const f = homepageFixture(),
    req = f.req();
  f.context.emit('request', req);
  f.context.emit('response', response(req, 403));
  f.context.emit('requestfailed', req);
  f.context.emit('close');
  const logs = homepageEvents(f).map((event) =>
    sanitize({
      level: 'log',
      text: redactText('[Session] 请求对照 ' + JSON.stringify(event)),
      timestamp: '2026-11-02T05:13:00.626Z'
    })
  );
  const persisted = sanitize({ logs });
  assert.deepEqual(
    persisted.logs.map((log) => JSON.parse(log.text.slice(log.text.indexOf('{')))),
    homepageEvents(f)
  );
  assert.ok(!JSON.stringify(persisted).includes(secret));
});

test('homepage teardown is bounded, idempotent and suppresses late response and lifecycle events', () => {
  const f = homepageFixture(),
    req = f.req();
  f.context.emit('request', req);
  f.context.emit('request', req);
  for (let i = 0; i < 40; i++) f.context.emit('request', f.req());
  assert.equal(homepageEvents(f).filter((e) => e.event === 'homepage_request').length, 30);
  f.observer.dispose();
  f.observer.dispose();
  const length = f.events.length;
  f.context.emit('response', response(req));
  f.context.emit('requestfinished', req);
  f.page.emit('domcontentloaded');
  f.page.emit('close');
  assert.equal(f.events.length, length);
  for (const name of ['request', 'response', 'requestfailed', 'requestfinished', 'close'])
    assert.equal(f.context.listenerCount(name), 0);
  assert.equal(f.page.listenerCount('domcontentloaded'), 0);
  assert.equal(f.page.listenerCount('close'), 0);
  assert.equal(
    homepageEvents(f).filter((e) => e.event === 'homepage_navigation_snapshot').length,
    30
  );
});

test('homepage observation logging and lifecycle setup failures do not escape into navigation', () => {
  const f = homepageFixture();
  f.page.on = () => {
    throw new Error(secret);
  };
  const req = f.req();
  assert.doesNotThrow(() => f.context.emit('request', req));
  assert.ok(homepageEvents(f).some((e) => e.event === 'homepage_lifecycle_unavailable'));
  assert.doesNotThrow(() => f.context.emit('response', response(req)));
  assert.doesNotThrow(() => f.context.emit('close'));
  const g = homepageFixture();
  g.observer.dispose();
  const observer = observeSessionRequests(g.context, () => {
    throw new Error(secret);
  });
  assert.doesNotThrow(() => g.context.emit('request', g.req()));
  assert.doesNotThrow(() => g.context.emit('close'));
  observer.dispose();
});

test(
  'isolated Chromium distinguishes a downloaded homepage from a deferred DOMContentLoaded',
  { timeout: 30000 },
  async () => {
    const { chromium } = require('../upstream/node_modules/playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--host-resolver-rules=MAP * ~NOTFOUND']
    });
    let releaseScript;
    const gate = new Promise((resolve) => {
      releaseScript = resolve;
    });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const events = [];
      let sawScript, sawFinished;
      const scriptRequested = new Promise((resolve) => {
        sawScript = resolve;
      });
      const mainFinished = new Promise((resolve) => {
        sawFinished = resolve;
      });
      // This fixture supplies every response; no login, Session or external network is used.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://chatgpt.com' && url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><script defer src="/synthetic-delay.js"></script><p>Synthetic fixture</p>'
          });
        if (url.origin === 'https://chatgpt.com' && url.pathname === '/synthetic-delay.js') {
          sawScript();
          await gate;
          return route.fulfill({ contentType: 'application/javascript', body: 'void 0;' });
        }
        return route.abort();
      });
      context.newCDPSession = async () => {
        throw new Error(secret);
      };
      const observer = observeSessionRequests(context, (row) => {
        events.push(row);
        if (row.event === 'homepage_request_finished') sawFinished();
      });
      const page = await context.newPage();
      const navigation = page.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      // Install rejection handling immediately so cleanup cannot leave an unhandled navigation.
      const settledNavigation = navigation.then(
        () => null,
        (error) => error
      );
      try {
        await Promise.race([
          Promise.all([scriptRequested, mainFinished]),
          settledNavigation.then((error) => {
            throw error || new Error('Expected navigation events were not observed');
          })
        ]);
        assert.ok(events.some((e) => e.event === 'homepage_response' && e.httpStatus === 200));
        assert.equal(
          events.some((e) => e.event === 'homepage_domcontentloaded'),
          false
        );
        releaseScript();
        assert.equal(await settledNavigation, null);
        assert.equal(events.filter((e) => e.event === 'homepage_domcontentloaded').length, 1);
        await page.close();
        const snapshot = events.find((e) => e.event === 'homepage_navigation_snapshot');
        assert.equal(snapshot.responseHeadersObserved, true);
        assert.equal(snapshot.requestFinishedObserved, true);
        assert.equal(snapshot.domContentLoadedObserved, true);
        assert.ok(!JSON.stringify(events).includes(secret));
      } finally {
        releaseScript();
        observer.dispose();
        await context.close();
        await settledNavigation;
      }
    } finally {
      releaseScript();
      await browser.close();
    }
  }
);
