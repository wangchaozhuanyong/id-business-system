import { describe, expect, it, vi } from 'vitest';
import { RechargeProxyRepository } from './persistence/proxy-pool.repository';
import { OnlineProxyPoolRepository } from './persistence/online-proxy.repository';
import {
  proxyConnectionVersion,
  publicProxyExitIp,
  safeProxyTestResult,
  safeProxyTestTaskResult
} from './proxy-test';

const proxy = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  urlHash: 'original',
  protocol: 'http',
  connectionMode: 'direct'
};

describe('proxy detection trust boundary', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts public IP %s',
    (ip) => {
      expect(publicProxyExitIp(ip)).toBe(ip);
    }
  );
  it.each([
    '<html>error</html>',
    '1.2.3.999',
    '10.0.0.1',
    '127.0.0.1',
    '100.64.1.1',
    '192.0.2.1',
    '224.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    'fe80::1%en0',
    '2001:db8::1',
    '2001:20::1',
    '3fff::1',
    'fc00::1'
  ])('rejects non-public exit %s', (ip) => {
    expect(publicProxyExitIp(ip)).toBeNull();
    expect(safeProxyTestResult({ ok: true, ip })).toMatchObject({
      ok: false,
      ip: null,
      errorCode: 'invalid_exit_ip'
    });
  });
  it('keeps secrets and raw supplier errors out of mapped messages', () => {
    const result = safeProxyTestResult({
      ok: false,
      errorCode: 'proxy_auth_failed',
      error: 'http://user:secret@proxy.test:8080/?token=secret'
    });
    expect(result.message).toContain('代理认证失败');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(
      safeProxyTestTaskResult(
        { results: [{ proxyId: proxy.id, ok: true, ip: '8.8.8.8', latencyMs: 1 }] },
        proxy.id
      )
    ).toMatchObject({ ok: true, ip: '8.8.8.8' });
  });
  it('does not replace a new connection result with an older task acknowledgement', async () => {
    const repository = {
      lock: vi.fn(),
      findInTransaction: vi.fn().mockResolvedValue({ ...proxy, urlHash: 'new' }),
      update: vi.fn()
    };
    const pool = new OnlineProxyPoolRepository({} as never, repository as never, {} as never);
    expect(
      await pool.result(
        {} as never,
        proxy.id,
        { ok: true, ip: '8.8.8.8', latencyMs: 1 },
        true,
        proxyConnectionVersion(proxy)
      )
    ).toEqual({ applied: false });
    expect(repository.update).not.toHaveBeenCalled();
    expect(
      await pool.result({} as never, proxy.id, { ok: true, ip: '8.8.8.8', latencyMs: 1 }, true)
    ).toEqual({ applied: false });
  });
  it('validates result IP again before persistence', async () => {
    const repository = {
      lock: vi.fn(),
      findInTransaction: vi.fn().mockResolvedValue(proxy),
      update: vi.fn()
    };
    const pool = new OnlineProxyPoolRepository({} as never, repository as never, {} as never);
    await pool.result(
      {} as never,
      proxy.id,
      { ok: true, ip: '<html>not an ip</html>', latencyMs: 12 },
      true,
      proxyConnectionVersion(proxy)
    );
    expect(repository.update).toHaveBeenCalledWith(
      {},
      proxy.id,
      expect.objectContaining({ exitIp: null, testMessage: '检测失败：未取得有效公网出口 IP' })
    );
  });
  it('protects actual business references and only active detection tasks', async () => {
    const tx = {
      idBusinessV2ProxyAlias: { findMany: vi.fn().mockResolvedValue([]) },
      onlineRechargeTask: { findFirst: vi.fn() }
    };
    await new RechargeProxyRepository({} as never).onlineReference(tx as never, proxy.id);
    expect(tx.onlineRechargeTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([{ operation: { not: 'proxy_test' } }])
        })
      })
    );
    await new RechargeProxyRepository({} as never).hasActiveTest(tx as never, proxy.id);
    expect(tx.onlineRechargeTask.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operation: 'proxy_test',
          deletedAt: null,
          status: { in: ['queued', 'running'] }
        })
      })
    );
  });
  it('reports acknowledgement failure separately from successful probe evidence', () => {
    const result = safeProxyTestTaskResult(
      {
        errorCode: 'result_write_failed',
        results: [{ proxyId: proxy.id, ok: true, ip: '8.8.8.8' }]
      },
      proxy.id
    );
    expect(result).toMatchObject({
      ok: false,
      probeOk: true,
      ip: '8.8.8.8',
      errorCode: 'result_write_failed'
    });
    expect(result.message).toContain('回写未能确认');
    expect(safeProxyTestTaskResult(result, proxy.id)).toMatchObject({
      ok: false,
      probeOk: true,
      ip: '8.8.8.8',
      errorCode: 'result_write_failed'
    });
  });
});
