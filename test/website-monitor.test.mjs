import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWebsiteMonitor } from '../server/tools/website-monitor.mjs';

const host = '127.0.0.1:4348';
const origin = `http://${host}`;
const actor = { id: 'staff-a' };
const publicV4 = { address: '93.184.216.34', family: 4 };
const publicV6 = { address: '2606:4700:4700::1111', family: 6 };

async function call(handler, payload, options = {}) {
  const request = Readable.from([Buffer.from(options.raw ?? JSON.stringify(payload))]);
  request.headers = { host, origin, 'content-type': 'application/json', ...options.headers };
  request.method = options.method || 'POST';
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
      return this;
    },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler(request, response, options.actor === undefined ? actor : options.actor);
  return response;
}

function mockedMonitor({ answers = () => [publicV4], responses = [] } = {}) {
  const resolutions = [];
  const requests = [];
  const monitor = createWebsiteMonitor({
    async resolve(hostname, timeoutMs) {
      resolutions.push({ hostname, timeoutMs });
      return answers(hostname);
    },
    request(options, onResponse) {
      requests.push(options);
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const result = responses.shift() || { statusCode: 200 };
        if (result.error) {
          request.emit('error', Object.assign(new Error('private failure details'), { code: result.error }));
          return;
        }
        onResponse({
          statusCode: result.statusCode,
          headers: result.location ? { location: result.location } : {},
          socket: { getPeerCertificate: () => ({ valid_to: result.validTo }) },
          destroy() { result.destroyed = true; }
        });
      });
      return request;
    }
  });
  return { monitor, resolutions, requests };
}

