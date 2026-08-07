import { watch } from 'vue';
import { createRouter, createWebHistory, type RouteLocationNormalizedLoaded } from 'vue-router';
import { sessionState } from '@/auth/sessionCoordinator';
import { useAuthStore } from '@/stores/auth';
import { hasUserRouteAccess } from '@/utils/permissions';
import { getSafeV2Redirect, requiresPasswordResetRedirect } from '@/v2/router/passwordReset';
import { getFirstAllowedV2Route } from '@/v2/router/permissionRedirect';
import { navigateSafely } from '@/v2/router/navigateSafely';
import {
  createSessionRecoveryTracker,
  createVerifiedDegradedFallback
} from '@/v2/router/sessionRecovery';
import {
  resetV2RouteNavigationState,
  setV2RouteNavigationState,
  v2RouteNavigationState,
  v2Routes
} from '@/v2/router/routes';
import { beginV2RoutePerformance, markV2RouteCodeReady } from '@/runtime/performance';
import { formatV2DocumentTitle, loadV2Branding, v2Branding } from '@/v2/composables/useV2Branding';

const V2LoginView = () => import('@/v2/views/V2LoginView.vue');
const V2ForbiddenView = () => import('@/v2/views/V2ForbiddenView.vue');
const V2ChangePasswordView = () => import('@/v2/views/V2ChangePasswordView.vue');
const V2SessionUnavailableView = () => import('@/v2/views/V2SessionUnavailableView.vue');

export const v2Router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/v2'
    },
    {
      path: '/login',
      name: 'login',
      component: V2LoginView,
      meta: {
        public: true,
        title: '登录'
      }
    },
    {
      path: '/403',
      name: 'forbidden',
      component: V2ForbiddenView,
      meta: {
        title: '权限不足'
      }
    },
    {
      path: '/session-unavailable',
      name: 'session-unavailable',
      component: V2SessionUnavailableView,
      meta: {
        title: '登录服务暂时不可用',
        sessionBoundary: 'unavailable'
      }
    },
    {
      path: '/change-password',
      name: 'change-password',
      component: V2ChangePasswordView,
      meta: {
        title: '修改密码',
        allowDuringPasswordReset: true
      }
    },
    ...v2Routes,
    {
      path: '/:pathMatch(.*)*',
      redirect: '/v2'
    }
  ]
});

v2Router.beforeEach(async (to, from) => {
  const authStore = useAuthStore();
  beginV2RoutePerformance(to.path);

  if (to.path.startsWith('/v2')) {
    setV2RouteNavigationState(to.fullPath, 'pending');
  }

  const sessionResolution = await authStore.ensureSessionReady({ source: 'navigation' });

  if (to.meta.sessionBoundary === 'unavailable') {
    resetV2RouteNavigationState(to.fullPath);
    if (sessionResolution === 'ready') return getSafeV2Redirect(to.query.redirect);
    if (sessionResolution === 'degraded') {
      return from.path.startsWith('/v2') ? restoreVerifiedRoute(from) : true;
    }
    if (sessionResolution === 'anonymous')
      return redirectToLogin(getSafeV2Redirect(to.query.redirect));
    if (sessionResolution === 'blocked') return getBlockedSessionRoute(authStore);
    return true;
  }

  if (to.meta.public) {
    resetV2RouteNavigationState(to.fullPath);
    if (sessionResolution === 'anonymous') return true;
    if (sessionResolution === 'unavailable') return redirectToSessionUnavailable('/v2');
    if (sessionResolution === 'degraded' && from.path.startsWith('/v2')) {
      return restoreVerifiedRoute(from);
    }
    if (sessionResolution === 'blocked') return getBlockedSessionRoute(authStore);
    return authStore.user?.mustResetPassword ? '/change-password' : '/v2';
  }

  if (to.path === '/403' && (sessionResolution === 'ready' || sessionResolution === 'blocked')) {
    resetV2RouteNavigationState(to.fullPath);
    return true;
  }

  if (
    to.meta.allowDuringPasswordReset &&
    sessionResolution === 'blocked' &&
    authStore.session.kind === 'blocked' &&
    authStore.session.reason === 'password-reset'
  ) {
    resetV2RouteNavigationState(to.fullPath);
    return true;
  }

  if (sessionResolution === 'unavailable') {
    resetV2RouteNavigationState('/session-unavailable');
    return redirectToSessionUnavailable(to.fullPath);
  }

  if (sessionResolution === 'degraded') {
    if (from.path.startsWith('/v2')) {
      if (to.fullPath === from.fullPath) {
        setV2RouteNavigationState(from.fullPath, 'ready');
        return true;
      }
      return restoreVerifiedRoute(from);
    }
    resetV2RouteNavigationState('/session-unavailable');
    return redirectToSessionUnavailable(to.fullPath);
  }

  if (sessionResolution === 'blocked') {
    resetV2RouteNavigationState('/403');
    return getBlockedSessionRoute(authStore, to.fullPath);
  }

  if (sessionResolution === 'anonymous' || !authStore.isAuthenticated) {
    resetV2RouteNavigationState('/login');
    return redirectToLogin(to.fullPath);
  }

  if (
    requiresPasswordResetRedirect(
      authStore.user?.mustResetPassword,
      to.meta.allowDuringPasswordReset
    )
  ) {
    resetV2RouteNavigationState('/change-password');
    return redirectToPasswordChange(to.fullPath);
  }

  if (authStore.shouldRefreshCurrentUser) {
    void refreshCurrentUserInBackground(authStore, to.fullPath);
  }

  if (!hasUserRouteAccess(authStore.user, to.meta.permission, to.meta.requiredRoles)) {
    if (to.meta.status === 'planned') {
      resetV2RouteNavigationState('/403');
      return {
        path: '/403',
        query: { from: to.fullPath }
      };
    }
    return getFirstAllowedV2Route(authStore.user);
  }

  return true;
});

