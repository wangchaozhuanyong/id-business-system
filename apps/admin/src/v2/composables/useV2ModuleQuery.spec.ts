import { createRenderer, h, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { clearV2QueryCache, useV2ModuleQuery } from './useV2Query';

type TestNode = { children: TestNode[]; parent: TestNode | null };
const node = (): TestNode => ({ children: [], parent: null });
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: () => undefined,
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
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (child) => child.parent,
  nextSibling: () => null
});
afterEach(clearV2QueryCache);

it('reloads mounted module filters and pagination without clearing successful content', async () => {
  const key = ref('all:1');
  const enabled = ref(true);
  let rejectNext!: (error: Error) => void;
  const pending = new Promise<string>((_, reject) => {
    rejectNext = reject;
  });
  const read = vi.fn(async () => (key.value === 'filtered:2' ? pending : key.value));
  let result!: ReturnType<typeof useV2ModuleQuery<string>>;
  const app = renderer.createApp({
    setup() {
      result = useV2ModuleQuery({
        moduleKey: 'auto-recharge-addresses',
        scope: 'auto-recharge',
        trackRouteData: false,
        key: () => key.value,
        enabled: () => enabled.value,
        query: read
      });
      return () => h('div');
    }
  });
  app.mount(node());
  try {
    await vi.waitFor(() => expect(result.data.value).toBe('all:1'));
    key.value = 'filtered:2';
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(result.data.value).toBe('all:1');
    expect(result.phase.value).toBe('transitioning');
    rejectNext(new Error('read failed'));
    await vi.waitFor(() => expect(result.phase.value).toBe('refresh-error'));
    expect(result.data.value).toBe('all:1');
    key.value = 'filtered:3';
    await vi.waitFor(() => expect(result.data.value).toBe('filtered:3'));
    enabled.value = false;
    key.value = 'disabled:4';
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    app.unmount();
  }
});
