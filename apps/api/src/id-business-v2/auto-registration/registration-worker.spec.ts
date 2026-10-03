import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registrationWorkerCommand, registrationWorkerReady } from './registration-worker';
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
    fetchMock.mockResolvedValueOnce(reply({ ready: true, engine: 'camoufox' }));
    expect(await registrationWorkerReady()).toBe(true);
  });
  it('传输失联只读取相同尝试的收据，不重发注册写请求', async () => {
    fetchMock.mockRejectedValueOnce(new Error('unavailable'));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, accepted: true }));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1].method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1].method).toBeUndefined();
  });
  it('旧尝试的已接收收据不能把新尝试标为成功', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 400));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 1, accepted: true }));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toBe('unknown');
  });
  it('任务收据不能证明继续或验证码提交成功', async () => {
    for (const action of ['resume', 'code'] as const) {
      fetchMock.mockResolvedValueOnce(reply({}, 400));
      fetchMock.mockResolvedValueOnce(reply({ attempt: 2, accepted: true }));
      expect(await registrationWorkerCommand('job', 2, action, {})).toBe('unknown');
    }
  });
  it('取消指令已接收但窗口未关闭时保留未知，只认可同尝试的关闭收据', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, cancelled: false, done: false }));
    expect(await registrationWorkerCommand('job', 2, 'cancel', {})).toBe('unknown');
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(reply({ attempt: 2, cancelled: true, done: true }));
    expect(await registrationWorkerCommand('job', 2, 'cancel', {})).toBe('accepted');
  });
  it('失联且原编号不存在时明确未接收', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 400));
    fetchMock.mockResolvedValueOnce(reply({}, 404));
    expect(await registrationWorkerCommand('job', 2, 'launch', {})).toBe('not_received');
  });
});
