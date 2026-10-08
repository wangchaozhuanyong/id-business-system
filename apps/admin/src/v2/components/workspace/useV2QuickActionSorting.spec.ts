import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2QuickActionItem } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2QuickActionSorting } from './useV2QuickActionSorting';

const mock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: mock }));
vi.mock('@/auth/sessionCoordinator', async () => {
  const { ref } = await import('vue');
  return { sessionCoordinator: { identityEpoch: ref(0) } };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let scope: EffectScope;
let flow: ReturnType<typeof useV2QuickActionSorting>;
let save: ReturnType<typeof deferred>;
let reorder: (ids: string[]) => Promise<void>;
let rows: Ref<V2QuickActionItem[]>;
const identityEpoch = sessionCoordinator.identityEpoch as Ref<number>;
function move() {
  return flow.moveWithKeyboard(
    {
      key: 'ArrowUp',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as KeyboardEvent,
    'second'
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  identityEpoch.value = 0;
  save = deferred();
  reorder = vi.fn(() => save.promise);
  rows = ref(['first', 'second'].map((id) => ({ id }) as V2QuickActionItem));
  scope = effectScope();
  flow = scope.run(() =>
    useV2QuickActionSorting({
      items: () => rows.value,
      enabled: () => !flow?.ordering.value,
      reorder
    })
  )!;
});
afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
});

describe('quick reply sort persistence feedback', () => {
  it('shows save success only after confirmation and prevents a second pending sort', async () => {
    const pending = move();
    expect(flow.customItems.value.map((item) => item.id)).toEqual(['second', 'first']);
    expect(flow.ordering.value).toBe(true);
    expect(mock.success).not.toHaveBeenCalled();
    await move();
    expect(reorder).toHaveBeenCalledOnce();
    rows.value = [...rows.value].reverse();
    save.resolve();
    await pending;
    expect(flow.ordering.value).toBe(false);
    expect(mock.success).toHaveBeenCalledWith('顺序已保存到当前账号');
  });

  it('rolls back an unconfirmed order and displays the failure', async () => {
    const pending = move();
    save.reject(new Error('顺序保存失败'));
    await pending;
    expect(flow.customItems.value.map((item) => item.id)).toEqual(['first', 'second']);
    expect(mock.error).toHaveBeenCalledWith('顺序保存失败');
    expect(mock.success).not.toHaveBeenCalled();
  });

  it('keeps a fresh database order when an ambiguous write fails after the reread', async () => {
    const pending = move();
    rows.value = [...rows.value].reverse();
    await nextTick();
    save.reject(new Error('保存回执失败'));
    await pending;
    expect(flow.customItems.value.map((item) => item.id)).toEqual(['second', 'first']);
    expect(mock.error).toHaveBeenCalledWith('保存回执失败');
    expect(mock.success).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'drops late %s feedback when identity changes',
    async (outcome) => {
      const pending = move();
      identityEpoch.value += 1;
      rows.value = [{ id: 'other-user' } as V2QuickActionItem];
      await nextTick();
      if (outcome === 'success') save.resolve();
      else save.reject(new Error('旧账号错误'));
      await pending;
      expect(flow.customItems.value.map((item) => item.id)).toEqual(['other-user']);
      expect(flow.ordering.value).toBe(false);
      expect(mock.success).not.toHaveBeenCalled();
      expect(mock.error).not.toHaveBeenCalled();
    }
  );

  it('does not report save success after its owner unmounts', async () => {
    const pending = move();
    scope.stop();
    save.resolve();
    await pending;
    expect(mock.success).not.toHaveBeenCalled();
  });
});
