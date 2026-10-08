import {
  effectScope,
  nextTick,
  ref,
  shallowRef,
  type EffectScope,
  type Ref,
  type ShallowRef
} from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2QuickActionItem, V2QuickActionList } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2QuickActions } from './useV2QuickActions';
import { quickActionOrderKey } from './quickActionOrder';

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  reorder: vi.fn(),
  prime: vi.fn(),
  refresh: vi.fn(),
  options: undefined as unknown,
  query: undefined as unknown
}));
vi.mock('@/auth/sessionCoordinator', async () => {
  const { ref } = await import('vue');
  return { sessionCoordinator: { identityEpoch: ref(0) } };
});
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/api/workspace', () => ({
  idBusinessV2WorkspaceApi: { listQuickActions: mock.list, reorderQuickActions: mock.reorder }
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: (options: unknown) => {
    mock.options = options;
    return mock.query;
  },
  primeV2Query: mock.prime
}));

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
function list(ids = [a, b], hasCustomOrder: boolean | undefined = false): V2QuickActionList {
  return {
    items: ids.map((id) => ({ id }) as V2QuickActionItem),
    hasCustomOrder
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let scope: EffectScope;
let flow: ReturnType<typeof useV2QuickActions>;
let userId: Ref<string>;
let writesAllowed: Ref<boolean>;
let open: Ref<boolean>;
let data: ShallowRef<V2QuickActionList>;
const identityEpoch = sessionCoordinator.identityEpoch as Ref<number>;
let values: Map<string, string>;
let removeItem: ReturnType<typeof vi.fn>;
let setItem: ReturnType<typeof vi.fn>;

async function read(signal = new AbortController().signal) {
  const options = mock.options as {
    query: (context: { signal: AbortSignal }) => Promise<V2QuickActionList>;
  };
  return options.query({ signal });
}

beforeEach(() => {
  vi.clearAllMocks();
  identityEpoch.value = 0;
  values = new Map();
  removeItem = vi.fn((key: string) => values.delete(key));
  setItem = vi.fn();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem,
    setItem
  });
  userId = ref('user-a');
  writesAllowed = ref(true);
  open = ref(true);
  data = shallowRef(list());
  mock.query = {
    data,
    phase: ref('ready'),
    hasCurrentData: ref(true),
    refresh: mock.refresh
  };
  mock.list.mockResolvedValue(list());
  mock.reorder.mockResolvedValue(list([b, a], true));
  mock.refresh.mockResolvedValue(list());
  scope = effectScope();
  flow = scope.run(() =>
    useV2QuickActions({
      userId: () => userId.value,
      writesAllowed: () => writesAllowed.value,
      open
    })
  )!;
});
afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
});

