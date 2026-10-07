import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registrationWorkerCommand,
  registrationWorkerReady,
  requireRegistrationWorker,
  registrationWindowLost
} from './registration-worker';
const fetchMock = vi.fn();
const reply = (value: object, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.stubEnv('AUTO_RECHARGE_WORKER_TOKEN', 'a'.repeat(64));
  vi.stubEnv('AUTO_RECHARGE_WORKER_URL', 'http://worker.example.test:8051');
  vi.stubEnv('AUTO_REGISTRATION_WORKER_URL', 'http://registration.example.test:8051');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('注册私网执行器接收边界', () => {
  it('健康、启动及失败后的原任务收据只请求独立注册执行器', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ ready: true, workerRole: 'registration', engine: 'camoufox', mailDeliveryVersion: 1 })
    );
    expect(await registrationWorkerReady()).toBe(true);
    fetchMock.mockResolvedValueOnce(reply({}, 400));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, accepted: true }));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toEqual({
      delivery: 'accepted'
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://registration.example.test:8051/registration/health',
      'http://registration.example.test:8051/registration/jobs/job',
      'http://registration.example.test:8051/registration/jobs/job/status'
    ]);
  });
  it('未配置注册地址时使用独立服务名，不回退到充值执行器', async () => {
    vi.stubEnv('AUTO_REGISTRATION_WORKER_URL', undefined);
    fetchMock.mockResolvedValueOnce(
      reply({ ready: true, workerRole: 'registration', engine: 'camoufox', mailDeliveryVersion: 1 })
    );
    expect(await registrationWorkerReady()).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://auto-registration:8051/registration/health');
  });
  it('只接受实际指纹内核就绪，不接受普通 Chromium 健康响应', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ready: true, engine: 'builtin-chromium' }));
    expect(await registrationWorkerReady()).toBe(false);
    fetchMock.mockResolvedValueOnce(
      reply({ ready: true, workerRole: 'registration', engine: 'camoufox', mailDeliveryVersion: 1 })
    );
    expect(await registrationWorkerReady()).toBe(true);
    fetchMock.mockResolvedValueOnce(reply({ ready: true, engine: 'camoufox' }));
    expect(await registrationWorkerReady()).toBe(false);
  });
  it('创建前拒绝保留窗口和仍在执行的任务，恢复原任务只检查内核', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        ready: true,
        workerRole: 'registration',
        engine: 'camoufox',
        mailDeliveryVersion: 1,
        registrationWindowRetained: true
      })
    );
    await expect(requireRegistrationWorker(true)).rejects.toThrow('原注册窗口');
    fetchMock.mockResolvedValueOnce(
      reply({
        ready: true,
        workerRole: 'registration',
        engine: 'camoufox',
        mailDeliveryVersion: 1,
        registrationBusy: true
      })
    );
    await expect(requireRegistrationWorker(true)).rejects.toThrow('已有注册任务');
    fetchMock.mockResolvedValueOnce(
      reply({
        ready: true,
        workerRole: 'registration',
        engine: 'camoufox',
        mailDeliveryVersion: 1,
        registrationWindowRetained: true
      })
    );
    await expect(requireRegistrationWorker()).resolves.toBeUndefined();
  });
  it('旧共用执行器或错误角色不得通过注册预检', async () => {
    for (const workerRole of [undefined, 'recharge', 'unexpected']) {
      fetchMock.mockResolvedValueOnce(
        reply({ ready: true, workerRole, engine: 'camoufox', mailDeliveryVersion: 1 })
      );
      await expect(requireRegistrationWorker()).rejects.toThrow('尚未就绪');
    }
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

describe('已注册任务的只读丢窗确认', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const emptyHealth = {
    ready: true,
    workerRole: 'registration',
    engine: 'camoufox',
    mailDeliveryVersion: 1,
    registrationBusy: false,
    registrationWindowRetained: false
  };
  it.each([
    [{ ok: false }, 404],
    [{ accepted: true, attempt: 2, done: true, cancelled: true }, 200]
  ])('只有明确原收据和空窗口健康共同确认丢失 %j', async (receipt, status) => {
    fetchMock.mockResolvedValueOnce(reply(receipt as object, status as number));
    fetchMock.mockResolvedValueOnce(reply(emptyHealth));
    expect(await registrationWindowLost(jobId, 2)).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `http://registration.example.test:8051/registration/jobs/${jobId}/status`,
      'http://registration.example.test:8051/registration/health'
    ]);
    expect(fetchMock.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
  });
  it.each([
    { registrationBusy: true },
    { registrationWindowRetained: true },
    { registrationBusy: undefined },
    { registrationWindowRetained: undefined },
    { registrationBusy: 'false' },
    { registrationWindowRetained: 0 },
    { ready: false },
    { workerRole: 'recharge' },
    { engine: 'chromium' },
    { mailDeliveryVersion: 2 }
  ])('保留、占用或非精确健康状态不能确认丢失 %j', async (patch) => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false }, 404));
    fetchMock.mockResolvedValueOnce(reply({ ...emptyHealth, ...patch }));
    expect(await registrationWindowLost(jobId, 2)).toBe(false);
  });
  it.each([
    [{}, 404],
    [{ ok: false, reason: 'unknown' }, 404],
    [{ ok: false }, 403],
    [{ accepted: true, attempt: 1, done: true, cancelled: true }, 200],
    [{ accepted: true, attempt: 2, done: false, cancelled: true }, 200],
    [{ accepted: true, attempt: 2, done: true, cancelled: false }, 200],
    [{ attempt: 2, done: true, cancelled: true }, 200]
  ])('不明或不同尝试的收据拒绝恢复 %j', async (receipt, status) => {
    fetchMock.mockResolvedValueOnce(reply(receipt as object, status as number));
    expect(await registrationWindowLost(jobId, 2)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('请求失联、健康失联及非法任务参数均保持未知且不写请求', async () => {
    fetchMock.mockRejectedValueOnce(new Error('synthetic-offline'));
    expect(await registrationWindowLost(jobId, 2)).toBe(false);
    fetchMock.mockResolvedValueOnce(reply({ ok: false }, 404));
    fetchMock.mockRejectedValueOnce(new Error('synthetic-offline'));
    expect(await registrationWindowLost(jobId, 2)).toBe(false);
    const count = fetchMock.mock.calls.length;
    expect(await registrationWindowLost('../other', 2)).toBe(false);
    expect(await registrationWindowLost(jobId, 0)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });
});
