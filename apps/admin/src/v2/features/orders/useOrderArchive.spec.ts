import { computed, effectScope, nextTick, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ archive: vi.fn(), unarchive: vi.fn(), get: vi.fn() }));
const identity = vi.hoisted(() => ({ value: 0 }));
vi.mock('./api', () => ({ idBusinessV2OrdersApi: api }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn() }
}));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: { identityEpoch: identity, subscribeIdentityChange: () => undefined }
}));
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import type { V2Order, V2OrderStatus } from './contracts';
import { canArchiveOrder, canUnarchiveOrder, useOrderArchive } from './useOrderArchive';

function order(
  id = 'order-a',
  status: V2OrderStatus = 'completed',
  archivedAt: string | null = null
): V2Order {
  return {
    id,
    orderNo: `ORD-${id}`,
    status,
    archivedAt,
    updatedAt: '2026-10-05T01:00:00.000Z',
    operations: {}
  } as V2Order;
}
function state() {
  const scope = effectScope();
  const allowed = ref(true);
  const transition = ref(false);
  const loadOrders = vi.fn(async () => undefined);
  const closeDetail = vi.fn();
  const archive = scope.run(() =>
    useOrderArchive({
      canUpdateOrders: computed(() => allowed.value),
      isOrderActionUnavailable: (permitted) => !permitted || transition.value,
      loadOrders,
      closeDetail
    })
  )!;
  return { archive, allowed, transition, loadOrders, closeDetail, stop: () => scope.stop() };
}
const success = (id: string, archivedAt: string | null = '2026-10-05T02:00:00.000Z') => ({
  id,
  archivedAt,
  updatedAt: '2026-10-05T02:00:00.000Z',
  idempotentReplay: false
});
beforeEach(() => {
  identity.value = 0;
  vi.clearAllMocks();
  clearV2SessionDrafts();
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('ordinary order archive without financial mutation', () => {
  it('only archives terminal unarchived orders and restores archived orders', () => {
    for (const status of ['completed', 'refunded', 'cancelled', 'failed'] as const)
      expect(canArchiveOrder(order('a', status))).toBe(true);
    for (const status of ['draft', 'pending', 'processing', 'waiting_external'] as const)
      expect(canArchiveOrder(order('a', status))).toBe(false);
    const archived = order('a', 'completed', '2026-10-05T02:00:00Z');
    expect(canArchiveOrder(archived)).toBe(false);
    expect(canUnarchiveOrder(archived)).toBe(true);
    expect(canUnarchiveOrder(order())).toBe(false);
    expect(
      canArchiveOrder({ ...order(), operations: { ...order().operations, canArchive: false } })
    ).toBe(false);
  });
  it('freezes explicit selected ids and original versions, rather than selecting a filter', () => {
    const s = state();
    const first = order();
    s.archive.select(first, true);
    first.updatedAt = '2026-10-05T03:00:00Z';
    s.archive.select(order('pending', 'pending'), true);
    s.archive.openSelected();
    expect(s.archive.form.targets).toEqual([
      { id: 'order-a', orderNo: 'ORD-order-a', expectedUpdatedAt: '2026-10-05T01:00:00.000Z' }
    ]);
    s.stop();
  });
  it('retries only failed rows with the same payload and idempotency key, preserving successful rows', async () => {
    const s = state();
    const a = order(),
      b = order('order-b');
    s.archive.select(a, true);
    s.archive.select(b, true);
    s.archive.openSelected();
    s.archive.form.reason = '清理历史订单列表';
    api.archive.mockImplementation(async (id: string) => {
      if (id === b.id) throw new Error('暂时失败');
      return success(id);
    });
    await s.archive.submit();
    expect(s.archive.visible.value).toBe(true);
    expect(s.archive.failures.value).toEqual([{ id: b.id, message: '暂时失败' }]);
    expect(s.archive.selectedCount.value).toBe(1);
    expect(s.archive.form.targets.map((target) => target.id)).toEqual([b.id]);
    expect(s.archive.form.reason).toBe('清理历史订单列表');
    const failedPayload = api.archive.mock.calls[1][1];
    api.archive.mockImplementation(async (id: string) => success(id));
    await s.archive.submit();
    expect(api.archive.mock.calls.map((call) => call[0])).toEqual([a.id, b.id, b.id]);
    expect(api.archive.mock.calls[2][1]).toEqual(failedPayload);
    expect(s.archive.visible.value).toBe(false);
    expect(s.archive.selectedCount.value).toBe(0);
    expect(s.closeDetail).toHaveBeenCalledTimes(2);
    s.stop();
  });
  it('keeps confirmation reason and original versions on close and route remount', async () => {
    const first = state();
    first.archive.openArchive(order());
    first.archive.form.reason = '保留未提交原因';
    first.archive.visible.value = false;
    first.stop();
    await nextTick();
    const second = state();
    const changed = order();
    changed.updatedAt = '2026-10-05T04:00:00Z';
    second.archive.openArchive(changed);
    expect(second.archive.form.reason).toBe('保留未提交原因');
    expect(second.archive.form.targets[0].expectedUpdatedAt).toBe('2026-10-05T01:00:00.000Z');
    second.stop();
  });
  it('requires explicit recheck before adopting a newer failed-order version', async () => {
    const s = state();
    s.archive.openArchive(order());
    s.archive.form.reason = '归档测试订单';
    api.archive.mockRejectedValue(new Error('资料版本已变化'));
    await s.archive.submit();
    expect(s.archive.form.targets[0].expectedUpdatedAt).toBe('2026-10-05T01:00:00.000Z');
    api.get.mockResolvedValue({ ...order(), updatedAt: '2026-10-05T05:00:00Z' });
    await s.archive.recheckFailed();
    expect(s.archive.form.targets[0].expectedUpdatedAt).toBe('2026-10-05T05:00:00Z');
    expect(s.archive.form.reason).toBe('归档测试订单');
    api.archive.mockResolvedValue(success('order-a'));
    await s.archive.submit();
    expect(api.archive.mock.calls[1][1].expectedUpdatedAt).toBe('2026-10-05T05:00:00Z');
    expect(api.archive.mock.calls[1][1].idempotencyKey).not.toBe(
      api.archive.mock.calls[0][1].idempotencyKey
    );
    s.stop();
  });
  it('reads back an unknown successful result without sending a duplicate archive', async () => {
    const s = state();
    s.archive.openArchive(order());
    s.archive.form.reason = '归档测试订单';
    api.archive.mockRejectedValue(new Error('响应丢失'));
    await s.archive.submit();
    api.get.mockResolvedValue(order('order-a', 'completed', '2026-10-05T02:00:00Z'));
    await s.archive.recheckFailed();
    await s.archive.submit();
    expect(api.archive).toHaveBeenCalledTimes(1);
    expect(s.archive.visible.value).toBe(false);
    s.stop();
  });
  it('restores visibility with a precise order version and no financial API calls', async () => {
    const s = state();
    s.archive.openUnarchive(order('order-a', 'completed', '2026-10-05T02:00:00Z'));
    s.archive.form.reason = '恢复查阅当前订单';
    api.unarchive.mockResolvedValue(success('order-a', null));
    await s.archive.submit();
    expect(api.unarchive.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        expectedUpdatedAt: '2026-10-05T01:00:00.000Z',
        reason: '恢复查阅当前订单'
      })
    );
    expect(api.archive).not.toHaveBeenCalled();
    s.stop();
  });
  it('blocks missing permission, parameter transitions and overlapping submissions', async () => {
    const s = state();
    s.allowed.value = false;
    s.archive.openArchive(order());
    expect(s.archive.visible.value).toBe(false);
    s.allowed.value = true;
    s.transition.value = true;
    s.archive.openArchive(order());
    expect(s.archive.visible.value).toBe(false);
    s.transition.value = false;
    s.archive.openArchive(order());
    s.archive.form.reason = '确认归档订单';
    let finish!: (result: ReturnType<typeof success>) => void;
    api.archive.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const first = s.archive.submit();
    await s.archive.submit();
    expect(api.archive).toHaveBeenCalledTimes(1);
    finish(success('order-a'));
    await first;
    s.stop();
  });
  it('a late success cannot clear newer confirmation input', async () => {
    const s = state();
    s.archive.openArchive(order());
    s.archive.form.reason = '本次已提交原因';
    let finish!: (result: ReturnType<typeof success>) => void;
    api.archive.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = s.archive.submit();
    s.archive.form.reason = '后续修改须保留';
    finish(success('order-a'));
    await pending;
    expect(s.archive.form.reason).toBe('后续修改须保留');
    expect(s.archive.visible.value).toBe(true);
    s.stop();
  });
  it('a closed partial batch cannot skip an order restored before a fresh selection', async () => {
    const first = state();
    const a = order(),
      b = order('order-b');
    first.archive.select(a, true);
    first.archive.select(b, true);
    first.archive.openSelected();
    first.archive.form.reason = '归档测试订单';
    api.archive.mockImplementation(async (id: string) => {
      if (id === b.id) throw new Error('暂时失败');
      return success(id);
    });
    await first.archive.submit();
    first.archive.visible.value = false;
    first.stop();
    const next = state();
    const restored = { ...a, updatedAt: '2026-10-05T06:00:00.000Z' };
    next.archive.openUnarchive({ ...a, archivedAt: '2026-10-05T02:00:00Z' });
    next.archive.form.reason = '恢复订单查阅';
    api.unarchive.mockResolvedValue(success(a.id, null));
    await next.archive.submit();
    next.archive.select(restored, true);
    next.archive.openSelected();
    next.archive.form.reason = '重新归档所选订单';
    api.archive.mockImplementation(async (id: string) => success(id));
    await next.archive.submit();
    expect(api.archive.mock.calls.map((call) => call[0])).toEqual([a.id, b.id, b.id, a.id]);
    expect(api.archive.mock.calls.at(-1)?.[1].expectedUpdatedAt).toBe(restored.updatedAt);
    expect(next.archive.selectedCount.value).toBe(0);
    next.stop();
  });
  it('an old successful receipt after restore requires explicit current-version recheck', async () => {
    const s = state();
    s.archive.openArchive(order());
    s.archive.form.reason = '归档测试订单';
    api.archive.mockRejectedValueOnce(new Error('响应丢失'));
    await s.archive.submit();
    api.archive.mockResolvedValueOnce({ ...success('order-a'), idempotentReplay: true });
    const restored = { ...order(), updatedAt: '2026-10-05T06:00:00.000Z' };
    api.get.mockResolvedValue(restored);
    await s.archive.submit();
    expect(s.archive.visible.value).toBe(true);
    expect(s.archive.failures.value[0].message).toContain('后续归档或恢复');
    expect(s.archive.form.targets[0].expectedUpdatedAt).toBe('2026-10-05T01:00:00.000Z');
    const oldKey = api.archive.mock.calls[1][1].idempotencyKey;
    await s.archive.recheckFailed();
    api.archive.mockResolvedValueOnce(success('order-a'));
    await s.archive.submit();
    expect(api.archive.mock.calls[2][1].expectedUpdatedAt).toBe(restored.updatedAt);
    expect(api.archive.mock.calls[2][1].idempotencyKey).not.toBe(oldKey);
    expect(s.archive.visible.value).toBe(false);
    s.stop();
  });
  it('a late partial failure cannot overwrite a newer draft opened after route remount', async () => {
    const first = state();
    first.archive.select(order(), true);
    first.archive.select(order('order-b'), true);
    first.archive.openSelected();
    first.archive.form.reason = '本次批量归档原因';
    let reject!: (error: Error) => void;
    api.archive.mockResolvedValueOnce(success('order-a')).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const pending = first.archive.submit();
    await nextTick();
    await nextTick();
    first.stop();
    const next = state();
    next.archive.openSelected();
    next.archive.form.reason = '后来切页填写的原因';
    const laterTargets = structuredClone(
      next.archive.form.targets.map((target) => ({ ...target }))
    );
    reject(new Error('迟到的失败'));
    await pending;
    expect(next.archive.form.reason).toBe('后来切页填写的原因');
    expect(next.archive.form.targets).toEqual(laterTargets);
    expect(next.archive.visible.value).toBe(true);
    next.stop();
  });
  it('a late partial result does not rekey or narrow subsequent edits to the confirmation', async () => {
    const s = state();
    s.archive.select(order(), true);
    s.archive.select(order('order-b'), true);
    s.archive.openSelected();
    s.archive.form.reason = '原提交原因';
    let reject!: (error: Error) => void;
    api.archive.mockResolvedValueOnce(success('order-a')).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const pending = s.archive.submit();
    await nextTick();
    await nextTick();
    s.archive.form.reason = '后续输入不能覆盖';
    reject(new Error('部分失败'));
    await pending;
    expect(s.archive.form.reason).toBe('后续输入不能覆盖');
    expect(s.archive.form.targets.map((target) => target.id)).toEqual(['order-a', 'order-b']);
    s.archive.visible.value = false;
    s.archive.openArchive(order('order-b'));
    expect(s.archive.form.reason).toBe('');
    s.stop();
  });
  it.each(['logout', 'login-replacement'])(
    'stops a rejected old batch after %s without issuing the next order under the new identity',
    async (change) => {
      const s = state();
      s.archive.select(order(), true);
      s.archive.select(order('order-b'), true);
      s.archive.openSelected();
      s.archive.form.reason = '原身份确认的批次';
      let reject!: (error: Error) => void;
      api.archive.mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          })
      );
      const pending = s.archive.submit();
      identity.value++;
      if (change === 'logout') s.allowed.value = false;
      clearV2SessionDrafts();
      const next = state();
      next.archive.openArchive(order('new-user-order'));
      next.archive.form.reason = '新身份自己的输入';
      reject(new DOMException('旧会话已退出', 'AbortError'));
      await pending;
      expect(api.archive).toHaveBeenCalledTimes(1);
      expect(s.closeDetail).not.toHaveBeenCalled();
      expect(s.loadOrders).not.toHaveBeenCalled();
      expect(ElMessage.success).not.toHaveBeenCalled();
      expect(ElMessage.warning).not.toHaveBeenCalled();
      expect(s.archive.selectedCount.value).toBe(2);
      expect(next.archive.form.reason).toBe('新身份自己的输入');
      next.stop();
      s.stop();
    }
  );
  it('ignores a successful old response after identity changes before continuing a batch', async () => {
    const s = state();
    s.archive.select(order(), true);
    s.archive.select(order('order-b'), true);
    s.archive.openSelected();
    s.archive.form.reason = '原身份操作';
    let finish!: (value: ReturnType<typeof success>) => void;
    api.archive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = s.archive.submit();
    identity.value++;
    finish(success('order-a'));
    await pending;
    expect(api.archive).toHaveBeenCalledTimes(1);
    expect(s.archive.completedIds.value.size).toBe(0);
    expect(s.archive.selectedCount.value).toBe(2);
    expect(s.closeDetail).not.toHaveBeenCalled();
    expect(s.loadOrders).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
    s.stop();
  });
  it('ignores a late failed-order recheck from an old identity without adopting versions or querying the next row', async () => {
    const s = state();
    s.archive.select(order(), true);
    s.archive.select(order('order-b'), true);
    s.archive.openSelected();
    s.archive.form.reason = '确认旧身份批次';
    api.archive.mockRejectedValue(new Error('需要重新核对'));
    await s.archive.submit();
    let finish!: (value: V2Order) => void;
    api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = s.archive.recheckFailed();
    identity.value++;
    clearV2SessionDrafts();
    const next = state();
    next.archive.openArchive(order('new-user-order'));
    next.archive.form.reason = '新身份确认原因';
    finish({ ...order(), updatedAt: '2026-10-05T07:00:00.000Z' });
    await pending;
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(s.archive.form.targets[0].expectedUpdatedAt).toBe('2026-10-05T01:00:00.000Z');
    expect(s.archive.failures.value).toHaveLength(2);
    expect(next.archive.form.reason).toBe('新身份确认原因');
    next.stop();
    s.stop();
  });
  it('does not accept a historical receipt readback after its session identity changes', async () => {
    const s = state();
    s.archive.select(order(), true);
    s.archive.openSelected();
    s.archive.form.reason = '旧身份归档';
    api.archive.mockResolvedValueOnce({ ...success('order-a'), idempotentReplay: true });
    let finish!: (value: V2Order) => void;
    api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = s.archive.submit();
    await nextTick();
    await nextTick();
    identity.value++;
    finish(order('order-a', 'completed', '2026-10-05T02:00:00Z'));
    await pending;
    expect(s.archive.completedIds.value.size).toBe(0);
    expect(s.archive.selectedCount.value).toBe(1);
    expect(s.closeDetail).not.toHaveBeenCalled();
    expect(s.loadOrders).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
    s.stop();
  });
  it('an old confirmation cannot start under a newly logged-in identity after asynchronous validation', async () => {
    const old = state();
    old.archive.openArchive(order());
    old.archive.form.reason = '旧身份的已验证输入';
    identity.value++;
    clearV2SessionDrafts();
    const current = state();
    current.archive.openArchive(order('new-user-order'));
    current.archive.form.reason = '新身份的确认输入';
    await old.archive.submit();
    await old.archive.recheckFailed();
    old.archive.visible.value = false;
    old.archive.openArchive(order('order-b'));
    old.archive.select(order('order-b'), true);
    expect(api.archive).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(old.archive.visible.value).toBe(false);
    expect(old.archive.selectedCount.value).toBe(0);
    expect(old.archive.form.targets[0].id).toBe('order-a');
    expect(current.archive.form.reason).toBe('新身份的确认输入');
    expect(old.loadOrders).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
    current.stop();
    old.stop();
  });
});
