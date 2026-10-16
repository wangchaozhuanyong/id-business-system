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

function mountListFrame(options: Parameters<typeof useV2StableListFrame>[0]) {
  let frame!: ReturnType<typeof useV2StableListFrame>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        frame = useV2StableListFrame(options);
        return () => null;
      }
    })
  );
  app.mount({});
  return { app, frame };
}

afterEach(() => vi.unstubAllGlobals());

describe('stable list frame after asynchronous content mounts', () => {
  it.each([true, false])(
    'retains body and pagination heights with a late list (pagination=%s)',
    async (hasPagination) => {
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
      const { app, frame } = mountListFrame({
        items: () => items.value,
        pageSize: () => pageSize.value
      });
      await nextTick();
      await nextTick();
      expect(observe).not.toHaveBeenCalled();

      let bodyHeight = 500;
      let paginationHeight = 48;
      const body = { getBoundingClientRect: () => ({ height: bodyHeight }) };
      const pagination = { getBoundingClientRect: () => ({ height: paginationHeight }) };
      const elements: Record<string, object | null> = {
        '.v2-unified-table': {},
        '.v2-unified-table-shell': body,
        '.v2-records-pagination': hasPagination ? pagination : null
      };
      frame.listRef.value = {
        querySelector: (selector: string) => elements[selector] ?? null,
        querySelectorAll: () => (hasPagination ? [body, pagination] : [body])
      } as unknown as HTMLElement;
      await nextTick();
      await nextTick();
      expect(observe).toHaveBeenCalledWith(body);
      if (hasPagination) expect(observe).toHaveBeenCalledWith(pagination);
      expect(frame.listFrameStyle.value).toEqual({
        '--v2-records-list-body-min-height': '500px',
        '--v2-records-pagination-min-height': hasPagination ? '48px' : '0px'
      });

      bodyHeight = 80;
      paginationHeight = 30;
      items.value = [{}];
      await nextTick();
      await nextTick();
      expect(frame.listFrameStyle.value).toEqual({
        '--v2-records-list-body-min-height': '500px',
        '--v2-records-pagination-min-height': hasPagination ? '48px' : '0px'
      });
      items.value = [];
      await nextTick();
      await nextTick();
      expect(frame.listFrameStyle.value).toEqual({
        '--v2-records-list-body-min-height': '500px',
        '--v2-records-pagination-min-height': hasPagination ? '48px' : '0px'
      });

      pageSize.value = 10;
      await nextTick();
      await nextTick();
      expect(frame.listFrameStyle.value).toEqual({
        '--v2-records-list-body-min-height': '80px',
        '--v2-records-pagination-min-height': hasPagination ? '30px' : '0px'
      });
      app.unmount();
      expect(disconnect).toHaveBeenCalled();
    }
  );

  it('remeasures the visible body and pagination when switching between desktop and mobile', async () => {
    let mobile = false;
    let onBreakpointChange!: () => void;
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    vi.stubGlobal('window', {
      getComputedStyle: () => ({ display: mobile ? 'none' : 'table' }),
      matchMedia: () => ({
        addEventListener: (_event: string, callback: () => void) => {
          onBreakpointChange = callback;
        },
        removeEventListener
      })
    });
    const body = { getBoundingClientRect: () => ({ height: 500 }) };
    const cards = { getBoundingClientRect: () => ({ height: 700 }) };
    const pagination = { getBoundingClientRect: () => ({ height: mobile ? 96 : 48 }) };
    const { app, frame } = mountListFrame({ items: () => [], pageSize: () => 20 });
    const elements: Record<string, object> = {
      '.v2-unified-table': {},
      '.v2-unified-table-shell': body,
      '.v2-records-mobile-list': cards,
      '.v2-records-pagination': pagination
    };
    frame.listRef.value = {
      querySelector: (selector: string) => elements[selector] ?? null,
      querySelectorAll: () => [body, cards, pagination]
    } as unknown as HTMLElement;
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({
      '--v2-records-list-body-min-height': '500px',
      '--v2-records-pagination-min-height': '48px'
    });
    mobile = true;
    onBreakpointChange();
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({
      '--v2-records-list-body-min-height': '700px',
      '--v2-records-pagination-min-height': '96px'
    });
    mobile = false;
    onBreakpointChange();
    await nextTick();
    await nextTick();
    expect(frame.listFrameStyle.value).toEqual({
      '--v2-records-list-body-min-height': '500px',
      '--v2-records-pagination-min-height': '48px'
    });
    app.unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', onBreakpointChange);
  });
});
