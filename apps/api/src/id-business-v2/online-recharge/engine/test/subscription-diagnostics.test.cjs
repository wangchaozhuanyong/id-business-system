'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { responseFacts, observeAuthResponses } = require('../subscription-diagnostics.cjs');
const session = {
  account: { id: 'synthetic-account' },
  user: { id: 'synthetic-user' },
  accessToken: 'synthetic-token'
};

test('challenge header and specific HTML markers are distinct from generic Cloudflare wording', () => {
  assert.equal(
    responseFacts(403, { 'cf-mitigated': 'challenge' }, '').classification,
    'CF_CHALLENGE'
  );
  assert.equal(
    responseFacts(
      403,
      { 'content-type': 'text/html' },
      '<script src="/cdn-cgi/challenge-platform/example"></script>'
    ).classification,
    'CF_CHALLENGE'
  );
  assert.equal(
    responseFacts(403, { 'content-type': 'text/html' }, '<script>window._cf_chl_opt={}</script>')
      .classification,
    'CF_CHALLENGE'
  );
  for (const body of [
    'Cloudflare cf-ray attention required Just a moment',
    '{"error":{"message":"challenge-platform Cloudflare"}}'
  ])
    assert.equal(
      responseFacts(403, { 'content-type': 'text/html' }, body).classification,
      'UNKNOWN_403'
    );
  assert.equal(responseFacts(403, { 'cf-mitigated': 'guardrails' }, '').cfMitigated, 'unknown');
  assert.equal(
    responseFacts(403, { 'cf-ray': 'synthetic-private-ray' }, '').classification,
    'UNKNOWN_403'
  );
});

test('only allowlisted JSON codes classify policy and authentication rejection', () => {
  assert.equal(
    responseFacts(403, {}, { error: { code: 'unsupported_country' } }).classification,
    'POLICY_OR_REGION_BLOCK'
  );
  assert.equal(
    responseFacts(403, {}, { error: { code: 'invalid_session' } }).classification,
    'AUTH_SESSION_REJECTED'
  );
  assert.equal(
    responseFacts(403, {}, { error: { code: 'permission_denied' } }).classification,
    'UNKNOWN_403'
  );
  const facts = responseFacts(
    403,
    { 'content-type': 'application/json; private=synthetic-secret', 'cf-ray': 'synthetic-secret' },
    { error: { code: 'synthetic-secret', type: 'synthetic-secret', message: 'synthetic-secret' } }
  );
  assert.equal(facts.errorCode, 'UNKNOWN');
  assert.equal(facts.errorType, 'UNKNOWN');
  assert.ok(!JSON.stringify(facts).includes('synthetic-secret'));
});

test('passive Session and CSRF receipts retain only identity booleans and cannot create requests', async () => {
  const page = new EventEmitter();
  const observer = observeAuthResponses(page, JSON.stringify(session));
  assert.deepEqual(observer.snapshot(), {
    session: { observed: false },
    csrf: { observed: false }
  });
  const emit = async (endpoint, body, status = 200) => {
    const response = {
      url: () => `https://chatgpt.com/api/auth/${endpoint}?private=synthetic-secret`,
      status: () => status,
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body)
    };
    await Promise.all(page.listeners('response').map((listener) => listener(response)));
  };
  await emit('session', { ...session, sessionToken: 'synthetic-secret' });
  await emit('csrf', { csrfToken: 'synthetic-secret' });
  assert.equal(observer.snapshot().session.hasValidUser, true);
  assert.equal(observer.snapshot().session.matchesTargetAccount, true);
  assert.equal(observer.snapshot().csrf.hasCsrfToken, true);
  assert.ok(!JSON.stringify(observer.snapshot()).includes('synthetic-secret'));
  await emit('session', { ...session, user: { id: 'other-user' } });
  assert.equal(observer.snapshot().session.matchesTargetAccount, false);
  await emit('session', {}, 403);
  assert.equal(observer.snapshot().session.hasValidUser, false);
  observer.dispose();
  assert.equal(page.listenerCount('response'), 0);
});

test('a late passive response cannot change a disposed receipt', async () => {
  const page = new EventEmitter();
  const observer = observeAuthResponses(page, JSON.stringify(session));
  let finish;
  const pending = page.listeners('response')[0]({
    url: () => 'https://chatgpt.com/api/auth/session',
    status: () => 200,
    headers: () => ({}),
    text: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  });
  observer.dispose();
  finish(JSON.stringify(session));
  await pending;
  assert.equal(observer.snapshot().session.complete, false);
});
