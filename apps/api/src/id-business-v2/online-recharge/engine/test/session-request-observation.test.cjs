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
  assert.equal(events.length, 1);
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
