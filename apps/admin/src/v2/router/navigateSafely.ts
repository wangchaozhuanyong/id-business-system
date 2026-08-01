import { isNavigationFailure, type RouteLocationRaw, type Router } from 'vue-router';
import { setV2RouteNavigationState } from '@/v2/router/routes';

export async function navigateSafely(
  router: Router,
  target: RouteLocationRaw,
  method: 'push' | 'replace' = 'push'
) {
  let targetPath = router.currentRoute.value.fullPath;
  try {
    targetPath = router.resolve(target).fullPath;
    const failure = await router[method](target);
    // Vue Router resolves push/replace with a NavigationFailure when navigation
    // is prevented; only successful navigation resolves with a falsy value.
    if (failure) return false;
    return true;
  } catch (error) {
    if (!isNavigationFailure(error)) {
      setV2RouteNavigationState(targetPath, 'error', error);
    }
    return false;
  }
}
