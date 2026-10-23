'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeSubscriptionNetwork } = require('../subscription-network-diagnostics.cjs');
const { sessionProbeFacts, safeSessionProbe } = require('../subscription-diagnostics.cjs');

test('Session states distinguish explicit invalidity, unknown 403, challenge and identity mismatch', () => {
  for (const [status, headers, body, expected] of [
    [401, {}, '{}', 'invalid'],
    [403, {}, '{"error":{"message":"synthetic-private-text"}}', 'blocked'],
    [403, { 'cf-mitigated': 'challenge' }, '', 'challenge'],
    [200, {}, '{}', 'invalid'],
    [200, {}, '{"user":{"id":"other"},"account":{"id":"account"}}', 'mismatch']
  ]) {
    const facts = sessionProbeFacts(status, headers, body, {
      accountId: 'account',
      userId: 'user'
    });
    assert.equal(facts.state, expected);
    assert.ok(!JSON.stringify(facts).includes('synthetic-private-text'));
  }
});

test('Session evidence contains identity booleans and allowlisted markers only', () => {
  const facts = sessionProbeFacts(
    200,
    { 'cf-ray': 'private-ray', 'content-type': 'application/json' },
    JSON.stringify({
      user: { id: 'user' },
      account: { id: 'account' },
      sessionToken: 'private-token'
    }),
    { accountId: 'account', userId: 'user' }
  );
  const safe = safeSessionProbe({
    ...facts,
    text: 'private-text',
    user: 'private-user',
    state: facts.state
  });
  assert.equal(safe.hasValidUser, true);
  assert.equal(safe.matchesTargetAccount, true);
  assert.equal(safe.cfRayPresent, true);
  assert.ok(!JSON.stringify(safe).includes('private-'));
});

test('conflicting response user and token identity cannot produce a matching Session receipt', () => {
  const claims = {
    'https://api.openai.com/auth': { chatgpt_account_id: 'account', chatgpt_user_id: 'other-user' }
  };
  const accessToken = `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
  const facts = sessionProbeFacts(
    200,
    {},
    JSON.stringify({ accessToken, user: { id: 'user' }, account: { id: 'account' } }),
    { accountId: 'account', userId: 'user' }
  );
  assert.equal(facts.state, 'mismatch');
  assert.equal(facts.matchesTargetAccount, false);
  assert.ok(!JSON.stringify(facts).includes(accessToken));
});

async function recorder() {
  const session = new EventEmitter();
  let detached = 0;
  session.send = async (method) => assert.equal(method, 'Network.enable');
  session.detach = async () => {
    detached++;
  };
  const url = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?private=value';
  const observer = await observeSubscriptionNetwork(
    { context: () => ({ newCDPSession: async () => session }) },
    url
  );
  const request = () =>
    session.emit('Network.requestWillBeSent', {
      requestId: 'private-request-id',
      request: { url, method: 'GET', headers: { Authorization: 'private-token' } }
    });
  return { session, observer, request, detached: () => detached };
}
test('passive network recorder never treats a browser request as an origin receipt', async () => {
  const f = await recorder();
  f.request();
  f.session.emit('Network.responseReceived', {
    requestId: 'private-request-id',
    response: {
      status: 403,
      remoteIPAddress: 'private-address',
      headers: { Cookie: 'private-cookie' },
      timing: { dnsStart: -1, sslEnd: 12.3, receiveHeadersEnd: 15.1 }
    }
  });
  f.observer.cancel();
  f.session.emit('Network.loadingFailed', {
    requestId: 'private-request-id',
    canceled: true,
    errorText: 'net::ERR_ABORTED private-text',
    blockedReason: 'csp'
  });
  const result = f.observer.snapshot();
  assert.equal(result.available, true);
  assert.equal(result.originReceiptProven, false);
  assert.equal(result.events[1].remoteEndpointPresent, true);
  assert.equal(result.events[2].error, 'net::ERR_ABORTED');
  assert.equal(result.events[2].blockedReason, 'csp');
  assert.equal(result.proxy.providerStatisticsAvailable, false);
  assert.ok(!JSON.stringify(result).includes('private-'));
  f.observer.dispose();
  f.request();
  assert.deepEqual(f.observer.snapshot(), result);
  assert.equal(f.detached(), 1);
});

test('network recorder has a fixed event bound and unavailable evidence never rejects business work', async () => {
  const f = await recorder();
  for (let i = 0; i < 50; i++) f.request();
  assert.equal(f.observer.snapshot().events.length, 24);
  assert.equal(f.observer.snapshot().truncated, true);
  f.observer.dispose();
  const unavailable = await observeSubscriptionNetwork(
    {
      context: () => ({
        newCDPSession: async () => {
          throw Error('private');
        }
      })
    },
    'private'
  );
  assert.equal(unavailable.snapshot().available, false);
  unavailable.dispose();
});

test('cancelling a pending CDP attachment freezes evidence and detaches a late session', async () => {
  const controller = new AbortController();
  let release,
    detached = 0,
    enabled = 0;
  const pending = observeSubscriptionNetwork(
    {
      context: () => ({
        newCDPSession: () =>
          new Promise((resolve) => {
            release = resolve;
          })
      })
    },
    'https://chatgpt.com/synthetic',
    { signal: controller.signal }
  );
  controller.abort();
  const observer = await pending;
  assert.equal(observer.snapshot().available, false);
  release({
    detach: async () => {
      detached++;
    },
    send: async () => {
      enabled++;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached, 1);
  assert.equal(enabled, 0);
  observer.dispose();
});
