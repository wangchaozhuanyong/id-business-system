import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker, {
  resolveFunctionRegion,
  resolveTargetUrl
} from '../deploy/cloudflare-free/worker.mjs';

const apiBaseUrl = 'https://fjquufgbnxyocmuzltxi.supabase.co/functions/v1/v2-api';
const functionRegion = 'ap-northeast-1';
const trustedProxySecret = 'trusted-proxy-secret-for-worker-tests-1234';
const clientIp = '203.0.113.25';

function workerEnvironment(overrides = {}) {
  return {
    SUPABASE_API_BASE_URL: apiBaseUrl,
    SUPABASE_FUNCTION_REGION: functionRegion,
    V2_TRUSTED_PROXY_SECRET: trustedProxySecret,
    ...overrides
  };
}

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
          'CF-Connecting-IP': clientIp,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.10',
          'X-Real-Ip': '198.51.100.11',
          'X-Request-Id': 'client-request-1234',
          'X-V2-Client-Ip': '198.51.100.12',
          'X-V2-Proxy-Signature': '0'.repeat(64),
          'X-V2-Proxy-Timestamp': '1786816800000'
        },
        body: JSON.stringify({ name: '测试账户' })
      }),
      workerEnvironment()
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
    assert.equal(capturedRequest.headers.get('x-region'), functionRegion);
    assert.equal(capturedRequest.headers.get('cf-connecting-ip'), null);
    assert.equal(capturedRequest.headers.get('x-forwarded-for'), null);
    assert.equal(capturedRequest.headers.get('x-real-ip'), null);
    assert.equal(capturedRequest.headers.get('x-v2-client-ip'), clientIp);
    const signedAt = capturedRequest.headers.get('x-v2-proxy-timestamp');
    const expectedSignature = createHmac('sha256', trustedProxySecret)
      .update(`${signedAt}\nclient-request-1234\n${clientIp}`)
      .digest('hex');
    assert.equal(capturedRequest.headers.get('x-v2-proxy-signature'), expectedSignature);
    assert.deepEqual(await capturedRequest.json(), { name: '测试账户' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('owns Supabase region routing and rejects invalid deployment values', async () => {
  assert.equal(resolveFunctionRegion(functionRegion), functionRegion);
  assert.equal(resolveFunctionRegion(''), null);
  assert.throws(() => resolveFunctionRegion('https://attacker.example.test'), /is invalid/);

  const originalFetch = globalThis.fetch;
  let capturedRequest;
  globalThis.fetch = async (request) => {
    capturedRequest = request;
    return Response.json({ success: true });
  };

  try {
    await worker.fetch(
      new Request('https://admin.example.test/api/health/live', {
        headers: { 'cf-connecting-ip': clientIp, 'x-region': 'us-east-1' }
      }),
      workerEnvironment({ SUPABASE_FUNCTION_REGION: '' })
    );
    assert.equal(capturedRequest.headers.get('x-region'), null);
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
      new Request('https://admin.example.test/api/health/ready', {
        headers: { 'cf-connecting-ip': clientIp }
      }),
      workerEnvironment()
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
