import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, type Component, type VNode } from 'vue';
const api = vi.hoisted(() => ({ humanVerification: vi.fn() }));
const identity = vi.hoisted(() => ({ epoch: { value: 0 }, listeners: new Set<() => void>() }));
const cache = vi.hoisted(() => ({ results: [] as unknown[] }));
vi.mock('./api', () => ({ onlineApi: api }));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: {
    identityEpoch: identity.epoch,
    subscribeIdentityChange(callback: () => void) {
      identity.listeners.add(callback);
      return () => identity.listeners.delete(callback);
    }
  }
}));
vi.mock('@/v2/composables/useV2Query', async () => {
  const { ref } = await import('vue');
  return {
    useV2ModuleQuery: (options: {
      query: (input: { signal: AbortSignal }) => Promise<unknown>;
    }) => {
      const error = ref<unknown>(),
        isRefreshing = ref(false);
      return {
        phase: ref('ready'),
        hasData: ref(true),
        error,
        isRefreshing,
        isInitialLoading: ref(false),
        cancel: vi.fn(),
        refresh: async () => {
          isRefreshing.value = true;
          try {
            cache.results.push(await options.query({ signal: new AbortController().signal }));
            error.value = undefined;
          } catch (e) {
            error.value = e;
          } finally {
            isRefreshing.value = false;
          }
        }
      };
    }
  };
});
import OnlineHumanVerification from './OnlineHumanVerification.vue';
type Node = { children: Node[]; parent: Node | null };
const node = (): Node => ({ children: [], parent: null });
const renderer = createRenderer<Node, Node>({
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent)
      child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  parentNode: (child) => child.parent,
  nextSibling: () => null
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.clearAllMocks();
  cache.results.length = 0;
});
function fixture() {
  vi.useFakeTimers();
  let vnode!: VNode;
  const app = renderer.createApp({
    setup: () => () =>
      (vnode = h({ ...OnlineHumanVerification, render: () => null } as Component, {
        taskId: 'synthetic-task'
      }))
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  const unmount = () => app.unmount();
  cleanups.push(unmount);
  const state = () =>
    (vnode.component as unknown as { setupState: unknown }).setupState as {
      verificationView: { available: boolean; owned?: boolean; screen?: object };
      busy: boolean;
      blocked: boolean;
      refresh: () => Promise<void>;
      act: (action: string) => Promise<void>;
      clickScreen: (event: MouseEvent) => void;
    };
  return { state, unmount };
}
const screen = { frameId: 'synthetic-frame', image: 'synthetic-pixels', width: 300, height: 100 };
const view = () => ({
  available: true,
  owned: true,
  generation: 'synthetic-generation',
  deadline: Date.now() + 30000,
  screen
});
describe('本人验证临时界面', () => {
  it('只在当前组件保存画面，不进入共享查询缓存，关闭时撤销接管', async () => {
    api.humanVerification.mockResolvedValue(view());
    const f = fixture();
    await f.state().refresh();
    expect(f.state().verificationView.screen).toEqual(screen);
    expect(cache.results).toEqual([{ available: true }]);
    f.unmount();
    cleanups.length = 0;
    expect(api.humanVerification).toHaveBeenLastCalledWith('synthetic-task', {
      action: 'cancel',
      generation: 'synthetic-generation'
    });
  });
  it('接管未完成、指令待确认、读取失败和到期时暂停点击', async () => {
    const f = fixture();
    api.humanVerification.mockResolvedValue({ ...view(), owned: false });
    await f.state().refresh();
    expect(f.state().blocked).toBe(true);
    api.humanVerification.mockResolvedValue({ ...view(), pending: true });
    await f.state().refresh();
    expect(f.state().blocked).toBe(true);
    api.humanVerification.mockResolvedValue(view());
    await f.state().refresh();
    expect(f.state().blocked).toBe(false);
    api.humanVerification.mockRejectedValue(new Error('synthetic-offline'));
    await f.state().refresh();
    expect(f.state().blocked).toBe(true);
    api.humanVerification.mockResolvedValue(view());
    await f.state().refresh();
    await vi.advanceTimersByTimeAsync(31000);
    expect(f.state().blocked).toBe(true);
  });
  it('按图片实际尺寸换算坐标，并携带原画面版本；重复点击在请求中被阻止', async () => {
    api.humanVerification.mockResolvedValue(view());
    const f = fixture();
    await f.state().refresh();
    let release!: (value: unknown) => void;
    api.humanVerification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const event = {
      detail: 1,
      clientX: 40,
      clientY: 35,
      currentTarget: {
        querySelector: () => ({
          getBoundingClientRect: () => ({ left: 10, top: 10, width: 150, height: 50 })
        })
      }
    } as unknown as MouseEvent;
    f.state().clickScreen(event);
    f.state().clickScreen(event);
    expect(api.humanVerification).toHaveBeenCalledTimes(2);
    expect(api.humanVerification.mock.calls[1][1]).toMatchObject({
      action: 'click',
      generation: 'synthetic-generation',
      frameId: screen.frameId,
      x: 60,
      y: 50
    });
    release({ ...view(), pending: true });
    await nextTick();
  });
  it('身份改变清空临时画面，迟到响应不能恢复接管', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    api.humanVerification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = f.state().refresh();
    identity.epoch.value++;
    identity.listeners.forEach((fn) => fn());
    release(view());
    await pending;
    expect(f.state().verificationView).toEqual({ available: false });
  });
});
