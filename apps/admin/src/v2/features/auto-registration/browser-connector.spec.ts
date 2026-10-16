import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkRegistrationConnector, dispatchRegistrationBrowser } from './browser-connector';
import type { AppleMailboxBrowserLaunch } from './contracts';

const taskUuid = '12345678-1234-4234-8234-123456789abc';
const websiteOrigin = 'https://system.example.invalid';
const grant = () =>
  ({
    taskUuid,
    launchToken: 'synthetic-one-use-only',
    callbackBaseUrl: `${websiteOrigin}/api/id-business-v2/auto-registration/browser/tasks/${taskUuid}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    record: {}
  }) as AppleMailboxBrowserLaunch;
const health = { service: 'id-business-v2-auto-registration-connector', version: 1, ok: true };
afterEach(() => vi.unstubAllGlobals());

describe('独立浏览器注册助手协议', () => {
  it('先核实独立服务和版本，不接受充值助手或不完整健康回执', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(health)));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkRegistrationConnector()).resolves.toEqual(health);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:55324/health',
      expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    );
    for (const value of [
      { ...health, service: 'id-business-v2-auto-recharge-connector' },
      { ...health, version: 2 },
      { ...health, ok: false },
      null
    ]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value)));
      await expect(checkRegistrationConnector()).rejects.toThrow('未连接或版本不匹配');
    }
  });
  it('只派发当前任务的三个字段，回执必须明确接收同一任务', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: true, taskUuid }), { status: 202 })
      );
    vi.stubGlobal('fetch', fetcher);
    const launch = grant();
    await dispatchRegistrationBrowser(launch, { websiteOrigin });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:55324/jobs');
    expect(JSON.parse(options.body)).toEqual({
      taskUuid,
      launchToken: launch.launchToken,
      callbackBaseUrl: launch.callbackBaseUrl
    });
    expect(options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    });
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });
  it('过期、外站、带查询凭据或错任务回调在本机请求前停止', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const patch of [
      { expiresAt: new Date(0).toISOString() },
      {
        callbackBaseUrl: grant().callbackBaseUrl.replace(
          websiteOrigin,
          'https://other.example.invalid'
        )
      },
      { callbackBaseUrl: `${grant().callbackBaseUrl}?token=synthetic-private` },
      { callbackBaseUrl: grant().callbackBaseUrl.replace(taskUuid, 'different-task') },
      { taskUuid: 'invalid' }
    ])
      await expect(
        dispatchRegistrationBrowser({ ...grant(), ...patch }, { websiteOrigin })
      ).rejects.toThrow('任务已保留');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('拒绝错任务和不确定回执，隐藏本机响应原文且不自动重发', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const receipt of [
      { accepted: true, taskUuid: 'another-task' },
      { accepted: false, taskUuid, reason: 'synthetic-private-secret' }
    ]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 202 }));
      const result = dispatchRegistrationBrowser(grant(), { websiteOrigin });
      await expect(result).rejects.toThrow('不要重新注册');
      await expect(result).rejects.not.toThrow('synthetic-private-secret');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('使用调用方取消信号，不忽略身份切换或页面离开', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockRejectedValue(new DOMException('synthetic-private', 'AbortError'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      dispatchRegistrationBrowser(grant(), { websiteOrigin, signal: controller.signal })
    ).rejects.toThrow('任务已保留');
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  });
});
