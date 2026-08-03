import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { resolveTargetUrl } from '../deploy/cloudflare-free/worker.mjs';

const apiBaseUrl = 'https://fjquufgbnxyocmuzltxi.supabase.co/functions/v1/v2-api';

test('maps same-origin API paths and query strings to the fixed Supabase function', () => {
  const target = resolveTargetUrl(
    new URL('https://admin.example.test/api/id-business-v2/orders?page=2'),
    apiBaseUrl
  );

  assert.equal(
    target.href,
    'https://fjquufgbnxyocmuzltxi.supabase.co/functions/v1/v2-api/api/id-business-v2/orders?page=2'
  );
  assert.throws(
    () =>
      resolveTargetUrl(
        new URL('https://admin.example.test/api/health/live'),
        'https://attacker.example.test/functions/v1/v2-api'
      ),
    /SUPABASE_API_BASE_URL is invalid/
  );
});

test('forwards method, body, authorization and request correlation without exposing the API cross-origin', async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest;
  globalThis.fetch = async (request) => {
    capturedRequest = request;
    return Response.json(
      { success: true },
      { status: 201, headers: { 'X-Request-Id': 'upstream-request-1234' } }
    );
  };

  try {
    const response = await worker.fetch(
      new Request('https://admin.example.test/api/id-business-v2/finance/accounts?source=ui', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Request-Id': 'client-request-1234'
        },
        body: JSON.stringify({ name: '测试账户' })
      }),
      { SUPABASE_API_BASE_URL: apiBaseUrl }
    );

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-request-id'), 'upstream-request-1234');
    assert.equal(
      capturedRequest.url,
      `${apiBaseUrl}/api/id-business-v2/finance/accounts?source=ui`
    );
    assert.equal(capturedRequest.method, 'POST');
    assert.equal(capturedRequest.headers.get('authorization'), 'Bearer test-token');
    assert.equal(capturedRequest.headers.get('x-forwarded-host'), 'admin.example.test');
    assert.equal(capturedRequest.headers.get('x-forwarded-proto'), 'https');
    assert.equal(capturedRequest.headers.get('x-request-id'), 'client-request-1234');
    assert.deepEqual(await capturedRequest.json(), { name: '测试账户' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns a stable retryable 503 when Supabase cannot be reached', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async () => {
    throw new TypeError('network unavailable');
  };
  console.log = () => undefined;

  try {
    const response = await worker.fetch(
      new Request('https://admin.example.test/api/health/ready'),
      { SUPABASE_API_BASE_URL: apiBaseUrl }
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(body.errorCode, 'SERVICE_UNAVAILABLE');
    assert.equal(body.retryable, true);
    assert.ok(body.requestId);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
