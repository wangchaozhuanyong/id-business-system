import type { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2WebsiteVisitSignatureGuard } from './id-business-v2-website-visit-signature.guard';
import { websiteVisitSignaturePayload } from './id-business-v2-website-visit-input';

const secret = 'test-secret-with-at-least-thirty-two-characters';
const event = () => ({
  eventId: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
  host: 'flashcast.com.my',
  path: '/zh/services',
  ip: '203.0.113.19',
  occurredAt: new Date().toISOString()
});
function context(request: object) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('website visit signature guard', () => {
  it('accepts the exact current body signature and attaches validated input', () => {
    const body = event();
    const signature = createHmac('sha256', secret)
      .update(websiteVisitSignaturePayload(body))
      .digest('hex');
    const request = { body, headers: { 'x-website-visit-signature': signature } };
    const guard = new IdBusinessV2WebsiteVisitSignatureGuard({ get: vi.fn(() => secret) } as never);
    expect(guard.canActivate(context(request))).toBe(true);
    expect(request).toHaveProperty('websiteVisit', body);
  });

  it('rejects missing, altered, stale or unconfigured signatures', () => {
    const body = event();
    const configured = new IdBusinessV2WebsiteVisitSignatureGuard({
      get: vi.fn(() => secret)
    } as never);
    expect(() => configured.canActivate(context({ body, headers: {} }))).toThrow('签名无效');
    expect(() =>
      configured.canActivate(
        context({
          body: { ...body, path: '/en' },
          headers: {
            'x-website-visit-signature': createHmac('sha256', secret)
              .update(websiteVisitSignaturePayload(body))
              .digest('hex')
          }
        })
      )
    ).toThrow('签名无效');
    const stale = { ...body, occurredAt: '2026-01-01T00:00:00.000Z' };
    expect(() =>
      configured.canActivate(
        context({
          body: stale,
          headers: {
            'x-website-visit-signature': createHmac('sha256', secret)
              .update(websiteVisitSignaturePayload(stale))
              .digest('hex')
          }
        })
      )
    ).toThrow('已过期');
    const missing = new IdBusinessV2WebsiteVisitSignatureGuard({ get: vi.fn() } as never);
    expect(() => missing.canActivate(context({ body, headers: {} }))).toThrow('尚未配置');
  });
});
