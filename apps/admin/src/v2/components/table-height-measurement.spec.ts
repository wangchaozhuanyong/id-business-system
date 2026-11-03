import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { expect, it, vi } from 'vitest';
import V2Table from './V2Table.vue';

const state = vi.hoisted(() => ({ renders: 0 }));
vi.mock('element-plus/es/components/table/index.mjs', () => ({
  ElTable: {
    render() {
      state.renders++;
      return null;
    }
  }
}));
vi.mock('element-plus/es/components/table/style/css', () => ({}));
vi.mock('./V2TableColumnSettings.vue', () => ({ default: { render: () => null } }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('@/v2/composables/useV2TablePreferences', () => ({
  clearV2TablePreferences() {},
  ensureV2TablePreferences: async () => {},
  isV2TableColumnVisible: () => true,
  v2TablePreferences: { value: {} }
}));
vi.mock('@/v2/composables/useV2TableContentWidths', async () => {
  const { ref } = await import('vue');
  return { useV2TableContentWidths: () => ({ tableWidth: ref(0) }) };
});

it('updates measured shell heights without rendering table cells again', async () => {
  const values = new Map<string, string>();
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({
      querySelector: () => ({}),
      style: {
        getPropertyValue: (key: string) => values.get(key),
        setProperty: (key: string, value: string) => values.set(key, value)
      }
    }),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  });
  const app = renderer.createApp(V2Table, {
    schema: { id: 'synthetic', columns: [], mobileMode: 'cards' }
  });
  app.config.warnHandler = () => {};
  app.provide(ssrContextKey, { modules: new Set() });
  try {
    app.mount({});
    await nextTick();
    const before = state.renders;
    expect(before).toBeGreaterThan(0);
    expect(callbacks).toHaveLength(2);
    const resize = (index: number, height: number) =>
      callbacks[index](
        [
          { borderBoxSize: [{ blockSize: height }], contentRect: { height } } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
    resize(0, 36);
    resize(1, 42);
    await nextTick();
    expect(state.renders).toBe(before);
    expect(values.get('--v2-table-toolbar-height')).toBe('36px');
    expect(values.get('--v2-table-header-height')).toBe('42px');
    resize(1, 84);
    await nextTick();
    expect(values.get('--v2-table-header-height')).toBe('84px');
    expect(state.renders).toBe(before);
  } finally {
    app.unmount();
    vi.unstubAllGlobals();
  }
});
