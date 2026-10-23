'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const filename = path.resolve(__dirname, '../upstream/session-auth.js');
const source = fs.readFileSync(filename, 'utf8');
const sandbox = {
  module: { exports: {} },
  require(name) {
    if (name === './auth-page-detect') return {};
    return require(path.resolve(path.dirname(filename), name));
  },
  console: { log() {}, warn() {} },
  process: { env: {} },
  Buffer,
  URL,
  performance
};
// Expose the private probe only in this isolated test evaluation. Production
// exports and all browser/network transports remain untouched.
runInNewContext(`${source}\nmodule.exports = { verifyRealSessionApi };`, sandbox, { filename });
const { verifyRealSessionApi } = sandbox.module.exports;

async function probe(options = {}) {
  const state = { opened: 0, navigated: 0, bodyReads: 0, closed: 0 };
  const page = {
    async goto(url, navigation) {
      state.navigated++;
      assert.equal(url, 'https://chatgpt.com/api/auth/session');
      assert.equal(navigation.waitUntil, 'domcontentloaded');
      if (options.navigationError) throw options.navigationError;
      return {
        status: () => options.status ?? 200,
        headers: () => options.headers ?? { 'content-type': 'application/json' }
      };
    },
    async evaluate() {
      state.bodyReads++;
      if (options.bodyError) throw options.bodyError;
      return options.body ?? '{}';
    },
    async close() {
      state.closed++;
    }
  };
  const result = await verifyRealSessionApi({
    async newPage() {
      state.opened++;
      return page;
    }
  });
  assert.equal(state.opened, 1);
  assert.equal(state.navigated, 1);
  assert.equal(state.closed, 1, 'the isolated probe Page is always closed in finally');
  return result;
}

test('valid HTTP 200 Session JSON may contain challenge wording in ordinary string fields', async () => {
  for (const name of ['verify you are human', 'just a moment']) {
    const result = await probe({
      body: JSON.stringify({
        accessToken: 'synthetic-probe-token',
        user: { id: 'synthetic-probe-user', name }
      })
    });
    assert.equal(result.ok, true);
    assert.equal(result.challenge, undefined);
    assert.equal(result.code, undefined);
    assert.equal(result.data.user.name, name);
  }
});

test('an explicit Cloudflare challenge response header is not overridden by Session-looking JSON', async () => {
  const result = await probe({
    headers: { 'content-type': 'application/json', 'cf-mitigated': 'Challenge' },
    body: JSON.stringify({ accessToken: 'synthetic-probe-token', user: { id: 'synthetic-user' } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.challenge, true);
  assert.equal(result.code, 'UPSTREAM_BLOCKED');
});

test('specific HTML challenge markers require verification without relying on generic wording', async () => {
  for (const heading of [
    '<script src="/cdn-cgi/challenge-platform/example"></script>',
    '<script>window._cf_chl_opt={}</script>'
  ]) {
    const result = await probe({
      status: 403,
      headers: { 'content-type': 'text/html' },
      body: `<html><body><h1>${heading}</h1></body></html>`
    });
    assert.equal(result.ok, false);
    assert.equal(result.challenge, true);
    assert.equal(result.code, 'UPSTREAM_BLOCKED');
  }
});

test('generic HTML wording alone stays unknown with its marker evidence retained', async () => {
  const result = await probe({
    status: 403,
    headers: { 'content-type': 'text/html' },
    body: 'Just a moment'
  });
  assert.equal(result.code, 'UPSTREAM_FORBIDDEN');
  assert.equal(result.diagnostics.classification, 'UNKNOWN_403');
  assert.equal(result.diagnostics.markers.justAMoment, true);
});

test('401, unrelated 403, empty Session and other HTTP failures retain their classifications', async () => {
  for (const [status, body, code] of [
    [401, '{"error":"unauthorized"}', 'SESSION_INVALID'],
    [403, '{"error":"forbidden"}', 'UPSTREAM_FORBIDDEN'],
    [200, '{}', 'SESSION_INVALID'],
    [503, '{"user":{"id":"synthetic-user"}}', 'NETWORK_UNAVAILABLE']
  ]) {
    const result = await probe({ status, body });
    assert.equal(result.ok, false);
    assert.equal(result.challenge, undefined);
    assert.equal(result.code, code);
  }
});

test('HTTP 200 error JSON containing a user field is not accepted as a valid Session', async () => {
  const result = await probe({
    body: JSON.stringify({ error: 'synthetic-error', user: { id: 'synthetic-user' } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NETWORK_UNAVAILABLE');
});

test('navigation timeouts close the probe Page and retain timeout classification', async () => {
  const result = await probe({
    navigationError: Object.assign(new Error('synthetic-timeout'), { name: 'TimeoutError' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NETWORK_TIMEOUT');
});

test('navigation failures close the probe Page and retain network classification', async () => {
  const result = await probe({ navigationError: new Error('synthetic-network-failure') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NETWORK_UNAVAILABLE');
});

test('body-read failure cannot become a valid Session and still closes the probe Page', async () => {
  const result = await probe({
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    bodyError: new Error('synthetic-body-read-failure')
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NETWORK_UNAVAILABLE');
  assert.equal(result.initialDiagnostics.httpStatus, 403);
  assert.equal(result.initialDiagnostics.cfMitigated, 'challenge');
  assert.equal(result.initialDiagnostics.complete, false);
});
