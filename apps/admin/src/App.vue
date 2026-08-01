<template>
  <ElConfigProvider :locale="elementLocale" :message="messageConfig">
    <RouterView v-slot="{ Component: RouteComponent }">
      <V2BootGate
        v-if="bootStage !== 'ready'"
        :state="bootStage"
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
import { computed, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import type { Language } from 'element-plus/es/locale/index.mjs';
import { authIdentityEpoch } from '@/auth/sessionCoordinator';
import { appRuntimeError, clearAppRuntimeError } from '@/runtime/appRuntimeError';
import { useAuthStore } from '@/stores/auth';
import V2BootGate from '@/v2/components/V2BootGate.vue';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { setV2RouteNavigationState, v2RouteNavigationState } from '@/v2/router/routes';

const router = useRouter();
const authStore = useAuthStore();
const elementLocale = shallowRef<Language>();
const routerSettled = ref(false);
const runtimeEpoch = authIdentityEpoch;
const currentRuntimeError = computed(() => appRuntimeError.value);
const isProtectedRoute = computed(
  () => router.currentRoute.value.matched.length > 0 && !router.currentRoute.value.meta.public
);
const hasBootRouteError = computed(
  () => !v2RouteNavigationState.stablePath && v2RouteNavigationState.state === 'error'
);
const isSessionUnavailableRoute = computed(
  () => router.currentRoute.value.meta.sessionBoundary === 'unavailable'
);
type BootStage = 'booting' | 'session-checking' | 'route-loading' | 'ready' | 'degraded' | 'fatal';
const bootStage = computed<BootStage>(() => {
  if (currentRuntimeError.value && !v2RouteNavigationState.stablePath) return 'fatal';
  if (hasBootRouteError.value) return 'degraded';
  if (isSessionUnavailableRoute.value) return routerSettled.value ? 'ready' : 'route-loading';
  if (authStore.session.kind === 'cold') return 'booting';
  if (
    authStore.session.kind === 'validating' ||
    (authStore.session.kind === 'degraded' && !authStore.session.verifiedInRuntime) ||
    (authStore.session.kind === 'anonymous' && isProtectedRoute.value)
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
const messageConfig = {
  duration: 2600,
  grouping: true,
  max: 2,
  offset: 16,
  placement: 'top-right',
  showClose: true
};

void import('element-plus/es/locale/lang/zh-cn.mjs').then(({ default: locale }) => {
  elementLocale.value = locale;
});

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

  const target =
    v2RouteNavigationState.path ||
    `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target.startsWith('/v2')) {
    setV2RouteNavigationState(target, 'pending');
  }
  await navigateSafely(router, target, 'replace');
}

function dismissRuntimeError() {
  clearAppRuntimeError();
}

void (async () => {
  try {
    await router.isReady();
  } catch (error) {
    setV2RouteNavigationState(router.currentRoute.value.fullPath, 'error', error);
  } finally {
    routerSettled.value = true;
  }
})();
</script>
