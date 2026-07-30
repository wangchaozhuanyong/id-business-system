import { createRouter, createWebHistory } from 'vue-router';
import { isAuthSessionExpired } from '@/auth/session';
import { useAuthStore } from '@/stores/auth';
import { hasUserRouteAccess } from '@/utils/permissions';
import { getFirstAllowedV2Route } from '@/v2/router/permissionRedirect';
import { setV2RouteNavigationState, v2RouteNavigationState, v2Routes } from '@/v2/router/routes';
import { beginV2RoutePerformance, markV2RouteCodeReady } from '@/runtime/performance';

const V2LoginView = () => import('@/v2/views/V2LoginView.vue');
const V2ForbiddenView = () => import('@/v2/views/V2ForbiddenView.vue');

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
    ...v2Routes,
    {
      path: '/:pathMatch(.*)*',
      redirect: '/v2'
    }
  ]
});

v2Router.beforeEach(async (to) => {
  const authStore = useAuthStore();
  beginV2RoutePerformance(to.path);

  if (to.path.startsWith('/v2')) {
    setV2RouteNavigationState(to.fullPath, 'pending');
  }

  if (isAuthSessionExpired()) {
    authStore.clearLocalSession({
      reason: 'session-expired'
    });
  }

  const sessionStatus = await authStore.ensureSessionReady();
  if (sessionStatus === 'error') {
    return false;
  }

  if (to.meta.public) {
    return sessionStatus === 'ready' ? '/v2' : true;
  }

  if (sessionStatus !== 'ready' || !authStore.isAuthenticated) {
    return redirectToLogin(to.fullPath);
  }

  try {
    if (authStore.shouldRefreshCurrentUser) {
      void refreshCurrentUserInBackground(authStore, to.fullPath);
    }
  } catch {
    authStore.sessionStatus = 'error';
    return false;
  }

  if (!hasUserRouteAccess(authStore.user, to.meta.permission, to.meta.requiredRoles)) {
    if (to.meta.status === 'planned') {
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

  const title = typeof to.meta.title === 'string' ? to.meta.title : 'ID 业务管理';
  document.title = `${title} - ID 业务管理`;
  if (to.path.startsWith('/v2')) {
    setV2RouteNavigationState(to.fullPath, 'ready');
  }
  markV2RouteCodeReady(
    to.path,
    typeof to.meta.v2ModuleKey === 'string' ? to.meta.v2ModuleKey : undefined
  );
});

v2Router.onError((error, to) => {
  setV2RouteNavigationState(to?.fullPath ?? v2Router.currentRoute.value.fullPath, 'error', error);
});

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
    await authStore.loadCurrentUser();
    const route = v2Router.currentRoute.value;
    if (route.fullPath !== activePath) return;
    if (!hasUserRouteAccess(authStore.user, route.meta.permission, route.meta.requiredRoles)) {
      if (route.meta.status === 'planned') {
        await v2Router.replace({
          path: '/403',
          query: { from: route.fullPath }
        });
        return;
      }
      await v2Router.replace(getFirstAllowedV2Route(authStore.user));
    }
  } catch {
    if (isAuthSessionExpired()) {
      authStore.clearLocalSession({
        reason: 'session-expired'
      });
      await v2Router.replace(redirectToLogin(activePath));
      return;
    }
    authStore.sessionStatus = 'error';
  }
}
