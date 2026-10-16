import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface V2StableListFrameOptions {
  items: () => readonly unknown[];
  pageSize: () => number;
  mobileBreakpoint?: number;
}

export function useV2StableListFrame(options: V2StableListFrameOptions) {
  const listRef = ref<HTMLElement>();
  const stableListBodyHeight = ref(0);
  const stablePaginationHeight = ref(0);
  let mobileMediaQuery: MediaQueryList | undefined;
  let listResizeObserver: ResizeObserver | undefined;

  const listFrameStyle = computed(() =>
    stableListBodyHeight.value
      ? {
          '--v2-records-list-body-min-height': `${stableListBodyHeight.value}px`,
          '--v2-records-pagination-min-height': `${stablePaginationHeight.value}px`
        }
      : undefined
  );

  function getVisibleListBody() {
    const table = listRef.value?.querySelector<HTMLElement>('.v2-unified-table');
    const tableShell = listRef.value?.querySelector<HTMLElement>('.v2-unified-table-shell');
    const mobileList = listRef.value?.querySelector<HTMLElement>('.v2-records-mobile-list');
    return table && window.getComputedStyle(table).display !== 'none' ? tableShell : mobileList;
  }

  async function rememberListBodyHeight() {
    await nextTick();
    const visibleBody = getVisibleListBody();
    if (!visibleBody) return;
    stableListBodyHeight.value = Math.max(
      stableListBodyHeight.value,
      Math.ceil(visibleBody.getBoundingClientRect().height)
    );
    const pagination = listRef.value?.querySelector<HTMLElement>('.v2-records-pagination');
    if (pagination)
      stablePaginationHeight.value = Math.max(
        stablePaginationHeight.value,
        Math.ceil(pagination.getBoundingClientRect().height)
      );
  }

  function resetStableListBodyHeight() {
    stableListBodyHeight.value = 0;
    stablePaginationHeight.value = 0;
    void rememberListBodyHeight();
  }

  watch(options.items, rememberListBodyHeight, { flush: 'post' });
  watch(options.pageSize, resetStableListBodyHeight);

  watch(
    listRef,
    (element) => {
      listResizeObserver?.disconnect();
      element
        ?.querySelectorAll<HTMLElement>(
          '.v2-unified-table-shell, .v2-records-mobile-list, .v2-records-pagination'
        )
        .forEach((body) => listResizeObserver?.observe(body));
      if (element) void rememberListBodyHeight();
    },
    { flush: 'post' }
  );

  onMounted(() => {
    mobileMediaQuery = window.matchMedia(`(max-width: ${options.mobileBreakpoint ?? 900}px)`);
    mobileMediaQuery.addEventListener('change', resetStableListBodyHeight);
    listResizeObserver = new ResizeObserver(() => {
      void rememberListBodyHeight();
    });
    listRef.value
      ?.querySelectorAll<HTMLElement>(
        '.v2-unified-table-shell, .v2-records-mobile-list, .v2-records-pagination'
      )
      .forEach((body) => listResizeObserver?.observe(body));
    void rememberListBodyHeight();
  });

  onBeforeUnmount(() => {
    mobileMediaQuery?.removeEventListener('change', resetStableListBodyHeight);
    listResizeObserver?.disconnect();
  });

  return {
    listRef,
    listFrameStyle
  };
}
