import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, nextTick, ref } from 'vue';
import { useV2StableListFrame } from './useV2StableListFrame';

const renderer = createRenderer<object, object>({
  patchProp: () => {},
  insert: () => {},
  remove: () => {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null
});

afterEach(() => vi.unstubAllGlobals());

describe('stable list frame after asynchronous content mounts', () => {
  it('observes a late list body and retains its height on the last and empty pages', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
      }
    );
    vi.stubGlobal('window', {
      getComputedStyle: () => ({ display: 'table' }),
      matchMedia: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })
    });
    const items = ref<unknown[]>([]);
    const pageSize = ref(20);
    let frame!: ReturnType<typeof useV2StableListFrame>;
    const app = renderer.createApp(
      defineComponent({
        setup() {
          frame = useV2StableListFrame({
            items: () => items.value,
            pageSize: () => pageSize.value
          });
          return () => null;
        }
      })
    );
    app.mount({});
    await nextTick();
    await nextTick();
    expect(observe).not.toHaveBeenCalled();

    let bodyHeight = 500;
    const body = { getBoundingClientRect: () => ({ height: bodyHeight }) };
    frame.listRef.value = {
      querySelector: (selector: string) => (selector === '.v2-unified-table' ? {} : body),
      querySelectorAll: () => [body]
    } as unknown as HTMLElement;
    await nextTick();
    await nextTick();
    expect(observe).toHaveBeenCalledWith(body);
    expect(frame.listFrameStyle.value).toEqual({ '--v2-records-list-body-min-height': '500px' });

    bodyHeight = 80;
    items.value = [{}];
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({ '--v2-records-list-body-min-height': '500px' });
    items.value = [];
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({ '--v2-records-list-body-min-height': '500px' });

    pageSize.value = 10;
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({ '--v2-records-list-body-min-height': '80px' });
    app.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