v2Router.afterEach((to, _from, failure) => {
  if (failure) {
    if (
      to.path.startsWith('/v2') &&
      v2RouteNavigationState.path === to.fullPath &&
      v2RouteNavigationState.state !== 'error'
    ) {
      setV2RouteNavigationState(
        v2RouteNavigationState.stablePath || v2Router.currentRoute.value.fullPath,
        'ready'
      );
    }
    return;
  }

  setRouteDocumentTitle(to);
  if (to.path.startsWith('/v2')) {
    setV2RouteNavigationState(to.fullPath, 'ready');
  } else {
    resetV2RouteNavigationState(to.fullPath);
  }
  markV2RouteCodeReady(
    to.path,
    typeof to.meta.v2ModuleKey === 'string' ? to.meta.v2ModuleKey : undefined
  );
});

v2Router.onError((error, to) => {
  setV2RouteNavigationState(to?.fullPath ?? v2Router.currentRoute.value.fullPath, 'error', error);
});

watch(
  () => v2Branding.value.documentTitleSuffix,
  () => setRouteDocumentTitle(v2Router.currentRoute.value)
);

void loadV2Branding().catch(() => undefined);

function setRouteDocumentTitle(route: RouteLocationNormalizedLoaded) {
  document.title = formatV2DocumentTitle(route.meta.title);
}

function redirectToLogin(targetFullPath: string) {
  return {
    path: '/login',
    query: { redirect: targetFullPath }
  };
}

async function refreshCurrentUserInBackground(
  authStore: ReturnType<typeof useAuthStore>,
  activePath: string
) {
  try {
    const resolution = await authStore.refreshCurrentUser('background');
    const route = v2Router.currentRoute.value;
    if (route.fullPath !== activePath) return;
    if (resolution === 'anonymous') {
      await navigateSafely(v2Router, redirectToLogin(activePath), 'replace');
      return;
    }
    if (resolution === 'blocked') {
      await navigateSafely(v2Router, getBlockedSessionRoute(authStore, activePath), 'replace');
      return;
    }
    if (resolution === 'unavailable' || resolution === 'degraded') return;
    if (
      requiresPasswordResetRedirect(
        authStore.user?.mustResetPassword,
        route.meta.allowDuringPasswordReset
      )
    ) {
      await navigateSafely(v2Router, redirectToPasswordChange(route.fullPath), 'replace');
      return;
    }
    if (!hasUserRouteAccess(authStore.user, route.meta.permission, route.meta.requiredRoles)) {
      if (route.meta.status === 'planned') {
        await navigateSafely(
          v2Router,
          {
            path: '/403',
            query: { from: route.fullPath }
          },
          'replace'
        );
        return;
      }
      await navigateSafely(v2Router, getFirstAllowedV2Route(authStore.user), 'replace');
    }
  } catch {
    // SessionCoordinator owns recoverable HTTP failures; this guard must not abort navigation.
  }
}