describe('database quick reply order', () => {
  it('saves the complete order and original snapshot without writing browser storage', async () => {
    await flow.reorder([b, a]);
    expect(mock.reorder).toHaveBeenCalledWith({
      quickActionIds: [b, a],
      expectedQuickActionIds: [a, b]
    });
    expect(mock.prime).toHaveBeenCalledWith({
      scope: 'workspace',
      key: 'quick-actions:user-a',
      data: list([b, a], true)
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(flow.savingOrder.value).toBe(false);
  });

  it('a new client with no local order displays the database order', async () => {
    mock.list.mockResolvedValue(list([b, a], true));
    data.value = await read();
    expect(flow.items.value.map((item) => item.id)).toEqual([b, a]);
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it('migrates only surviving legacy IDs, appends new records and clears legacy data after confirmation', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, 'deleted', a]));
    mock.list.mockResolvedValue(list([a, b, c]));
    mock.reorder.mockResolvedValue(list([b, a, c], true));
    expect(await read()).toEqual(list([b, a, c], true));
    expect(mock.reorder).toHaveBeenCalledWith({
      quickActionIds: [b, a, c],
      expectedQuickActionIds: [a, b, c],
      initializeOnly: true
    });
    expect(values.has(quickActionOrderKey('user-a'))).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('database order takes precedence over a different legacy order', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([a, b]));
    mock.list.mockResolvedValue(list([b, a], true));
    expect(await read()).toEqual(list([b, a], true));
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it('keeps the database result when another client initialized first', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    mock.reorder.mockResolvedValue(list([a, b], true));
    expect(await read()).toEqual(list([a, b], true));
  });

  it('retains a failed migration for explicit retry without replaying on background reads', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    mock.reorder.mockRejectedValueOnce(new Error('保存失败'));
    expect(await read()).toEqual(list());
    expect(flow.migrationError.value).toContain('保存失败');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(true);
    await read();
    expect(mock.reorder).toHaveBeenCalledTimes(1);
    await flow.refresh();
    await read();
    expect(mock.reorder).toHaveBeenCalledTimes(2);
    expect(flow.migrationError.value).toBe('');
  });

  it('shows an explicit retry after closing during a failed legacy migration without replaying it on reopen', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await nextTick();
    expect(mock.reorder).toHaveBeenCalledOnce();
    open.value = false;
    controller.abort();
    saved.reject(new Error('保存失败'));
    await cancelled;
    expect(flow.migrationError.value).toContain('重试同步');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(true);

    open.value = true;
    data.value = await read();
    expect(flow.items.value.map((item) => item.id)).toEqual([a, b]);
    expect(flow.migrationError.value).toContain('重试同步');
    expect(mock.reorder).toHaveBeenCalledOnce();
    await read();
    expect(mock.reorder).toHaveBeenCalledOnce();

    await flow.refresh();
    data.value = await read();
    expect(mock.reorder).toHaveBeenCalledTimes(2);
    expect(flow.items.value.map((item) => item.id)).toEqual([b, a]);
    expect(flow.migrationError.value).toBe('');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(false);
  });

  it('confirms a cancelled but committed migration by reading the database without another write', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await nextTick();
    open.value = false;
    controller.abort();
    saved.resolve(list([b, a], true));
    await cancelled;
    expect(values.has(quickActionOrderKey('user-a'))).toBe(true);
    expect(flow.migrationError.value).toContain('重试同步');

    open.value = true;
    mock.list.mockResolvedValue(list([b, a], true));
    data.value = await read();
    expect(flow.items.value.map((item) => item.id)).toEqual([b, a]);
    expect(flow.migrationError.value).toBe('');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(false);
    expect(mock.reorder).toHaveBeenCalledOnce();
  });

  it('does not restore an old cancellation error after another read confirms the database order', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await nextTick();
    controller.abort();
    mock.list.mockResolvedValue(list([b, a], true));
    data.value = await read();
    saved.reject(new Error('响应失败，但另一台电脑已同步'));
    await cancelled;
    expect(flow.migrationError.value).toBe('');
    expect(flow.items.value.map((item) => item.id)).toEqual([b, a]);
    expect(mock.reorder).toHaveBeenCalledOnce();
  });

  it('does not show a cancelled migration failure for a later login identity', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await nextTick();
    controller.abort();
    userId.value = 'user-b';
    identityEpoch.value += 1;
    await nextTick();
    saved.reject(new Error('上一身份保存失败'));
    await cancelled;
    expect(flow.migrationError.value).toBe('');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(true);
    expect(removeItem).not.toHaveBeenCalled();

    values.set(quickActionOrderKey('user-b'), JSON.stringify([b, a]));
    expect(await read()).toEqual(list([b, a], true));
    expect(mock.reorder).toHaveBeenCalledTimes(2);
  });

  it('does not show a late legacy migration failure after its owner unmounts', async () => {
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await nextTick();
    controller.abort();
    scope.stop();
    saved.reject(new Error('保存失败'));
    await cancelled;
    expect(flow.migrationError.value).toBe('');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(true);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('blocks writes and migration while read-only', async () => {
    writesAllowed.value = false;
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    expect(await read()).toEqual(list());
    expect(flow.migrationError.value).toContain('尚未同步');
    await expect(flow.reorder([b, a])).rejects.toThrow('只读');
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it('does not migrate or claim success against an older API', async () => {
    data.value = list();
    delete data.value.hasCustomOrder;
    values.set(quickActionOrderKey('user-a'), JSON.stringify([b, a]));
    mock.list.mockResolvedValue(data.value);
    await read();
    await expect(flow.reorder([b, a])).rejects.toThrow('尚未支持');
    expect(mock.reorder).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('re-reads after a failed order save and requires a new user action', async () => {
    mock.reorder.mockRejectedValueOnce(new Error('顺序已变化'));
    await expect(flow.reorder([b, a])).rejects.toThrow('顺序已变化');
    expect(mock.refresh).toHaveBeenCalledOnce();
    expect(mock.reorder).toHaveBeenCalledOnce();
    expect(mock.prime).not.toHaveBeenCalled();
  });

  it('blocks duplicate saves while the first request is pending', async () => {
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const first = flow.reorder([b, a]);
    await expect(flow.reorder([b, a])).rejects.toThrow('正在保存');
    saved.resolve(list([b, a], true));
    await first;
    expect(mock.reorder).toHaveBeenCalledOnce();
  });

  it('does not prime, clear storage or refresh for another identity after a late save', async () => {
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const pending = flow.reorder([b, a]);
    userId.value = 'user-b';
    identityEpoch.value += 1;
    await nextTick();
    expect(open.value).toBe(false);
    saved.resolve(list([b, a], true));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.prime).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled();
  });

  it('does not migrate after a cancelled read or an unmounted owner', async () => {
    const loaded = deferred<V2QuickActionList>();
    mock.list.mockReturnValueOnce(loaded.promise);
    const controller = new AbortController();
    const pending = read(controller.signal);
    controller.abort();
    loaded.resolve(list());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const saved = deferred<V2QuickActionList>();
    mock.reorder.mockReturnValueOnce(saved.promise);
    const writing = flow.reorder([b, a]);
    scope.stop();
    saved.resolve(list([b, a], true));
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.prime).not.toHaveBeenCalled();
  });
});