test('checks an authenticated same-origin JSON request before attempting network access', async () => {
  const { monitor, requests, resolutions } = mockedMonitor();
  const payload = { url: 'example.com' };
  assert.equal((await call(monitor, payload, { actor: null })).status, 401);
  assert.equal((await call(monitor, payload, { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await call(monitor, payload, { headers: { host: 'other.example', origin: 'http://other.example' } })).status, 403);
  assert.equal((await call(monitor, payload, { headers: { origin: undefined } })).status, 403);
  assert.equal((await call(monitor, payload, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const unsupported = await call(monitor, payload, { method: 'GET' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.Allow, 'POST');
  assert.equal((await call(monitor, payload, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(monitor, null, { raw: 'broken' })).status, 400);
  assert.equal((await call(monitor, null, { raw: 'a'.repeat(4097) })).status, 413);
  assert.equal(requests.length, 0);
  assert.equal(resolutions.length, 0);
});

test('pins each public redirect independently and omits URL query values from all returned URLs', async () => {
  const redirect = { statusCode: 302, location: 'https://other.example.net/end?key=next#fragment' };
  const destination = { statusCode: 200, validTo: new Date(Date.now() + 86_400_000).toUTCString() };
  const { monitor, resolutions, requests } = mockedMonitor({
    answers: (hostname) => hostname === 'start.example.com' ? [publicV6, publicV4] : [publicV6],
    responses: [redirect, destination]
  });
  const response = await call(monitor, { url: 'start.example.com/path?token=first#private' }, {
    headers: { cookie: 'local=private', authorization: 'Bearer private' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.status, 'reachable');
  assert.equal(response.body.tls, 'valid');
  assert.equal(response.body.failure, null);
  assert.equal(response.body.statusCode, 200);
  assert.ok(response.body.latencyMs >= 0);
  assert.ok(response.body.warnings.includes('certificate_expiring'));
  assert.equal(response.body.requestedUrl, 'https://start.example.com/path');
  assert.equal(response.body.effectiveUrl, 'https://other.example.net/end');
  assert.deepEqual(response.body.hops.map(({ url, statusCode }) => [url, statusCode]), [
    ['https://start.example.com/path', 302], ['https://other.example.net/end', 200]
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /token|first|key=next|fragment|private/);
  assert.deepEqual(resolutions.map(({ hostname }) => hostname), ['start.example.com', 'other.example.net']);
  assert.ok(resolutions.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 3000));
  assert.deepEqual(requests.map(({ hostname, family, servername, path }) => [hostname, family, servername, path]), [
    [publicV4.address, 4, 'start.example.com', '/path?token=first'],
    [publicV6.address, 6, 'other.example.net', '/end?key=next']
  ]);
  assert.equal(requests[0].headers.Host, 'start.example.com');
  assert.ok(requests.every((request) => request.agent === false && request.rejectUnauthorized === true));
  assert.equal(
    requests[0].checkServerIdentity(publicV4.address, { subjectaltname: 'DNS:start.example.com' }),
    undefined
  );
  assert.equal(
    requests[0].checkServerIdentity(publicV4.address, { subjectaltname: `IP Address:${publicV4.address}` }).code,
    'ERR_TLS_CERT_ALTNAME_INVALID'
  );
  assert.ok(requests.every((request) => !('cookie' in request.headers) && !('authorization' in request.headers)));
  assert.ok(redirect.destroyed && destination.destroyed);
});

test('blocks local literals and rejects a DNS answer set if any address is non-public', async () => {
  const { monitor, requests, resolutions } = mockedMonitor({
    answers: () => [publicV4, { address: '::ffff:127.0.0.1', family: 6 }]
  });
  for (const url of [
    'localhost', 'http://0x7f000001', 'http://10.0.0.1', 'http://100.64.2.1',
    'http://[fe80::1]', 'http://[2001:db8::4]', 'http://[3fff::2]', 'http://[::ffff:7f00:1]',
    'https://site.local', 'http://secret:pass@example.com', 'file:///etc/hosts'
  ]) {
    assert.equal((await call(monitor, { url })).status, 400, url);
  }
  assert.equal(resolutions.length, 0);
  assert.equal((await call(monitor, { url: 'mixed.example.com' })).status, 400);
  assert.deepEqual(resolutions.map(({ hostname }) => hostname), ['mixed.example.com']);
  assert.equal(requests.length, 0);
});

test('never follows a redirect into private DNS, credentials or a non-HTTP scheme', async () => {
  for (const destination of ['https://private.example.net/x', 'https://user:secret@example.net/x', 'file:///etc/hosts']) {
    const { monitor, requests } = mockedMonitor({
      answers: (hostname) => hostname === 'private.example.net'
        ? [publicV4, { address: '169.254.169.254', family: 4 }]
        : [publicV4],
      responses: [{ statusCode: 302, location: destination }]
    });
    const response = await call(monitor, { url: 'https://example.com' });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'unreachable');
    assert.equal(response.body.failure, 'blocked_target');
    assert.equal(response.body.hops.length, 1);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /secret|169\.254/);
  }
});

test('stops loops and after at most five redirects', async () => {
  const loop = mockedMonitor({ responses: [{ statusCode: 302, location: '/' }] });
  assert.equal((await call(loop.monitor, { url: 'https://example.com' })).body.failure, 'redirect');
  assert.equal(loop.requests.length, 1);
  const chain = mockedMonitor({
    responses: Array.from({ length: 8 }, (_, index) => ({ statusCode: 302, location: `/${index}` }))
  });
  const response = await call(chain.monitor, { url: 'https://example.com' });
  assert.equal(response.body.failure, 'redirect');
  assert.equal(chain.requests.length, 6);
});

test('reports safe separate results for TLS failure, HTTP status, DNS failure, and an HTTP warning', async () => {
  const tls = mockedMonitor({ responses: [{ error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }] });
  const tlsResult = (await call(tls.monitor, { url: 'example.com' })).body;
  assert.equal(tlsResult.status, 'tls_error');
  assert.equal(tlsResult.tls, 'invalid');
  assert.equal(tlsResult.statusCode, null);
  assert.doesNotMatch(JSON.stringify(tlsResult), /private failure details/);

  const http = mockedMonitor({ responses: [{ statusCode: 503 }] });
  const httpResult = (await call(http.monitor, { url: 'http://example.com' })).body;
  assert.equal(httpResult.status, 'http_error');
  assert.equal(httpResult.statusCode, 503);
  assert.equal(httpResult.tls, 'not_applicable');
  assert.ok(httpResult.warnings.includes('insecure_http'));

  const missing = mockedMonitor({ answers: () => [] });
  const missingResult = (await call(missing.monitor, { url: 'example.com' })).body;
  assert.equal(missingResult.status, 'unreachable');
  assert.equal(missingResult.failure, 'dns');
  assert.equal(missing.requests.length, 0);
});

test('limits requests per actor and in parallel while allowing a different actor', async () => {
  const { monitor, requests } = mockedMonitor();
  for (let i = 0; i < 20; i++) {
    assert.equal((await call(monitor, { url: 'example.com' })).status, 200);
  }
  assert.equal((await call(monitor, { url: 'example.com' })).status, 429);
  assert.equal((await call(monitor, { url: 'example.com' }, { actor: { id: 'staff-b' } })).status, 200);
  assert.equal(requests.length, 21);

  let release;
  const resolving = new Promise((resolve) => { release = resolve; });
  const busy = mockedMonitor({ answers: () => resolving });
  const first = call(busy.monitor, { url: 'example.com' });
  const sameActor = call(busy.monitor, { url: 'example.com' });
  assert.equal((await sameActor).status, 429);
  const otherActors = Array.from({ length: 7 }, (_, index) =>
    call(busy.monitor, { url: 'example.com' }, { actor: { id: `parallel-${index}` } })
  );
  const excess = call(busy.monitor, { url: 'example.com' }, { actor: { id: 'parallel-excess' } });
  assert.equal((await excess).status, 429);
  release([publicV4]);
  assert.equal((await first).status, 200);
  assert.ok((await Promise.all(otherActors)).every(({ status }) => status === 200));
});
