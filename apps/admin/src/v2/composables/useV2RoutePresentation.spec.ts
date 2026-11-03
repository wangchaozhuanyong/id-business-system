import { createRenderer, nextTick, reactive, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { V2RoutePresentation } from '@/runtime/performance';
import { useV2RoutePresentation } from './useV2RoutePresentation';

const mocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((event: V2RoutePresentation) => Promise<void>),
  current: true,
  painted: vi.fn(),
  stop: vi.fn()
}));
vi.mock('@/runtime/performance', () => ({
  subscribeV2RoutePresentation: (listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return mocks.stop;
  },
  isV2RoutePerformanceCurrent: () => mocks.current,
  markV2RoutePaintReady: mocks.painted
}));
vi.mock('@/v2/router/routes', () => ({ v2RouteNavigationState: reactive({ state: 'ready' }) }));
import { v2RouteNavigationState } from '@/v2/router/routes';
const renderer = createRenderer<object, object>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null
});
let app: ReturnType<typeof renderer.createApp>;
let reduced = false;
let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
class Group {
  hidden = false;
  children: Group[] = [];
  querySelector: () => HTMLElement | null = () => null;
  cancel = vi.fn();
  animate = vi.fn(() => ({ cancel: this.cancel }));
}
let page: Group;
const event = { navigationId: 1, moduleKey: 'orders', source: 'network' as const };
function frame() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((fn) => fn(0));
}
beforeEach(() => {
  reduced = false;
  mocks.current = true;
  vi.clearAllMocks();
  (v2RouteNavigationState as { state: string }).state = 'ready';
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++sequence, fn);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'grid' }));
  vi.stubGlobal('HTMLElement', Group);
  page = new Group();
  page.children = [new Group(), new Group(), new Group(), new Group()];
  app = renderer.createApp({
    setup() {
      useV2RoutePresentation(ref({ querySelector: () => page } as unknown as HTMLElement));
      return () => null;
    }
  });
  app.mount({});
});
afterEach(() => {
  app.unmount();
  vi.unstubAllGlobals();
});

it('presents at most three groups without delaying content and measures after two frames', async () => {
  await mocks.listener!(event);
  expect(page.children.map((group) => group.animate.mock.calls.length)).toEqual([1, 1, 1, 0]);
  expect(mocks.painted).not.toHaveBeenCalled();
  frame();
  expect(mocks.painted).not.toHaveBeenCalled();
  frame();
  expect(mocks.painted).toHaveBeenCalledWith(event);
});
it('uses only opacity on cache return and respects reduced motion', async () => {
  await mocks.listener!({ ...event, source: 'memory-cache' });
  expect(page.children[0].animate).toHaveBeenCalledWith(
    [{ opacity: 0.8 }, { opacity: 1 }],
    expect.objectContaining({ duration: 120 })
  );
  vi.clearAllMocks();
  reduced = true;
  await mocks.listener!(event);
  expect(page.children[0].animate).not.toHaveBeenCalled();
  frame();
  frame();
  expect(mocks.painted).toHaveBeenCalledTimes(1);
});
it('cancels old animations and paint callbacks on navigation and unmount', async () => {
  await mocks.listener!(event);
  (v2RouteNavigationState as { state: string }).state = 'pending';
  expect(frames.size).toBe(0);
  expect(page.children[0].cancel).toHaveBeenCalled();
  frame();
  expect(mocks.painted).not.toHaveBeenCalled();
  await mocks.listener!(event);
  app.unmount();
  frame();
  frame();
  expect(mocks.painted).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalled();
});
it('rejects stale navigation events before starting any animation', async () => {
  const pending = mocks.listener!(event);
  mocks.current = false;
  await pending;
  await nextTick();
  expect(frames.size).toBe(0);
  expect(page.children[0].animate).not.toHaveBeenCalled();
});

it('keeps table and mobile-card bodies out of route compositing', async () => {
  page.children[2].querySelector = () => ({}) as HTMLElement;
  await mocks.listener!(event);
  expect(page.children[2].animate).not.toHaveBeenCalled();
  expect(page.animate).not.toHaveBeenCalled();
});
