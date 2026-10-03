import { effectScope, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBankRechargeOrderTiming } from './useBankRechargeOrderTiming';
import type { BankRechargeOrder } from './bank-recharge-api';

const clock = vi.hoisted(() => ({ now: null as number | null }));
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: vi.fn(),
  onUnmounted: vi.fn()
}));
vi.mock('@/v2/runtime/businessClock', () => ({
  getV2BusinessNowMs: () => clock.now,
  ensureV2BusinessNowMs: async () => clock.now
}));

let scope = effectScope();
beforeEach(() => {
  scope = effectScope();
  clock.now = Date.parse('2026-01-01T02:15:00Z');
});
afterEach(() => scope.stop());

describe('银充开通与到期时间', () => {
  it('按服务器时间初始化，并随开通时间跨月调整默认到期时间', async () => {
    const form = reactive({ openedAt: '', dueAt: '' });
    const timing = scope.run(() => useBankRechargeOrderTiming(form))!;
    timing.initializeDates();
    await nextTick();
    expect(form).toEqual({ openedAt: '2026-01-01T10:15', dueAt: '2026-01-31T10:15' });
    form.openedAt = '2026-02-01T10:15';
    await nextTick();
    expect(form.dueAt).toBe('2026-02-28T10:15');
  });

  it('保留手工指定的到期时间及恢复的草稿', async () => {
    const form = reactive({ openedAt: '2026-01-01T10:15', dueAt: '2026-04-01T10:15' });
    const timing = scope.run(() => useBankRechargeOrderTiming(form))!;
    timing.initializeDates();
    form.openedAt = '2026-02-01T10:15';
    await nextTick();
    expect(form.dueAt).toBe('2026-04-01T10:15');
  });

  it('服务器时间未同步时不猜测日期，并将到期边界和历史订单判为已到期', () => {
    clock.now = null;
    const form = reactive({ openedAt: '', dueAt: '' });
    const unsynchronized = scope.run(() => useBankRechargeOrderTiming(form))!;
    unsynchronized.initializeDates();
    expect(form).toEqual({ openedAt: '', dueAt: '' });
    const row = {
      dueAt: '2026-01-01T02:15:00Z',
      activeSubscription: null,
      accountId: 'synthetic-account'
    } as BankRechargeOrder;
    expect(unsynchronized.usageLabel(row)).toBe('时间同步中');
    clock.now = Date.parse(row.dueAt!);
    const synchronized = scope.run(() => useBankRechargeOrderTiming(form))!;
    expect(synchronized.usageLabel(row)).toBe('已到期');
    expect(synchronized.usageTagType(row)).toBe('warning');
  });
});
