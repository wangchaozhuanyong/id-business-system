import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registrationWorkerCommand,
  registrationWorkerReady,
  requireRegistrationWorker
} from './registration-worker';
const fetchMock = vi.fn();
const reply = (value: object, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.stubEnv('AUTO_RECHARGE_WORKER_TOKEN', 'a'.repeat(64));
  vi.stubEnv('AUTO_RECHARGE_WORKER_URL', 'http://worker.example.test:8051');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('注册私网执行器接收边界', () => {
  it('只接受实际指纹内核就绪，不接受普通 Chromium 健康响应', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ready: true, engine: 'builtin-chromium' }));
    expect(await registrationWorkerReady()).toBe(false);
    fetchMock.mockResolvedValueOnce(
      reply({ ready: true, engine: 'camoufox', mailDeliveryVersion: 1 })
    );
    expect(await registrationWorkerReady()).toBe(true);
    fetchMock.mockResolvedValueOnce(reply({ ready: true, engine: 'camoufox' }));
    expect(await registrationWorkerReady()).toBe(false);
  });
  it('创建前拒绝保留窗口和仍在执行的任务，恢复原任务只检查内核', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        ready: true,
        engine: 'camoufox',
        mailDeliveryVersion: 1,
        registrationWindowRetained: true
      })
    );
    await expect(requireRegistrationWorker(true)).rejects.toThrow('原注册窗口');
    fetchMock.mockResolvedValueOnce(
      reply({ ready: true, engine: 'camoufox', mailDeliveryVersion: 1, registrationBusy: true })
    );
    await expect(requireRegistrationWorker(true)).rejects.toThrow('已有注册任务');
    fetchMock.mockResolvedValueOnce(
      reply({
        ready: true,
        engine: 'camoufox',
        mailDeliveryVersion: 1,
        registrationWindowRetained: true
      })
    );
    await expect(requireRegistrationWorker()).resolves.toBeUndefined();
  });
  it('明确拒绝保留受控占用原因，取消拒绝不能冒充窗口已关闭', async () => {
    for (const [action, reason] of [
      ['launch', 'worker_busy'],
      ['launch', 'builtin_original_window_pending'],
      ['launch', 'builtin_profile_missing'],
      ['cancel', 'fingerprint_cleanup_failed']
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        reply({ ok: false, reason, unsafe: 'synthetic-private-details' }, 409)
      );
      expect(await registrationWorkerCommand('job', 2, action, {})).toEqual({
        delivery: 'rejected',
        reason
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('未知异常文本不返回管理端，状态失联保持未知', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false, reason: 'synthetic-private-details' }, 400));
    fetchMock.mockRejectedValueOnce(new Error('synthetic-network-error'));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toEqual({
      delivery: 'unknown'
    });
  });
  it('传输失联只读取相同尝试的收据，不重发注册写请求', async () => {
    fetchMock.mockRejectedValueOnce(new Error('unavailable'));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, accepted: true }));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toEqual({
      delivery: 'accepted'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1].method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1].method).toBeUndefined();
  });
  it('旧尝试的已接收收据不能把新尝试标为成功', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 400));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 1, accepted: true }));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toEqual({
      delivery: 'unknown'
    });
  });
  it('任务收据不能证明继续或验证码提交成功', async () => {
    for (const action of ['resume', 'code'] as const) {
      fetchMock.mockResolvedValueOnce(reply({}, 400));
      fetchMock.mockResolvedValueOnce(reply({ attempt: 2, accepted: true }));
      expect(await registrationWorkerCommand('job', 2, action, {})).toEqual({
        delivery: 'unknown'
      });
    }
  });
  it('取消指令已接收但窗口未关闭时保留未知，只认可同尝试的关闭收据', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, cancelled: false, done: false }));
    expect(await registrationWorkerCommand('job', 2, 'cancel', {})).toEqual({
      delivery: 'unknown'
    });
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, cancelled: true, done: true }));
    expect(await registrationWorkerCommand('job', 2, 'cancel', {})).toEqual({
      delivery: 'accepted'
    });
  });
  it('失联且原编号不存在时明确未接收', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 400));
    fetchMock.mockResolvedValueOnce(reply({}, 404));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toEqual({
      delivery: 'not_received'
    });
  });
});