const trackSessionRecovery = createSessionRecoveryTracker(() => {
  void refreshQueriesAfterSessionRecovery();
});

watch(
  sessionState,
  (state) => {
    trackSessionRecovery(state.kind);
    if (state.kind === 'degraded') {
      if (!state.verifiedInRuntime) void routeUnverifiedSessionToBoundary();
      return;
    }
    if (state.kind === 'anonymous') {
      void routeAnonymousSessionToLogin();
      return;
    }
    if (state.kind === 'blocked') void routeBlockedSession();
  },
  { flush: 'post' }
);

async function refreshQueriesAfterSessionRecovery() {
  const [{ V2_DATA_SCOPES }, { invalidateV2Queries }] = await Promise.all([
    import('@apple-business/shared'),
    import('@/v2/composables/useV2Query')
  ]);
  invalidateV2Queries(V2_DATA_SCOPES);
  await reconcileRouteAfterSessionRecovery();
}

async function routeUnverifiedSessionToBoundary() {
  const route = v2Router.currentRoute.value;
  if (!route.path.startsWith('/v2')) return;
  await navigateSafely(v2Router, redirectToSessionUnavailable(route.fullPath), 'replace');
}

async function routeAnonymousSessionToLogin() {
  const route = v2Router.currentRoute.value;
  if (!route.path.startsWith('/v2') && route.meta.sessionBoundary !== 'unavailable') return;
  const redirect =
    route.meta.sessionBoundary === 'unavailable'
      ? getSafeV2Redirect(route.query.redirect)
      : route.fullPath;
  await navigateSafely(v2Router, redirectToLogin(redirect), 'replace');
}

async function routeBlockedSession() {
  const route = v2Router.currentRoute.value;
  if (route.path === '/403' || route.path === '/change-password') return;
  if (!route.path.startsWith('/v2') && route.meta.sessionBoundary !== 'unavailable') return;
  const authStore = useAuthStore();
  await navigateSafely(v2Router, getBlockedSessionRoute(authStore, route.fullPath), 'replace');
}

async function reconcileRouteAfterSessionRecovery() {
  const authStore = useAuthStore();
  const route = v2Router.currentRoute.value;
  if (route.meta.sessionBoundary === 'unavailable' || route.path === '/login') {
    await navigateSafely(v2Router, getSafeV2Redirect(route.query.redirect), 'replace');
    return;
  }
  if (!route.path.startsWith('/v2')) return;
  if (
    requiresPasswordResetRedirect(
      authStore.user?.mustResetPassword,
      route.meta.allowDuringPasswordReset
    )
  ) {
    await navigateSafely(v2Router, redirectToPasswordChange(route.fullPath), 'replace');
    return;
  }
  if (!hasUserRouteAccess(authStore.user, route.meta.permission, route.meta.requiredRoles)) {
    await navigateSafely(v2Router, getFirstAllowedV2Route(authStore.user), 'replace');
  }
}

function restoreVerifiedRoute(from: RouteLocationNormalizedLoaded) {
  setV2RouteNavigationState(from.fullPath, 'ready');
  return createVerifiedDegradedFallback(from);
}

function redirectToPasswordChange(targetFullPath: string) {
  return {
    path: '/change-password',
    query: { redirect: getSafeV2Redirect(targetFullPath) }
  };
}

function redirectToSessionUnavailable(targetFullPath: string) {
  return {
    path: '/session-unavailable',
    query: { redirect: getSafeV2Redirect(targetFullPath) }
  };
}

function getBlockedSessionRoute(
  authStore: ReturnType<typeof useAuthStore>,
  targetFullPath = '/v2'
) {
  if (authStore.session.kind === 'blocked' && authStore.session.reason === 'password-reset') {
    return redirectToPasswordChange(targetFullPath);
  }
  return {
    path: '/403',
    query: { from: getSafeV2Redirect(targetFullPath) }
  };
}
