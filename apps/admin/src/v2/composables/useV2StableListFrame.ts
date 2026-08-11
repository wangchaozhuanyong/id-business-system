import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface V2StableListFrameOptions {
  items: () => readonly unknown[];
  pageSize: () => number;
  mobileBreakpoint?: number;
}

export function useV2StableListFrame(options: V2StableListFrameOptions) {
  const listRef = ref<HTMLElement>();
  const stableListBodyHeight = ref(0);
  let mobileMediaQuery: MediaQueryList | undefined;
  let listResizeObserver: ResizeObserver | undefined;

  const listFrameStyle = computed(() =>
    stableListBodyHeight.value
      ? { '--v2-records-list-body-min-height': `${stableListBodyHeight.value}px` }
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
  }

  function resetStableListBodyHeight() {
    stableListBodyHeight.value = 0;
    void rememberListBodyHeight();
  }

  watch(options.items, rememberListBodyHeight, { flush: 'post' });
  watch(options.pageSize, resetStableListBodyHeight);

  onMounted(() => {
    mobileMediaQuery = window.matchMedia(`(max-width: ${options.mobileBreakpoint ?? 900}px)`);
    mobileMediaQuery.addEventListener('change', resetStableListBodyHeight);
    listResizeObserver = new ResizeObserver(() => {
      void rememberListBodyHeight();
    });
    void nextTick().then(() => {
      listRef.value
        ?.querySelectorAll<HTMLElement>('.v2-unified-table-shell, .v2-records-mobile-list')
        .forEach((element) => listResizeObserver?.observe(element));
      void rememberListBodyHeight();
    });
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
