import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleMailboxTaskBridgeService } from './apple-mailboxes-task-bridge.service';
import type { AuthenticatedUser } from '../../auth/auth.types';

const actor = { id: 'operator-one', roles: ['admin'] } as AuthenticatedUser;

describe('注册凭据后台同步补偿', () => {
  let bridge: AppleMailboxTaskBridgeService | undefined;
  afterEach(() => {
    bridge?.onModuleDestroy();
    vi.useRealTimers();
  });

  it('没有取码任务时仍定期补偿通用邮箱已保存事实，不重发注册', async () => {
    vi.useFakeTimers();
    const worker = { appleMailboxRequest: vi.fn() };
    const revalidate = vi.fn().mockResolvedValue(true);
    bridge = new AppleMailboxTaskBridgeService(worker as never, {} as never, {} as never);
    bridge.onReconcile = vi.fn().mockResolvedValue(1);
    bridge.rememberOperator(actor, revalidate);
    await bridge.pump();
    await bridge.pump();
    expect(bridge.onReconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.onReconcile).toHaveBeenCalledTimes(2);
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it('会话被撤销后停止补偿，不保留旧权限持续处理', async () => {
    vi.useFakeTimers();
    const revalidate = vi.fn().mockResolvedValue(false);
    bridge = new AppleMailboxTaskBridgeService({} as never, {} as never, {} as never);
    bridge.onReconcile = vi.fn();
    bridge.rememberOperator(actor, revalidate);
    await bridge.pump();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bridge.onReconcile).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('后台传输临时失败后再次读取，不叠加并行请求', async () => {
    vi.useFakeTimers();
    bridge = new AppleMailboxTaskBridgeService({} as never, {} as never, {} as never);
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValue(1);
    bridge.onReconcile = reconcile;
    bridge.rememberOperator(actor, async () => true);
    await bridge.pump();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
