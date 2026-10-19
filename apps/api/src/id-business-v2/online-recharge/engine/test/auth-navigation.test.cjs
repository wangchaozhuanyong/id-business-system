'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../upstream/auth-page-detect');

test('quoted authentication destinations do not cancel ordinary pages or challenge resources', () => {
  for (const url of [
    'https://chatgpt.com/?return=/auth/login',
    'https://chatgpt.com/#/auth/signin',
    'https://chatgpt.com/?provider=accounts.google.com',
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/check.js?hint=accounts.google.com',
    'https://challenges.cloudflare.com/fixture?return=/auth/login',
    'https://third-party.invalid/?host=auth.openai.com',
    'https://accounts.google.com.third-party.invalid/fixture',
    'https://third-party.invalid/auth/login',
    'https://chatgpt.com/auth/login-help',
    'https://auth.openai.com.third-party.invalid/fixture'
  ]) {
    assert.equal(auth.isLoginRedirectUrl(url), false, url);
    assert.equal(auth.isHardLoginRedirectUrl(url), false, url);
    for (const kind of ['document', 'script', 'xhr', 'fetch']) {
      assert.equal(auth.shouldBlockLoginNavigation(url, kind), false, `${kind}: ${url}`);
    }
  }
});

test('real authentication destinations retain the existing login checks', () => {
  for (const url of [
    'https://chatgpt.com/auth/login',
    'https://chatgpt.com/api/auth/signin?callbackUrl=/checkout/synthetic',
    'https://chatgpt.com/api/auth/error',
    'https://chat.openai.com/auth/error?return=/checkout/fake',
    'https://auth.openai.com/auth/signin/nested',
    'https://accounts.google.com/fixture',
    'https://login.microsoftonline.com/fixture',
    'https://ACCOUNTS.GOOGLE.COM./fixture'
  ]) {
    assert.equal(auth.isLoginRedirectUrl(url), true, url);
    assert.equal(auth.isHardLoginRedirectUrl(url), true, url);
    assert.equal(auth.shouldBlockLoginNavigation(url, 'document'), true, url);
  }
  assert.equal(auth.isLoginRedirectUrl('https://auth.openai.com/u/login'), true);
  assert.equal(auth.isHardLoginRedirectUrl('https://auth.openai.com/u/login'), false);
  assert.equal(auth.shouldBlockLoginNavigation('https://chatgpt.com/auth/login', 'xhr'), false);
  assert.equal(
    auth.shouldBlockLoginNavigation('https://chatgpt.com/api/auth/signin', 'xhr'),
    false
  );
  assert.equal(
    auth.shouldBlockLoginNavigation('https://chatgpt.com/api/auth/error', 'fetch'),
    false
  );
});

test('checkout recognition uses the actual origin and path rather than a quoted destination', () => {
  assert.equal(
    auth.isCheckoutPageUrl('https://chatgpt.com/checkout/synthetic?return=/auth/login'),
    true
  );
  for (const url of [
    'https://chatgpt.com/?return=https://chatgpt.com/checkout/synthetic',
    'https://chatgpt.com/auth/login?return=https://chatgpt.com/checkout/synthetic',
    'https://not-chatgpt.com/checkout/synthetic',
    'http://chatgpt.com/checkout/synthetic',
    'https://chatgpt.com:444/checkout/synthetic',
    'https://third-party.invalid/chatgpt.com/checkout/synthetic'
  ])
    assert.equal(auth.isCheckoutPageUrl(url), false, url);
  assert.equal(
    auth.shouldBlockLoginNavigation(
      'https://chatgpt.com/auth/login?return=https://chatgpt.com/checkout/synthetic',
      'document'
    ),
    true
  );
});

test('malformed and non-web values are not treated as observed login or checkout pages', () => {
  for (const value of [
    null,
    undefined,
    '',
    '/auth/login',
    'not a url',
    'about:blank',
    'data:text/plain,accounts.google.com',
    'javascript:location="https://chatgpt.com/auth/login"'
  ]) {
    assert.equal(auth.isLoginRedirectUrl(value), false);
    assert.equal(auth.isHardLoginRedirectUrl(value), false);
    assert.equal(auth.isCheckoutPageUrl(value), false);
    assert.equal(auth.shouldBlockLoginNavigation(value, 'document'), false);
  }
});
