import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface V2StableListFrameOptions {
  items: () => readonly unknown[];
  pageSize: () => number;
  mobileBreakpoint?: number;
}

export function useV2StableListFrame(options: V2StableListFrameOptions) {
  const mediaCondition = `(max-width: ${options.mobileBreakpoint ?? 900}px)`;
  const isMobile = ref(
    typeof window !== 'undefined' && window.matchMedia(mediaCondition).matches === true
  );
  const listRef = ref<HTMLElement>();
  const stableListBodyHeight = ref(0);
  const stablePaginationHeight = ref(0);
  let measuring = false;
  let disposed = false;
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
    if (measuring || disposed) return;
    measuring = true;
    await nextTick();
    measuring = false;
    if (disposed) return;
    const visibleBody = getVisibleListBody();
    if (!visibleBody) return;
    const bodyHeight = Math.ceil(visibleBody.getBoundingClientRect().height);
    const pagination = listRef.value?.querySelector<HTMLElement>('.v2-records-pagination');
    const paginationHeight = pagination ? Math.ceil(pagination.getBoundingClientRect().height) : 0;
    stableListBodyHeight.value = Math.max(stableListBodyHeight.value, bodyHeight);
    stablePaginationHeight.value = Math.max(stablePaginationHeight.value, paginationHeight);
  }

  function resetStableListBodyHeight() {
    stableListBodyHeight.value = 0;
    stablePaginationHeight.value = 0;
    void rememberListBodyHeight();
  }

  watch(options.items, rememberListBodyHeight, { flush: 'post' });
  watch(options.pageSize, resetStableListBodyHeight);

  function observeListBodies() {
    listResizeObserver?.disconnect();
    listRef.value
      ?.querySelectorAll<HTMLElement>(
        '.v2-unified-table-shell, .v2-records-mobile-list, .v2-records-pagination'
      )
      .forEach((body) => listResizeObserver?.observe(body));
    void rememberListBodyHeight();
  }
  function handleBreakpointChange(event?: MediaQueryListEvent) {
    isMobile.value = event?.matches ?? window.matchMedia(mediaCondition).matches === true;
    resetStableListBodyHeight();
  }
  watch(listRef, observeListBodies, { flush: 'post' });
  watch(isMobile, observeListBodies, { flush: 'post' });

  onMounted(() => {
    mobileMediaQuery = window.matchMedia(mediaCondition);
    mobileMediaQuery.addEventListener('change', handleBreakpointChange);
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
    disposed = true;
    mobileMediaQuery?.removeEventListener('change', handleBreakpointChange);
    listResizeObserver?.disconnect();
  });

  return {
    listRef,
    listFrameStyle,
    isMobile
  };
}
