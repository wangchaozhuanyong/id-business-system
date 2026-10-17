import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeWorkerRpcRepository } from './worker-rpc.repository';

describe('受保护原单恢复 RPC', () => {
  function fixture(value: unknown) {
    const key = 'synthetic-worker-credential-at-least-32-characters';
    const workers = { getCheckoutRecovery: vi.fn(async () => value) };
    const rpc = new OnlineRechargeWorkerRpcRepository(
      {} as never,
      { get: () => key } as never,
      {} as never,
      workers as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { key, workers, rpc };
  }
  it('没有原单来源时仍返回明确 JSON 空资料，执行器不会把空 HTTP 响应当网络失败', async () => {
    const f = fixture(null);
    expect(await f.rpc.rpc(f.key, { method: 'getCheckoutRecovery' })).toEqual({
      checkoutRecovery: null
    });
  });
  it('资料只委托有效内部执行器，公开任务或管理员接口不会通过此入口读取', async () => {
    const f = fixture({ version: 1 });
    await expect(f.rpc.rpc('invalid', { method: 'getCheckoutRecovery' })).rejects.toThrow(
      '执行器凭证无效'
    );
    expect(f.workers.getCheckoutRecovery).not.toHaveBeenCalled();
    expect(
      await f.rpc.rpc(f.key, { method: 'getCheckoutRecovery', taskId: 'leased-task' })
    ).toEqual({ checkoutRecovery: { version: 1 } });
  });
});
