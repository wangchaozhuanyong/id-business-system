<template>
  <ElConfigProvider :locale="zhCn" :message="messageConfig">
    <RouterView v-slot="{ Component: RouteComponent }">
      <V2BootGate
        v-if="bootStage !== 'ready'"
        :state="bootStage"
        :variant="bootGateVariant"
        :degraded-reason="hasBootRouteError ? 'route' : 'session'"
        @retry="retryBoot"
      />
      <component :is="RouteComponent" v-else :key="runtimeEpoch" />
    </RouterView>
    <Transition name="app-route-error">
      <div
        v-if="currentRuntimeError && bootStage !== 'fatal'"
        class="app-route-error"
        role="alert"
        aria-live="assertive"
      >
        <section class="app-route-error__panel">
          <div class="app-route-error__copy">
            <strong>页面运行时遇到问题</strong>
            <p>{{ currentRuntimeError.message }}</p>
          </div>
          <div class="app-route-error__actions">
            <button
              class="app-route-error__button app-route-error__button--primary"
              type="button"
              @click="reloadApp"
            >
              重新加载
            </button>
            <button class="app-route-error__button" type="button" @click="dismissRuntimeError">
              继续查看
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </ElConfigProvider>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs';
import { AUTH_IDENTITY_CHANGED_EVENT, AUTH_SESSION_EXPIRED_EVENT } from '@/auth/session';
import { appRuntimeError, clearAppRuntimeError } from '@/runtime/appRuntimeError';
import { useAuthStore } from '@/stores/auth';
import V2BootGate from '@/v2/components/V2BootGate.vue';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { setV2RouteNavigationState, v2RouteNavigationState } from '@/v2/router/routes';

const router = useRouter();
const authStore = useAuthStore();
const routerSettled = ref(false);
const runtimeEpoch = ref(0);
const currentRuntimeError = computed(() => appRuntimeError.value);
const isProtectedRoute = computed(
  () => router.currentRoute.value.matched.length > 0 && !router.currentRoute.value.meta.public
);
const hasBootRouteError = computed(
  () => !v2RouteNavigationState.stablePath && v2RouteNavigationState.state === 'error'
);
type BootStage = 'booting' | 'session-checking' | 'route-loading' | 'ready' | 'degraded' | 'fatal';
const bootStage = computed<BootStage>(() => {
  if (currentRuntimeError.value && !v2RouteNavigationState.stablePath) return 'fatal';
  if (authStore.sessionStatus === 'error' || hasBootRouteError.value) return 'degraded';
  if (authStore.sessionStatus === 'idle') return 'booting';
  if (
    authStore.sessionStatus === 'checking' ||
    (authStore.sessionStatus === 'anonymous' && isProtectedRoute.value)
  ) {
    return 'session-checking';
  }
  if (
    !routerSettled.value ||
    (!v2RouteNavigationState.stablePath && v2RouteNavigationState.state === 'pending')
  ) {
    return 'route-loading';
  }
  return 'ready';
});
const bootGateVariant = computed<'login' | 'workspace'>(() =>
  window.location.pathname.startsWith('/v2') ? 'workspace' : 'login'
);
const messageConfig = {
  duration: 2600,
  grouping: true,
  max: 2,
  offset: 16,
  placement: 'top-right',
  showClose: true
};

function handleAuthSessionExpired(rawEvent: Event) {
  const event = rawEvent as CustomEvent<{ message?: string }>;
  const currentRoute = router.currentRoute.value;

  authStore.clearLocalSession({
    reason: 'session-expired'
  });
  void import('@/v2/services/feedback').then(({ showV2Warning }) => {
    showV2Warning(event.detail?.message || '登录状态已过期，请重新登录。');
  });

  if (currentRoute.path !== '/login') {
    void router.replace({
      path: '/login',
      query: { redirect: currentRoute.fullPath }
    });
  }
}

function handleAuthIdentityChanged() {
  clearV2QueryCache();
  runtimeEpoch.value += 1;
}

function reloadApp() {
  window.location.reload();
}

async function retryBoot() {
  if (bootStage.value === 'fatal') {
    reloadApp();
    return;
  }
  if (hasBootRouteError.value) {
    reloadApp();
    return;
  }

  const status = await authStore.ensureSessionReady({ force: true });
  if (status === 'error') return;

  const target =
    v2RouteNavigationState.path ||
    `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target.startsWith('/v2')) {
    setV2RouteNavigationState(target, 'pending');
  }
  try {
    await router.replace(target);
  } catch (error) {
    setV2RouteNavigationState(target, 'error', error);
  }
}

function dismissRuntimeError() {
  clearAppRuntimeError();
}

void router.isReady().finally(() => {
  routerSettled.value = true;
});

watch(
  () => authStore.sessionStatus,
  (status) => {
    const currentRoute = router.currentRoute.value;
    if (status === 'anonymous' && currentRoute.path.startsWith('/v2')) {
      void router.replace({
        path: '/login',
        query: { redirect: currentRoute.fullPath }
      });
    }
  }
);

window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleAuthSessionExpired);
window.addEventListener(AUTH_IDENTITY_CHANGED_EVENT, handleAuthIdentityChanged);

onBeforeUnmount(() => {
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleAuthSessionExpired);
  window.removeEventListener(AUTH_IDENTITY_CHANGED_EVENT, handleAuthIdentityChanged);
});
</script>
