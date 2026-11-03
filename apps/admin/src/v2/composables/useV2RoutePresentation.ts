import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';
import {
  isV2RoutePerformanceCurrent,
  markV2RoutePaintReady,
  subscribeV2RoutePresentation,
  type V2RoutePresentation
} from '@/runtime/performance';
import { v2RouteNavigationState } from '@/v2/router/routes';
import { observeV2LongTasks } from '@/v2/runtime/interactionDiagnostics';

// Presentation follows the one primary query. It never delays DOM, navigation or writes.
export function useV2RoutePresentation(content: Ref<HTMLElement | null>) {
  let disposed = false;
  let revision = 0;
  let frames: number[] = [];
  let animations: Animation[] = [];
  let stopLongTasks = () => {};
  function cancel() {
    revision += 1;
    frames.forEach(cancelAnimationFrame);
    frames = [];
    animations.forEach((animation) => animation.cancel());
    animations = [];
  }
  const stop = subscribeV2RoutePresentation(async (event: V2RoutePresentation) => {
    cancel();
    const generation = revision;
    await nextTick();
    const current = () =>
      !disposed &&
      revision === generation &&
      document.visibilityState === 'visible' &&
      isV2RoutePerformanceCurrent(event.navigationId, event.moduleKey);
    if (!current()) return;
    const page = content.value?.querySelector<HTMLElement>('.v2-content__inner > .v2-page-layout');
    if (!page) return;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const cached = event.source === 'memory-cache';
      // Keep table/card bodies opaque: compositing a full records page adds work on every frame.
      const groups = [...page.children]
        .filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement &&
            !element.hidden &&
            element.style.display !== 'none' &&
            !element.querySelector?.('.v2-unified-table, .v2-records-mobile-list')
        )
        .slice(0, cached ? 2 : 3);
      groups.forEach((element, index) => {
        if (typeof element.animate !== 'function') return;
        const animation = element.animate(
          cached
            ? [{ opacity: 0.8 }, { opacity: 1 }]
            : [
                { opacity: 0.7, transform: 'translateY(4px)' },
                { opacity: 1, transform: 'none' }
              ],
          {
            duration: cached ? 120 : 180,
            delay: cached ? 0 : index * 20,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
          }
        );
        animations.push(animation);
      });
    }
    // Two animation frames approximate a committed content frame, not GPU completion.
    frames.push(
      requestAnimationFrame(() => {
        if (!current()) return;
        frames.push(
          requestAnimationFrame(() => {
            frames = [];
            if (current()) markV2RoutePaintReady(event);
          })
        );
      })
    );
  });
  const stopNavigation = watch(
    () => v2RouteNavigationState.state,
    (state) => {
      if (state === 'pending' || state === 'error') cancel();
    },
    { flush: 'sync' }
  );
  const hide = () => {
    if (document.visibilityState === 'hidden') cancel();
  };
  onMounted(() => {
    stopLongTasks = observeV2LongTasks();
    document.addEventListener('visibilitychange', hide);
  });
  onBeforeUnmount(() => {
    disposed = true;
    cancel();
    stop();
    stopNavigation();
    stopLongTasks();
    document.removeEventListener('visibilitychange', hide);
  });
}
