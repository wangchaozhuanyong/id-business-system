import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  IdBusinessV2WebsiteMonitorService,
  type WebsiteHopProbe,
  type WebsiteProbeTrace
} from './id-business-v2-website-monitor.service';

const user = { id: 'user-1' } as AuthenticatedUser;

class StubWebsiteMonitorService extends IdBusinessV2WebsiteMonitorService {
  constructor(private readonly trace: WebsiteProbeTrace) {
    super();
  }

  protected override async probeTarget() {
    return this.trace;
  }
}

class RedirectWebsiteMonitorService extends IdBusinessV2WebsiteMonitorService {
  readonly visited: string[] = [];

  constructor(private readonly probes: WebsiteHopProbe[]) {
    super();
  }

  inspect(target: URL) {
    return this.probeTarget(target);
  }

  protected override async probeHop(target: URL) {
    this.visited.push(target.href);
    const probe = this.probes.shift();
    if (!probe) throw new Error('缺少模拟响应');
    return probe;
  }
}

function trace(overrides: Partial<WebsiteProbeTrace> = {}): WebsiteProbeTrace {
  return {
    finalUrl: new URL('https://example.com/health'),
    hops: [
      {
        durationMs: 180,
        statusCode: 200,
        url: 'https://example.com/health'
      }
    ],
    responseTimeMs: 180,
    statusCode: 200,
    tls: {
      authorized: true,
      daysRemaining: 45,
      expiresAt: '2026-10-18T00:00:00.000Z',
      protocol: 'TLSv1.3'
    },
    ...overrides
  };
}

describe('IdBusinessV2WebsiteMonitorService', () => {
  it('returns a healthy public result without query parameters', async () => {
    const service = new StubWebsiteMonitorService(
      trace({ finalUrl: new URL('https://example.com/health?token=secret') })
    );

    await expect(service.check({ url: 'example.com/health?token=secret' }, user)).resolves.toEqual(
      expect.objectContaining({
        errorCategory: null,
        finalUrl: 'https://example.com/health',
        message: '网站访问正常',
        responseTimeMs: 180,
        status: 'healthy',
        statusCode: 200
      })
    );
  });

  it('marks HTTP, client errors and server errors with controlled Chinese statuses', async () => {
    await expect(
      new StubWebsiteMonitorService(trace({ tls: null })).check(
        { url: 'https://example.com' },
        user
      )
    ).resolves.toMatchObject({ status: 'warning', message: '网站可访问，但当前地址未使用 HTTPS' });

    await expect(
      new StubWebsiteMonitorService(trace({ statusCode: 404 })).check(
        { url: 'https://example.com/missing' },
        user
      )
    ).resolves.toMatchObject({ status: 'warning', message: '网站已响应，但当前地址返回访问错误' });

    await expect(
      new StubWebsiteMonitorService(trace({ statusCode: 503 })).check(
        { url: 'https://example.com' },
        user
      )
    ).resolves.toMatchObject({ status: 'down', message: '网站已响应，但服务端返回异常状态' });
  });

  it('rejects unauthenticated and private targets before any network request', async () => {
    const service = new StubWebsiteMonitorService(trace());
    await expect(service.check({ url: 'https://example.com' })).rejects.toThrow(
      '无法识别当前操作人'
    );
    await expect(
      service.check({ url: 'http://169.254.169.254/latest/meta-data' }, user)
    ).rejects.toThrow('只允许检测公开网站');
  });

  it('revalidates redirect targets and rejects redirects into private networks', async () => {
    const service = new RedirectWebsiteMonitorService([
      { durationMs: 30, location: 'http://127.0.0.1/admin', statusCode: 302, tls: null }
    ]);

    await expect(service.inspect(new URL('https://example.com'))).rejects.toThrow(
      '只允许检测公开网站'
    );
    expect(service.visited).toEqual(['https://example.com/']);
  });

  it('does not follow an untrusted HTTPS response', async () => {
    const service = new RedirectWebsiteMonitorService([
      {
        durationMs: 30,
        location: 'https://example.org',
        statusCode: 302,
        tls: { authorized: false, daysRemaining: null, expiresAt: null, protocol: 'TLSv1.3' }
      }
    ]);

    const result = await service.inspect(new URL('https://example.com'));

    expect(result.finalUrl.href).toBe('https://example.com/');
    expect(result.tls?.authorized).toBe(false);
    expect(service.visited).toEqual(['https://example.com/']);
  });
});
