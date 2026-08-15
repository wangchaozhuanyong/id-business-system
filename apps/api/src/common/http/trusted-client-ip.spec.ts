import { ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { resolveTrustedClientIp } from './trusted-client-ip';

describe('resolveTrustedClientIp', () => {
  const secret = 'trusted-proxy-secret-for-unit-tests-123456';
  const now = 1_786_816_800_000;
  const timestamp = String(now);
  const requestId = 'request-unit-test-1234';
  const clientIp = '203.0.113.25';

  function signature(ip = clientIp, signedAt = timestamp) {
    return createHmac('sha256', secret).update(`${signedAt}\n${requestId}\n${ip}`).digest('hex');
  }

  it('uses a fresh HMAC-signed client IP in edge mode', () => {
    expect(
      resolveTrustedClientIp(
        {
          ip: '10.0.0.8',
          headers: {
            'x-request-id': requestId,
            'x-v2-client-ip': clientIp,
            'x-v2-proxy-timestamp': timestamp,
            'x-v2-proxy-signature': signature()
          }
        },
        { SUPABASE_EDGE_FUNCTION: 'true', V2_TRUSTED_PROXY_SECRET: secret },
        now
      )
    ).toBe(clientIp);
  });

  it('ignores caller-controlled forwarding headers outside the signed proxy chain', () => {
    expect(
      resolveTrustedClientIp({
        ip: '127.0.0.1',
        headers: {
          'cf-connecting-ip': '198.51.100.10',
          'x-forwarded-for': '198.51.100.11',
          'x-real-ip': '198.51.100.12'
        }
      })
    ).toBe('127.0.0.1');
  });

  it('rejects invalid or expired proxy signatures in edge mode', () => {
    const environment = {
      SUPABASE_EDGE_FUNCTION: 'true',
      V2_TRUSTED_PROXY_SECRET: secret
    };
    expect(() =>
      resolveTrustedClientIp(
        {
          ip: '10.0.0.8',
          headers: {
            'x-request-id': requestId,
            'x-v2-client-ip': clientIp,
            'x-v2-proxy-timestamp': timestamp,
            'x-v2-proxy-signature': '0'.repeat(64)
          }
        },
        environment,
        now
      )
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      resolveTrustedClientIp(
        {
          headers: {
            'x-request-id': requestId,
            'x-v2-client-ip': clientIp,
            'x-v2-proxy-timestamp': timestamp,
            'x-v2-proxy-signature': signature()
          }
        },
        environment,
        now + 5 * 60 * 1000 + 1
      )
    ).toThrow(ServiceUnavailableException);
  });
});
