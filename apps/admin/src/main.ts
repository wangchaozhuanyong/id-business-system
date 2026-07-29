import './v2/styles/base.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { setAppRuntimeError, shouldIgnoreRuntimeError } from './runtime/appRuntimeError';
import { markAppPerformance, measureAppPerformance } from './runtime/performance';
import { v2PaginationLabel } from './v2/directives/paginationLabel';
import { setV2RouteNavigationState, v2RouteNavigationState } from './v2/router/routes';
import { installV2PreloadRecovery } from './v2/runtime/preloadRecovery';
import { initializeV2Theme } from './v2/theme';
import { v2Router } from './v2-router';

markAppPerformance('v2:entry-evaluated');
initializeV2Theme();
window.__V2_APP_MOUNTED__ = false;

function bootstrapV2() {
  const app = createApp(App);
  const pinia = createPinia();

  app.config.errorHandler = (error) => {
    if (shouldIgnoreRuntimeError(error)) return;
    setAppRuntimeError('vue');
  };
  window.addEventListener('error', (event) => {
    if (shouldIgnoreRuntimeError(event)) return;
    setAppRuntimeError('window');
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (shouldIgnoreRuntimeError(event.reason)) return;
    setAppRuntimeError('promise');
  });

  installV2PreloadRecovery({
    buildId: __V2_BUILD_ID__,
    hasStableRoute: () => Boolean(v2RouteNavigationState.stablePath),
    onRepeatedBootFailure: (error) => {
      setV2RouteNavigationState(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
        'error',
        error
      );
    }
  });

  app.use(pinia);
  app.directive('pagination-label', v2PaginationLabel);
  app.use(v2Router);
  app.mount('#app');

  window.__V2_APP_MOUNTED__ = true;
  markAppPerformance('v2:app-mounted');
  measureAppPerformance('v2:entry-to-mount', 'v2:entry-evaluated', 'v2:app-mounted');
}

try {
  bootstrapV2();
} catch {
  const status = document.querySelector<HTMLElement>('.v2-boot__status');
  const retry = document.querySelector<HTMLButtonElement>('.v2-boot__retry');
  if (status) {
    status.textContent = '页面核心资源没有成功加载，请检查网络后重试。';
    status.hidden = false;
  }
  if (retry) retry.hidden = false;
}
