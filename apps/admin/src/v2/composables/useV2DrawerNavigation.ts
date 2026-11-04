import { inject, onScopeDispose } from 'vue';
import { routerKey } from 'vue-router';
import { flushV2FormDrafts } from './useV2SessionDraft';

export function useV2DrawerNavigation(close: () => void) {
  const router = inject(routerKey, undefined);
  if (!router) return;
  const stop = router.afterEach((to, from, failure) => {
    if (!failure && to.fullPath !== from.fullPath) {
      flushV2FormDrafts();
      close();
    }
  });
  onScopeDispose(stop);
}
